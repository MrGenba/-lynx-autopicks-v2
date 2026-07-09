"""Cliente de statsapi.mlb.com -- puerta A/B del detector. Porta exactamente el patron ya
probado en lineup_watcher_poll_pitchers.js / lineup_watcher_poll.js de este mismo proyecto,
incluido el fallback a r.jina.ai cuando la API bloquea la IP de la VPS (406)."""
import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

STATS_API = "https://statsapi.mlb.com/api/v1"

# sportId -> (leagueId opcional). LMB necesita leagueId=125 ademas del sportId.
LEAGUE_SPORT = {
    "MLB": {"sport_id": 1, "league_id": None},
    "MiLB": {"sport_id": 11, "league_id": None},
    "LMB": {"sport_id": 23, "league_id": 125},
}


async def fetch_with_fallback(client: httpx.AsyncClient, url: str) -> dict:
    try:
        resp = await client.get(url, headers={"Accept": "application/json"}, timeout=10.0)
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        logger.warning("fetch directo fallo (%s), probando fallback Jina.ai: %s", url, e)
        return await _fetch_jina(client, url)


async def _fetch_jina(client: httpx.AsyncClient, url: str, retries: int = 1) -> dict:
    # r.jina.ai (servicio gratuito) devuelve 429 bajo carga -- encontrado en vivo 2026-07-09
    # (detector_tick usaba esto para CADA partido activo en CADA tick de 180s para siempre,
    # ver el fix en detector.py que ya reduce el volumen; este reintento es solo la red de
    # seguridad adicional para picos puntuales, no el arreglo principal).
    for attempt in range(retries + 1):
        jina_resp = await client.get(
            f"https://r.jina.ai/{url}",
            headers={"Accept": "text/plain", "X-Return-Format": "text"},
            timeout=15.0,
        )
        if jina_resp.status_code == 429 and attempt < retries:
            await asyncio.sleep(3.0)
            continue
        jina_resp.raise_for_status()
        body = jina_resp.text
        return json.loads(body) if isinstance(body, str) else body


@dataclass
class ScheduledGame:
    game_pk: int
    status: str
    game_datetime_utc: str
    away_team_id: int
    home_team_id: int
    away_team_name: str
    home_team_name: str
    away_pitcher_id: Optional[int] = None
    away_pitcher_name: Optional[str] = None
    home_pitcher_id: Optional[int] = None
    home_pitcher_name: Optional[str] = None
    game_number: Optional[int] = None


async def get_schedule(client: httpx.AsyncClient, sport_id: int, date_str: str, league_id: Optional[int] = None) -> list[ScheduledGame]:
    url = f"{STATS_API}/schedule?sportId={sport_id}&date={date_str}&hydrate=probablePitcher"
    if league_id:
        url += f"&leagueId={league_id}"
    data = await fetch_with_fallback(client, url)
    games = []
    for day in data.get("dates", []):
        for g in day.get("games", []):
            away, home = g.get("teams", {}).get("away", {}), g.get("teams", {}).get("home", {})
            away_p, home_p = away.get("probablePitcher"), home.get("probablePitcher")
            games.append(ScheduledGame(
                game_pk=g["gamePk"],
                status=(g.get("status") or {}).get("detailedState", ""),
                game_datetime_utc=g.get("gameDate", ""),
                away_team_id=away.get("team", {}).get("id"),
                home_team_id=home.get("team", {}).get("id"),
                away_team_name=away.get("team", {}).get("name", ""),
                home_team_name=home.get("team", {}).get("name", ""),
                away_pitcher_id=away_p.get("id") if away_p else None,
                away_pitcher_name=away_p.get("fullName") if away_p else None,
                home_pitcher_id=home_p.get("id") if home_p else None,
                home_pitcher_name=home_p.get("fullName") if home_p else None,
                game_number=g.get("gameNumber"),
            ))
    return games


@dataclass
class LineupInfo:
    published: bool
    batting_order: Optional[list[int]] = None
    pitcher_id: Optional[int] = None


async def get_lineup(client: httpx.AsyncClient, game_pk: int, side: str) -> LineupInfo:
    """Gate B: True si battingOrder tiene >=9 jugadores. Identico a getLineup() de
    lineup_watcher_poll.js."""
    url = f"{STATS_API}/game/{game_pk}/boxscore"
    data = await fetch_with_fallback(client, url)
    team = (data.get("teams") or {}).get(side)
    if not team:
        return LineupInfo(published=False)
    order = team.get("battingOrder") or []
    if len(order) < 9:
        return LineupInfo(published=False)
    pitchers = team.get("pitchers") or []
    return LineupInfo(published=True, batting_order=order[:9], pitcher_id=pitchers[0] if pitchers else None)
