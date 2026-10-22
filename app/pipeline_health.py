"""Delivery reconciliation and alerts based on games expected to be evaluated."""
import datetime as dt
import json
import logging

import httpx

from app.pipelines import CANDIDATES_HISTORY_TABLE, CANDIDATES_LINEUP_TABLE, LEAGUE_LABEL

logger = logging.getLogger(__name__)
_last_notice = None
_last_state = None
_statcast_last_state = None
_statcast_last_notice = None
_defense_last_state = None
_defense_last_notice = None


async def defense_health_tick(ctx):
    global _defense_last_state, _defense_last_notice
    try:
        catchers = await ctx.supabase.select(ctx.http_client, "bb_catcher_defense_health", {"select": "metric_group,state"})
        tracking = await ctx.supabase.select(ctx.http_client, "bb_tracking_coverage_health", {"select": "state"})
        if len(catchers) != 3 or len(tracking) != 1:
            raise ValueError("Incomplete catcher/tracking monitor")
        bad = sorted(f"MLB {r['metric_group']}: {r['state']}" for r in catchers if r["state"] != "ok")
        state_lmb = tracking[0]["state"]
        if state_lmb not in {"not_available_in_sample", "no_games"}:
            bad.append(f"LMB cobertura pública: {state_lmb}")
    except (httpx.HTTPError, ValueError, KeyError):
        logger.exception("Catcher/tracking monitor unavailable")
        bad = ["Monitor de catchers/cobertura LMB no disponible"]
    state = tuple(bad)
    now = dt.datetime.now(dt.timezone.utc)
    if state != _defense_last_state and (state or _defense_last_state is not None):
        if _defense_last_notice is None or now-_defense_last_notice >= dt.timedelta(hours=1):
            message = ("⚠️ Revisión de datos defensivos: " + "; ".join(state) +
                       ". Los datos caducados se excluyen; el tracking detectado en LMB requiere validar cobertura."
                       if state else "✅ Captura de catchers y comprobación de cobertura LMB recuperadas.")
            await ctx.telegram.send_message(ctx.admin_chat_id, message)
            _defense_last_state, _defense_last_notice = state, now
    if _defense_last_state is None and not state:
        _defense_last_state = state
    return bad


async def statcast_health_tick(ctx):
    global _statcast_last_state, _statcast_last_notice
    try:
        rows = await ctx.supabase.select(ctx.http_client, "bb_statcast_health", {"select": "sport_id,player_type,season_type,state"})
        if len(rows) != 8:
            raise ValueError("Incomplete Statcast monitor")
        bad = sorted((r["sport_id"], r["player_type"], r["season_type"], r["state"])
                     for r in rows if r["state"] not in {"ok", "no_games"})
    except (httpx.HTTPError, ValueError, KeyError):
        logger.exception("Statcast monitor unavailable")
        bad = [(0, "monitor", "", "unavailable")]
    state = tuple(bad)
    now = dt.datetime.now(dt.timezone.utc)
    if state != _statcast_last_state and (state or _statcast_last_state is not None):
        if _statcast_last_notice is None or now-_statcast_last_notice >= dt.timedelta(hours=1):
            if state:
                detail = "; ".join(f"{LEAGUE_LABEL.get(sport, 'Statcast')} {role} {phase}: {status}"
                                   for sport, role, phase, status in state)
                message = "⚠️ Captura Statcast: " + detail + ". Las métricas caducadas se excluyen del modelo."
            else:
                message = "✅ Captura Statcast recuperada: MLB y Triple-A actualizados por liga y fase."
            await ctx.telegram.send_message(ctx.admin_chat_id, message)
            _statcast_last_notice = now
            _statcast_last_state = state
    if _statcast_last_state is None and not state:
        _statcast_last_state = state
    return bad


async def pipeline_health_tick(ctx):
    global _last_notice, _last_state
    async with ctx.pool.acquire() as conn:
        receipts = await conn.fetch("""SELECT * FROM pipeline_runs WHERE published=true
            AND telegram_message_id IS NOT NULL AND prediction_snapshot_id IS NOT NULL
            AND receipt_synced_at IS NULL ORDER BY claimed_at LIMIT 20""")
        missing = await conn.fetch("""SELECT g.sport_id,count(*) AS missing
            FROM games_gate_state g JOIN game_odds o USING(sport_id,game_pk)
            WHERE g.game_datetime_utc BETWEEN now()-interval '24 hours' AND now()+interval '30 minutes'
            AND g.away_pitcher_id IS NOT NULL AND g.home_pitcher_id IS NOT NULL
            AND o.updated_at < g.game_datetime_utc
            AND NOT EXISTS(SELECT 1 FROM pipeline_runs r WHERE r.sport_id=g.sport_id
                AND r.game_pk=g.game_pk AND r.quant_result IS NOT NULL)
            GROUP BY g.sport_id""")
    failed = 0
    for r in receipts:
        try:
            result = json.loads(r["quant_result"]) if isinstance(r["quant_result"], str) else r["quant_result"]
            pick = result.get("best_pick") or {}
            if not pick.get("market") or not pick.get("pick_side"):
                raise ValueError("Published selection unavailable")
            receipt = {"snapshot_id": r["prediction_snapshot_id"], "market": pick["market"], "pick_side": pick["pick_side"],
                       "telegram_message_id": r["telegram_message_id"], "published_at": r["published_at"].isoformat()}
            try:
                await ctx.supabase.insert(ctx.http_client, "bb_prediction_publications", [receipt])
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code != 409:
                    raise
                existing = await ctx.supabase.select_one(ctx.http_client, "bb_prediction_publications", {"snapshot_id": "eq." + receipt["snapshot_id"]})
                if not existing or existing["telegram_message_id"] != receipt["telegram_message_id"]:
                    raise ValueError("Delivery receipt conflict") from exc
            table = (CANDIDATES_LINEUP_TABLE if r["pipeline"] == 2 else CANDIDATES_HISTORY_TABLE)[r["sport_id"]]
            await ctx.supabase.patch(ctx.http_client, table,
                {"prediction_snapshot_id": "eq." + receipt["snapshot_id"], "market": "eq." + receipt["market"], "pick_side": "eq." + receipt["pick_side"]},
                {"published": True, "publication_message_id": receipt["telegram_message_id"], "published_at": receipt["published_at"]})
            async with ctx.pool.acquire() as conn:
                await conn.execute("UPDATE pipeline_runs SET receipt_synced_at=now() WHERE id=$1", r["id"])
        except Exception:
            failed += 1
            logger.exception("Delivery reconciliation pending run_id=%s", r["id"])
    state = tuple(sorted((r["sport_id"], r["missing"]) for r in missing)), failed
    now = dt.datetime.now(dt.timezone.utc)
    if state != _last_state and (missing or failed or _last_state is not None) and (_last_notice is None or now-_last_notice > dt.timedelta(hours=1)):
        if missing or failed:
            detail = ", ".join(f"{LEAGUE_LABEL[r['sport_id']]}: {r['missing']} partidos" for r in missing)
            text = f"⚠️ Revisión de captura: {detail or 'sin huecos de evaluación'}. Recibos pendientes: {failed}. Hay datos/cuotas pero falta revisar la evaluación o su guardado."
        else:
            text = "✅ Captura: resueltos los huecos de evaluación y recibos pendientes detectados por el monitor."
        await ctx.telegram.send_message(ctx.admin_chat_id, text)
        _last_notice = now
        _last_state = state
    if _last_state is None and not missing and not failed:
        _last_state = state
    statcast = await statcast_health_tick(ctx)
    defense = await defense_health_tick(ctx)
    return {"missing": [dict(r) for r in missing], "pending_receipts": failed, "statcast": statcast, "defense": defense}
