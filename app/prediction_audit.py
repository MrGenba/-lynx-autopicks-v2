"""Pregame evidence kept separately from mutable candidate/settlement tables."""
import datetime as dt
import hashlib
import json
import math

from app.version import HUELLA

EXPERIMENT = "milb-totals-prospective-20261022-v1"
UTC = dt.timezone.utc


def timestamp(value):
    if isinstance(value, dt.datetime):
        return value.astimezone(UTC) if value.tzinfo else value.replace(tzinfo=UTC)
    if not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.astimezone(UTC) if parsed.tzinfo else None
    except (ValueError, TypeError):
        return None


def valid_pregame(start, now=None):
    start = timestamp(start)
    return start is not None and start > (now or dt.datetime.now(UTC))


def line_missing(candidate):
    market = str(candidate.get("market") or "").upper()
    field = "total_line" if market in {"OU", "OVER", "UNDER"} else "hc_value" if market.startswith("HC") else None
    if field is None:
        return False
    value = candidate.get(field)
    return not isinstance(value, (int, float)) or not math.isfinite(value) or (field == "total_line" and value <= 0)


def build_snapshot(sport_id, game_id, pipeline, payload, result, prediction_at, odds_at=None):
    game = payload["game"]
    start = timestamp(game.get("game_datetime_utc"))
    predicted = timestamp(prediction_at)
    if not start or not predicted or predicted >= start:
        raise ValueError("Prediction must precede the known game start")
    flags = []
    innings = game.get("scheduled_innings")
    if innings not in (7, 9):
        flags.append("unknown_innings")
    if not game.get("away_pitcher_id") or not game.get("home_pitcher_id"):
        flags.append("missing_starter")
    captured = timestamp(odds_at)
    if not captured:
        flags.append("unknown_odds_time")
    elif captured > predicted or (predicted - captured).total_seconds() > 1200:
        flags.append("stale_or_future_odds")
    if any(line_missing(c) for c in result.get("candidates", [])):
        flags.append("missing_market_line")
    # Retrieval time is known; historical source cutoff is not inferred from it.
    inputs = {"payload": payload, "stats_source_as_of": game.get("stats_source_as_of"),
              "retrieved_at": predicted.isoformat(), "bookmaker": game.get("bookmaker"),
              "odds_source": game.get("odds_source")}
    canonical = json.dumps([sport_id, game_id, pipeline, HUELLA, predicted.isoformat(), inputs, result],
                           sort_keys=True, separators=(",", ":"), allow_nan=False)
    return {"snapshot_id": hashlib.sha256(canonical.encode()).hexdigest(),
            "league": {1: "MLB", 11: "MiLB", 23: "LMB"}[sport_id], "game_id": game_id,
            "pipeline": pipeline, "prediction_at": predicted.isoformat(), "game_start": start.isoformat(),
            "scheduled_innings": innings, "odds_captured_at": captured.isoformat() if captured else None,
            "model_version": HUELLA, "source": "autopicks_v2", "quality_flags": flags,
            "experiment_id": EXPERIMENT if sport_id == 11 else None, "inputs": inputs, "output": result}


async def save_snapshot(ctx, snapshot):
    await ctx.supabase.insert(ctx.http_client, "bb_prediction_snapshots", [snapshot])
