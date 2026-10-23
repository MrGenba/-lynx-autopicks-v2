import datetime as dt
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from app.prediction_audit import build_snapshot, line_missing
from app.telegram import TelegramClient

NOW = dt.datetime(2026, 10, 22, 10, tzinfo=dt.timezone.utc)


def fixture():
    return {"game": {"game_datetime_utc": "2026-10-22T12:00:00Z", "scheduled_innings": 9,
                     "away_pitcher_id": 1, "home_pitcher_id": 2}, "total_line": 9.5}


def test_snapshot_rejects_postgame_features():
    with pytest.raises(ValueError, match="precede"):
        build_snapshot(11, 1, 1, fixture(), {}, NOW+dt.timedelta(hours=3), NOW)


def test_snapshot_separates_innings_and_marks_stale_market():
    payload = fixture()
    payload["game"]["scheduled_innings"] = 7
    row = build_snapshot(11, 1, 1, payload, {"candidates": [{"market": "OVER"}]}, NOW, NOW-dt.timedelta(hours=1))
    assert row["scheduled_innings"] == 7
    assert row["quality_flags"] == ["stale_or_future_odds", "missing_market_line"]
    assert row["inputs"]["stats_source_as_of"] is None
    assert row["inputs"]["bookmaker"] is None


def test_missing_or_invalid_lines_excluded():
    for line in (None, float("nan"), float("inf"), -1, "9.5"):
        assert line_missing({"market": "OVER", "total_line": line})
    assert not line_missing({"market": "HC_HOME", "hc_value": 0})


def test_snapshot_keeps_rejected_candidates_without_mutating_predictions():
    result = {"candidates": [{"market": "ML", "pick_side": "AWAY", "edge": -0.1, "edge_threshold": 0.15},
                             {"market": "ML", "pick_side": "HOME", "edge": 0.2, "edge_threshold": 0.15}],
              "best_pick": {"market": "ML", "pick_side": "HOME"}}
    snapshot = build_snapshot(1, 1, 1, fixture(), result, NOW, NOW)
    discarded, selected = snapshot["output"]["candidates"]
    assert discarded["model_decision"] == "not_shortlisted"
    assert discarded["decision_reasons"] == ["below_edge_threshold"]
    assert selected["model_decision"] == "selected"
    assert "model_decision" not in result["candidates"][0]


@pytest.mark.asyncio
async def test_telegram_cannot_report_failed_delivery_as_success():
    for status, data in [(429, {}), (200, {"ok": False}), (200, {"ok": True, "result": {}})]:
        client = SimpleNamespace(post=AsyncMock(return_value=httpx.Response(status, json=data)))
        with pytest.raises(RuntimeError):
            await TelegramClient("fake", client).send_message(1, "test")


@pytest.mark.asyncio
async def test_telegram_returns_delivery_receipt():
    client = SimpleNamespace(post=AsyncMock(return_value=httpx.Response(200, json={"ok": True, "result": {"message_id": 17}})))
    assert await TelegramClient("fake", client).send_message(1, "test") == 17


@pytest.mark.asyncio
async def test_daily_predictions_exclude_live_final_and_unknown_start(monkeypatch):
    from app import predictions_log_milb as mod
    future = (dt.datetime.now(dt.timezone.utc)+dt.timedelta(hours=2)).isoformat()
    games = [SimpleNamespace(game_pk=i, status=status, game_datetime_utc=start, scheduled_innings=innings,
                away_team_name="A", home_team_name="B", away_pitcher_id=1, home_pitcher_id=2)
             for i, (status, start, innings) in enumerate([("Final", future, 9), ("In Progress", future, 9),
                 ("Scheduled", "", 9), ("Scheduled", future, 7), ("Scheduled", future, 9)])]
    monkeypatch.setattr(mod.mlb_stats_client, "get_schedule", AsyncMock(return_value=games))
    rows = await mod._partidos_de_hoy(SimpleNamespace(http_client=None))
    assert [r["scheduled_innings"] for r in rows] == [7, 9]


def test_partial_market_cannot_refresh_other_side_or_new_line():
    from app.market_evidence import complete_markets
    assert complete_markets({"away_ml": 2, "home_ml": 2, "total_line": 10.5, "over_odds": 1.9}) == ["ML"]
    assert complete_markets({"away_hc_val": 1.5, "home_hc_val": 1.5, "away_hc_odds": 2, "home_hc_odds": 2}) == []


def test_fresh_ml_does_not_refresh_stale_total():
    from app.market_evidence import fresh_payload
    payload = {"game": {}, "away_ml": 2, "home_ml": 2, "total_line": 9.5, "over_odds": 2, "under_odds": 2}
    row = {"market_meta": {"ML": {"captured_at": NOW.isoformat()}, "OU": {"captured_at": (NOW-dt.timedelta(hours=1)).isoformat()}}}
    result = fresh_payload(payload, row, NOW)
    assert result["away_ml"] == 2 and result["home_ml"] == 2
    assert all(result[k] is None for k in ["total_line", "over_odds", "under_odds"])


def test_pre_lineup_price_is_excluded_per_market():
    from app.market_evidence import fresh_payload
    payload = {"game": {"lineup_confirmed_at": NOW.isoformat()}, "away_ml": 2, "home_ml": 2}
    result = fresh_payload(payload, {"market_meta": {"ML": {"captured_at": (NOW-dt.timedelta(minutes=1)).isoformat()}}}, NOW)
    assert result["away_ml"] is None
