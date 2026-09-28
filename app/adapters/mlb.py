"""Adaptador MLB -- el mas simple de los 3: vw_mlb_matchups_ready ya hace todos los joins
pesados (stats de abridor, bullpen, ofensiva, park factors, clima, Statcast, SIERA) y ya
nombra las columnas como away_p_*/home_p_* etc., igual que consume "Motor MLB" en n8n.
"""
import logging
import math
from typing import Optional

import httpx

from app.adapters import Mode
from app.mlb_stats_client import STATS_API, fetch_with_fallback
from app.supabase_client import SupabaseClient
from app.weather_client import fetch_fresh_weather

logger = logging.getLogger(__name__)

REQUIRED_FIELDS = ("away_p_era", "home_p_era")  # sin esto el motor no tiene nada que analizar


class MlbAdapter:
    def __init__(self, supabase: SupabaseClient, http_client: httpx.AsyncClient):
        self.supabase = supabase
        self.http_client = http_client

    async def _pitcher_name(self, player_id: int) -> Optional[str]:
        try:
            data = await fetch_with_fallback(
                self.http_client, f"{STATS_API}/people/{player_id}", direct_retries=0,
            )
            people = data.get("people") or []
            return people[0].get("fullName") if people else None
        except (KeyError, TypeError, ValueError, httpx.HTTPError):
            return None

    async def _pitcher_mlb_stats(self, player_id: Optional[int], season: int) -> dict:
        if not player_id or not season:
            return {}
        try:
            data = await fetch_with_fallback(
                self.http_client,
                f"{STATS_API}/people/{player_id}/stats?stats=season&group=pitching&season={season}&sportIds=1&gameType=R",
                direct_retries=0,
            )
            splits = [split for group in data.get("stats", []) for split in group.get("splits", [])
                      if str(split.get("season")) == str(season)]
            if len(splits) != 1:
                return {}
            stats = splits[0].get("stat") or {}
            innings_text = str(stats.get("inningsPitched") or "")
            whole, dot, outs = innings_text.partition(".")
            if not whole.isdigit() or (dot and outs not in ("0", "1", "2")):
                return {}
            innings = int(whole) + (int(outs) / 3 if dot else 0)
            era = float(stats["era"])
            if innings <= 0 or not math.isfinite(era) or era < 0:
                return {}
            strikeouts = stats.get("strikeOuts")
            walks = stats.get("baseOnBalls")
            return {
                "era": era,
                "ip_season": innings,
                "k_9": 9 * float(strikeouts) / innings if strikeouts is not None else None,
                "bb_9": 9 * float(walks) / innings if walks is not None else None,
                "stats_season": season,
            }
        except (KeyError, TypeError, ValueError, OverflowError, httpx.HTTPError):
            logger.warning("stats MLB oficiales no disponibles para player_id=%s season=%s", player_id, season)
            return {}

    async def build_game_object(
        self,
        game_pk: int,
        mode: Mode,
        away_pitcher_id: Optional[int] = None,
        home_pitcher_id: Optional[int] = None,
        game_datetime_utc: Optional[object] = None,
    ) -> Optional[dict]:
        row = await self.supabase.select_one(
            self.http_client, "vw_mlb_matchups_ready", {"game_pk": f"eq.{game_pk}", "select": "*"}
        )
        if row is None:
            logger.warning("vw_mlb_matchups_ready sin fila para game_pk=%s", game_pk)
            return None

        game = dict(row)

        season = int(game.get("season") or str(game.get("game_date") or "")[:4] or 0)
        for side, confirmed_id in (("away", away_pitcher_id), ("home", home_pitcher_id)):
            view_id = game.get(f"{side}_pitcher_id")
            pitcher_id = confirmed_id or view_id
            mismatch = confirmed_id is not None and str(confirmed_id) != str(view_id)
            if mismatch:
                for field in game:
                    if field.startswith(f"{side}_p_"):
                        game[field] = None
                game[f"{side}_pitcher_id"] = confirmed_id
                game[f"{side}_pitcher_name"] = None
            if mismatch or game.get(f"{side}_p_era") is None:
                stats = await self._pitcher_mlb_stats(pitcher_id, season)
                if stats:
                    for field, value in stats.items():
                        game[f"{side}_p_{field}"] = value
                    if mismatch:
                        game[f"{side}_pitcher_name"] = await self._pitcher_name(pitcher_id)

        if any(game.get(f) is None for f in REQUIRED_FIELDS):
            logger.info("game_pk=%s sin ERA de abridores todavia (ni con fallback), se omite", game_pk)
            return None

        # El lineup_factor ya lo calcula y guarda el Lineup Watcher existente (n8n) en
        # lineup_watch -- solo lectura, no se recalcula aqui. En modo "pitchers_only" se
        # ignora deliberadamente aunque ya exista, para que el pipeline 1 sea una lectura
        # limpia de "solo con abridores confirmados".
        if mode == "full_lineup":
            lineup_row = await self.supabase.select_one(
                self.http_client, "lineup_watch",
                {"game_pk": f"eq.{game_pk}", "select": "lineup_factor_away,lineup_factor_home,lineup_woba_away,lineup_woba_home,lineup_away_detected_at,lineup_home_detected_at,reevaluado_at"},
            )
            if lineup_row:
                game["lineup_factor_away"] = lineup_row.get("lineup_factor_away")
                game["lineup_factor_home"] = lineup_row.get("lineup_factor_home")
                game["lineup_woba_away"] = lineup_row.get("lineup_woba_away")
                game["lineup_woba_home"] = lineup_row.get("lineup_woba_home")
                game["lineup_away_detected_at"] = lineup_row.get("lineup_away_detected_at")
                game["lineup_home_detected_at"] = lineup_row.get("lineup_home_detected_at")
                game["lineup_reevaluado_at"] = lineup_row.get("reevaluado_at")
            # 2026-07-21: volver a consultar el clima real en este momento (en vez de conformarse
            # con el snapshot que ya trajo vw_mlb_matchups_ready) -- decision del usuario. Si
            # falla o el estadio no tiene lat/lon conocidas, se conserva el snapshot previo.
            fresh_weather = await fetch_fresh_weather(
                self.http_client, self.supabase, game.get("venue_id"), game.get("game_date"),
                game_datetime_utc,
            )
            if fresh_weather:
                game.update(fresh_weather)
        else:
            game["lineup_factor_away"] = None
            game["lineup_factor_home"] = None

        return game
