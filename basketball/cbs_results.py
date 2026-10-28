"""Validated public NBA final boxes, fetched directly by the VPS (no login/proxy)."""
import html,json,re,time
from datetime import datetime,timezone
from bs4 import BeautifulSoup
from basketball.context_capture import match_name
from basketball.context_sources import norm,ET
from basketball.advanced_stats import NBA_TEAMS

SOURCE='cbs_public_boxscore'
CBS_CODES={'NYK':'NY','GSW':'GS','NOP':'NO','SAS':'SA','UTA':'UTA','PHX':'PHO'}
# Explicit publisher aliases, never fuzzy surname or initial matching.
# https://gleague.nba.com/player/1641842/ronald-holland-ii
# https://www.cbssports.com/nba/players/28952672/gregory-jackson/
NAME_ALIASES={'ron holland':'Ronald Holland II','gregory jackson':'GG Jackson'}
def url_for(g):
    if g['league']!='NBA':raise ValueError('CBS_LEAGUE_UNSUPPORTED')
    codes={tid:CBS_CODES.get(code,code) for tid,code in NBA_TEAMS.items()}
    day=datetime.fromisoformat(g['starts_at'].replace('Z','+00:00')).astimezone(ET).strftime('%Y%m%d')
    return 'https://www.cbssports.com/nba/gametracker/boxscore/NBA_'+day+'_'+codes[g['away_team_id']]+'%40'+codes[g['home_team_id']]+'/'
def count(s):
    if not re.fullmatch(r'\d+',str(s).strip()):raise ValueError('CBS_COUNT_INVALID')
    return int(s)
def pair(s):
    m=re.match(r'^(\d+)[/-](\d+)(?:\s|$)',s)
    if not m:raise ValueError('CBS_SHOOTING_INVALID')
    a,b=map(int,m.groups())
    if a>b:raise ValueError('CBS_SHOOTING_INVALID')
    return a,b
def consistent(s):
    if s['points']!=2*s['fgm']+s['fg3m']+s['ftm'] or s['fg3m']>s['fgm'] or s['rebounds']!=s['orb']+s['drb']:raise ValueError('CBS_STATS_INCONSISTENT')
def parse(page,g,known,now):
    soup=BeautifulSoup(page,'html.parser')
    m=re.search(r"var current_game_scoreboard = JSON.parse\('([^\n]+?)'",page)
    if not m:raise ValueError('CBS_SCOREBOARD_MISSING')
    board=json.loads(html.unescape(m[1]))
    if board['status']!='FINAL':raise ValueError('CBS_NOT_FINAL')
    if datetime.fromisoformat(g['starts_at'].replace('Z','+00:00'))>=now:raise ValueError('CBS_FUTURE_GAME')
    if abs(float(board['scheduled_epoch'])-datetime.fromisoformat(g['starts_at'].replace('Z','+00:00')).timestamp())>1200:raise ValueError('CBS_GAME_TIME_MISMATCH')
    team_norm=lambda x:norm(x.replace('Los Angeles Clippers','LA Clippers'))
    for side in ('home','away'):
        if board[side+'team']['league']!=g['league'] or team_norm(board[side+'team']['name'])!=team_norm(g[side+'_team']):raise ValueError('CBS_TEAM_MISMATCH')
    quarters=[board['game_status'][s+'score']['quarter'] for s in ('home','away')]
    periods=int(board['game_status']['quarter'])
    scores={s:count(board[s+'TeamScore']) for s in ('home','away')}
    if periods<4 or scores['home']==scores['away'] or any(len(q)!=periods or sum(count(v) for v in q.values())!=scores[s] for q,s in zip(quarters,('home','away'))):raise ValueError('CBS_PERIOD_SCORE_MISMATCH')
    if any(set(q)!=set(map(str,range(1,periods+1))) for q in quarters):raise ValueError('CBS_PERIOD_KEYS_INVALID')
    period_scores={side:[count(q[str(i)]) for i in range(1,periods+1)] for side,q in zip(('home','away'),quarters)}
    if any(sum(period_scores['home'][:i])!=sum(period_scores['away'][:i]) for i in range(4,periods)):raise ValueError('CBS_OVERTIME_TIE_MISMATCH')
    game={**g,'status':'final','home_score':scores['home'],'away_score':scores['away'],'periods':periods,'source':SOURCE,'source_url':url_for(g),'source_checked_at':now.isoformat()}
    payload={'game':game,'teams':[],'players':[]}
    # A validated final score remains useful if the player identities are incomplete.
    try:
        rows={}
        for tr in soup.select('#team-stats-container table.team-stats tbody tr'):
            cells=[c.get_text(' ',strip=True) for c in tr.select('td')]
            if len(cells)==3:rows[cells[0]]=cells[1:]
        omitted=[]
        for side,index in [('away',0),('home',1)]:
            tid=g[side+'_team_id'];opponent=g['home_team_id' if side=='away' else 'away_team_id']
            stat={key:count(rows[label][index]) for key,label in {'points':'Points','orb':'Offensive','drb':'Defensive','assists':'Assists','steals':'Steals','blocks':'Blocks','turnovers':'Turnovers','fouls':'Fouls'}.items()}
            stat['rebounds']=stat['orb']+stat['drb'];stat['total_turnovers']=stat['turnovers']
            for k,label in [('fg','Field Goals'),('fg3','3-Pointers'),('ft','Free Throws')]:stat[k+'m'],stat[k+'a']=pair(rows[label][index])
            consistent(stat)
            if stat['points']!=scores[side]:raise ValueError('CBS_BOX_SCORE_MISMATCH')
            payload['teams'].append({'league':g['league'],'game_id':g['game_id'],'team_id':tid,'opponent_id':opponent,'stats':stat,'source':SOURCE})
            catalog=[p for p in known if p['league']==g['league'] and p['team_id']==tid and p.get('season',0)>=g['season']-1]
            found={}
            for table in soup.select('#player-stats-'+side+' table.stats-table'):
                header=table.select_one('tr.header-row')
                if not header:continue
                cols=[c.get_text(' ',strip=True) for c in header.select('td')]
                if cols[0] not in ('Starters','Bench'):continue
                for tr in table.select('tr.data-row'):
                    cells=tr.select('td');a=cells[0].find('a',href=re.compile(r'/nba/players/\d+/')) if cells else None
                    if not a or len(cells)!=len(cols):raise ValueError('CBS_PLAYER_ROW_INVALID')
                    slug=a['href'].rstrip('/').rsplit('/',1)[-1];name=slug.replace('-',' ')
                    values=dict(zip(cols,[c.get_text(' ',strip=True) for c in cells]));dnp=values['MIN']=='-'
                    name=NAME_ALIASES.get(name,name)
                    pid=match_name(name,catalog)
                    # A completed box is new team evidence after a trade. Permit only
                    # a globally unique exact full name in the existing league catalog.
                    global_matches={p['player_id'] for p in known if p['league']==g['league'] and norm(p['player_name'])==norm(name)}
                    if not pid and len(global_matches)==1:pid=next(iter(global_matches))
                    if not pid:
                        if dnp:omitted.append(name);continue
                        raise ValueError('CBS_ACTIVE_PLAYER_UNMAPPED:'+name)
                    p={'league':g['league'],'game_id':g['game_id'],'team_id':tid,'player_id':pid,'player_name':next(p['player_name'] for p in known if p['league']==g['league'] and p['player_id']==pid),'position':None,'starter':cols[0]=='Starters','did_not_play':dnp,'minutes':0 if dnp else count(values['MIN']),'stats':None,'source':SOURCE}
                    if not dnp:
                        p['stats']={k:count(values[v]) for k,v in {'points':'PTS','rebounds':'REB','assists':'AST','fouls':'PF','steals':'STL','blocks':'BLK','turnovers':'TO','orb':'OREB','drb':'DREB'}.items()}
                        for k,label in [('fg','FG'),('fg3','3PT'),('ft','FT')]:p['stats'][k+'m'],p['stats'][k+'a']=pair(values[label])
                        consistent(p['stats'])
                    if pid in found and found[pid]!=p:raise ValueError('CBS_DUPLICATE_CONFLICT')
                    found[pid]=p
            active=[p for p in found.values() if not p['did_not_play']]
            if len(active)<5 or sum(p['starter'] for p in active)!=5:raise ValueError('CBS_PLAYERS_INCOMPLETE')
            for k in ('points','fgm','fga','fg3m','fg3a','ftm','fta','assists','steals','blocks'):
                if sum(p['stats'][k] for p in active)!=stat[k]:raise ValueError('CBS_PLAYER_TOTAL_'+k.upper())
            if abs(sum(p['minutes'] for p in active)-5*(48+5*(periods-4)))>len(active):raise ValueError('CBS_MINUTES_TOTAL')
            payload['players'].extend(found.values())
        if len({p['player_id'] for p in payload['players']})!=len(payload['players']):raise ValueError('CBS_PLAYER_TEAM_CONFLICT')
        payload['receipt']={'complete':True,'collector':'cbs-validated-1','team_count':2,'player_count':len(payload['players']),'omitted_unmapped_dnp':sorted(set(omitted)),'source_url':game['source_url'],'observed_at':now.isoformat(),'minutes_precision':'rounded_whole_minutes'}
    except (ValueError,KeyError,TypeError) as e:
        payload={'game':game,'teams':[],'players':[],'receipt':{'complete':False,'collector':'cbs-validated-1','reason':str(e) if isinstance(e,ValueError) else 'CBS_BOX_FIELDS_MISSING'}}
    payload['receipt']['period_scores']=period_scores
    return payload

async def refresh(client,rest,now):
    from datetime import timedelta
    iso=lambda d:d.isoformat().replace('+00:00','Z')
    games=await rest('bk_games?league=eq.NBA&status=in.(scheduled,live,final)&box_complete=eq.false&starts_at=gt.'+iso(now-timedelta(days=3))+'&starts_at=lt.'+iso(now-timedelta(hours=3))+'&order=starts_at.asc&limit=40&select=*')
    access=await rest('bk_state?league=eq.NBA&component=eq.cbs_results_access&status=eq.blocked&select=detail')
    result={'games':len(games),'finals':0,'boxes':0,'errors':[]}
    if access:return {**result,'status':'access_denied'}
    known=await rest('rpc/bk_player_identity_catalog',{}) if games else []
    started=time.monotonic()
    for g in games:
        if time.monotonic()-started>180:result['errors'].append({'error':'CBS_TIME_BUDGET'});break
        try:
            response=await client.get(url_for(g),timeout=20)
            if response.status_code in (401,403):
                await rest('bk_state?on_conflict=league,component',{'league':'NBA','component':'cbs_results_access','status':'blocked','checked_at':now.isoformat(),'detail':{'http':response.status_code}},'resolution=merge-duplicates,return=minimal')
                result['errors'].append({'game_id':g['game_id'],'error':'CBS_ACCESS_DENIED'});break
            if response.status_code!=200:raise ValueError('CBS_HTTP_'+str(response.status_code))
            payload=parse(response.text,g,known,now)
            await rest('rpc/bk_store_game',{'p_payload':payload});result['finals']+=1;result['boxes']+=int(payload['receipt']['complete'])
            if not payload['receipt']['complete']:result['errors'].append({'game_id':g['game_id'],'error':payload['receipt']['reason']})
        except Exception as e:result['errors'].append({'game_id':g['game_id'],'error':str(e) if isinstance(e,ValueError) else 'CBS_FETCH_FAILED'})
    return {**result,'status':'partial' if result['errors'] else 'healthy'}
