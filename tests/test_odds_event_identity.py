import datetime as dt
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app import odds_autofetch as mod
from app.aliases import CandidateGame
from app.message_handler import _store_odds


def candidate(day=24, hour=0):
    return CandidateGame(1,849805+day-24,None,None,'Tampa Bay Rays','Milwaukee Brewers',dt.datetime(2026,10,day,hour,tzinfo=dt.timezone.utc))


def scraped():
    return {'away_team':'Tampa Bay Rays','home_team':'Milwaukee Brewers','time':'02:00',
            'start_time_utc':'2026-10-24T00:00:00Z','source':'cuotasahora'}


def test_single_playoff_series_matches_after_restart_without_training(monkeypatch):
    monkeypatch.setattr(mod,'_DESFASE_SITIO_MIN',None)
    game=candidate()
    assert mod._match_scraped_game(scraped(),[game]) is game


@pytest.mark.parametrize('other', [candidate(25),candidate(24,5)])
def test_same_teams_and_clock_on_wrong_date_or_doubleheader_rejected(other,monkeypatch):
    monkeypatch.setattr(mod,'_DESFASE_SITIO_MIN',120)
    assert mod._match_scraped_game(scraped(),[other]) is None


def test_malformed_dated_source_cannot_fall_back_to_matching_clock(monkeypatch):
    monkeypatch.setattr(mod,'_DESFASE_SITIO_MIN',120)
    for value in (None,'invalid','2026-10-24T00:00:00'):
        assert mod._match_scraped_game({**scraped(),'start_time_utc':value},[candidate()]) is None
    sc=scraped();del sc['start_time_utc']
    assert mod._match_scraped_game(sc,[candidate()]) is None


class Pool:
    def __init__(self,conn):self.conn=conn
    def acquire(self):return self
    async def __aenter__(self):return self.conn
    async def __aexit__(self,*args):pass


@pytest.mark.asyncio
async def test_store_preserves_actual_source_and_only_complete_markets():
    conn=SimpleNamespace(execute=AsyncMock())
    values=mod._values_from_scraped({'moneyline':{'home':1.91,'away':1.91},'total':{'line':7.5,'over_odds':1.9}})
    provenance={'source':'cuotasahora','bookmaker':'Bet365','captured_at':'2026-10-23T05:00:00Z','start_time_utc':'2026-10-24T00:00:00Z','source_event_url':'https://www.cuotasahora.com/baseball/h2h/example/'}
    await _store_odds(Pool(conn),1,849805,values,0,0,provenance=provenance)
    meta=json.loads(conn.execute.call_args.args[-1])
    assert set(meta)=={'ML'}
    assert meta['ML']==provenance


@pytest.mark.asyncio
async def test_missing_bookmaker_stops_rotation_retries(monkeypatch):
    async def missing(*args):return 0,'bookmaker_unavailable'
    monkeypatch.setattr(mod,'_scrape_and_apply',missing)
    rotate=AsyncMock();monkeypatch.setattr(mod,'rotate_tor_circuit',rotate)
    assert not await mod.autofetch_single_game(SimpleNamespace(pool=None),1,1,'A','B',dt.datetime.now(dt.timezone.utc)+dt.timedelta(hours=4))
    rotate.assert_not_awaited()


@pytest.mark.asyncio
async def test_missing_odds_monitor_alerts_once_and_reports_recovery(monkeypatch):
    from app import pipeline_health as health
    monkeypatch.setattr(health,'_odds_last_state',None);monkeypatch.setattr(health,'_odds_last_notice',None)
    conn=SimpleNamespace(fetch=AsyncMock(return_value=[{'sport_id':1,'game_pk':849805,'away_team_name':'A','home_team_name':'B','last_source_status':'bookmaker_unavailable'}]))
    tg=SimpleNamespace(send_message=AsyncMock());ctx=SimpleNamespace(pool=Pool(conn),telegram=tg,admin_chat_id=1)
    await health.odds_health_tick(ctx);await health.odds_health_tick(ctx)
    tg.send_message.assert_awaited_once()
    monkeypatch.setattr(health,'_odds_last_notice',dt.datetime.now(dt.timezone.utc)-dt.timedelta(hours=2))
    conn.fetch.return_value=[]
    await health.odds_health_tick(ctx)
    assert tg.send_message.await_count==2


@pytest.mark.asyncio
async def test_valid_page_without_bookmaker_reports_availability_not_transport_failure(monkeypatch):
    c=candidate()
    c.game_datetime_utc=dt.datetime.now(dt.timezone.utc)+dt.timedelta(hours=3)
    missing={**scraped(),"start_time_utc":c.game_datetime_utc.isoformat()}
    monkeypatch.setattr(mod,"run_odds_scraper",AsyncMock(return_value={"games":[],"bookmaker_unavailable":[missing]}))
    monkeypatch.setattr(mod,"_stamp_partial_retry",AsyncMock())
    monkeypatch.setattr(mod,"_notify_status_change",AsyncMock())
    breaker=AsyncMock();monkeypatch.setattr(mod,"_anotar_breaker",breaker)
    telemetry=AsyncMock();monkeypatch.setattr(mod,"record_activity",telemetry)
    monkeypatch.setattr(mod,"_breaker_abierto",lambda _:False)
    monkeypatch.setattr(mod,"_MIN_SCRAPE_GAP_S",0)
    monkeypatch.setattr(mod,"_manual_waiting",[0])
    ctx=SimpleNamespace(pool=None,node_bin="node",vendor_dir="vendor",proxy_server="socks5://localhost:9050")
    assert await mod._scrape_and_apply(ctx,1,[c])==(0,"bookmaker_unavailable")
    assert breaker.call_args.kwargs["ok"] is True
    assert telemetry.call_args.kwargs["status"]=="bookmaker_unavailable"
