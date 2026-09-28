import pytest

from app.adapters.mlb import MlbAdapter


class FakeSupabase:
    def __init__(self, game, lineup=None):
        self.game = game
        self.lineup = lineup

    async def select_one(self, client, table, params):
        if table == "vw_mlb_matchups_ready":
            return self.game
        if table == "lineup_watch":
            return self.lineup
        raise AssertionError(f"consulta inesperada: {table}")


def game_row():
    return {
        "game_pk": 824705,
        "game_date": "2026-09-27",
        "season": 2026,
        "away_pitcher_id": 100,
        "away_pitcher_name": "Abridor antiguo",
        "away_p_era": 2.0,
        "away_p_ip_season": 120.0,
        "away_p_siera": 2.5,
        "home_pitcher_id": 200,
        "home_p_era": 3.5,
    }


@pytest.mark.asyncio
async def test_pitcher_confirmado_distinto_descarta_stats_del_abridor_antiguo(monkeypatch):
    adapter = MlbAdapter(FakeSupabase(game_row()), object())

    async def official_stats(player_id, season):
        assert (player_id, season) == (101, 2026)
        return {"era": 3.77, "ip_season": 174 + 1 / 3, "k_9": 8.98, "bb_9": 1.91, "stats_season": 2026}

    async def official_name(player_id):
        assert player_id == 101
        return "Abridor correcto"

    monkeypatch.setattr(adapter, "_pitcher_mlb_stats", official_stats)
    monkeypatch.setattr(adapter, "_pitcher_name", official_name)
    game = await adapter.build_game_object(824705, "pitchers_only", away_pitcher_id=101, home_pitcher_id=200)

    assert game["away_pitcher_id"] == 101
    assert game["away_pitcher_name"] == "Abridor correcto"
    assert game["away_p_era"] == 3.77
    assert game["away_p_ip_season"] == 174 + 1 / 3
    assert game["away_p_siera"] is None
    assert game["home_p_era"] == 3.5
    assert game["lineup_factor_away"] is None


@pytest.mark.asyncio
async def test_sin_stats_mlb_oficiales_no_usa_fallback_de_ligas_menores(monkeypatch):
    row = game_row()
    row["away_pitcher_id"] = None
    row["away_p_era"] = None
    adapter = MlbAdapter(FakeSupabase(row), object())

    async def no_official_stats(player_id, season):
        return {}

    monkeypatch.setattr(adapter, "_pitcher_mlb_stats", no_official_stats)
    assert await adapter.build_game_object(824705, "pitchers_only", away_pitcher_id=101, home_pitcher_id=200) is None


@pytest.mark.asyncio
async def test_stats_oficiales_interpretan_outs_en_innings_pitchados(monkeypatch):
    async def fake_fetch(client, url, direct_retries):
        assert "sportIds=1" in url
        return {"stats": [{"splits": [{"season": "2026", "stat": {
            "era": "3.77", "inningsPitched": "174.1", "strikeOuts": 174, "baseOnBalls": 37,
        }}]}]}

    monkeypatch.setattr("app.adapters.mlb.fetch_with_fallback", fake_fetch)
    stats = await MlbAdapter(FakeSupabase(game_row()), object())._pitcher_mlb_stats(101, 2026)

    assert stats["ip_season"] == 174 + 1 / 3
    assert stats["era"] == 3.77
    assert stats["k_9"] == pytest.approx(9 * 174 / (174 + 1 / 3))


@pytest.mark.asyncio
async def test_abridores_sin_lineup_no_aplican_factores_existentes():
    lineup = {"lineup_factor_away": 1.08, "lineup_factor_home": 0.94}
    adapter = MlbAdapter(FakeSupabase(game_row(), lineup), object())
    game = await adapter.build_game_object(824705, "pitchers_only", away_pitcher_id=100, home_pitcher_id=200)

    assert game["lineup_factor_away"] is None
    assert game["lineup_factor_home"] is None
