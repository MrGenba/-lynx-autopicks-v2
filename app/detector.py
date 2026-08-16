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
# 2026-08-06 se subio SOLO LMB de 3h a 6h: cuotasahora publica sus lineas ANTES de 3h del inicio
# (verificado con Toros@Caliente, ML/Total/HC a 3h33m), y con 3h el detector no las pedia a tiempo.
# A MLB/MiLB se les dejo en 3h asumiendo que "sus cuotas salen ~al lineup".
#
# 2026-08-14: esa premisa era FALSA y costaba casi todo el slate. Medido contra el calendario real
# de MLB de ese dia: de 14 partidos, 13 tenian ya abridores confirmados y quedaban FUERA de la
# ventana de 3h (8 entre 3h y 6h, 5 mas alla) -> el detector ni siquiera los insertaba en
# games_gate_state, asi que no habia partido al que asignar cuotas por mucho que el scraper
# funcionara. El sintoma que se veia era "hay cuotas y no las recoge".
#
# Se unifica en 6h para las 3 ligas, que ademas es el valor que ya usaba la ventana del sondeo de
# cuotas (GAMES_WINDOW_SQL, now+6h en odds_autofetch.py): antes el detector la estrangulaba a 3h,
# asi que las dos ventanas trabajaban con criterios distintos. Mas alla de 6h no tendria efecto
# sin subir tambien esa otra.
LOOKAHEAD = dt.timedelta(hours=6)


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


async def fill_pitcher_ids_from_lineup(
    pool: asyncpg.Pool, sport_id: int, game_pk: int, away_pitcher_id: Optional[int], home_pitcher_id: Optional[int]
) -> None:
    """Relleno de emergencia: el schedule de MLB Stats API (hydrate=probablePitcher, lo que
    alimenta games_gate_state en Gate A) a veces no trae el abridor de un lado incluso para
    partidos de MiLB cuyo lineup YA se confirmo por boxscore (caso real: game_pk=815512,
    2026-07-11 -- Rochester @ Worcester, home.probablePitcher ausente del schedule pese a que el
    boxscore ya tenia el abridor real y el lineup completo publicado). Sin este relleno, el
    adaptador de MiLB/LMB se queda sin pitcher_id para ese lado y bloquea el analisis entero
    ("datos insuficientes") aunque las stats del pitcher SI existen en Supabase.
    COALESCE no pisa un valor ya bueno -- solo rellena huecos."""
    if away_pitcher_id is None and home_pitcher_id is None:
        return
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE games_gate_state SET "
            "away_pitcher_id = COALESCE(away_pitcher_id, $3), "
            "home_pitcher_id = COALESCE(home_pitcher_id, $4) "
            "WHERE sport_id=$1 AND game_pk=$2",
            sport_id, game_pk, away_pitcher_id, home_pitcher_id,
        )


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


# Cooldown entre reintentos de cuotas al confirmarse el lineup -- evita re-scrapear en CADA tick de
# 180s (martilleo -> throttle de cuotasahora, lección 2026-07-26).
ODDS_REFRESH_COOLDOWN = dt.timedelta(minutes=8)


async def cooldown_elapsed(pool: asyncpg.Pool, sport_id: int, game_pk: int, cooldown: dt.timedelta) -> bool:
    async with pool.acquire() as conn:
        last = await conn.fetchval(
            "SELECT last_odds_attempt_at FROM games_gate_state WHERE sport_id=$1 AND game_pk=$2",
            sport_id, game_pk,
        )
    if last is None:
        return True
    if last.tzinfo is None:
        last = last.replace(tzinfo=dt.timezone.utc)
    return dt.datetime.now(dt.timezone.utc) - last >= cooldown


async def mark_odds_attempt(pool: asyncpg.Pool, sport_id: int, game_pk: int) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE games_gate_state SET last_odds_attempt_at = now() WHERE sport_id=$1 AND game_pk=$2",
            sport_id, game_pk,
        )


async def _refresh_odds_and_forecast(
    ctx: PipelineContext, sport_id: int, game_pk: int, away: str, home: str,
    minutes_to_start: int, game_dt: dt.datetime,
) -> None:
    """"Fresco siempre" al confirmarse el lineup completo (2026-07-26): re-scrape de cuotas FRESCAS
    (autofetch, con retry-on-empty). Si las consigue, autofetch ya dispara pipeline 2 vía
    _check_gates_and_fire. Si NO consigue frescas pero había cuotas previas, no perder el pronóstico
    -> dispara pipeline 2 con las que haya. Si no hay ninguna, avisa (el cooldown reintentará en
    ticks posteriores hasta lograrlo o hasta que empiece el partido)."""
    try:
        got_fresh = await autofetch_single_game(ctx, sport_id, game_pk, away, home, game_dt)
    except Exception:
        logger.exception("_refresh_odds_and_forecast: autofetch falló sport_id=%s game_pk=%s", sport_id, game_pk)
        got_fresh = False
    if got_fresh:
        return
    odds = await get_odds(ctx.pool, sport_id, game_pk)
    if odds is not None:
        await try_fire_pipeline(ctx, sport_id, game_pk, 2, "full_lineup", away, home)
    else:
        await notify_missing_odds_once(ctx, sport_id, game_pk, "lineup_no_odds_notice_at", away, home, minutes_to_start)


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
                # Guardia 2026-07-31: un partido activo sin game_datetime_utc (o con formato raro)
                # reventaba aqui (.replace sobre None -> AttributeError) y, sin try/except por
                # partido, tumbaba el TICK ENTERO -> 0 candidatos en todas las ligas. Se salta.
                if not g.game_datetime_utc:
                    continue
                try:
                    game_dt = dt.datetime.fromisoformat(g.game_datetime_utc.replace("Z", "+00:00"))
                except (ValueError, AttributeError):
                    logger.warning("detector: game_datetime_utc invalido para game_pk=%s: %r", g.game_pk, g.game_datetime_utc)
                    continue
                now = dt.datetime.now(dt.timezone.utc)
                if game_dt - now > LOOKAHEAD or game_dt < now:
                    continue

                already_lineup_confirmed = await upsert_game(ctx.pool, sport_id, g, game_dt)
                minutes_to_start = int((game_dt - now).total_seconds() // 60)

                # Gate A -- abridores. Ya NO dispara autofetch de cuotas (a peticion del usuario
                # 2026-07-11): los abridores probables suelen confirmarse horas o dias antes del
                # partido, mucho antes de que el analisis automatico haga falta de verdad -- pedir
                # cuotas aqui gastaba peticiones de odds-api.io (limite 100/hora) demasiado pronto.
                # Solo dispara pipeline 1 si las cuotas YA existen (enviadas a mano, o ya obtenidas
                # por el autofetch real de Gate B en un tick anterior) -- nunca pide cuotas nuevas.
                if g.away_pitcher_id and g.home_pitcher_id:
                    first_pitchers = await mark_pitchers_confirmed(ctx.pool, sport_id, g.game_pk)
                    odds = await get_odds(ctx.pool, sport_id, g.game_pk)
                    if odds is not None:
                        await try_fire_pipeline(ctx, sport_id, g.game_pk, 1, "pitchers_only", g.away_team_name, g.home_team_name)
                    # Gate A: auto-fetch de cuotas por ABRIDORES para MiLB y LMB (2026-07-31). Ambas
                    # sufren lineups tardios/ausentes en StatsAPI: si las cuotas cuelgan solo del
                    # Gate B (lineup), un lineup tardio deja el partido sin cuotas y sin pick (caso
                    # real MiLB game_pk=816394, lineup a 10min del inicio -> 0 candidatos). Pidiendo
                    # cuotas ya con los abridores (que se saben horas antes) se cachean -> pipeline 1
                    # sale temprano y, cuando el lineup confirme, pipeline 2 dispara al instante. MLB
                    # NO entra (sus lineups llegan a tiempo por StatsAPI). Solo se re-scrapea mientras
                    # falten cuotas (con cooldown) -> no se martillea Tor.
                    lineup_ready = False
                    first_lineup = False
                    # 2026-08-06: MiLB (sport 11) RE-ACTIVADO aqui a peticion del usuario -- quiere el
                    # analisis de ABRIDORES temprano (pipeline 1 en cuanto haya cuotas), no esperando
                    # al lineup, y ademas el de lineup despues (2 modalidades). El motivo del revert de
                    # 01-ago (martilleo de Tor con ~30 partidos/dia) queda acotado por: (a) LOOKAHEAD=3h
                    # -> solo se piden cuotas de partidos dentro de 3h del inicio, no un dia antes;
                    # (b) en cuanto el partido consigue cuotas, odds!=None -> fetch_needed=False, deja de
                    # pedir; (c) MiLB ahora scrapea de forma fiable (no como LMB) -> consigue cuotas en
                    # 1-2 intentos y para. Si aun asi Tor se throttlea, acotar con una ventana < LOOKAHEAD.
                    fetch_needed = sport_id in (11, 23) and odds is None and (first_pitchers or await cooldown_elapsed(
                        ctx.pool, sport_id, g.game_pk, ODDS_REFRESH_COOLDOWN))
                    if sport_id == 23:
                        # LMB-ONLY: StatsAPI no da el lineup LMB pre-partido -> confirmar el lineup
                        # desde lineup_watch (el Lineup Watcher de n8n lo detecta ~30min antes y
                        # guarda su woba, que el adapter full_lineup ya consume) -> pipeline 2. MiLB
                        # NO entra: usa el Gate B normal de StatsAPI mas abajo (su lineup si llega).
                        # BUGFIX 2026-07-31: lineup_watch vive en SUPABASE (no en la DB interna de
                        # asyncpg) -> hay que consultarla con ctx.supabase, NO ctx.pool. La version
                        # anterior (ctx.pool) lanzaba UndefinedTable y, sin try/except por partido,
                        # tumbaba el tick. try/except defensivo para que nunca vuelva a pasar.
                        lineup_ready = False
                        try:
                            lw = await ctx.supabase.select_one(ctx.http_client, "lineup_watch", {
                                "game_pk": f"eq.{g.game_pk}",
                                "lineup_away_detected_at": "not.is.null",
                                "lineup_home_detected_at": "not.is.null",
                                "lineup_woba_away": "not.is.null",
                                "lineup_woba_home": "not.is.null",
                                "select": "game_pk",
                            })
                            lineup_ready = lw is not None
                        except Exception:
                            logger.warning("detector: fallo consultando lineup_watch para game_pk=%s", g.game_pk)
                        if lineup_ready:
                            first_lineup = await mark_lineup_confirmed(ctx.pool, sport_id, g.game_pk)
                        if first_lineup:
                            fetch_needed = True  # cuotas frescas justo al confirmarse el lineup
                    if fetch_needed:
                        await mark_odds_attempt(ctx.pool, sport_id, g.game_pk)
                        asyncio.create_task(autofetch_single_game(
                            ctx, sport_id, g.game_pk, g.away_team_name, g.home_team_name, game_dt,
                        ))
                    elif sport_id == 23 and lineup_ready and odds is not None:
                        # LMB: lineup confirmado + cuotas ya presentes -> asegurar pipeline 2 (por si
                        # el fetch fresco fallo en el tick que confirmo el lineup).
                        await try_fire_pipeline(ctx, sport_id, g.game_pk, 2, "full_lineup", g.away_team_name, g.home_team_name)
                    if sport_id == 23:
                        continue  # LMB no usa el Gate B de StatsAPI (boxscore vacio pre-partido)

                # Gate B -- lineup completo (9 bateadores en ambos lados). Si ya se confirmo en
                # un tick anterior, no hace falta volver a pedir el boxscore -- esto era una
                # fuente real de carga innecesaria sobre MLB Stats API / el fallback de Jina.ai
                # (2 llamadas por partido activo, EN CADA tick de 180s, para siempre, aunque el
                # gate llevara horas confirmado). Encontrado en vivo 2026-07-09 tras un 429 de
                # Jina.ai en LMB.
                if already_lineup_confirmed is not None:
                    # El lineup ya se confirmo en un tick anterior -- normalmente no hace falta
                    # volver a pedir el boxscore (ver comentario arriba), PERO si pipeline 2
                    # nunca llego a reclamarse (ej. build_game_object fallo por falta de datos,
                    # caso real: game_pk=815512, 2026-07-11), este game_pk quedaba huerfano para
                    # siempre -- el mensaje "reintentando en proximos ticks" era falso en ese
                    # camino. Un SELECT barato (sin boxscore) basta para distinguir "ya publicado
                    # con exito" de "confirmado pero nunca proceso".
                    async with ctx.pool.acquire() as conn:
                        pipeline2_done = await conn.fetchval(
                            "SELECT 1 FROM pipeline_runs WHERE sport_id=$1 AND game_pk=$2 AND pipeline=2",
                            sport_id, g.game_pk,
                        )
                    if pipeline2_done:
                        continue

                try:
                    away_lineup = await mlb_api.get_lineup(client, g.game_pk, "away")
                    home_lineup = await mlb_api.get_lineup(client, g.game_pk, "home")
                except Exception:
                    logger.warning("detector: fallo boxscore de game_pk=%s", g.game_pk)
                    continue

                if away_lineup.published and home_lineup.published:
                    first_time = await mark_lineup_confirmed(ctx.pool, sport_id, g.game_pk)
                    await fill_pitcher_ids_from_lineup(
                        ctx.pool, sport_id, g.game_pk, away_lineup.pitcher_id, home_lineup.pitcher_id,
                    )
                    # "Fresco siempre" (2026-07-26): al confirmarse el lineup (o en reintento con
                    # cooldown si el intento anterior falló) se re-scrapean cuotas FRESCAS -- las
                    # líneas se mueven justo cuando salen los lineups. Solo se llega aquí si pipeline
                    # 2 aún no corrió (ver chequeo pipeline2_done arriba). El cooldown evita
                    # re-scrapear en cada tick (martilleo -> throttle).
                    if first_time or await cooldown_elapsed(ctx.pool, sport_id, g.game_pk, ODDS_REFRESH_COOLDOWN):
                        await mark_odds_attempt(ctx.pool, sport_id, g.game_pk)
                        asyncio.create_task(_refresh_odds_and_forecast(
                            ctx, sport_id, g.game_pk, g.away_team_name, g.home_team_name,
                            minutes_to_start, game_dt,
                        ))
                    else:
                        # aún en cooldown: si ya hay cuotas y pipeline 2 no corrió, pronosticar con ellas
                        odds = await get_odds(ctx.pool, sport_id, g.game_pk)
                        if odds is not None:
                            await try_fire_pipeline(ctx, sport_id, g.game_pk, 2, "full_lineup", g.away_team_name, g.home_team_name)
