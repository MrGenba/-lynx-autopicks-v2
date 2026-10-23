"""Hourly, public SportsDataverse snapshots. No retries around ESPN access denials.

Runs only in the server; credentials come from its existing private environment.
Incomplete boxes stay pending and a delayed source is explicitly reported.
"""
import asyncio,hashlib,json,os,tempfile
from datetime import datetime,timezone,timedelta
from pathlib import Path
import httpx
from basketball.import_history import convert

ROOT=Path(tempfile.gettempdir())/'lynx_basketball_snapshots'
REGISTRIES=Path(__file__).parent/'registries'
def snapshot_url(league,season,kind):
    repo='hoopR-nba-data' if league=='NBA' else 'wehoop-wnba-data'
    prefix=league.lower();folder='schedules' if kind=='schedule' else kind
    filename=f'{prefix}_schedule_{season}' if kind=='schedule' else f'{kind}_{season}'
    return f'https://raw.githubusercontent.com/sportsdataverse/{repo}/main/{prefix}/{folder}/parquet/{filename}.parquet'

async def run():
    ROOT.mkdir(exist_ok=True)
    now=datetime.now(timezone.utc)
    base=os.environ['SUPABASE_URL'].rstrip('/')+'/rest/v1/'
    headers={'apikey':os.environ['SUPABASE_KEY'],'Authorization':'Bearer '+os.environ['SUPABASE_KEY']}
    async with httpx.AsyncClient(timeout=40) as client:
      async def rest(path,body=None,prefer=None):
        response=await client.request('GET' if body is None else 'POST',base+path,headers={**headers,**({'Prefer':prefer} if prefer else {})},**({'json':body} if body is not None else {}))
        if response.status_code>=300:raise RuntimeError('DATABASE_HTTP_'+str(response.status_code))
        return response.json() if response.content else None
      reports=[]
      for league,season in [('NBA',now.year+(now.month>=9)),('WNBA',now.year)]:
       state={'source':'sportsdataverse_public_parquet','season':season,'live_source':'ESPN_ACCESS_DENIED','player_props_odds':'NO_PROVIDER'}
       try:
        urls={}
        for kind in ['schedule','team_box','player_box']:
          url=snapshot_url(league,season,kind)
          response=await client.get(url)
          if response.status_code!=200:raise RuntimeError('SNAPSHOT_HTTP_'+str(response.status_code))
          (ROOT/f'{league}_{kind}_{season}.parquet').write_bytes(response.content);urls[kind]=url
        (ROOT/f'{league}_teams.json').write_text((REGISTRIES/f'{league}.json').read_text())
        summary=convert(ROOT,[(league,[season])],False)[0]
        cache_file=ROOT/f'{league}_stored_hashes.json';cache=json.loads(cache_file.read_text()) if cache_file.exists() else {}
        rows=[json.loads(line) for line in (ROOT/f'{league}_history.ndjson').read_text(encoding='utf8').splitlines()]
        changed=[];updates={}
        for payload in rows:
          g=payload['game'];g['source_url']=urls['schedule'];stable=json.loads(json.dumps(payload));stable['game'].pop('source_checked_at',None)
          digest=hashlib.sha256(json.dumps(stable,sort_keys=True).encode()).hexdigest()
          if cache.get(g['game_id'])!=digest:changed.append(payload);updates[g['game_id']]=digest
        for i in range(0,len(changed),15):await rest('rpc/bk_import_batch',{'p_payloads':changed[i:i+15]})
        cache.update(updates);cache_file.write_text(json.dumps(cache))
        past=now-timedelta(hours=5)
        recent=now-timedelta(days=3)
        overdue=[p['game']['game_id'] for p in rows if recent<datetime.fromisoformat(p['game']['starts_at'])<past and p['game']['status'] in ('scheduled','live','final') and not p.get('receipt',{}).get('complete')]
        completed=[p['game']['starts_at'] for p in rows if p.get('receipt',{}).get('complete')]
        state.update({'games':summary['games'],'valid_boxes':summary['complete'],'players':summary['players'],'updated':len(changed),'incomplete_boxes':len(summary['excluded']),
          'recent_missing':overdue,'latest_completed_start':max(completed) if completed else None,'source_urls':urls})
        state['status']='delayed' if overdue else 'daily_snapshot_ok'
       except Exception as error:
        msg=str(error);state.update({'status':'error','error':msg if msg.startswith(('DATABASE_HTTP_','SNAPSHOT_HTTP_')) else 'SNAPSHOT_IMPORT_FAILED'})
       await rest('bk_state?on_conflict=league,component',{'league':league,'component':'capture','status':state['status'],'checked_at':now.isoformat(),'detail':state},'resolution=merge-duplicates,return=minimal')
       reports.append({'league':league,**state})
      return {'at':now.isoformat(),'reports':reports}

if __name__=='__main__':
    try:print(json.dumps(asyncio.run(run())))
    except Exception:print(json.dumps({'status':'error','error':'SNAPSHOT_JOB_FAILED'}));raise SystemExit(1)
