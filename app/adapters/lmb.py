"""Adaptador LMB (sport_id=23) -- porta "Buscar Matchup LMB": vista pre-construida
vw_lmb_matchups_ready (igual de simple que MLB), mas una consulta de clima separada
(lmb_game_weather) y un fallback de ERA via MLB Stats API (yearByYear) cuando la vista
no tiene away_p_era/home_p_era para el abridor (comun en LMB, cobertura de stats mas floja).
"""
import datetime as dt
import logging
from typing import Optional

import httpx

from app.adapters import Mode
from app.mlb_stats_client import fetch_with_fallback
from app.supabase_client import SupabaseClient

logger = logging.getLogger(__name__)

REQUIRED_FIELDS = ("away_p_era", "home_p_era")
STATS_API = "https://statsapi.mlb.com/api/v1"


def _valid_era(v) -> Optional[float]:
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    return n if 0 < n < 30 else None


def _parse_ip(raw) -> Optional[float]:
    if raw is None or raw == "":
        return None
    s = str(raw).strip()
    if "." not in s:
        try:
            return float(s)
        except ValueError:
            return None
    whole_s, _, dec = s.partition(".")
    try:
        whole = float(whole_s)
    except ValueError:
        return None
    if dec == "1":
        return whole + 1 / 3
    if dec == "2":
        return whole + 2 / 3
    try:
        return float(s)
    except ValueError:
        return whole


def _pick_era_from_splits(splits: list[dict], min_season: int) -> Optional[dict]:
    rows = sorted(splits, key=lambda s: -(s.get("season") and int(s["season"]) or 0))
    season_now = dt.datetime.utcnow().year
    for s in rows:
        era = _valid_era((s.get("stat") or {}).get("era"))
        if era is None:
            continue
        season = int(s.get("season") or 0)
        if season < min_season:
            continue
        ip = _parse_ip((s.get("stat") or {}).get("inningsPitched"))
        min_ip = 0.5 if season == season_now else 3
        if ip is not None and ip < min_ip:
            continue
        return {"era": era, "ip": round(ip, 2) if ip is not None else None, "season": season}
    return None


class LmbAdapter:
    def __init__(self, supabase: SupabaseClient, http_client: httpx.AsyncClient):
        self.supabase = supabase
        self.http_client = http_client

    async def _era_fallback(self, player_id: Optional[int]) -> Optional[dict]:
        if not player_id:
            return None
        season_now = dt.datetime.utcnow().year
        try:
            data = await fetch_with_fallback(
                self.http_client, f"{STATS_API}/people/{player_id}/stats?stats=yearByYear&group=pitching&sportId=23"
            )
            splits = ((data.get("stats") or [{}])[0]).get("splits", [])
            pick = _pick_era_from_splits(splits, season_now - 6)
            if pick:
                return {**pick, "source": "statsapi_yearByYear_s23"}
        except Exception:
            logger.debug("fallback ERA LMB (sportId=23) fallo para player_id=%s", player_id)

        try:
            data = await fetch_with_fallback(
                self.http_client, f"{STATS_API}/people/{player_id}/stats?stats=yearByYear&group=pitching"
            )
            splits = ((data.get("stats") or [{}])[0]).get("splits", [])
            pick = _pick_era_from_splits(splits, season_now - 6)
            if pick:
                return {**pick, "source": "statsapi_yearByYear_global"}
        except Exception:
            logger.debug("fallback ERA global fallo para player_id=%s", player_id)
        return None

    async def _weather(self, game_pk: int) -> dict:
        rows = await self.supabase.select(
            self.http_client, "lmb_game_weather",
            {"game_pk": f"eq.{game_pk}", "select": "temperature_2m,wind_speed_10m,wind_direction,wind_tailwind"},
        )
        return rows[0] if rows else {}

    async def build_game_object(
        self,
        game_pk: int,
        mode: Mode,
        away_pitcher_id: Optional[int] = None,
        home_pitcher_id: Optional[int] = None,
    ) -> Optional[dict]:
        base = await self.supabase.select_one(
            self.http_client, "vw_lmb_matchups_ready", {"game_pk": f"eq.{game_pk}", "select": "*"}
        )
        if base is None:
            logger.warning("vw_lmb_matchups_ready sin fila para game_pk=%s", game_pk)
            return None

        # Fallback: si la vista aun no tiene el pitcher_id de un lado, usar el que el
        # detector ya confirmo en vivo (games_gate_state) para poder buscar su ERA igual.
        resolved_away_pid = base.get("away_pitcher_id") or away_pitcher_id
        resolved_home_pid = base.get("home_pitcher_id") or home_pitcher_id

        game = dict(base)
        game["away_pitcher_id"] = resolved_away_pid
        game["home_pitcher_id"] = resolved_home_pid
        wx = await self._weather(game_pk)
        game["temperature_2m"] = base.get("temperature_2m") or wx.get("temperature_2m")
        game["wind_speed_10m"] = base.get("wind_speed_10m") or wx.get("wind_speed_10m")
        game["wind_tailwind"] = base.get("wind_tailwind") or wx.get("wind_tailwind")

        if game.get("away_p_era") is None:
            fb = await self._era_fallback(resolved_away_pid)
            if fb:
                game["away_p_era"] = fb["era"]
                game["away_p_ip_season"] = game.get("away_p_ip_season") or fb["ip"]
        if game.get("home_p_era") is None:
            fb = await self._era_fallback(resolved_home_pid)
            if fb:
                game["home_p_era"] = fb["era"]
                game["home_p_ip_season"] = game.get("home_p_ip_season") or fb["ip"]

        if mode == "full_lineup":
            lineup_row = await self.supabase.select_one(
                self.http_client, "lineup_watch",
                {"game_pk": f"eq.{game_pk}", "select": "lineup_factor_away,lineup_factor_home,lineup_woba_away,lineup_woba_home"},
            )
            if lineup_row:
                game.update(lineup_row)

        if any(game.get(f) is None for f in REQUIRED_FIELDS):
            logger.info("game_pk=%s sin ERA de abridores todavia (ni con fallback), se omite", game_pk)
            return None
        return game
