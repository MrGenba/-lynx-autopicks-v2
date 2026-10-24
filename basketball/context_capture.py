"""VPS-only pregame context; immutable evidence plus a fresh current pointer."""
import asyncio,json,os,re
from datetime import datetime,timedelta,timezone
from urllib.parse import urlparse
import httpx
from basketball.context_sources import ET,norm,digest,injury_pdf,lineups,news
from basketball.injury_reports import latest_report
from basketball.advanced_stats import NBA_TEAMS

WNBA_NAMES={'Atlanta Dream':'ATL','Chicago Sky':'CHI','Connecticut Sun':'CON','Dallas Wings':'DAL','Golden State Valkyries':'GSV','Indiana Fever':'IND','Las Vegas Aces':'LVA','Los Angeles Sparks':'LAS','Minnesota Lynx':'MIN','New York Liberty':'NYL','Phoenix Mercury':'PHO','Seattle Storm':'SEA','Washington Mystics':'WAS','Toronto Tempo':'TOR','Portland Fire':'POR'}
def abbreviation(g,side):
    return NBA_TEAMS.get(g[side+'_team_id']) if g['league']=='NBA' else WNBA_NAMES.get(g[side+'_team'])
def match_name(name,players,aliases=()):
    ids={p['player_id'] for p in [*players,*aliases] if norm(p['player_name'])==norm(name)}
    if not ids:
        # Publishers sometimes omit generational suffixes; keep the full remaining
        # name and exact team, and still reject any ambiguous canonical identity.
        key=lambda s:norm(re.sub(r'\s+(?:Jr\.?|Sr\.?|II|III|IV)$','',s,flags=re.I))
        ids={p['player_id'] for p in [*players,*aliases] if key(p['player_name'])==key(name)}
    return next(iter(ids)) if len(ids)==1 else None

def context_for(g,known,aliases,report,lu,headlines,sources):
    date=datetime.fromisoformat(g['starts_at'].replace('Z','+00:00')).astimezone(ET).date().isoformat()
    matchup=str(abbreviation(g,'away'))+'@'+str(abbreviation(g,'home'));teams={};players={};unmapped=[]
    for side in ['home','away']:
        tid=g[side+'_team_id'];code=abbreviation(g,side)
        catalog=[p for p in known if p['league']==g['league'] and p['team_id']==tid and p.get('season',0)>=g['season']-1]
        alias=[p for p in aliases if p['league']==g['league'] and p.get('team_abbreviation')==code and p.get('player_id') in {x['player_id'] for x in catalog}]
        team_name=lambda s:norm(s.replace('Los Angeles Clippers','LA Clippers'))
        injuries=[p for p in report.get('records',[]) if p['date']==date and p['matchup']==matchup and team_name(p['team'])==team_name(g[side+'_team'])]
        submitted=bool(injuries and all(p['submitted'] for p in injuries))
        candidates=[l for l in lu if l['team']==code and l['away']==abbreviation(g,'away') and l['home']==abbreviation(g,'home') and abs((datetime.fromisoformat(l['starts_at'])-datetime.fromisoformat(g['starts_at'].replace('Z','+00:00'))).total_seconds())<=20*60]
        lineup=candidates[0] if len(candidates)==1 else None;starters=[]
        if lineup:
            for p in lineup['players']:
                pid=match_name(p['name'],catalog,alias)
                if pid:starters.append(pid)
                else:unmapped.append({'team_id':tid,'name':p['name'],'source':'lineup'})
        confirmed=bool(lineup and lineup['confirmed'] and len(starters)==5)
        teams[tid]={'injury_report_submitted':submitted,'lineup':'CONFIRMED' if confirmed else 'UNMAPPED' if lineup and lineup['confirmed'] else 'EXPECTED' if lineup else 'UNKNOWN','starters':starters,'team_name':g[side+'_team']}
        for p in catalog:
            players[p['player_id']]={'player_id':p['player_id'],'name':p['player_name'],'team_id':tid,'availability':'NOT_LISTED' if submitted else 'UNVERIFIED','role':'STARTER' if confirmed and p['player_id'] in starters else 'BENCH' if confirmed else 'UNKNOWN','expected_starter':bool(lineup and p['player_id'] in starters),'news':[]}
        for item in injuries:
            if not item['player_name']:continue
            pid=match_name(item['player_name'],catalog,alias)
            if not pid:unmapped.append({'team_id':tid,'name':item['player_name'],'source':'injury','status':item['status']});continue
            players[pid].update(availability=item['status'],injury_reason=item['reason'],injury_source=report['source_url'])
            if confirmed and pid in starters and item['status'] in ['OUT','DOUBTFUL','SUSPENDED','INACTIVE']:
                players[pid]['availability']='CONFLICT'
        for item in headlines:
            if item['team']!=code:continue
            pid=match_name(item['name'],catalog,alias)
            if not pid:continue
            players[pid]['news'].append(item)
            # Date-only headlines cannot overturn a timed official status. Unresolved
            # health/role news is a blocker, never a numeric sentiment adjustment.
            rotation=item.get('rotation',{})
            applicable=rotation.get('target_date')==date
            if applicable:
                players[pid].setdefault('rotation_evidence',[]).append({**rotation,'source_url':item['source_url'],'published_date':item['date'],'date_precision':item.get('date_precision','day')})
            # A sourced cap resolves the workload question, never the medical status.
            known_cap=applicable and rotation.get('numeric_evidence')=='EXPLICIT_STAFF_CAP'
            if item['availability_risk'] and not known_cap and (not submitted or players[pid]['availability']=='NOT_LISTED'):
                players[pid]['news_unresolved']=True
    model_inputs={'teams':teams,'players':{pid:{k:v for k,v in p.items() if k!='injury_source'} for pid,p in players.items()},'sources':sources,'unmapped':unmapped}
    return {'policy':'bk-context-1','model_revision':digest(model_inputs),'league':g['league'],'game_id':g['game_id'],'teams':teams,'players':players,'unmapped':unmapped,'sources':sources,'report_published_at':report.get('published_at'),'report_url':report.get('source_url')}

async def run():
    from basketball.storage import rest_config
    now=datetime.now(timezone.utc);base,headers=rest_config()
    async with httpx.AsyncClient(timeout=25) as client:
        async def rest(path,body=None,prefer=None):
            r=await client.request('GET' if body is None else 'POST',base+path,headers={**headers,**({'Prefer':prefer} if prefer else {})},**({'json':body} if body is not None else {}))
            if r.status_code>=300:raise RuntimeError('DATABASE_HTTP_'+str(r.status_code))
            return r.json() if r.content else None
        async def all_rows(path):
            out=[]
            for off in range(0,10000,1000):
                rows=await rest(path+'&limit=1000&offset='+str(off));out+=rows
                if len(rows)<1000:return out
            raise RuntimeError('CONTEXT_ROWS_LIMIT')
        games=await rest('bk_games?status=eq.scheduled&starts_at=gt.'+now.isoformat().replace('+00:00','Z')+'&starts_at=lt.'+(now+timedelta(hours=36)).isoformat().replace('+00:00','Z')+'&select=*')
        known=await rest('rpc/bk_player_identity_catalog',{});aliases=await all_rows('bk_player_advanced_current?dataset=eq.stats_base&select=league,player_id,player_name,team_abbreviation')
        blocked=await rest('bk_state?component=eq.context_source_access&status=eq.blocked&select=league,detail')
        async def fetch(source,url):
            if any(s['league']=='ALL' and s['detail'].get('source')==source for s in blocked):raise RuntimeError('SOURCE_ACCESS_BLOCKED')
            r=await client.get(url)
            if r.status_code in [401,403]:
                # One persistent state row per provider; do not rotate IPs or retry denials.
                entry={'league':source,'component':'context_source_access','status':'blocked','checked_at':now.isoformat(),'detail':{'source':source,'http':r.status_code}}
                await rest('bk_state?on_conflict=league,component',entry,'resolution=merge-duplicates,return=minimal');blocked.append({'league':'ALL','detail':{'source':source}})
            return r
        # Restore access circuit identities independently of league state.
        blocked=[{'league':'ALL','detail':s['detail']} for s in blocked]
        reports=[]
        for league in ['NBA','WNBA']:
            gs=[g for g in games if g['league']==league];sources={};report={};lu=[];ns=[]
            if gs:
                source=league+'_injury_pdf'
                if any(s['detail'].get('source')==source for s in blocked):
                    sources['injuries']='SOURCE_ACCESS_BLOCKED'
                else:
                    prior=await rest('bk_state?league=eq.'+league+'&component=eq.injury_report&select=detail')
                    report,detail=await latest_report(league,now,client.get,prior[0]['detail'] if prior else None)
                    sources['injuries']=detail['source_status']
                    await rest('bk_state?on_conflict=league,component',{'league':league,'component':'injury_report','checked_at':now.isoformat(),'status':detail['source_status'],'detail':detail},'resolution=merge-duplicates,return=minimal')
                    if detail.get('blocked'):
                        await rest('bk_state?on_conflict=league,component',{'league':source,'component':'context_source_access','checked_at':now.isoformat(),'status':'blocked','detail':{'source':source,'http':detail.get('http'),'url':detail['last_attempt_url'],'control_http':detail.get('control_http')}},'resolution=merge-duplicates,return=minimal')
                for kind in ['lineups','news']:
                    path=('basketball/nba-lineups.php' if league=='NBA' else 'wnba/lineups.php') if kind=='lineups' else ('basketball/news.php' if league=='NBA' else 'wnba/news.php')
                    try:
                        response=await fetch('rotowire_'+league+'_'+kind,'https://www.rotowire.com/'+path)
                        if response.status_code!=200:raise RuntimeError('SOURCE_HTTP_'+str(response.status_code))
                        if kind=='lineups':lu=lineups(response.text,league,now)
                        else:
                            incoming=news(response.text,league,now)
                            cached=await rest('bk_state?league=eq.'+league+'&component=eq.news_cache&select=detail')
                            previous=cached[0]['detail'].get('items',[]) if cached else []
                            # Headlines scroll off the public page; preserve recent
                            # captured restrictions instead of silently forgetting them.
                            items={}
                            for item in [*previous,*incoming]:
                                try:
                                    age=(now.astimezone(ET).date()-datetime.fromisoformat(item['date']).date()).days
                                except (ValueError,KeyError):continue
                                if 0<=age<=2:items[(item['source_url'],item['date'],item['headline'])]=item
                            ns=sorted(items.values(),key=lambda item:item['date'],reverse=True)[:500]
                            await rest('bk_state?on_conflict=league,component',{'league':league,'component':'news_cache','checked_at':now.isoformat(),'status':'healthy','detail':{'items':ns,'retention_days':2,'max_items':500}},'resolution=merge-duplicates,return=minimal')
                        sources[kind]='OK'
                    except Exception as e:sources[kind]=str(e) if isinstance(e,(ValueError,RuntimeError)) else 'SOURCE_FAILED'
            snapshots=0
            for g in gs:
                body=context_for(g,known,aliases,report,lu,ns,sources);revision=digest(body)
                await rest('rpc/bk_store_context',{'p_row':{'snapshot_id':revision,'league':league,'game_id':g['game_id'],'observed_at':now.isoformat(),'body':body}});snapshots+=1
            health='source_error' if any(s not in ['OK','AWAITING_REPORT'] for s in sources.values()) else 'healthy' if gs and all(s=='OK' for s in sources.values()) else 'partial' if gs else 'no_games'
            state={'league':league,'component':'context','checked_at':now.isoformat(),'status':health,'detail':{'games':len(gs),'snapshots':snapshots,'sources':sources,'injury_rows':len(report.get('records',[])),'lineup_teams':len(lu),'confirmed_teams':sum(x['confirmed'] for x in lu),'news':len(ns)}}
            await rest('bk_state?on_conflict=league,component',state,'resolution=merge-duplicates,return=minimal');reports.append(state)
        return {'reports':reports}
if __name__=='__main__':
    try:print(json.dumps(asyncio.run(run())))
    except Exception:print(json.dumps({'status':'error','error':'CONTEXT_CAPTURE_FAILED'}));raise SystemExit(1)
