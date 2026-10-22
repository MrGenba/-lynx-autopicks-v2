import datetime as dt
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.catcher_defense import accepted_groups, starting_catcher, attach_catcher_evidence

NOW = dt.datetime(2026, 10, 22, 22, tzinfo=dt.timezone.utc)


def row(**changes):
    return {"player_id": 1, "sport_id": 1, "season": 2026, "season_type": "R", "metric_group": "framing",
            "captured_at": NOW.isoformat(), "quality_flags": [], "metrics": {"framing_runs": 0}, **changes}


def test_scope_freshness_and_unknown_pop_time_phase():
    assert accepted_groups([row()], 1, 2026, NOW)["framing"]["metrics"]["framing_runs"] == 0
    for changes in ({"sport_id": 11}, {"season": 2025}, {"player_id": 2}, {"season_type": "POST"},
                    {"captured_at": (NOW-dt.timedelta(hours=49)).isoformat()},
                    {"captured_at": (NOW+dt.timedelta(hours=1)).isoformat()}, {"quality_flags": ["invalid"]}):
        assert not accepted_groups([row(**changes)], 1, 2026, NOW)
    assert not accepted_groups([row(metric_group="poptime")], 1, 2026, NOW)
    assert "poptime" in accepted_groups([row(metric_group="poptime", season_type="SOURCE_DEFAULT")], 1, 2026, NOW)


def box():
    return {"teams": {"away": {"team": {"id": 100}, "battingOrder": list(range(1, 10)), "players": {
        "ID1": {"position": {"code": "2"}, "battingOrder": "800"},
        "ID2": {"position": {"code": "10"}, "person": {"primaryPosition": {"code": "2"}}, "battingOrder": "100"}}}}}


def test_only_confirmed_actual_catcher_not_dh_roster_position_or_substitute():
    data = box()
    assert starting_catcher(data, "away", 100) == 1
    assert starting_catcher(data, "away", 200) is None
    data["teams"]["away"]["players"]["ID1"]["battingOrder"] = "801"
    assert starting_catcher(data, "away", 100) is None


@pytest.mark.asyncio
async def test_enrichment_is_evidence_only_and_missing_side_explicit(monkeypatch):
    monkeypatch.setattr("app.catcher_defense.fetch_with_fallback", AsyncMock(return_value=box()))
    sb = SimpleNamespace(select=AsyncMock(return_value=[row(captured_at=dt.datetime.now(dt.timezone.utc).isoformat())]))
    game = {"game_pk": 1, "away_team_id": 100, "home_team_id": 200, "away_p_era": 3.1}
    await attach_catcher_evidence(game, sb, object(), 2026)
    assert game["catcher_defense"]["away"]["groups"]["framing"]["metrics"]["framing_runs"] == 0
    assert not game["catcher_defense"]["applied_to_probability"]
    assert game["away_p_era"] == 3.1
    assert "catcher_unconfirmed_home" in game["catcher_quality_flags"]


@pytest.mark.asyncio
async def test_health_stays_quiet_for_known_unavailable_lmb_and_notifies_new_tracking(monkeypatch):
    from app import pipeline_health as health
    monkeypatch.setattr(health, "_defense_last_state", None)
    monkeypatch.setattr(health, "_defense_last_notice", None)
    state = "not_available_in_sample"
    async def select(client, table, params):
        return [{"metric_group": g, "state": "ok"} for g in ("framing", "blocking", "poptime")] if table == "bb_catcher_defense_health" else [{"state": state}]
    ctx = SimpleNamespace(supabase=SimpleNamespace(select=select), http_client=None,
                          telegram=SimpleNamespace(send_message=AsyncMock()), admin_chat_id=1)
    assert await health.defense_health_tick(ctx) == []
    ctx.telegram.send_message.assert_not_awaited()
    state = "tracking_detected"
    assert await health.defense_health_tick(ctx)
    ctx.telegram.send_message.assert_awaited_once()
    await health.defense_health_tick(ctx)
    ctx.telegram.send_message.assert_awaited_once()
