"""Normalize public SportsDataverse parquet files. No credentials or network writes.

Run: python basketball/import_history.py <download-directory>
Produces validated NDJSON plus a report. Current collection uses ESPN Core directly.
"""
import json,sys
from pathlib import Path
from datetime import datetime,timezone
import pandas as pd

FIELDS={'points':'points','rebounds':'rebounds','assists':'assists','steals':'steals','blocks':'blocks','turnovers':'turnovers','fouls':'fouls',
        'fgm':'field_goals_made','fga':'field_goals_attempted','fg3m':'three_point_field_goals_made','fg3a':'three_point_field_goals_attempted',
        'ftm':'free_throws_made','fta':'free_throws_attempted','orb':'offensive_rebounds','drb':'defensive_rebounds'}
def number(v):
    if pd.isna(v) or float(v)<0 or not float(v).is_integer(): raise ValueError('INVALID_COUNT')
    return int(v)
def stats(row,team=False):
    result={k:number(row['team_score' if team and k=='points' else 'total_rebounds' if team and k=='rebounds' else v]) for k,v in FIELDS.items()}
    if team: result['total_turnovers']=number(row.get('total_turnovers',row['turnovers']))
    if result['fgm']>result['fga'] or result['fg3m']>result['fg3a'] or result['fg3m']>result['fgm'] or result['ftm']>result['fta'] or result['points']!=2*result['fgm']+result['fg3m']+result['ftm'] or result['rebounds']!=result['orb']+result['drb']: raise ValueError('INCONSISTENT_STATS')
    return result
def game(row,league):
    name=row['status_type_name'];state='final' if row['status_type_completed']==True else 'scheduled'
    if 'POSTPON' in name:state='postponed'
    elif 'CANCEL' in name:state='cancelled'
    elif 'SUSPEND' in name:state='suspended'
    elif row['status_type_state']=='in':state='live'
    gid=str(int(row['game_id']))
    return {'league':league,'game_id':gid,'season':int(row.season),'season_type':int(row.season_type),'starts_at':pd.Timestamp(row['date']).tz_convert('UTC').isoformat(),
      'status':state,'neutral_site':bool(row['neutral_site']),'home_team_id':str(int(row['home_id'])),'away_team_id':str(int(row['away_id'])),
      'home_team':str(row['home_display_name']),'away_team':str(row['away_display_name']),
      'home_score':number(row['home_score']) if state=='final' else None,'away_score':number(row['away_score']) if state=='final' else None,
      'periods':int(row['status_period']) if pd.notna(row['status_period']) and row['status_period']>0 else None,'source':'sportsdataverse_espn',
      'source_url':f'https://sports.core.api.espn.com/v2/sports/basketball/leagues/{league.lower()}/events/{gid}',
      'source_checked_at':datetime.now(timezone.utc).isoformat()}
def convert(root,leagues=None,print_report=True):
    report=[]
    for league,seasons in (leagues or [('NBA',[2026,2027]),('WNBA',[2026])]):
      allowed=set(json.loads((root/f'{league}_teams.json').read_text())['ids'])
      output=root/f'{league}_history.ndjson';counts={'league':league,'games':0,'complete':0,'players':0,'exhibitions_excluded':0,'excluded':[]}
      with output.open('w',encoding='utf8') as f:
       for season in seasons:
        schedule=pd.read_parquet(root/f'{league}_schedule_{season}.parquet');teams=pd.read_parquet(root/f'{league}_team_box_{season}.parquet');players=pd.read_parquet(root/f'{league}_player_box_{season}.parquet')
        tg={str(int(k)):v for k,v in teams.groupby('game_id')};pg={str(int(k)):v for k,v in players.groupby('game_id')}
        for _,row in schedule.iterrows():
         if int(row.season_type) not in (2,3):continue
         g=game(row,league);payload={'game':g,'teams':[],'players':[]};gid=g['game_id']
         if g['home_team_id'] not in allowed or g['away_team_id'] not in allowed:
          counts['exhibitions_excluded']+=1;continue
         if g['status']=='final':
          try:
           tb=tg.get(gid);pb=pg.get(gid)
           if tb is None or pb is None or len(tb)!=2 or pb.athlete_id.duplicated().any():raise ValueError('INCOMPLETE_BOX')
           for _,t in tb.iterrows():
            tid=str(int(t.team_id));stat=stats(t,True)
            if tid not in [g['home_team_id'],g['away_team_id']] or stat['points']!=g['home_score' if tid==g['home_team_id'] else 'away_score']:raise ValueError('TEAM_IDENTITY_SCORE')
            payload['teams'].append({'league':league,'game_id':gid,'team_id':tid,'opponent_id':str(int(t.opponent_team_id)),'stats':stat,'source':'sportsdataverse_espn'})
           for _,p in pb.iterrows():
            dnp=bool(p.did_not_play);minutes=0 if dnp else float(p.minutes)
            if not 0<=minutes<=90:raise ValueError('MINUTES')
            payload['players'].append({'league':league,'game_id':gid,'team_id':str(int(p.team_id)),'player_id':str(int(p.athlete_id)),
             'player_name':str(p.athlete_display_name),'position':None if pd.isna(p.athlete_position_abbreviation) else str(p.athlete_position_abbreviation),
             'starter':bool(p.starter),'did_not_play':dnp,'minutes':minutes,'stats':None if dnp else stats(p),'source':'sportsdataverse_espn'})
           for t in payload['teams']:
            pp=[p for p in payload['players'] if p['team_id']==t['team_id'] and not p['did_not_play']]
            if len(pp)<5:raise ValueError('MISSING_PLAYERS')
            for key in ['points','fgm','fga','fg3m','fg3a','ftm','fta','assists','steals','blocks']:
             if sum(p['stats'][key] for p in pp)!=t['stats'][key]:raise ValueError('PLAYER_TEAM_TOTAL_'+key)
            if g['periods']:
             duration=(48 if league=='NBA' else 40)+max(0,g['periods']-4)*5
             if abs(sum(p['minutes'] for p in pp)-5*duration)>len(pp):raise ValueError('MINUTES_TOTAL')
           payload['receipt']={'complete':True,'collector':'sportsdataverse-validated-1','player_count':len(payload['players']),'team_count':2,'historical_publication_time_unknown':True}
           counts['complete']+=1;counts['players']+=len(payload['players'])
          except (ValueError,KeyError,TypeError) as e:
           counts['excluded'].append({'game_id':gid,'reason':str(e)});payload={'game':g,'teams':[],'players':[]}
         f.write(json.dumps(payload,ensure_ascii=False,allow_nan=False,separators=(',',':'))+'\n');counts['games']+=1
      report.append(counts)
    (root/'history_report.json').write_text(json.dumps(report,indent=2),encoding='utf8')
    if print_report:print(json.dumps(report))
    return report
if __name__=='__main__':convert(Path(sys.argv[1]))
