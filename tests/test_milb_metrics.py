"""Tests de los fixes de métricas MiLB (2026-07-25):
  #1 el adaptador MiLB mapea los campos de temporada del abridor (*_stats_season / *_statcast_season)
     que el motor necesita para no anular el 54% del data_score.
  #2 build_candidates_history_rows guarda el data_score del RESULTADO (no c.get, que era None -> 0)."""
import pytest

from app.adapters.milb import MilbAdapter
from app.pipelines import build_candidates_history_rows


class FakeSupabase:
    """Mock mínimo: devuelve filas canónicas por tabla para probar el mapeo del game object."""
    async def select_one(self, client, table, params):
        rows = await self.select(client, table, params)
        return rows[0] if rows else None

    async def select(self, client, table, params):
        if table == "vw_matchups_enriched":
            return [{"game_id": 123, "away_team_id": 1, "home_team_id": 2, "venue_id": 10,
                     "away_pitcher_id": 100, "home_pitcher_id": 200, "game_date": "2026-07-25"}]
        if table == "player_stats":
            return [{"era": 3.5, "fip": 3.6, "innings_pitched": 80, "k_9": 9, "bb_9": 3,
                     "xwoba": 0.31, "whip": 1.1, "season": 2026}]
        if table == "player_statcast_pitchers":
            return [{"season": 2025, "xwoba": 0.30, "k_percent": 24, "bb_percent": 8,
                     "hard_hit_pct": 35, "barrel_pct": 7}]
        if table == "vw_team_batting":
            return [{"num_batters": 20, "xwoba": 0.32, "woba": 0.33, "hard_hit_pct": 36,
                     "barrel_pct": 7, "avg_exit_velo": 88}]
        if table == "vw_team_bullpen":
            return [{"num_pitchers": 8, "era": 4.0, "fip": 4.1, "k9": 9, "bb9": 3, "xwoba_allowed": 0.32}]
        if table == "park_factors":
            return [{"park_factor_runs": 100, "park_factor_hr": 100, "altitude_m": 200, "stadium_name": "Park"}]
        if table == "game_weather":
            return [{"temperature_2m": 25, "wind_speed_10m": 10, "wind_direction_10m": 180}]
        if table == "daily_games":
            return [{"away_score": 5}] if "away_team_id" in params else [{"home_score": 4}]
        return []


@pytest.mark.asyncio
async def test_milb_adapter_mapea_campos_de_temporada():
    adapter = MilbAdapter(FakeSupabase(), None)
    game = await adapter.build_game_object(123, "starters", None, None)
    assert game is not None
    # Fix #1: los campos de temporada que el motor necesita ahora están presentes.
    assert game["away_p_stats_season"] == 2026
    assert game["home_p_stats_season"] == 2026
    assert game["away_p_statcast_season"] == 2025
    assert game["home_p_statcast_season"] == 2025
    # Los valores del abridor siguen mapeados (no se rompió nada).
    assert game["away_p_era_season"] == 3.5
    assert game["away_p_xwoba"] == 0.31


def test_candidates_usan_data_score_del_resultado():
    # Fix #2: candidatos sin data_score propio -> se usa el del resultado (antes se guardaba 0).
    result = {
        "away_mu": 4.5, "home_mu": 4.6, "data_score": 0.83,
        "candidates": [
            {"market": "ML", "pick_side": "AWAY", "odds": 2.0, "edge": 0.05,
             "edge_threshold": 0.18, "prob_model": 0.5, "prob_implied": 0.48},  # sin data_score
        ],
    }
    _table, rows = build_candidates_history_rows(
        11, 123, "2026-07-25", "Away AAA", "Home AAA", result, published_key=None
    )
    assert rows[0]["data_score"] == 0.83


def test_candidato_con_data_score_propio_se_respeta():
    result = {"away_mu": 4.5, "home_mu": 4.6, "data_score": 0.83,
              "candidates": [{"market": "ML", "pick_side": "AWAY", "odds": 2.0, "edge": 0.05,
                              "edge_threshold": 0.18, "data_score": 0.71}]}
    _table, rows = build_candidates_history_rows(
        11, 123, "2026-07-25", "A", "B", result, published_key=None
    )
    assert rows[0]["data_score"] == 0.71
