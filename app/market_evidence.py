"""Only complete, contemporaneous market pairs can refresh a price timestamp."""
import datetime as dt
import json
import math

from app.prediction_audit import timestamp

GROUPS = {"ML": ("away_ml", "home_ml"), "OU": ("total_line", "over_odds", "under_odds"),
          "HC": ("away_hc_val", "away_hc_odds", "home_hc_val", "home_hc_odds")}


def complete_markets(values):
    valid = []
    for market, keys in GROUPS.items():
        try:
            if any(values.get(k) is None or not math.isfinite(float(values[k])) for k in keys):
                continue
            prices = keys if market == "ML" else [k for k in keys if k.endswith("odds")]
            if any(float(values[k]) <= 1 for k in prices):
                continue
            if market == "OU" and float(values["total_line"]) <= 0:
                continue
            if market == "HC" and abs(float(values["away_hc_val"])+float(values["home_hc_val"])) > 1e-8:
                continue
            valid.append(market)
        except (ValueError, TypeError):
            continue
    return valid


def fresh_payload(payload, odds, now=None):
    # Column absent is supported for callers with legacy in-memory fixtures only.
    if "market_meta" not in odds:
        return payload
    meta = odds.get("market_meta") or {}
    if isinstance(meta, str):
        meta = json.loads(meta)
    now = now or dt.datetime.now(dt.timezone.utc)
    news_at = timestamp(payload.get("game", {}).get("lineup_confirmed_at"))
    for market, keys in GROUPS.items():
        at = timestamp(meta.get(market, {}).get("captured_at"))
        if not at or not 0 <= (now-at).total_seconds() <= 1200 or (news_at and at < news_at):
            for key in keys:
                payload[key] = None
    payload["market_meta"] = meta
    return payload
