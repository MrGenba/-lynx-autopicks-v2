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

    async def build_game_object(
        self,
        game_pk: int,
        mode: Mode,
        away_pitcher_id: Optional[int] = None,
        home_pitcher_id: Optional[int] = None,
    ) -> Optional[dict]:
        # away_pitcher_id/home_pitcher_id no se usan aqui: a diferencia de MiLB/LMB, MLB no
        # hace una consulta propia de stats de abridor -- vw_mlb_matchups_ready ya trae el ERA
        # calculado. Si la vista no tiene fila o le falta el ERA, el fallback de pitcher_id no
        # tiene forma de actuar sobre eso (ver games_gate_state en pipelines.py). Se acepta el
        # parametro solo para mantener la misma firma que los otros 2 adaptadores.
        row = await self.supabase.select_one(
            self.http_client, "vw_mlb_matchups_ready", {"game_pk": f"eq.{game_pk}", "select": "*"}
        )
        if row is None:
            logger.warning("vw_mlb_matchups_ready sin fila para game_pk=%s", game_pk)
            return None
        if any(row.get(f) is None for f in REQUIRED_FIELDS):
            logger.info("game_pk=%s sin ERA de abridores todavia, se omite", game_pk)
            return None

        game = dict(row)

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
                self.http_client, self.supabase, game.get("venue_id"), game.get("game_date")
            )
            if fresh_weather:
                game.update(fresh_weather)
        else:
            game["lineup_factor_away"] = None
            game["lineup_factor_home"] = None

        return game
