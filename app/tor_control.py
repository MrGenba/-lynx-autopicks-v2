"""Rotacion del circuito de Tor via ControlPort (SIGNAL NEWNYM).

El entrypoint (docker-entrypoint.sh) arranca Tor con ControlPort 9051 +
CookieAuthentication (cookie binaria en /tmp/tor.cookie). Aqui se fuerza un exit
distinto tras un scrape fallido: cuotasahora bloquea/throttlea algunos exits de Tor,
asi que rotando el circuito se cicla hasta dar con uno que no este bloqueado (el
usuario confirma que Tor SI funciona con exits buenos). No usa 'stem' para no anadir
dependencia -- habla el protocolo de control por socket directamente (auth por cookie
en hex, que Tor acepta con CookieAuthentication 1).
"""
import asyncio
import logging

logger = logging.getLogger(__name__)

_COOKIE_PATH = "/tmp/tor.cookie"
_CONTROL_HOST = "127.0.0.1"
_CONTROL_PORT = 9051


async def rotate_tor_circuit() -> bool:
    """Envia SIGNAL NEWNYM a Tor. Devuelve True si Tor confirmo (250 OK). Nunca lanza."""
    writer = None
    try:
        with open(_COOKIE_PATH, "rb") as f:
            cookie_hex = f.read().hex()
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(_CONTROL_HOST, _CONTROL_PORT), timeout=5,
        )
        writer.write(f"AUTHENTICATE {cookie_hex}\r\n".encode())
        await writer.drain()
        auth = await asyncio.wait_for(reader.readline(), timeout=5)
        if not auth.startswith(b"250"):
            logger.warning("tor NEWNYM: auth rechazada: %s", auth[:80])
            return False
        writer.write(b"SIGNAL NEWNYM\r\n")
        await writer.drain()
        resp = await asyncio.wait_for(reader.readline(), timeout=5)
        if resp.startswith(b"250"):
            logger.info("tor NEWNYM: circuito rotado (nuevo exit para conexiones nuevas)")
            return True
        logger.warning("tor NEWNYM: signal rechazada: %s", resp[:80])
        return False
    except Exception as e:
        logger.warning("tor NEWNYM: no se pudo rotar el circuito: %s", e)
        return False
    finally:
        if writer is not None:
            try:
                writer.close()
            except Exception:
                pass
