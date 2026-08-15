"""Rotacion del circuito de Tor via ControlPort (SIGNAL NEWNYM) + observabilidad del scrapeo.

El entrypoint arranca Tor con ControlPort 9051 + CookieAuthentication (cookie binaria
en /tmp/tor.cookie). Se fuerza un exit distinto SOLO tras un scrape fallido: cuotasahora
sirve una pagina "decoy" (indice sin enlaces de partido) a algunos circuitos de Tor, asi
que rotando el circuito se cicla hasta uno que devuelva la pagina real.

IMPORTANTE (leccion 2026-08-02): NO se baja MaxCircuitDirtiness -> el circuito se mantiene
ESTABLE durante cada scrape (rotarlo a mitad rompe la sesion del navegador y todo el scrape
falla). Solo se rota AQUI, entre reintentos, cuando un scrape ya termino fallando -- o bajo
demanda desde Telegram ("cambio tor"), que espera al semaforo de scrape antes de rotar.

2026-08-14: ademas de rotar, este modulo sabe (a) mirar por que IP se esta saliendo ahora
mismo y si esa salida es de verdad la red Tor, y (b) dejar rastro persistente de cada scrape
y cada rotacion en la tabla tor_activity, que es lo que alimenta el dashboard /d/<token>.
"""
import asyncio
import logging
import time

import httpx

logger = logging.getLogger(__name__)

_COOKIE_PATH = "/tmp/tor.cookie"
_CONTROL_HOST = "127.0.0.1"
_CONTROL_PORT = 9051
DEFAULT_SOCKS = "socks5://127.0.0.1:9050"

# check.torproject.org/api/ip devuelve {"IsTor":true,"IP":"x.x.x.x"}. Se usa en vez de un
# "cual es mi IP" cualquiera porque responde ADEMAS si la peticion salio realmente por la red
# Tor -- que es justo lo que el dashboard tiene que mostrar como "el scrapeo esta online".
# Por HTTPS a proposito: un exit malicioso no puede falsear la respuesta.
_IP_CHECK_URL = "https://check.torproject.org/api/ip"


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


async def get_exit_ip(proxy: str | None = None, timeout: float = 12.0) -> dict:
    """Envoltorio con tope DURO. El timeout de httpx no basta: un SOCKS que ACEPTA la conexion y
    luego no responde (exactamente lo que hace una instancia de Tor sin circuitos utilizables, por
    ejemplo con ExitNodes demasiado restringido) puede colgarse indefinidamente durante el
    handshake, antes de que exista una peticion HTTP que cronometrar.

    Incidente real 2026-08-16: al anadir la comprobacion de la 2a instancia, el dashboard entero
    dejo de cargar -- una pagina de diagnostico que se cuelga por aquello que intenta diagnosticar
    es peor que no tenerla. Con este tope, la pagina siempre renderiza y el fallo se REPORTA."""
    try:
        return await asyncio.wait_for(_get_exit_ip(proxy, timeout), timeout=timeout + 3)
    except asyncio.TimeoutError:
        return {
            "ok": False, "ip": None, "is_tor": None,
            "detail": "sin respuesta (el proxy acepta la conexión pero no contesta: "
                      "probablemente Tor vivo pero sin circuitos utilizables)",
            "latency_ms": int((timeout + 3) * 1000),
        }
    except Exception as e:
        return {"ok": False, "ip": None, "is_tor": None,
                "detail": f"{type(e).__name__}: {e}"[:200], "latency_ms": 0}


async def _get_exit_ip(proxy: str | None = None, timeout: float = 12.0) -> dict:
    """IP de salida observada AHORA a traves del SOCKS de Tor. Nunca lanza.

    Matiz que conviene no olvidar al leer el dashboard: Tor elige circuito por destino, asi que
    esta es la IP del circuito que sirve a check.torproject.org en este instante. Con la config
    por defecto (MaxCircuitDirtiness=600s, sin aislamiento por SOCKS auth) suele ser el mismo
    circuito que usa el scraper, pero NO es una garantia dura -- vale como "por donde estoy
    saliendo", no como prueba de que cuotasahora ve exactamente esa IP.
    """
    started = time.monotonic()
    url = proxy or DEFAULT_SOCKS
    try:
        async with httpx.AsyncClient(proxy=url, timeout=timeout) as client:
            r = await client.get(_IP_CHECK_URL, headers={"User-Agent": "curl/8.5.0"})
            r.raise_for_status()
            data = r.json()
        return {
            "ok": True,
            "ip": data.get("IP"),
            "is_tor": bool(data.get("IsTor")),
            "detail": "",
            "latency_ms": int((time.monotonic() - started) * 1000),
        }
    except Exception as e:
        return {
            "ok": False,
            "ip": None,
            "is_tor": None,
            "detail": f"{type(e).__name__}: {e}"[:200],
            "latency_ms": int((time.monotonic() - started) * 1000),
        }


async def rotate_and_verify(proxy: str | None = None, max_wait_s: float = 15.0) -> dict:
    """Rota el circuito y comprueba por que IP se sale despues. Nunca lanza.

    Los margenes (12s por comprobacion de IP, 15s de sondeo) estan elegidos para que el peor caso
    total quede holgadamente por debajo de un minuto: esto se sirve por HTTP sincrono a traves de
    Traefik, que corta las conexiones largas (misma razon por la que /scrape-odds usa el patron
    arrancar+consultar en vez de responder de una vez).

    Que la IP NO cambie no es un fallo: NEWNYM solo afecta a circuitos NUEVOS, dos NEWNYM en
    menos de 10s los agrupa Tor en uno solo, y la red tiene relativamente pocos exits rapidos,
    asi que repetir exit por azar es normal. Por eso se devuelve `changed` como dato informativo
    y `rotated` (¿acepto Tor la señal?) como el resultado real de la operacion.
    """
    before = await get_exit_ip(proxy)
    ok, detail = await rotate_tor_circuit()
    if not ok:
        return {"rotated": False, "detail": detail, "before": before, "after": before, "changed": False}

    loop = asyncio.get_running_loop()
    deadline = loop.time() + max_wait_s
    after = before
    while True:
        await asyncio.sleep(3)
        after = await get_exit_ip(proxy)
        if after["ok"] and after["ip"] and after["ip"] != before.get("ip"):
            break
        if loop.time() >= deadline:
            break
    changed = bool(after.get("ip")) and after.get("ip") != before.get("ip")
    return {"rotated": True, "detail": detail, "before": before, "after": after, "changed": changed}


async def record_activity(
    pool,
    kind: str,
    *,
    ok: bool,
    sport_id: int | None = None,
    league: str | None = None,
    status: str | None = None,
    n_candidates: int | None = None,
    n_scraped: int | None = None,
    n_matched: int | None = None,
    duration_ms: int | None = None,
    exit_ip: str | None = None,
    detail: str | None = None,
    source: str | None = None,
) -> None:
    """Deja rastro en tor_activity. Nunca lanza: es telemetria, jamas debe tumbar un scrape
    ni una rotacion por un fallo de escritura. pool=None (tests) = no hay donde registrar."""
    if pool is None:
        return
    try:
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO tor_activity (kind, sport_id, league, ok, status, n_candidates,
                  n_scraped, n_matched, duration_ms, exit_ip, detail, source)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                """,
                kind, sport_id, league, ok, status, n_candidates, n_scraped, n_matched,
                duration_ms, exit_ip, (detail or "")[:500] or None, source,
            )
    except Exception:
        logger.exception("no se pudo registrar tor_activity (kind=%s) -- se ignora", kind)
