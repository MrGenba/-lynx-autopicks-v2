from basketball.injury_exit import signal,match
import asyncio
from datetime import datetime,timezone

def test_explicit_named_dated_exit():
    e=signal('Test Player',"Player left Tuesday's game with an ankle injury and did not return.",'2026-10-28')
    assert e['game_date']=='2026-10-27'

def test_no_low_minutes_inference():
    assert signal('Test Player','Player played only two minutes Tuesday.','2026-10-28') is None

def test_no_ambiguous_exit_or_return_or_wrong_subject():
    for s in ["Player left Tuesday's game with an ankle injury but returned.","Teammate left Tuesday's game with an ankle injury and did not return.","Player may have left Tuesday's game with an injury and did not return.","Player left the game with an injury and did not return."]:
        assert signal('Test Player',s,'2026-10-28') is None

def test_matching_preserves_actual_stats():
    games=[{'league':'NBA','game_id':'g','starts_at':'2026-10-27T23:00:00Z','status':'final','box_complete':True}]
    players=[{'game_id':'g','player_id':'p','player_name':'Test Player','minutes':3,'stats':{'points':2}}]
    item={'name':'Test Player','summary':"Player left Tuesday's game with a knee injury and did not return.",'date':'2026-10-28','source_url':'https://www.rotowire.com/basketball/player/test-1'}
    r=match(item,'NBA',games,players,'2026-10-28T12:00:00Z')
    assert r['game_id']=='g' and r['player_id']=='p'
    assert players[0]['minutes']==3 and players[0]['stats']['points']==2
    assert match(item,'WNBA',games,players,'2026-10-28T12:00:00Z') is None

def test_capture_uses_unambiguous_rest_timestamps():
    from basketball.injury_exit import capture
    calls=[]
    async def rest(path,*args):
        calls.append(path)
        assert '+00:00' not in path
        return []
    assert asyncio.run(capture(rest,'NBA',[],datetime(2026,10,28,12,tzinfo=timezone.utc)))==0
    assert 'starts_at=lt.2026-10-28T12:00:00Z' in calls[0]
