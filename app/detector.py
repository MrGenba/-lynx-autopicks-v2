"""El detector: cada 180s descubre partidos de hoy (MLB/MiLB/LMB), comprueba Gate A
(abridores) y Gate B (lineup completo), y dispara pipelines cuando corresponde.

Join bidireccional con las cuotas: si un gate pasa y NO hay cuotas todavia, se avisa una vez
al admin ("faltan cuotas") y no se dispara nada -- cuando las cuotas lleguen despues por
Telegram, el propio manejador de mensajes consulta games_gate_state y dispara el pipeline en
ese momento (ver telegram_handlers.py). Si el gate pasa y las cuotas YA estaban, se dispara
aqui mismo.
"""
import asyncio
import datetime as dt
import logging
from typing import Optional

import asyncpg
import httpx

from app import mlb_stats_client as mlb_api
from app.odds_autofetch import autofetch_single_game
from app.pipelines import PipelineContext, get_odds, try_fire_pipeline

logger = logging.getLogger(__name__)

ACTIVE_STATUSES = {"Preview", "Pre-Game", "Warmup", "Scheduled"}
LOOKAHEAD = dt.timedelta(hours=3)


async def upsert_game(pool: asyncpg.Pool, sport_id: int, g: mlb_api.ScheduledGame, game_dt: dt.datetime) -> Optional[dt.datetime]:
    """Devuelve el lineup_confirmed_at YA guardado (si lo habia) -- el llamador lo usa para
    saltarse las 2 llamadas de boxscore de Gate B si ya estaba confirmado en un tick anterior
    (ver detector_tick). asyncpg exige un datetime.datetime real para columnas TIMESTAMPTZ --
    pasarle el string ISO crudo de la API (ej. "2026-07-07T23:45:00Z") revienta con DataError.
    game_dt ya viene parseado por el llamador (detector_tick), que lo necesita de todos modos
    para el filtro de ventana horaria."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
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
            RETURNING lineup_confirmed_at
            """,
            sport_id, g.game_pk, g.away_team_id, g.home_team_id, g.away_team_name, g.home_team_name,
            game_dt, g.status, g.away_pitcher_id, g.home_pitcher_id,
        )
    return row["lineup_confirmed_at"] if row else None


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


async def _autofetch_or_notify(
    ctx: PipelineContext, sport_id: int, game_pk: int, gate_col: str, away: str, home: str,
    minutes_to_start: int, game_dt: dt.datetime,
) -> None:
    """Disparo puntual de cuotas (un scrape acotado a este partido) en el momento exacto en que
    un gate se confirma por primera vez -- esto es lo que se pidio originalmente ("manda las
    cuotas cuando se confirmen las alineaciones"), no un sondeo periodico de la liga entera.
    Corre en segundo plano (create_task en el llamador) para no bloquear el resto del tick del
    detector mientras dura el scrape (hasta 300s). game_dt se le pasa a autofetch_single_game
    para que pueda descartar el resultado si el scrape termina despues de que el partido ya
    haya acabado (ver MAX_GAME_AGE en odds_autofetch.py)."""
    try:
        found = await autofetch_single_game(ctx, sport_id, game_pk, away, home, game_dt)
    except Exception:
        logger.exception("autofetch_single_game fallo para sport_id=%s game_pk=%s", sport_id, game_pk)
        found = False
    if not found:
        await notify_missing_odds_once(ctx, sport_id, game_pk, gate_col, away, home, minutes_to_start)


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

                already_lineup_confirmed = await upsert_game(ctx.pool, sport_id, g, game_dt)
                minutes_to_start = int((game_dt - now).total_seconds() // 60)

                # Gate A -- abridores
                if g.away_pitcher_id and g.home_pitcher_id:
                    first_time = await mark_pitchers_confirmed(ctx.pool, sport_id, g.game_pk)
                    odds = await get_odds(ctx.pool, sport_id, g.game_pk)
                    if odds is not None:
                        await try_fire_pipeline(ctx, sport_id, g.game_pk, 1, "pitchers_only", g.away_team_name, g.home_team_name)
                    elif first_time:
                        asyncio.create_task(_autofetch_or_notify(
                            ctx, sport_id, g.game_pk, "pitchers_no_odds_notice_at",
                            g.away_team_name, g.home_team_name, minutes_to_start, game_dt,
                        ))

                # Gate B -- lineup completo (9 bateadores en ambos lados). Si ya se confirmo en
                # un tick anterior, no hace falta volver a pedir el boxscore -- esto era una
                # fuente real de carga innecesaria sobre MLB Stats API / el fallback de Jina.ai
                # (2 llamadas por partido activo, EN CADA tick de 180s, para siempre, aunque el
                # gate llevara horas confirmado). Encontrado en vivo 2026-07-09 tras un 429 de
                # Jina.ai en LMB.
                if already_lineup_confirmed is not None:
                    continue

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
                        asyncio.create_task(_autofetch_or_notify(
                            ctx, sport_id, g.game_pk, "lineup_no_odds_notice_at",
                            g.away_team_name, g.home_team_name, minutes_to_start, game_dt,
                        ))
