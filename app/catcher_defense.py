"""Pregame catcher evidence for prospective evaluation; no model coefficient yet."""
import asyncio
import datetime as dt
import logging

import httpx

from app.mlb_stats_client import STATS_API, fetch_with_fallback
from app.prediction_audit import timestamp

logger = logging.getLogger(__name__)
PHASES = {"framing": "R", "blocking": "R", "poptime": "SOURCE_DEFAULT"}


def starting_catcher(box, side, team_id):
    team = (box.get("teams") or {}).get(side) or {}
    if (team.get("team") or {}).get("id") != team_id:
        return None
    order = team.get("battingOrder") or []
    if len(order) != 9 or len(set(order)) != 9:
        return None
    players = team.get("players") or {}
    catchers = []
    for player_id in order:
        player = players.get(f"ID{player_id}") or {}
        # Actual lineup position, never a roster's primary position.
        if str((player.get("position") or {}).get("code")) == "2":
            if not str(player.get("battingOrder") or "").endswith("00"):
                continue
            catchers.append(player_id)
    return catchers[0] if len(catchers) == 1 else None


def accepted_groups(rows, player_id, season, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    accepted = {}
    for row in rows:
        group = row.get("metric_group")
        captured = timestamp(row.get("captured_at"))
        if (row.get("sport_id") != 1 or row.get("season") != season or row.get("player_id") != player_id
                or group not in PHASES or row.get("season_type") != PHASES[group]
                or not captured or not 0 <= (now-captured).total_seconds() <= 48*3600
                or row.get("quality_flags")):
            continue
        accepted[group] = {k: row.get(k) for k in (
            "metrics", "season", "sport_id", "season_type", "captured_at", "source_url", "batch_id")}
        accepted[group]["source_data_through"] = None
    return accepted


async def attach_catcher_evidence(game, supabase, client, season):
    game["catcher_defense"] = {"usage": "prospective_evaluation", "applied_to_probability": False}
    flags = game.setdefault("catcher_quality_flags", [])
    try:
        box = await fetch_with_fallback(client, f"{STATS_API}/game/{game['game_pk']}/boxscore", direct_retries=0)
    except (httpx.HTTPError, ValueError):
        flags.append("catcher_lineup_unavailable")
        return

    async def side_evidence(side):
        player_id = starting_catcher(box, side, game.get(f"{side}_team_id"))
        evidence = {"player_id": player_id, "groups": {}}
        if not player_id:
            flags.append(f"catcher_unconfirmed_{side}")
            return side, evidence
        try:
            rows = await supabase.select(client, "bb_catcher_defense_current", {
                "player_id": f"eq.{player_id}", "season": f"eq.{season}", "sport_id": "eq.1", "select": "*"})
            evidence["groups"] = accepted_groups(rows, player_id, season)
        except httpx.HTTPError:
            logger.warning("Catcher defense unavailable player=%s", player_id)
        evidence["missing_groups"] = sorted(set(PHASES)-set(evidence["groups"]))
        if evidence["missing_groups"]:
            flags.append(f"catcher_defense_incomplete_{side}")
        return side, evidence

    for side, evidence in await asyncio.gather(*(side_evidence(s) for s in ("away", "home"))):
        game["catcher_defense"][side] = evidence
