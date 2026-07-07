"""Adaptador MiLB AAA (sport_id=11) -- a diferencia de MLB no hay una vista unica que lo
resuelva todo; se portan las mismas consultas paralelas y el mismo calculo de wind_tailwind
que hace "Buscar Matchup MiLB" en n8n (buscar_Buscar_Matchup_MiLB_live.js), pero consultando
solo los 2 equipos/partido concretos en vez de cargar la liga entera (ahi el nodo procesaba
varios partidos por ejecucion; aqui se llama uno a la vez).
"""
import asyncio
import datetime as dt
import logging
import math
from typing import Optional

import httpx

from app.adapters import Mode
from app.supabase_client import SupabaseClient

logger = logging.getLogger(__name__)

REQUIRED_FIELDS = ("away_p_era_season", "home_p_era_season")


class MilbAdapter:
    def __init__(self, supabase: SupabaseClient, http_client: httpx.AsyncClient):
        self.supabase = supabase
        self.http_client = http_client

    async def _team_rpg(self, team_id: int, season: int) -> tuple[Optional[float], Optional[int]]:
        as_away, as_home = await asyncio.gather(
            self.supabase.select(
                self.http_client, "daily_games",
                {"away_team_id": f"eq.{team_id}", "game_date": f"gte.{season}-01-01",
                 "away_score": "not.is.null", "select": "away_score"},
            ),
            self.supabase.select(
                self.http_client, "daily_games",
                {"home_team_id": f"eq.{team_id}", "game_date": f"gte.{season}-01-01",
                 "home_score": "not.is.null", "select": "home_score"},
            ),
        )
        scores = [r["away_score"] for r in as_away] + [r["home_score"] for r in as_home]
        if not scores:
            return None, 0
        return round(sum(scores) / len(scores), 2), len(scores)

    async def _pitcher_stats(self, player_id: Optional[int]) -> dict:
        if not player_id:
            return {}
        rows = await self.supabase.select(
            self.http_client, "player_stats",
            {"player_id": f"eq.{player_id}", "order": "season.desc", "limit": "1",
             "select": "era,fip,k_9,bb_9,innings_pitched,xwoba,whip,season"},
        )
        return rows[0] if rows else {}

    async def _pitcher_statcast(self, player_id: Optional[int]) -> dict:
        if not player_id:
            return {}
        rows = await self.supabase.select(
            self.http_client, "player_statcast_pitchers",
            {"player_id": f"eq.{player_id}", "order": "season.desc", "limit": "1",
             "select": "season,xwoba,k_percent,bb_percent,hard_hit_pct,barrel_pct"},
        )
        return rows[0] if rows else {}

    async def _team_batting(self, team_id: Optional[int], season: int) -> dict:
        if not team_id:
            return {}
        rows = await self.supabase.select(
            self.http_client, "vw_team_batting",
            {"team_id": f"eq.{team_id}", "season": f"eq.{season}",
             "select": "num_batters,xwoba,woba,hard_hit_pct,barrel_pct,avg_exit_velo"},
        )
        return rows[0] if rows else {}

    async def _team_bullpen(self, team_id: Optional[int], season: int) -> dict:
        if not team_id:
            return {}
        rows = await self.supabase.select(
            self.http_client, "vw_team_bullpen",
            {"team_id": f"eq.{team_id}", "season": f"eq.{season}",
             "select": "num_pitchers,era,fip,k9,bb9,xwoba_allowed"},
        )
        return rows[0] if rows else {}

    async def _park_factor(self, venue_id: Optional[int]) -> dict:
        if not venue_id:
            return {}
        rows = await self.supabase.select(
            self.http_client, "park_factors",
            {"venue_id": f"eq.{venue_id}", "select": "park_factor_runs,park_factor_hr,altitude_m,stadium_name"},
        )
        return rows[0] if rows else {}

    async def _weather(self, game_id: int) -> dict:
        rows = await self.supabase.select(
            self.http_client, "game_weather",
            {"game_id": f"eq.{game_id}", "select": "temperature_2m,wind_speed_10m,wind_direction_10m", "limit": "1"},
        )
        if not rows:
            return {}
        r = rows[0]
        if r.get("wind_speed_10m") is not None and r.get("wind_direction_10m") is not None:
            r["wind_tailwind"] = round(r["wind_speed_10m"] * math.cos(math.radians(r["wind_direction_10m"])), 1)
        else:
            r["wind_tailwind"] = None
        return r

    async def build_game_object(self, game_pk: int, mode: Mode) -> Optional[dict]:
        base = await self.supabase.select_one(
            self.http_client, "vw_matchups_enriched", {"game_id": f"eq.{game_pk}", "select": "*"}
        )
        if base is None:
            logger.warning("vw_matchups_enriched sin fila para game_id=%s", game_pk)
            return None

        season = dt.datetime.utcnow().year
        (
            ap, hp, apsc, hpsc, away_batt, home_batt, away_bull, home_bull,
            away_rpg, home_rpg, park, weather,
        ) = await asyncio.gather(
            self._pitcher_stats(base.get("away_pitcher_id")),
            self._pitcher_stats(base.get("home_pitcher_id")),
            self._pitcher_statcast(base.get("away_pitcher_id")),
            self._pitcher_statcast(base.get("home_pitcher_id")),
            self._team_batting(base.get("away_team_id"), season),
            self._team_batting(base.get("home_team_id"), season),
            self._team_bullpen(base.get("away_team_id"), season),
            self._team_bullpen(base.get("home_team_id"), season),
            self._team_rpg(base.get("away_team_id"), season),
            self._team_rpg(base.get("home_team_id"), season),
            self._park_factor(base.get("venue_id")),
            self._weather(game_pk),
        )

        lineup = {}
        if mode == "full_lineup":
            lineup_row = await self.supabase.select_one(
                self.http_client, "lineup_watch",
                {"game_pk": f"eq.{game_pk}", "select": "lineup_factor_away,lineup_factor_home,lineup_woba_away,lineup_woba_home"},
            )
            lineup = lineup_row or {}

        game = {
            **base,
            "sport_id": 11,
            "lineup_factor_away": lineup.get("lineup_factor_away"),
            "lineup_factor_home": lineup.get("lineup_factor_home"),
            "lineup_woba_away": lineup.get("lineup_woba_away"),
            "lineup_woba_home": lineup.get("lineup_woba_home"),
            "away_p_era_season": ap.get("era"), "away_p_fip_season": ap.get("fip"),
            "away_p_ip_season": ap.get("innings_pitched"), "away_p_k_9": ap.get("k_9"), "away_p_bb_9": ap.get("bb_9"),
            "away_p_xwoba": ap.get("xwoba"),
            "home_p_era_season": hp.get("era"), "home_p_fip_season": hp.get("fip"),
            "home_p_ip_season": hp.get("innings_pitched"), "home_p_k_9": hp.get("k_9"), "home_p_bb_9": hp.get("bb_9"),
            "home_p_xwoba": hp.get("xwoba"),
            "away_p_k_pct": apsc.get("k_percent"), "away_p_bb_pct": apsc.get("bb_percent"),
            "away_p_hard_hit": apsc.get("hard_hit_pct"), "away_p_barrel": apsc.get("barrel_pct"),
            "home_p_k_pct": hpsc.get("k_percent"), "home_p_bb_pct": hpsc.get("bb_percent"),
            "home_p_hard_hit": hpsc.get("hard_hit_pct"), "home_p_barrel": hpsc.get("barrel_pct"),
            "away_team_xwoba": away_batt.get("xwoba"), "away_team_woba": away_batt.get("woba"),
            "away_team_hard_hit": away_batt.get("hard_hit_pct"), "away_team_barrel": away_batt.get("barrel_pct"),
            "away_team_exit_velo": away_batt.get("avg_exit_velo"),
            "home_team_xwoba": home_batt.get("xwoba"), "home_team_woba": home_batt.get("woba"),
            "home_team_hard_hit": home_batt.get("hard_hit_pct"), "home_team_barrel": home_batt.get("barrel_pct"),
            "home_team_exit_velo": home_batt.get("avg_exit_velo"),
            "away_team_rpg_season": away_rpg[0], "away_team_games_played": away_rpg[1],
            "home_team_rpg_season": home_rpg[0], "home_team_games_played": home_rpg[1],
            "away_bullpen_era": away_bull.get("era"), "away_bullpen_fip": away_bull.get("fip"),
            "away_bullpen_xwoba": away_bull.get("xwoba_allowed"),
            "home_bullpen_era": home_bull.get("era"), "home_bullpen_fip": home_bull.get("fip"),
            "home_bullpen_xwoba": home_bull.get("xwoba_allowed"),
            "park_factor_runs": park.get("park_factor_runs"), "park_factor_hr": park.get("park_factor_hr"),
            "altitude_m": park.get("altitude_m"),
            "temperature_2m": weather.get("temperature_2m") or base.get("temperature_2m"),
            "wind_speed_10m": weather.get("wind_speed_10m") or base.get("wind_speed_10m"),
            "wind_tailwind": weather.get("wind_tailwind") or base.get("wind_tailwind"),
        }

        if any(game.get(f) is None for f in REQUIRED_FIELDS):
            logger.info("game_id=%s sin ERA de abridores todavia, se omite", game_pk)
            return None
        return game
