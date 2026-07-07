"""Invoca vendor/run_quant.js como subproceso -- los quant_engine*.js no se tocan ni se
reimplementan, se llaman tal cual estan vendorizados."""
import asyncio
import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)


class NodeBridgeError(Exception):
    pass


async def run_quant(node_bin: str, vendor_dir: str, league: str, payload: dict, timeout: float = 15.0) -> dict:
    script = str(Path(vendor_dir) / "run_quant.js")
    proc = await asyncio.create_subprocess_exec(
        node_bin, script, league,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(json.dumps(payload).encode("utf-8")), timeout=timeout
        )
    except asyncio.TimeoutError:
        proc.kill()
        raise NodeBridgeError(f"run_quant.js ({league}) supero el timeout de {timeout}s")

    if proc.returncode != 0:
        err = stderr.decode("utf-8", errors="replace") or f"exit code {proc.returncode}"
        raise NodeBridgeError(err)

    try:
        return json.loads(stdout.decode("utf-8"))
    except json.JSONDecodeError as e:
        raise NodeBridgeError(f"salida de run_quant.js no es JSON valido: {e}")
