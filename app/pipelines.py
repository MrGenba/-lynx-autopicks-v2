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


async def get_odds(pool: asyncpg.Pool, sport_id: int, game_pk: int) -> Optional[asyncpg.Record]:
    async with pool.acquire() as conn:
        return await conn.fetchrow(
            "SELECT * FROM game_odds WHERE sport_id = $1 AND game_pk = $2", sport_id, game_pk
        )


def build_quant_payload(game: dict, odds: asyncpg.Record) -> dict:
    return {
        "game": game,
        "away_ml": odds["away_ml"],
        "home_ml": odds["home_ml"],
        "away_hc_val": odds["away_hc_val"],
        "away_hc_odds": odds["away_hc_odds"],
        "home_hc_val": odds["home_hc_val"],
        "home_hc_odds": odds["home_hc_odds"],
        "total_line": odds["total_line"],
        "over_odds": odds["over_odds"],
        "under_odds": odds["under_odds"],
    }


def _fmt_odds(v) -> str:
    return f"{float(v):.2f}" if v is not None else "?"


def format_pick_message(league_label: str, pipeline: int, away_team: str, home_team: str, best_pick: dict, data_score: float) -> str:
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

    game_obj = await adapter.build_game_object(game_pk, mode)
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

    if published:
        league_label = LEAGUE_LABEL.get(sport_id, str(sport_id))
        text = format_pick_message(league_label, pipeline, away_team, home_team, best_pick, data_score)
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
