"""Statcast inputs must match the league, season and phase and have a recent receipt."""
import datetime as dt
import logging
import math

import httpx

from app.prediction_audit import timestamp

logger = logging.getLogger(__name__)
MAX_AGE_HOURS = 48
METRICS = {
    "xwoba": "xwoba", "k_pct": "k_percent", "bb_pct": "bb_percent",
    "hard_hit": "hard_hit_pct", "barrel": "barrel_pct", "xba": "xba", "xslg": "xslg",
    "exit_velocity": "avg_exit_velocity", "velocity": "velocity", "spin_rate": "spin_rate",
}


async def fetch_pitcher(supabase, client, player_id, sport_id, season):
    if not player_id:
        return {}
    try:
        return await supabase.select_one(client, "bb_statcast_current", {
            "player_id": f"eq.{player_id}", "sport_id": f"eq.{sport_id}", "season": f"eq.{season}",
            "player_type": "eq.pitcher", "season_type": "eq.R",
            "select": "player_id,sport_id,season,player_type,season_type,captured_at,requested_through,source_url,batch_id,quality_flags,"
                      "xwoba,k_percent,bb_percent,hard_hit_pct,barrel_pct,xba,xslg,avg_exit_velocity,velocity,spin_rate,pa,bip",
        }) or {}
    except httpx.HTTPError:
        logger.warning("Statcast unavailable sport=%s player=%s", sport_id, player_id)
        return {}


def apply_pitcher(game, side, row, sport_id, season, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    reason = None
    captured = timestamp(row.get("captured_at"))
    try:
        through = dt.date.fromisoformat(str(row.get("requested_through")))
    except (ValueError, TypeError):
        through = None
    if not row:
        reason = "missing"
    elif (row.get("player_id") != game.get(f"{side}_pitcher_id") or row.get("sport_id") != sport_id
          or row.get("season") != season or row.get("player_type") != "pitcher" or row.get("season_type") != "R"):
        reason = "wrong_scope"
    elif not captured or not 0 <= (now-captured).total_seconds() <= MAX_AGE_HOURS*3600:
        reason = "stale_or_unknown"
    elif not through or not 0 <= (now.date()-through).days <= 2:
        reason = "stale_or_unknown_cutoff"
    flags = game.setdefault("statcast_quality_flags", [])
    if reason:
        flags.append(f"{reason}_statcast_{side}")
    for target, source in METRICS.items():
        value = row.get(source) if not reason else None
        if value is not None:
            try:
                value = float(value)
                if not math.isfinite(value) or (source.endswith(("_pct", "_percent")) and not 0 <= value <= 100):
                    raise ValueError("invalid metric")
            except (TypeError, ValueError):
                flags.append(f"invalid_statcast_{side}_{source}")
                value = None
        game[f"{side}_p_{target}"] = value
    game[f"{side}_p_statcast_season"] = None if reason else season
    game.setdefault("statcast_provenance", {})[side] = {
        **{k: row.get(k) for k in ("player_id", "sport_id", "season", "season_type", "captured_at", "requested_through", "source_url", "batch_id", "pa", "bip")},
        "accepted": reason is None, "reason": reason,
        # The aggregate export does not disclose the exact last observation timestamp.
        "source_data_through": None,
    }
    for flag in row.get("quality_flags") or []:
        flags.append(f"statcast_{side}_{flag}")
