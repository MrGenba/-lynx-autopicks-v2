"""Invoca vendor/run_quant.js y vendor/run_odds_scraper.js como subprocesos -- ni los
quant_engine*.js ni el scraper de cuotas se tocan/reimplementan, se llaman tal cual estan
vendorizados."""
import asyncio
import json
import logging
import os
import signal
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


class NodeBridgeError(Exception):
    pass


def _kill_process_tree(proc: asyncio.subprocess.Process) -> None:
    """2026-07-19: diagnosticado en vivo -- pedir Winamax para MLB (sin cobertura en la mayoria
    de partidos, perfora mucho antes de rendirse) agoto el timeout de run_odds_scraper() y dejo
    el endpoint /scrape-odds/status devolviendo 502 varios minutos (mientras /healthz seguia
    respondiendo 200 todo el rato -- no era el contenedor entero caido). proc.kill() solo mata
    el proceso Node inmediato; el Chromium que Playwright lanza por debajo queda huerfano
    (Node nunca llega a ejecutar su propio cleanup/shutdown() porque SIGKILL no da margen para
    manejadores) y sigue consumiendo CPU/memoria, saturando el event loop del contenedor
    compartido. Con start_new_session=True (ver create_subprocess_exec mas abajo) todo el
    arbol de procesos del subproceso queda en su propio grupo -- se puede matar entero de una
    vez con os.killpg en vez de solo el proceso Node."""
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except ProcessLookupError:
        pass  # ya no existe (raro pero no es un fallo real)
    except Exception:
        logger.exception("no se pudo matar el grupo de procesos de pid=%s, fallback a proc.kill()", proc.pid)
        proc.kill()


async def run_quant(node_bin: str, vendor_dir: str, league: str, payload: dict, timeout: float = 15.0) -> dict:
    script = str(Path(vendor_dir) / "run_quant.js")
    proc = await asyncio.create_subprocess_exec(
        node_bin, script, league,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        start_new_session=True,
    )
    try:
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(json.dumps(payload).encode("utf-8")), timeout=timeout
        )
    except asyncio.TimeoutError:
        _kill_process_tree(proc)
        raise NodeBridgeError(f"run_quant.js ({league}) supero el timeout de {timeout}s")

    if proc.returncode != 0:
        err = stderr.decode("utf-8", errors="replace") or f"exit code {proc.returncode}"
        raise NodeBridgeError(err)

    try:
        return json.loads(stdout.decode("utf-8"))
    except json.JSONDecodeError as e:
        raise NodeBridgeError(f"salida de run_quant.js no es JSON valido: {e}")


async def run_odds_scraper(
    node_bin: str,
    vendor_dir: str,
    league: str,
    proxy_server: Optional[str] = None,
    proxy_username: Optional[str] = None,
    proxy_password: Optional[str] = None,
    candidate_names: Optional[list[str]] = None,
    bookmaker: str = "Bet365",
    timeout: float = 480.0,
) -> dict:
    """Scrapear una liga entera puede tardar varios minutos (varios partidos, cada uno con 2-3
    clics dentro de la pagina) -- mas aun pasando por Tor (mas lento que un proxy residencial de
    pago; probado en vivo 2026-07-10: con 8 partidos de MLB pendientes a la vez, 300s no
    bastaban aunque el filtro de candidate_names ya reduce cuanto se visita). candidate_names
    filtra que partidos se "perforan" (Totales/Handicap, lo caro) -- sin esto el scraper perfora
    TODOS los partidos de la liga, no solo los que hacen falta. El proxy (si se pasa) va por
    variables de entorno del subproceso, nunca como argv (no queda en logs de proceso)."""
    script = str(Path(vendor_dir) / "run_odds_scraper.js")
    env = dict(os.environ)
    if proxy_server:
        env["PROXY_SERVER"] = proxy_server
        if proxy_username:
            env["PROXY_USERNAME"] = proxy_username
        if proxy_password:
            env["PROXY_PASSWORD"] = proxy_password
    proc = await asyncio.create_subprocess_exec(
        node_bin, script, league,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env,
        start_new_session=True,
    )
    stdin_payload = json.dumps({"candidateNames": candidate_names or [], "bookmaker": bookmaker}).encode("utf-8")
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(stdin_payload), timeout=timeout)
    except asyncio.TimeoutError:
        _kill_process_tree(proc)
        raise NodeBridgeError(f"run_odds_scraper.js ({league}) supero el timeout de {timeout}s")

    if proc.returncode != 0:
        err = stderr.decode("utf-8", errors="replace") or f"exit code {proc.returncode}"
        raise NodeBridgeError(err)

    try:
        return json.loads(stdout.decode("utf-8"))
    except json.JSONDecodeError as e:
        raise NodeBridgeError(f"salida de run_odds_scraper.js no es JSON valido: {e}")
