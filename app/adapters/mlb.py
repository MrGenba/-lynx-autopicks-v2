"""Adaptador MLB -- el mas simple de los 3: vw_mlb_matchups_ready ya hace todos los joins
pesados (stats de abridor, bullpen, ofensiva, park factors, clima, Statcast, SIERA) y ya
nombra las columnas como away_p_*/home_p_* etc., igual que consume "Motor MLB" en n8n.
"""
import logging
from typing import Optional

import httpx

from app.adapters import Mode
from app.supabase_client import SupabaseClient
from app.weather_client import fetch_fresh_weather

logger = logging.getLogger(__name__)

REQUIRED_FIELDS = ("away_p_era", "home_p_era")  # sin esto el motor no tiene nada que analizar


class MlbAdapter:
    def __init__(self, supabase: SupabaseClient, http_client: httpx.AsyncClient):
        self.supabase = supabase
        self.http_client = http_client

    async def _pitcher_era_fip(self, player_id: Optional[int]) -> dict:
        """Fallback de stats de abridor por player_id -- player_stats es combinada (MLB+MiLB) y
        suele tener el ERA/FIP antes de que el sync los propague a vw_mlb_matchups_ready."""
        if not player_id:
            return {}
        try:
            rows = await self.supabase.select(
                self.http_client, "player_stats",
                {"player_id": f"eq.{player_id}", "order": "season.desc", "limit": "1", "select": "era,fip"},
            )
            return rows[0] if rows else {}
        except Exception:
            logger.warning("fallback ERA MLB fallo para player_id=%s", player_id)
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

        # Fallback de abridor (2026-08-05): la vista a veces no tiene el ERA/FIP del abridor a tiempo
        # (lag del sync -> "datos insuficientes" recurrente, p.ej. Dodgers@Cubs). Se busca directo en
        # player_stats por el pitcher_id que el detector confirmo en vivo (games_gate_state, pasado
        # como away/home_pitcher_id) o, en su defecto, el de la propia vista. Igual criterio que MiLB.
        if game.get("away_p_era") is None:
            fb = await self._pitcher_era_fip(away_pitcher_id or game.get("away_pitcher_id"))
            if fb.get("era") is not None:
                game["away_p_era"] = fb["era"]
                if game.get("away_p_fip") is None:
                    game["away_p_fip"] = fb.get("fip")
        if game.get("home_p_era") is None:
            fb = await self._pitcher_era_fip(home_pitcher_id or game.get("home_pitcher_id"))
            if fb.get("era") is not None:
                game["home_p_era"] = fb["era"]
                if game.get("home_p_fip") is None:
                    game["home_p_fip"] = fb.get("fip")

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
                {"game_pk": f"eq.{game_pk}", "select": "lineup_factor_away,lineup_factor_home,lineup_woba_away,lineup_woba_home"},
            )
            if lineup_row:
                game["lineup_factor_away"] = lineup_row.get("lineup_factor_away")
                game["lineup_factor_home"] = lineup_row.get("lineup_factor_home")
                game["lineup_woba_away"] = lineup_row.get("lineup_woba_away")
                game["lineup_woba_home"] = lineup_row.get("lineup_woba_home")
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
