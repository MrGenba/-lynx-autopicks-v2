import datetime as dt
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.statcast import apply_pitcher
from app.prediction_audit import build_snapshot

NOW = dt.datetime(2026, 10, 22, 20, tzinfo=dt.timezone.utc)


def row():
    return {"player_id": 42, "sport_id": 11, "season": 2026, "player_type": "pitcher", "season_type": "R",
            "captured_at": NOW.isoformat(), "requested_through": "2026-10-22", "xwoba": .301,
            "hard_hit_pct": 38.5, "k_percent": 0, "bb_percent": 8, "quality_flags": []}


@pytest.mark.parametrize("changed", [
    {"sport_id": 1}, {"player_id": 43}, {"season": 2025}, {"season_type": "POST"},
    {"captured_at": "2026-04-27T11:00:00Z"}, {"captured_at": "2026-10-23T00:00:00Z"},
    {"requested_through": "2026-09-30"}, {"requested_through": "2026-10-23"},
])
def test_wrong_or_stale_metrics_cannot_survive_from_view(changed):
    game = {"away_pitcher_id": 42, "away_p_xwoba": .222, "away_p_hard_hit": 20}
    apply_pitcher(game, "away", {**row(), **changed}, 11, 2026, NOW)
    assert game["away_p_xwoba"] is None
    assert game["away_p_hard_hit"] is None
    assert game["away_p_statcast_season"] is None
    assert game["statcast_quality_flags"]
    assert not game["statcast_provenance"]["away"]["accepted"]


def test_valid_zero_and_receipt_are_preserved_without_inventing_source_date():
    game = {"away_pitcher_id": 42}
    apply_pitcher(game, "away", row(), 11, 2026, NOW)
    assert game["away_p_xwoba"] == .301
    assert game["away_p_k_pct"] == 0
    assert game["statcast_provenance"]["away"]["accepted"]
    assert game["statcast_provenance"]["away"]["source_data_through"] is None


def test_missing_statcast_is_recorded_in_prediction_evidence():
    game = {"away_pitcher_id": 42, "home_pitcher_id": 43, "scheduled_innings": 9,
            "game_datetime_utc": "2026-10-23T00:00:00Z"}
    apply_pitcher(game, "away", {}, 1, 2026, NOW)
    audit = build_snapshot(1, 849817, 1, {"game": game}, {}, NOW, NOW)
    assert "missing_statcast_away" in audit["quality_flags"]
    assert audit["inputs"]["payload"]["game"]["statcast_provenance"]["away"]["reason"] == "missing"


@pytest.mark.asyncio
async def test_monitor_is_quiet_when_healthy_and_deduplicates_failure(monkeypatch):
    from app import pipeline_health as mod
    monkeypatch.setattr(mod, "_statcast_last_state", None)
    monkeypatch.setattr(mod, "_statcast_last_notice", None)
    rows = [{"sport_id": s, "player_type": r, "season_type": p, "state": "ok"}
            for s in (1, 11) for r in ("pitcher", "batter") for p in ("R", "POST")]
    ctx = SimpleNamespace(supabase=SimpleNamespace(select=AsyncMock(return_value=rows)), http_client=None,
                          telegram=SimpleNamespace(send_message=AsyncMock()), admin_chat_id=1)
    assert await mod.statcast_health_tick(ctx) == []
    ctx.telegram.send_message.assert_not_awaited()
    rows[0]["state"] = "stale"
    await mod.statcast_health_tick(ctx)
    await mod.statcast_health_tick(ctx)
    assert ctx.telegram.send_message.await_count == 1
    monkeypatch.setattr(mod, "_statcast_last_notice", dt.datetime.now(dt.timezone.utc)-dt.timedelta(hours=2))
    rows[0]["state"] = "ok"
    await mod.statcast_health_tick(ctx)
    assert ctx.telegram.send_message.await_count == 2
