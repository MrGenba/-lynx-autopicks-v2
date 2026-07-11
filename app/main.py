"""Punto de entrada: arranca el pool de Postgres, aplica migraciones, siembra alias (si hace
falta), y lanza en paralelo el detector (APScheduler, cada N segundos), el long-poll de
Telegram, y un servidor aiohttp con el health check de EasyPanel + /scrape-odds/* (ver mas
abajo)."""
import asyncio
import datetime as dt
import logging
import uuid

import httpx
from aiohttp import web
from apscheduler.schedulers.asyncio import AsyncIOScheduler

from app import aliases, db
from app.adapters.mlb import MlbAdapter
from app.adapters.milb import MilbAdapter
from app.adapters.lmb import LmbAdapter
from app.config import Config
from app.detector import detector_tick
from app.logging_setup import setup_logging
from app.message_handler import handle_message
from app.node_bridge import NodeBridgeError, run_odds_scraper
from app.odds_api_client import get_league_odds
from app.odds_autofetch import _scrape_semaphore, autofetch_tick
from app.pipelines import PipelineContext
from app.supabase_client import SupabaseClient
from app.telegram import TelegramClient, poll_loop

logger = logging.getLogger(__name__)

# Trabajos de scraping en curso para produccion (ver /scrape-odds/start y /scrape-odds/status
# mas abajo) -- en memoria, se pierde en cada reinicio, aceptable porque un trabajo dura como
# mucho unos minutos y n8n reintentaria de todos modos. JOB_TTL limita cuanto se guarda un
# resultado ya terminado antes de purgarlo (evita crecer sin limite en un contenedor de larga
# duracion).
_scrape_jobs: dict[str, dict] = {}
JOB_TTL = dt.timedelta(hours=1)


def _prune_old_jobs() -> None:
    cutoff = dt.datetime.now(dt.timezone.utc) - JOB_TTL
    stale = [jid for jid, j in _scrape_jobs.items() if j["created_at"] < cutoff]
    for jid in stale:
        del _scrape_jobs[jid]


async def health(_request: web.Request) -> web.Response:
    return web.json_response({"ok": True})


def _check_scrape_token(request: web.Request, cfg: Config) -> bool:
    auth_header = request.headers.get("Authorization", "")
    token = auth_header[len("Bearer "):] if auth_header.startswith("Bearer ") else None
    return bool(cfg.scrape_endpoint_token) and token == cfg.scrape_endpoint_token


async def _run_scrape_job(job_id: str, cfg: Config, league: str) -> None:
    try:
        # 2026-07-11: prueba primero odds-api.io (API real, mas rapido y fiable) -- exito real
        # es "encontro partidos" O "termino sin errores" (liga sin partidos publicados ahora
        # mismo es valido, no un fallo). Solo cae al scraper de Tor si de verdad no pudo
        # completar la consulta -- no se borro ese camino, sigue siendo el respaldo real.
        if cfg.odds_api_key:
            try:
                api_result = await get_league_odds(cfg.odds_api_key, league)
            except Exception:
                logger.exception("get_league_odds fallo de forma inesperada para %s", league)
                api_result = None
            if api_result is not None and (api_result["games"] or not api_result["errors"]):
                _scrape_jobs[job_id]["status"] = "done"
                _scrape_jobs[job_id]["result"] = api_result
                return
            logger.warning("odds-api.io sin resultado usable para %s, cae al scraper de Tor", league)

        async with _scrape_semaphore:
            result = await run_odds_scraper(
                cfg.node_bin, cfg.vendor_dir, league,
                cfg.proxy_server, cfg.proxy_username, cfg.proxy_password,
            )
        _scrape_jobs[job_id]["status"] = "done"
        _scrape_jobs[job_id]["result"] = result
    except NodeBridgeError as e:
        _scrape_jobs[job_id]["status"] = "error"
        _scrape_jobs[job_id]["error"] = str(e)
    except Exception:
        logger.exception("_run_scrape_job fallo de forma inesperada (job_id=%s)", job_id)
        _scrape_jobs[job_id]["status"] = "error"
        _scrape_jobs[job_id]["error"] = "error interno inesperado"


async def scrape_odds_start(request: web.Request) -> web.Response:
    """Endpoint HTTP para que produccion (n8n, proyecto EasyPanel distinto sin red interna
    compartida con este) reuse el scraper con Tor de este contenedor en vez de duplicar
    Tor+Chrome alli. Devuelve al instante un job_id -- el scrape real (varios minutos, un
    ciclo completo de la liga sin filtrar por partidos concretos, a diferencia del autofetch
    interno) corre en segundo plano. Se probo devolver el resultado directamente (bloqueando
    la respuesta hasta terminar) y el proxy de EasyPanel (Traefik) cortaba la conexion mucho
    antes de que el scrape terminara -- de ahi el patron arrancar+consultar. Protegido por
    token compartido (SCRAPE_ENDPOINT_TOKEN) via cabecera Authorization: Bearer <token> --
    NUNCA en la URL/query string (quedaria en logs)."""
    cfg: Config = request.app["cfg"]
    if not _check_scrape_token(request, cfg):
        return web.json_response({"error": "unauthorized"}, status=401)

    league = request.query.get("league")
    if league not in ("MLB", "MiLB", "LMB"):
        return web.json_response({"error": "parametro 'league' debe ser MLB, MiLB o LMB"}, status=400)

    _prune_old_jobs()
    job_id = str(uuid.uuid4())
    _scrape_jobs[job_id] = {"status": "running", "created_at": dt.datetime.now(dt.timezone.utc)}
    asyncio.create_task(_run_scrape_job(job_id, cfg, league))
    return web.json_response({"job_id": job_id, "status": "running"})


async def scrape_odds_status(request: web.Request) -> web.Response:
    cfg: Config = request.app["cfg"]
    if not _check_scrape_token(request, cfg):
        return web.json_response({"error": "unauthorized"}, status=401)

    job_id = request.match_info["job_id"]
    job = _scrape_jobs.get(job_id)
    if job is None:
        return web.json_response({"error": "job_id desconocido (o expirado, TTL 1h)"}, status=404)

    if job["status"] == "running":
        return web.json_response({"status": "running"})
    if job["status"] == "error":
        return web.json_response({"status": "error", "error": job["error"]}, status=502)
    return web.json_response({"status": "done", "result": job["result"]})


async def run_health_server(cfg: Config, port: int = 8080) -> None:
    app = web.Application()
    app["cfg"] = cfg
    app.router.add_get("/healthz", health)
    app.router.add_get("/scrape-odds/start", scrape_odds_start)
    app.router.add_get("/scrape-odds/status/{job_id}", scrape_odds_status)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", port)
    await site.start()


async def main() -> None:
    cfg = Config.from_env()
    setup_logging(cfg.log_level, cfg.log_dir)
    logger.info("arrancando autopicks_v2")

    pool = await db.create_pool(cfg.database_url)
    await db.run_migrations(pool)

    async with pool.acquire() as conn:
        alias_count = await conn.fetchval("SELECT count(*) FROM team_aliases")
    if alias_count == 0:
        logger.info("team_aliases vacia, sembrando desde MLB Stats API...")
        inserted = await aliases.seed_all(pool)
        logger.info("alias sembrados: %s", inserted)

    http_client = httpx.AsyncClient()
    supabase = SupabaseClient(cfg.supabase_url, cfg.supabase_key)
    telegram = TelegramClient(cfg.tg_bot_token, http_client)
    # Bot de produccion (@Lynx_HunterBot) -- SOLO se usa para publicar picks al canal existente,
    # nunca para polling (eso seguiria chocando con el webhook de n8n de ese mismo bot).
    picks_telegram = TelegramClient(cfg.tg_picks_bot_token, http_client)

    adapters = {
        1: MlbAdapter(supabase, http_client),
        11: MilbAdapter(supabase, http_client),
        23: LmbAdapter(supabase, http_client),
    }

    ctx = PipelineContext(
        pool=pool, adapters=adapters, telegram=telegram, picks_telegram=picks_telegram,
        admin_chat_id=cfg.tg_admin_chat_id, picks_channel_id=cfg.tg_picks_channel_id,
        node_bin=cfg.node_bin, vendor_dir=cfg.vendor_dir,
        supabase=supabase, http_client=http_client,
        proxy_server=cfg.proxy_server, proxy_username=cfg.proxy_username, proxy_password=cfg.proxy_password,
        odds_api_key=cfg.odds_api_key,
    )

    scheduler = AsyncIOScheduler()
    # next_run_time=now: por defecto APScheduler espera el intervalo completo antes del primer
    # tick (180s en frio tras arrancar) -- se fuerza a que corra de inmediato al iniciar.
    scheduler.add_job(
        detector_tick, "interval", seconds=cfg.detector_interval_seconds, args=[ctx],
        max_instances=1, next_run_time=dt.datetime.now(),
    )
    # Pausado por defecto (ODDS_AUTOFETCH_ENABLED=false) -- ver comentario en config.py. Con
    # el job desactivado, /fetchodds sigue funcionando igual para disparar un ciclo a proposito.
    if cfg.odds_autofetch_enabled:
        scheduler.add_job(
            autofetch_tick, "interval", seconds=cfg.odds_autofetch_interval_seconds, args=[ctx],
            max_instances=1, next_run_time=dt.datetime.now() + dt.timedelta(seconds=30),
        )
    else:
        logger.info("odds_autofetch_enabled=false -- job automatico NO registrado, solo /fetchodds manual")
    scheduler.start()

    await telegram.send_message(cfg.tg_admin_chat_id, "🟢 Auto-Picks v2 arrancado y en marcha.")

    await asyncio.gather(
        run_health_server(cfg),
        poll_loop(telegram, pool, lambda chat_id, text, msg_id: handle_message(ctx, chat_id, text, msg_id)),
    )


if __name__ == "__main__":
    asyncio.run(main())
