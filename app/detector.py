"""El detector: cada 180s descubre partidos de hoy (MLB/MiLB/LMB), comprueba Gate A
(abridores) y Gate B (lineup completo), y dispara pipelines cuando corresponde.

Join bidireccional con las cuotas: si un gate pasa y NO hay cuotas todavia, se avisa una vez
al admin ("faltan cuotas") y no se dispara nada -- cuando las cuotas lleguen despues por
Telegram, el propio manejador de mensajes consulta games_gate_state y dispara el pipeline en
ese momento (ver telegram_handlers.py). Si el gate pasa y las cuotas YA estaban, se dispara
aqui mismo.
"""
import datetime as dt
import logging

import asyncpg
import httpx

from app import mlb_stats_client as mlb_api
from app.pipelines import PipelineContext, get_odds, try_fire_pipeline

logger = logging.getLogger(__name__)

ACTIVE_STATUSES = {"Preview", "Pre-Game", "Warmup", "Scheduled"}
LOOKAHEAD = dt.timedelta(hours=3)


async def upsert_game(pool: asyncpg.Pool, sport_id: int, g: mlb_api.ScheduledGame) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO games_gate_state
              (sport_id, game_pk, away_team_id, home_team_id, away_team_name, home_team_name,
               game_datetime_utc, status, away_pitcher_id, home_pitcher_id, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
            ON CONFLICT (sport_id, game_pk) DO UPDATE SET
              status = EXCLUDED.status,
              away_pitcher_id = COALESCE(games_gate_state.away_pitcher_id, EXCLUDED.away_pitcher_id),
              home_pitcher_id = COALESCE(games_gate_state.home_pitcher_id, EXCLUDED.home_pitcher_id),
              updated_at = now()
            """,
            sport_id, g.game_pk, g.away_team_id, g.home_team_id, g.away_team_name, g.home_team_name,
            g.game_datetime_utc, g.status, g.away_pitcher_id, g.home_pitcher_id,
        )


async def mark_pitchers_confirmed(pool: asyncpg.Pool, sport_id: int, game_pk: int) -> bool:
    """Devuelve True solo la PRIMERA vez que se confirma (transicion), para no re-disparar."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "UPDATE games_gate_state SET pitchers_confirmed_at = now() "
            "WHERE sport_id=$1 AND game_pk=$2 AND pitchers_confirmed_at IS NULL RETURNING id",
            sport_id, game_pk,
        )
    return row is not None


async def mark_lineup_confirmed(pool: asyncpg.Pool, sport_id: int, game_pk: int) -> bool:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "UPDATE games_gate_state SET lineup_confirmed_at = now() "
            "WHERE sport_id=$1 AND game_pk=$2 AND lineup_confirmed_at IS NULL RETURNING id",
            sport_id, game_pk,
        )
    return row is not None


async def notify_missing_odds_once(ctx: PipelineContext, sport_id: int, game_pk: int, gate_col: str, away: str, home: str, minutes_to_start: int) -> None:
    async with ctx.pool.acquire() as conn:
        row = await conn.fetchrow(
            f"UPDATE games_gate_state SET {gate_col} = now() "
            f"WHERE sport_id=$1 AND game_pk=$2 AND {gate_col} IS NULL RETURNING id",
            sport_id, game_pk,
        )
    if row is None:
        return  # ya avisado antes, no repetir
    hours, mins = divmod(max(minutes_to_start, 0), 60)
    await ctx.telegram.send_message(
        ctx.admin_chat_id,
        f"📋 Lineup listo, faltan cuotas: {away} @ {home} (empieza en {hours}h {mins}min)",
    )


async def detector_tick(ctx: PipelineContext) -> None:
    today = dt.datetime.utcnow().strftime("%Y-%m-%d")
    async with httpx.AsyncClient() as client:
        for sport_id, cfg in ((1, {}), (11, {}), (23, {"league_id": 125})):
            try:
                games = await mlb_api.get_schedule(client, sport_id, today, cfg.get("league_id"))
            except Exception as e:
                logger.exception("detector: fallo el schedule de sport_id=%s", sport_id)
                # Sin acceso a logs del contenedor, avisar tambien por Telegram es la unica
                # forma practica de detectar este tipo de fallo en producción.
                await ctx.telegram.send_message(
                    ctx.admin_chat_id,
                    f"❌ Detector: fallo el schedule de sport_id={sport_id}: {str(e)[:250]}",
                )
                continue

            for g in games:
                if g.status not in ACTIVE_STATUSES:
                    continue
                game_dt = dt.datetime.fromisoformat(g.game_datetime_utc.replace("Z", "+00:00"))
                now = dt.datetime.now(dt.timezone.utc)
                if game_dt - now > LOOKAHEAD or game_dt < now:
                    continue

                await upsert_game(ctx.pool, sport_id, g)
                minutes_to_start = int((game_dt - now).total_seconds() // 60)

                # Gate A -- abridores
                if g.away_pitcher_id and g.home_pitcher_id:
                    first_time = await mark_pitchers_confirmed(ctx.pool, sport_id, g.game_pk)
                    odds = await get_odds(ctx.pool, sport_id, g.game_pk)
                    if odds is not None:
                        await try_fire_pipeline(ctx, sport_id, g.game_pk, 1, "pitchers_only", g.away_team_name, g.home_team_name)
                    elif first_time:
                        await notify_missing_odds_once(
                            ctx, sport_id, g.game_pk, "pitchers_no_odds_notice_at",
                            g.away_team_name, g.home_team_name, minutes_to_start,
                        )

                # Gate B -- lineup completo (9 bateadores en ambos lados)
                try:
                    away_lineup = await mlb_api.get_lineup(client, g.game_pk, "away")
                    home_lineup = await mlb_api.get_lineup(client, g.game_pk, "home")
                except Exception:
                    logger.warning("detector: fallo boxscore de game_pk=%s", g.game_pk)
                    continue

                if away_lineup.published and home_lineup.published:
                    first_time = await mark_lineup_confirmed(ctx.pool, sport_id, g.game_pk)
                    odds = await get_odds(ctx.pool, sport_id, g.game_pk)
                    if odds is not None:
                        await try_fire_pipeline(ctx, sport_id, g.game_pk, 2, "full_lineup", g.away_team_name, g.home_team_name)
                    elif first_time:
                        await notify_missing_odds_once(
                            ctx, sport_id, g.game_pk, "lineup_no_odds_notice_at",
                            g.away_team_name, g.home_team_name, minutes_to_start,
                        )
