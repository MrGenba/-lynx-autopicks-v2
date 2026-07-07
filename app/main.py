"""Punto de entrada: arranca el pool de Postgres, aplica migraciones, siembra alias (si hace
falta), y lanza en paralelo el detector (APScheduler, cada N segundos), el long-poll de
Telegram, y un servidor aiohttp minimo solo para el health check de EasyPanel."""
import asyncio
import logging

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
from app.pipelines import PipelineContext
from app.supabase_client import SupabaseClient
from app.telegram import TelegramClient, poll_loop

logger = logging.getLogger(__name__)


async def health(_request: web.Request) -> web.Response:
    return web.json_response({"ok": True})


async def run_health_server(port: int = 8080) -> None:
    app = web.Application()
    app.router.add_get("/healthz", health)
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
    )

    scheduler = AsyncIOScheduler()
    scheduler.add_job(detector_tick, "interval", seconds=cfg.detector_interval_seconds, args=[ctx], max_instances=1)
    scheduler.start()

    await telegram.send_message(cfg.tg_admin_chat_id, "🟢 Auto-Picks v2 arrancado y en marcha.")

    await asyncio.gather(
        run_health_server(),
        poll_loop(telegram, pool, lambda chat_id, text, msg_id: handle_message(ctx, chat_id, text, msg_id)),
    )


if __name__ == "__main__":
    asyncio.run(main())
