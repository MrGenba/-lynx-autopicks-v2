"""Rotacion del circuito de Tor via ControlPort (SIGNAL NEWNYM).

El entrypoint arranca Tor con ControlPort 9051 + CookieAuthentication (cookie binaria
en /tmp/tor.cookie). Se fuerza un exit distinto SOLO tras un scrape fallido: cuotasahora
sirve una pagina "decoy" (indice sin enlaces de partido) a algunos circuitos de Tor, asi
que rotando el circuito se cicla hasta uno que devuelva la pagina real.

IMPORTANTE (leccion 2026-08-02): NO se baja MaxCircuitDirtiness -> el circuito se mantiene
ESTABLE durante cada scrape (rotarlo a mitad rompe la sesion del navegador y todo el scrape
falla). Solo se rota AQUI, entre reintentos, cuando un scrape ya termino fallando.
"""
import asyncio
import logging

logger = logging.getLogger(__name__)

_COOKIE_PATH = "/tmp/tor.cookie"
_CONTROL_HOST = "127.0.0.1"
_CONTROL_PORT = 9051


async def rotate_tor_circuit() -> tuple[bool, str]:
    """Envia SIGNAL NEWNYM a Tor. Devuelve (ok, detalle). Nunca lanza."""
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
            return False, f"auth rechazada: {auth[:80]!r}"
        writer.write(b"SIGNAL NEWNYM\r\n")
        await writer.drain()
        resp = await asyncio.wait_for(reader.readline(), timeout=5)
        if resp.startswith(b"250"):
            logger.info("tor NEWNYM: circuito rotado")
            return True, "ok"
        return False, f"signal rechazada: {resp[:80]!r}"
    except Exception as e:
        return False, f"error: {e}"
    finally:
        if writer is not None:
            try:
                writer.close()
            except Exception:
                pass
