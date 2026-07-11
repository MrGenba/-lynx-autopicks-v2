"""El disparador de pipelines -- llamado tanto por el detector (tick cada 180s) como por el
manejador de mensajes de Telegram cuando llegan cuotas. Es la MISMA funcion en ambos casos,
lo que evita divergencia entre "quien se dio cuenta primero".

Idempotencia: el INSERT...ON CONFLICT DO NOTHING en pipeline_runs es lo que garantiza un solo
disparo real por partido/pipeline, incluso si el detector y Telegram llegan casi a la vez o si
el proceso se reinicia a mitad. La comprobacion de "ya existe" de mas arriba es solo una
optimizacion (evita reconstruir el objeto game innecesariamente); la garantia real esta en la
restriccion UNIQUE de la base de datos, no en la logica de la aplicacion.
"""
import json
import logging
from dataclasses import dataclass
from typing import Optional

import asyncpg
import httpx

from app.adapters import Adapter, Mode
from app.node_bridge import NodeBridgeError, run_quant
from app.telegram import TelegramClient

logger = logging.getLogger(__name__)

LEAGUE_KEY = {1: "mlb", 11: "milb", 23: "lmb"}
LEAGUE_LABEL = {1: "MLB", 11: "MiLB", 23: "LMB"}


@dataclass
class PipelineContext:
    pool: asyncpg.Pool
    adapters: dict[int, Adapter]
    telegram: TelegramClient  # bot NUEVO -- polling (recibe cuotas) + avisos al admin
    picks_telegram: TelegramClient  # @Lynx_HunterBot (produccion) -- SOLO para publicar picks al
    # canal de produccion existente; enviar mensajes no choca con el webhook de n8n de ese bot,
    # solo RECIBIR (polling) chocaria, y este bot nunca hace polling en este sistema.
    admin_chat_id: int
    picks_channel_id: int
    node_bin: str
    vendor_dir: str
    # Proxy opcional para vendor/run_odds_scraper.js -- ver app/odds_autofetch.py. None = sin
    # proxy (el scraper fallara igual que produccion, bloqueado por cuotasahora.com).
    proxy_server: Optional[str] = None
    proxy_username: Optional[str] = None
    proxy_password: Optional[str] = None
    # odds-api.io (2026-07-11) -- fuente primaria nueva, ver app/odds_api_client.py. None =
    # desactivada, cae directo al scraper de Tor (comportamiento identico a antes de esto).
    odds_api_key: Optional[str] = None


async def get_odds(pool: asyncpg.Pool, sport_id: int, game_pk: int) -> Optional[asyncpg.Record]:
    async with pool.acquire() as conn:
        return await conn.fetchrow(
            "SELECT * FROM game_odds WHERE sport_id = $1 AND game_pk = $2", sport_id, game_pk
        )


def _num(v):
    """asyncpg devuelve las columnas NUMERIC de game_odds como Decimal -- json.dumps no sabe
    serializarlas (run_quant.js solo necesita precision de float, no la exactitud de Decimal)."""
    return float(v) if v is not None else None


def build_quant_payload(game: dict, odds: asyncpg.Record) -> dict:
    return {
        "game": game,
        "away_ml": _num(odds["away_ml"]),
        "home_ml": _num(odds["home_ml"]),
        "away_hc_val": _num(odds["away_hc_val"]),
        "away_hc_odds": _num(odds["away_hc_odds"]),
        "home_hc_val": _num(odds["home_hc_val"]),
        "home_hc_odds": _num(odds["home_hc_odds"]),
        "total_line": _num(odds["total_line"]),
        "over_odds": _num(odds["over_odds"]),
        "under_odds": _num(odds["under_odds"]),
    }


def _fmt_odds(v) -> str:
    return f"{float(v):.2f}" if v is not None else "?"


def _lineup_incomplete(sport_id: int, pipeline: int, game_obj: dict) -> bool:
    """MLB/MiLB ajustan mu por calidad real de lineup (Fase 2, ver quant_engine_mlb.js/quant_engine.js)
    -- si lineup_watch aun no lo reevaluo, el motor sigue calculando pero SIN ese ajuste, en
    silencio (mismo resultado que pitchers_only aunque el pipeline se llame "full_lineup").
    LMB no tiene este ajuste en absoluto (quant_engine_lmb.js no referencia lineup_factor por
    ningun lado) -- avisar ahi seria ruido constante, no una alerta real, asi que se excluye."""
    if pipeline != 2 or sport_id not in (1, 11):
        return False
    return game_obj.get("lineup_factor_away") is None or game_obj.get("lineup_factor_home") is None


def format_pick_message(league_label: str, pipeline: int, away_team: str, home_team: str, best_pick: dict, data_score: float, lineup_incomplete: bool = False) -> str:
    market = best_pick.get("market")
    pick_side = best_pick.get("pick_side")
    odds = best_pick.get("odds")
    edge = best_pick.get("edge")
    prob = best_pick.get("prob_model") or best_pick.get("prob_estimated")
    pipeline_label = "abridores" if pipeline == 1 else "lineup completo"
    lines = [
        f"🧪 PICK [Auto-Picks v2 — experimental] ({league_label} · {pipeline_label})",
        f"{away_team} @ {home_team}",
        f"Mercado: {market} — {pick_side}",
        f"Cuota: {_fmt_odds(odds)}  |  Edge: {edge * 100:.1f}%  |  Prob. modelo: {(prob or 0) * 100:.1f}%",
        f"data_score: {data_score:.2f}",
    ]
    if lineup_incomplete:
        lines.append("⚠️ lineup_factor aún sin calcular en producción — este pick NO llevó ajuste por calidad real del lineup.")
    return "\n".join(lines)


async def try_fire_pipeline(ctx: PipelineContext, sport_id: int, game_pk: int, pipeline: int, mode: Mode, away_team: str, home_team: str) -> None:
    async with ctx.pool.acquire() as conn:
        existing = await conn.fetchrow(
            "SELECT id FROM pipeline_runs WHERE sport_id=$1 AND game_pk=$2 AND pipeline=$3", sport_id, game_pk, pipeline
        )
    if existing:
        return

    odds = await get_odds(ctx.pool, sport_id, game_pk)
    if odds is None:
        return  # no deberia llamarse sin cuotas, pero por si acaso no hacemos nada

    adapter = ctx.adapters.get(sport_id)
    if adapter is None:
        logger.error("no hay adaptador para sport_id=%s", sport_id)
        return

    async with ctx.pool.acquire() as conn:
        gate_row = await conn.fetchrow(
            "SELECT away_pitcher_id, home_pitcher_id FROM games_gate_state WHERE sport_id=$1 AND game_pk=$2",
            sport_id, game_pk,
        )
    gate_away_pid = gate_row["away_pitcher_id"] if gate_row else None
    gate_home_pid = gate_row["home_pitcher_id"] if gate_row else None

    game_obj = await adapter.build_game_object(game_pk, mode, gate_away_pid, gate_home_pid)
    if game_obj is None:
        # Datos incompletos (p.ej. ERA de abridores aun sin poblar) -- NO se reclama la fila,
        # asi que se puede reintentar en un proximo tick del detector sin violar idempotencia.
        await ctx.telegram.send_message(
            ctx.admin_chat_id,
            f"⚠️ {LEAGUE_LABEL.get(sport_id, sport_id)} game_pk={game_pk}: datos insuficientes para calcular ({mode}), reintentando en próximos ticks.",
        )
        return

    # Punto de reclamo atomico -- a partir de aqui, cualquier llamada concurrente para el
    # mismo (sport_id, game_pk, pipeline) recibira claim=None y no hara nada.
    async with ctx.pool.acquire() as conn:
        claim = await conn.fetchrow(
            "INSERT INTO pipeline_runs (sport_id, game_pk, pipeline) VALUES ($1,$2,$3) "
            "ON CONFLICT (sport_id, game_pk, pipeline) DO NOTHING RETURNING id",
            sport_id, game_pk, pipeline,
        )
    if claim is None:
        return
    run_id = claim["id"]

    payload = build_quant_payload(game_obj, odds)
    try:
        result = await run_quant(ctx.node_bin, ctx.vendor_dir, LEAGUE_KEY[sport_id], payload)
    except NodeBridgeError as e:
        logger.exception("run_quant fallo para game_pk=%s pipeline=%s", game_pk, pipeline)
        async with ctx.pool.acquire() as conn:
            await conn.execute("UPDATE pipeline_runs SET error=$1 WHERE id=$2", str(e), run_id)
        await ctx.telegram.send_message(ctx.admin_chat_id, f"❌ Error calculando game_pk={game_pk}: {str(e)[:200]}")
        return

    async with ctx.pool.acquire() as conn:
        for cand in result.get("candidates", []):
            edge = cand.get("edge") or 0
            threshold = cand.get("edge_threshold") or 0.18
            await conn.execute(
                "INSERT INTO candidates_log (pipeline_run_id, market, pick_side, pick_team, odds, "
                "prob_estimated, prob_implied, edge, edge_threshold, confidence, publicable) "
                "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
                run_id, cand.get("market"), cand.get("pick_side"), cand.get("pick_team") or cand.get("away_team"),
                cand.get("odds"), cand.get("prob_model") or cand.get("prob_estimated"), cand.get("prob_implied"),
                edge, threshold, cand.get("confidence"), edge >= threshold,
            )

    best_pick = result.get("best_pick")
    data_score = result.get("data_score") or 0
    published = bool(best_pick)
    telegram_message_id = None

    league_label = LEAGUE_LABEL.get(sport_id, str(sport_id))
    lineup_incomplete = _lineup_incomplete(sport_id, pipeline, game_obj)
    if published:
        text = format_pick_message(league_label, pipeline, away_team, home_team, best_pick, data_score, lineup_incomplete)
        await ctx.picks_telegram.send_message(ctx.picks_channel_id, text)
    else:
        # Sin esto, "se calculo bien pero sin edge suficiente" y "algo fallo silenciosamente"
        # se ven identicos desde fuera (ningun mensaje llega a ningun sitio). Avisar siempre
        # al admin, aunque sea "sin valor", cierra ese hueco de visibilidad.
        candidates = result.get("candidates") or []
        best_candidate = max(candidates, key=lambda c: (c.get("edge") or -999), default=None)
        if best_candidate:
            edge_pct = (best_candidate.get("edge") or 0) * 100
            threshold_pct = (best_candidate.get("edge_threshold") or 0.18) * 100
            market = best_candidate.get("market")
            pick_side = best_candidate.get("pick_side")
            team_label = best_candidate.get("pick_team") or {"home": home_team, "away": away_team}.get(pick_side, pick_side)
            odds = _fmt_odds(best_candidate.get("odds"))
            detail = f"mejor candidato: {market} {team_label} @{odds} edge={edge_pct:.1f}% (umbral {threshold_pct:.0f}%)"
        else:
            detail = "sin candidatos calculables (faltan cuotas de algun mercado)"
        lineup_note = " ⚠️ sin ajuste de lineup (lineup_factor aún no calculado en producción)." if lineup_incomplete else ""
        await ctx.telegram.send_message(
            ctx.admin_chat_id,
            f"ℹ️ {league_label} {away_team} @ {home_team} (pipeline {pipeline}) calculado, sin valor suficiente — {detail}{lineup_note}",
        )

    async with ctx.pool.acquire() as conn:
        await conn.execute(
            "UPDATE pipeline_runs SET quant_result=$1, data_score=$2, best_pick=$3, published=$4, "
            "published_at=CASE WHEN $4 THEN now() ELSE NULL END WHERE id=$5",
            json.dumps(result), data_score, json.dumps(best_pick) if best_pick else None, published, run_id,
        )

    logger.info(
        "pipeline %s disparado: sport_id=%s game_pk=%s published=%s data_score=%.2f",
        pipeline, sport_id, game_pk, published, data_score,
    )
