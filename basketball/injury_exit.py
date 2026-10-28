"""Conservative named-player, dated evidence. Never infer injury from low minutes."""
import re
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

POLICY='bk-explicit-injury-exit-1'
ET=ZoneInfo('America/New_York')
WEEKDAYS=['monday','tuesday','wednesday','thursday','friday','saturday','sunday']

def signal(name, summary, published_date):
    if not name or not published_date:return None
    try:published=date.fromisoformat(published_date)
    except ValueError:return None
    surname=re.sub(r'\s+(?:Jr\.?|Sr\.?|II|III|IV)$','',name,flags=re.I).split()[-1]
    text=summary.replace('\u2019',"'")
    subject=r'\b(?:'+re.escape(name)+'|'+re.escape(surname)+r')\b\s*(?:\([^)]*\)\s*)?(?:(?:has|had)\s+)?(?:left|exited|departed)\b'
    for sentence in re.split(r'(?<=[.!?])\s+',text):
        if not re.search(subject,sentence,re.I):continue
        if re.search(r"\b(?:might|may|could|did not leave|didn't leave)\b",sentence,re.I):continue
        if not re.search(r'\b(?:injury|injured|sprain|strain|concussion|soreness|pain|tightness)\b',sentence,re.I):continue
        if not re.search(r"\b(?:did not return|didn't return|will not return|won't return|ruled out for (?:the )?(?:rest|remainder))\b",sentence,re.I):continue
        low=sentence.lower();day=None
        if 'yesterday' in low:day=published-timedelta(days=1)
        elif re.search(r'\b(?:today|tonight)\b',low):day=published
        else:
            days=[i for i,d in enumerate(WEEKDAYS) if re.search(r'\b'+d+r"(?:'s)?\b",low)]
            if len(days)==1:
                delta=(published.weekday()-days[0])%7
                if delta<=2:day=published-timedelta(days=delta)
        if day:return {'policy':POLICY,'status':'EXITED_INJURY_NO_RETURN','game_date':day.isoformat(),'evidence':sentence[:1200]}
    return None

def match(item,league,games,players,observed_at):
    e=signal(item.get('name',''),item.get('summary',''),item.get('date'))
    if not e or not re.match(r'^https://www\.rotowire\.com/(basketball|wnba)/',item.get('source_url','')):return None
    # Exact canonical identity plus a unique completed game on the explicit date.
    key=lambda s:re.sub(r'[^a-z0-9]','',s.lower())
    ids={p['player_id'] for p in players if key(p['player_name'])==key(item['name'])}
    if len(ids)!=1:return None
    pid=next(iter(ids));found=[]
    for g in games:
        if g['league']!=league or g['status']!='final' or not g.get('box_complete'):continue
        if datetime.fromisoformat(g['starts_at'].replace('Z','+00:00')).astimezone(ET).date().isoformat()!=e['game_date']:continue
        p=next((p for p in players if p['game_id']==g['game_id'] and p['player_id']==pid and p.get('minutes',0)>0 and not p.get('did_not_play')),None)
        if p:found.append((g,p))
    if len(found)!=1:return None
    g,p=found[0]
    published=datetime.combine(date.fromisoformat(item['date']),datetime.min.time(),ET).isoformat()
    return {'league':league,'game_id':g['game_id'],'player_id':pid,'observed_at':observed_at,'evidence':{**e,'player_id':pid,'game_id':g['game_id'],'source_url':item['source_url'],'published_at':published,'published_date':item['date'],'date_precision':'day','observed_at':observed_at}}

async def capture(rest,league,items,now):
    end=now.isoformat().replace('+00:00','Z');start=(now-timedelta(days=4)).isoformat().replace('+00:00','Z')
    games=await rest('bk_games?league=eq.'+league+'&status=eq.final&box_complete=eq.true&starts_at=gte.'+start+'&starts_at=lt.'+end+'&select=*')
    if not games:return 0
    ids=','.join(g['game_id'] for g in games)
    players=await rest('bk_player_box?league=eq.'+league+'&game_id=in.('+ids+')&select=game_id,player_id,player_name,team_id,minutes,did_not_play')
    rows={}
    for item in items:
        row=match(item,league,games,players,end)
        if row:rows[(row['league'],row['game_id'],row['player_id'])]=row
    if rows:await rest('bk_player_game_evidence?on_conflict=league,game_id,player_id',list(rows.values()),'resolution=ignore-duplicates,return=minimal')
    return len(rows)
