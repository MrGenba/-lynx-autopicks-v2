"""El disparador de pipelines -- llamado tanto por el detector (tick cada 180s) como por el
manejador de mensajes de Telegram cuando llegan cuotas. Es la MISMA funcion en ambos casos,
lo que evita divergencia entre "quien se dio cuenta primero".

Idempotencia: el INSERT...ON CONFLICT DO NOTHING en pipeline_runs es lo que garantiza un solo
disparo real por partido/pipeline, incluso si el detector y Telegram llegan casi a la vez o si
el proceso se reinicia a mitad. La comprobacion de "ya existe" de mas arriba es solo una
optimizacion (evita reconstruir el objeto game innecesariamente); la garantia real esta en la
restriccion UNIQUE de la base de datos, no en la logica de la aplicacion.
"""
import datetime as dt
import json
import logging
from dataclasses import dataclass
from typing import Optional

import asyncpg
import httpx

from app.adapters import Adapter, Mode
from app.node_bridge import NodeBridgeError, run_quant
from app.supabase_client import SupabaseClient
from app.telegram import TelegramClient

logger = logging.getLogger(__name__)

LEAGUE_KEY = {1: "mlb", 11: "milb", 23: "lmb"}
LEAGUE_LABEL = {1: "MLB", 11: "MiLB", 23: "LMB"}
CANDIDATES_HISTORY_TABLE = {1: "mlb_candidates_history", 11: "candidates_history", 23: "lmb_candidates_history"}
# Columnas reales por tabla (verificadas contra Supabase 2026-07-11 antes de escribir -- mismo
# bug ya sufrido una vez con prob_edge faltante en mlb_picks_history, ver CLAUDE.md/KNOWN_ISSUES).
# Solo se envian las columnas que existen de verdad en cada tabla, nunca el superset completo.
CANDIDATES_HISTORY_COLUMNS = {
    "mlb_candidates_history": {
        "game_id", "game_date", "market", "pick_side", "pick_team", "odds", "prob_estimated",
        "prob_implied", "prob_edge", "edge", "edge_threshold", "data_score", "published", "result",
        "total_line", "hc_value", "diag_flags", "away_runs_predicted", "home_runs_predicted",
        "league", "created_at", "matchup_label", "prob_model", "market_prob", "fair_odds",
        "model_version", "source",
    },
    "candidates_history": {
        "game_id", "game_date", "market", "pick_side", "pick_team", "odds", "prob_estimated",
        "prob_implied", "prob_edge", "edge", "edge_threshold", "data_score", "published", "result",
        "total_line", "hc_value", "diag_flags", "away_runs_predicted", "home_runs_predicted",
        "league", "created_at", "matchup_label", "away_team", "home_team", "source",
    },
    "lmb_candidates_history": {
        "game_id", "game_date", "market", "pick_side", "pick_team", "odds", "prob_estimated",
        "prob_implied", "prob_edge", "edge", "edge_threshold", "data_score", "published", "result",
        "total_line", "hc_value", "diag_flags", "away_runs_predicted", "home_runs_predicted",
        "league", "created_at", "source",
    },
}


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
    supabase: SupabaseClient  # lectura de vistas + escritura SOLO en *_candidates_history (ver supabase_client.py)
    http_client: httpx.AsyncClient
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


def format_full_analysis(league_label: str, pipeline: int, away_team: str, home_team: str, result: dict, lineup_incomplete: bool = False) -> str:
    """Desglose completo de TODOS los mercados evaluados (no solo el mejor) -- para el chat
    privado del admin via @Cuotasodds_bot, en todo pipeline run, se haya publicado o no."""
    pipeline_label = "abridores" if pipeline == 1 else "lineup completo"
    data_score = result.get("data_score") or 0
    candidates = sorted(result.get("candidates") or [], key=lambda c: (c.get("edge") or -999), reverse=True)
    best_pick = result.get("best_pick")
    published_key = (best_pick.get("market"), best_pick.get("pick_side")) if best_pick else None

    lines = [
        f"🔍 Análisis completo ({league_label} · {pipeline_label})",
        f"{away_team} @ {home_team}",
        f"data_score: {data_score:.2f}",
        "",
    ]
    if not candidates:
        lines.append("Sin candidatos calculables (faltan cuotas de algún mercado).")
    for c in candidates:
        market = c.get("market")
        pick_side = c.get("pick_side")
        odds = c.get("odds")
        edge = c.get("edge") or 0
        threshold = c.get("edge_threshold") or 0.18
        prob_model = c.get("prob_model") or c.get("prob_estimated") or 0
        prob_implied = c.get("prob_implied") or 0
        prob_blended = c.get("prob_blended")
        confidence = c.get("confidence")
        mark = "✅" if edge >= threshold else "➖"
        key = (market, pick_side)
        published_mark = "  📣 PUBLICADO" if published_key == key else ""
        blended_txt = f"  |  Prob. blend: {prob_blended * 100:.1f}%" if prob_blended is not None else ""
        conf_txt = f"  |  Confianza: {confidence}" if confidence else ""
        lines.append(f"{mark} {market} — {pick_side}{published_mark}")
        lines.append(
            f"   Cuota: {_fmt_odds(odds)}  |  Prob. modelo: {prob_model * 100:.1f}%  |  "
            f"Prob. mercado: {prob_implied * 100:.1f}%{blended_txt}"
        )
        lines.append(f"   Edge: {edge * 100:.1f}% (umbral {threshold * 100:.0f}%){conf_txt}")

    if lineup_incomplete:
        lines.append("")
        lines.append("⚠️ lineup_factor aún sin calcular en producción — este análisis NO llevó ajuste por calidad real del lineup.")
    return "\n".join(lines)


def _pick_team_for(pick_side: Optional[str], away_team: str, home_team: str) -> Optional[str]:
    if not pick_side:
        return None
    upper = pick_side.upper()
    if upper.startswith("AWAY"):
        return away_team
    if upper.startswith("HOME"):
        return home_team
    return None


def build_candidates_history_rows(
    sport_id: int, game_pk: int, game_date, away_team: str, home_team: str, result: dict, published_key
) -> tuple[str, list[dict]]:
    """Mapea los candidatos de un pipeline run al esquema real de *_candidates_history (Supabase),
    marcados con source='autopicks_v2' para distinguirlos de los de produccion (n8n). Solo se
    incluyen columnas que existen de verdad en cada tabla (CANDIDATES_HISTORY_COLUMNS) -- ver
    comentario en la constante, mismo bug que el prob_edge de mlb_picks_history a evitar."""
    table = CANDIDATES_HISTORY_TABLE[sport_id]
    allowed = CANDIDATES_HISTORY_COLUMNS[table]
    league_label = LEAGUE_LABEL.get(sport_id, str(sport_id))
    away_mu = result.get("away_mu")
    home_mu = result.get("home_mu")
    now_iso = dt.datetime.now(dt.timezone.utc).isoformat()

    rows = []
    for c in result.get("candidates") or []:
        market = c.get("market")
        pick_side = c.get("pick_side")
        prob_model = c.get("prob_model") or c.get("prob_estimated")
        prob_implied = c.get("prob_implied")
        prob_blended = c.get("prob_blended")
        prob_final = prob_blended if prob_blended is not None else prob_model
        full_row = {
            "game_id": game_pk, "game_date": game_date, "market": market, "pick_side": pick_side,
            "pick_team": c.get("pick_team") or _pick_team_for(pick_side, away_team, home_team),
            "odds": c.get("odds"),
            "prob_estimated": prob_final, "prob_implied": prob_implied,
            "prob_edge": (prob_final - prob_implied) if (prob_final is not None and prob_implied is not None) else None,
            "edge": c.get("edge"), "edge_threshold": c.get("edge_threshold"),
            "data_score": c.get("data_score"),
            "published": (market, pick_side) == published_key,
            "result": "PENDING",
            "total_line": c.get("total_line"), "hc_value": c.get("hc_value"),
            "diag_flags": [],
            "away_runs_predicted": away_mu, "home_runs_predicted": home_mu,
            "league": league_label, "created_at": now_iso,
            "matchup_label": f"{away_team} @ {home_team}",
            "prob_model": prob_model, "market_prob": prob_implied,
            "fair_odds": round(1 / prob_final, 2) if prob_final else None,
            "model_version": "autopicks_v2",
            "away_team": away_team, "home_team": home_team,
            "source": "autopicks_v2",
        }
        rows.append({k: v for k, v in full_row.items() if k in allowed})
    return table, rows


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
    published_key = (best_pick.get("market"), best_pick.get("pick_side")) if best_pick else None
    telegram_message_id = None

    league_label = LEAGUE_LABEL.get(sport_id, str(sport_id))
    lineup_incomplete = _lineup_incomplete(sport_id, pipeline, game_obj)

    # Candidatos evaluados -> mismo pool de calibracion que produccion (*_candidates_history en
    # Supabase, source='autopicks_v2'). No critico: si falla, no bloquea el envio de mensajes.
    try:
        table, rows = build_candidates_history_rows(
            sport_id, game_pk, game_obj.get("game_date"), away_team, home_team, result, published_key
        )
        await ctx.supabase.insert(ctx.http_client, table, rows)
    except Exception:
        logger.exception("fallo guardando candidates_history en Supabase para game_pk=%s pipeline=%s", game_pk, pipeline)

    # El admin (@Cuotasodds_bot) recibe SIEMPRE el analisis completo (todos los mercados
    # evaluados, no solo el mejor), se haya publicado o no en el canal de produccion.
    full_text = format_full_analysis(league_label, pipeline, away_team, home_team, result, lineup_incomplete)
    await ctx.telegram.send_message(ctx.admin_chat_id, full_text)

    if published:
        text = format_pick_message(league_label, pipeline, away_team, home_team, best_pick, data_score, lineup_incomplete)
        await ctx.picks_telegram.send_message(ctx.picks_channel_id, text)

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
