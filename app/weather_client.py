"""Clima en vivo via open-meteo (gratis, sin API key). Se coge la hora del forecast mas cercana
a la hora REAL del primer lanzamiento (game_datetime_utc) cuando el llamador la pasa; si no se
conoce, se cae a la aproximacion historica de las 20:00 UTC del dia del partido (el metodo que
usaba produccion, ver build_sync_workflows.js:fetchWeatherOpenMeteo). 2026-08-04: pasar la hora
real del partido para que el clima corresponda al momento en que se juega, no a un punto fijo.

2026-07-21: decision del usuario -- cuando se confirma el lineup completo (pipeline
"full_lineup"), volver a consultar el clima real en ese momento en vez de conformarse con el
snapshot que ya trajo la vista/tabla de Supabase (que puede llevar horas de retraso segun
cuando corrio el ultimo sync). Solo lectura de `stadiums` (lat/lon) via SupabaseClient -- sin
escribir nada en Supabase, respeta la politica ya existente de solo-lectura salvo
*_candidates_history (ver supabase_client.py)."""
import datetime as dt
import logging
import math
from typing import Optional

import httpx

from app.supabase_client import SupabaseClient

logger = logging.getLogger(__name__)

OPEN_METEO_BASE = "https://api.open-meteo.com/v1/forecast"


def _parse_iso_utc(raw: str) -> Optional[dt.datetime]:
    try:
        s = raw.replace("Z", "+00:00")
        if "+" not in s:
            s += "+00:00"
        return dt.datetime.fromisoformat(s)
    except ValueError:
        return None


async def fetch_fresh_weather(
    http_client: httpx.AsyncClient,
    supabase: SupabaseClient,
    venue_id: Optional[int],
    game_date: Optional[str],
    game_datetime_utc: Optional[object] = None,
) -> Optional[dict]:
    """None si falta venue_id/game_date, si el estadio no tiene lat/lon conocidas (stadiums.lat
    IS NULL para varios recintos menores, ver tabla real), o si open-meteo falla -- el llamador
    debe conservar el clima que ya tenia (snapshot previo) en ese caso, no borrarlo."""
    if not venue_id or not game_date:
        return None

    try:
        stadium = await supabase.select_one(
            http_client, "stadiums", {"venue_id": f"eq.{venue_id}", "select": "lat,lon"}
        )
    except Exception:
        logger.exception("fetch_fresh_weather: fallo consultando stadiums para venue_id=%s", venue_id)
        return None
    if not stadium or stadium.get("lat") is None or stadium.get("lon") is None:
        return None

    try:
        resp = await http_client.get(
            OPEN_METEO_BASE,
            params={
                "latitude": stadium["lat"],
                "longitude": stadium["lon"],
                "hourly": "temperature_2m,wind_speed_10m,wind_direction_10m",
                "timezone": "UTC",
                "forecast_days": 3,
            },
            timeout=15.0,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        logger.exception("fetch_fresh_weather: fallo consultando open-meteo para venue_id=%s", venue_id)
        return None

    hourly = data.get("hourly") or {}
    times = hourly.get("time") or []
    if not times:
        return None

    # target: la hora REAL del primer lanzamiento (game_datetime_utc, que el detector guarda en
    # games_gate_state) si el llamador la pasa -> el forecast se coge de la hora del partido de
    # verdad. Si no se conoce, se cae a la aproximacion historica de las 20:00 UTC del dia (compat
    # con produccion / calibracion previa). 2026-08-04, a peticion del usuario.
    target = None
    if game_datetime_utc is not None:
        target = game_datetime_utc if isinstance(game_datetime_utc, dt.datetime) else _parse_iso_utc(str(game_datetime_utc))
        if target is not None and target.tzinfo is None:
            target = target.replace(tzinfo=dt.timezone.utc)
    if target is None:
        game_date_str = str(game_date)[:10]
        target = dt.datetime.fromisoformat(f"{game_date_str}T20:00:00+00:00")
    best_idx, best_diff = None, None
    for i, t in enumerate(times):
        t_dt = _parse_iso_utc(t)
        if t_dt is None:
            continue
        diff = abs((t_dt - target).total_seconds())
        if best_diff is None or diff < best_diff:
            best_diff, best_idx = diff, i
    if best_idx is None:
        return None

    temps = hourly.get("temperature_2m") or []
    speeds = hourly.get("wind_speed_10m") or []
    dirs = hourly.get("wind_direction_10m") or []
    temp = temps[best_idx] if best_idx < len(temps) else None
    speed = speeds[best_idx] if best_idx < len(speeds) else None
    wdir = dirs[best_idx] if best_idx < len(dirs) else None

    tailwind = None
    if speed is not None and wdir is not None:
        tailwind = round(speed * math.cos(math.radians(wdir)), 2)

    return {
        "temperature_2m": round(temp, 2) if temp is not None else None,
        "wind_speed_10m": round(speed, 2) if speed is not None else None,
        "wind_direction": wdir,
        "wind_direction_10m": wdir,
        "wind_tailwind": tailwind,
    }
