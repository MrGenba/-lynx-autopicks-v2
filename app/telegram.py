"""Telegram por polling directo (getUpdates + sendMessage), sin libreria de bot -- mismo
estilo que el resto del proyecto (helpers.httpRequest en n8n). Bot NUEVO, separado del
@Lynx_HunterBot que usa webhook (un mismo token no puede tener las dos cosas a la vez)."""
import asyncio
import logging
from typing import Optional

import asyncpg
import httpx

logger = logging.getLogger(__name__)


class TelegramClient:
    def __init__(self, bot_token: str, http_client: httpx.AsyncClient):
        self.base_url = f"https://api.telegram.org/bot{bot_token}"
        self.http_client = http_client

    async def send_message(self, chat_id: int, text: str, parse_mode: Optional[str] = None) -> None:
        # Telegram limita a 4096 caracteres -- trocear si hace falta (mismo margen de 3800
        # ya usado en otras integraciones de Telegram de este proyecto).
        for i in range(0, len(text), 3800):
            chunk = text[i:i + 3800]
            payload = {"chat_id": chat_id, "text": chunk}
            if parse_mode:
                payload["parse_mode"] = parse_mode
            resp = await self.http_client.post(
                f"{self.base_url}/sendMessage", json=payload, timeout=10.0
            )
            if resp.status_code >= 400:
                logger.warning("sendMessage fallo (%s): %s", resp.status_code, resp.text[:300])

    async def get_updates(self, offset: Optional[int], timeout: int = 25) -> list[dict]:
        params = {"timeout": timeout}
        if offset is not None:
            params["offset"] = offset
        resp = await self.http_client.get(f"{self.base_url}/getUpdates", params=params, timeout=timeout + 10)
        resp.raise_for_status()
        return resp.json().get("result", [])


async def get_offset(pool: asyncpg.Pool) -> Optional[int]:
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT value FROM telegram_state WHERE key = 'update_offset'")
    return int(row["value"]) if row else None


async def set_offset(pool: asyncpg.Pool, offset: int) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO telegram_state (key, value) VALUES ('update_offset', $1) "
            "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
            str(offset),
        )


MESSAGE_TIMEOUT_SECONDS = 900.0  # ver comentario en poll_loop -- subido junto con el timeout
# del scraper (480s) para que /fetchodds nunca choque con este limite en uso normal


async def poll_loop(client: TelegramClient, pool: asyncpg.Pool, on_message):
    """Long-poll infinito. `on_message(chat_id, text, message_id)` procesa cada mensaje;
    el offset solo avanza tras procesar (con exito O con timeout), asi un reinicio a mitad de
    un update no lo pierde -- pero un comando que se cuelga tampoco bloquea el resto para
    siempre. Sin este limite, un solo comando lento (ej. /fetchodds si scrapear una liga se
    alarga) bloqueaba TODOS los mensajes siguientes indefinidamente, y encima se repetia en
    cada reinicio del contenedor porque el offset nunca llegaba a avanzar (bug real encontrado
    en vivo 2026-07-09: /status dejo de responder durante varios reinicios seguidos)."""
    offset = await get_offset(pool)
    while True:
        try:
            updates = await client.get_updates(offset)
        except Exception as e:
            logger.warning("getUpdates fallo, reintentando: %s", e)
            continue
        for update in updates:
            offset = update["update_id"] + 1
            message = update.get("message")
            if not message or "text" not in message:
                await set_offset(pool, offset)
                continue
            try:
                await asyncio.wait_for(
                    on_message(message["chat"]["id"], message["text"], message["message_id"]),
                    timeout=MESSAGE_TIMEOUT_SECONDS,
                )
            except asyncio.TimeoutError:
                logger.error("mensaje (update_id=%s) supero %ss, se descarta para no bloquear el resto", update["update_id"], MESSAGE_TIMEOUT_SECONDS)
            except Exception:
                logger.exception("error procesando mensaje de Telegram (update_id=%s)", update["update_id"])
            await set_offset(pool, offset)
