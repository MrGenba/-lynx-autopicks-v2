'use strict';
const {VERSION:ADVANCED,buildAdvanced}=require('./advanced_model');
const {notify}=require('./notifications');
const legacy=require('./legacy_context');
const minutes=require('./minutes_model');
const matchup=require('./player_matchup');
const {fingerprint}=require('./fingerprint');
const VERSION='bk-player-context-2';
const INPUT_VERSION='bk-advanced-input-2';
const POLICY='bk-player-context-prospective-2';
const unavailable=s=>['OUT','SUSPENDED','INACTIVE'].includes(s);
function currentOK(current,now){return !!current?.body?.model_revision&&Number.isFinite(Date.parse(current.checked_at))&&Date.parse(current.checked_at)<=now.getTime()+60000&&Date.parse(current.checked_at)>=now.getTime()-10*60000;}
function contextReasons(f,current,now){
 const reasons=[];
 if(!currentOK(current,now))return ['CONTEXT_STALE_OR_MISSING'];
 if(f?.context?.revision!==current.body.model_revision)return ['CONTEXT_CHANGED'];
 if(Object.values(current.body.sources||{}).some(s=>s!=='OK')||Object.keys(current.body.sources||{}).length!==3)reasons.push('CONTEXT_SOURCE_UNAVAILABLE');
 if(!current.body.report_published_at||Date.parse(current.body.report_published_at)<now.getTime()-6*3600000||Date.parse(current.body.report_published_at)>now.getTime())reasons.push('INJURY_REPORT_STALE');
 reasons.push(...(f?.context?.blockers||[]));
 if((current.body.unmapped||[]).some(p=>p.source==='injury'&&p.status!=='AVAILABLE'&&(!f?.player_id||p.team_id===f.team_id)))reasons.push('INJURY_IDENTITY_UNRESOLVED');
 if(f?.player_id){
  const p=current.body.players?.[f.player_id];
  if(!p||!['AVAILABLE','NOT_LISTED','PROBABLE'].includes(p.availability))reasons.push('PARTICIPATION_UNCONFIRMED');
  if(p?.availability==='PROBABLE'&&f.context.lineup!=='CONFIRMED')reasons.push('PARTICIPATION_UNCONFIRMED');
  if(f.context.lineup!=='CONFIRMED')reasons.push('LINEUP_UNCONFIRMED');
  if(p?.news_unresolved)reasons.push('NEWS_UNRESOLVED');
 }else if(Object.values(current.body.teams).some(t=>t.lineup!=='CONFIRMED'||!t.injury_report_submitted))reasons.push('LINEUP_OR_REPORT_UNCONFIRMED');
 return [...new Set(reasons)];
}
function derive(game,forecasts,current,history,now,comparison=[]){
 if(!currentOK(current,now))return [];
 const originals=forecasts.filter(f=>[ADVANCED,INPUT_VERSION].includes(f.model_version)),body=current.body;
 const rows=legacy.derive(game,originals.map(r=>({...r,model_version:ADVANCED})),current,history,now).map(row=>{
  const source=originals.find(f=>(f.player_id||null)===(row.player_id||null)),old=row.result;
  if(!row.player_id)return {...row,result:{...old,model_version:VERSION,context:{...old.context,base_model:source.model_version}}};
  const estimate=minutes.estimate(source.result,game,history,body,originals.map(f=>f.result),now);
  let f=minutes.apply({...source.result,availability:old.availability,context:old.context},estimate);
  f.context={...f.context,base_model:source.model_version,blockers:estimate.blockers,original_minutes:source.result.projected_minutes,role_sample:estimate.sample,minutes_adjusted:Math.abs(f.projected_minutes-source.result.projected_minutes)>.01};
  f.model_version=VERSION;return {...row,result:f};
 });
 minutes.constrainTeam(rows.filter(r=>r.player_id).map(r=>r.result),game);
 for(const row of rows.filter(r=>r.player_id)){
  row.result=matchup.apply(row.result,game,history,now);
  row.result.context.minutes_adjusted=Math.abs(row.result.projected_minutes-row.result.context.original_minutes)>.01;
  if(row.result.defense.status!=='APPLIED')row.result.context.blockers.push('OPPONENT_CONTEXT_MISSING');
  row.result.context.blockers=[...new Set(row.result.context.blockers)];
 }
 const team=rows.find(r=>!r.player_id);
 if(team&&rows.some(r=>r.result.context.blockers.some(b=>['RETURN_MINUTES_UNCERTAIN','STAFF_REPORTS_CONFLICT','STAFF_WORKLOAD_UNQUANTIFIED'].includes(b))))team.result.context.blockers.push('ROTATION_IMPACT_UNMODELED');
 // Separate generation identity from the availability revision. Fresh historical
 // and advanced inputs create a new immutable forecast even if lineups are stable.
 const inputRevision=fingerprint({version:VERSION,revision:body.model_revision,players:rows.map(r=>({id:r.player_id,props:r.result.props,minutes:r.result.minutes,defense:r.result.defense,advanced:r.result.advanced,blockers:r.result.context.blockers})),team:team&&[team.result.home_points,team.result.away_points,team.result.p_home,team.result.total_variance,team.result.margin_variance]});
 return rows.map(row=>({...row,forecast_id:[VERSION,game.league,game.game_id,row.player_id||'team',inputRevision].join(':'),model_version:VERSION,as_of:now.toISOString(),result:{...row.result,context:{...row.result.context,input_revision:inputRevision},evaluation:{protocol:POLICY,base_forecast_id:comparison.find(f=>(f.player_id||null)===(row.player_id||null))?.forecast_id||null}}}));
}
function inputs(game,history,current,stats,forecasts,now,rosters=[]){
 if(!currentOK(current,now))return [];
 const roster=[game.home_team_id,game.away_team_id].map(team_id=>{
  const fresh=rosters.find(r=>r.team_id===team_id&&r.game_id===game.game_id&&Date.parse(r.observed_at)<=now.getTime()&&Date.parse(r.observed_at)>now.getTime()-3*3600000);
  const ids=new Set(fresh?fresh.players.map(p=>p.player_id):forecasts.filter(f=>f.model_version===ADVANCED&&f.player_id&&f.result.team_id===team_id).map(f=>f.player_id));
  if(!fresh){
   const recent=history.teams.filter(t=>t.team_id===team_id&&t.game.season===game.season&&Date.parse(t.game.starts_at)>now.getTime()-30*86400000).at(-1);
   if(recent)for(const p of history.players.filter(p=>p.team_id===team_id&&p.game_id===recent.game_id))ids.add(p.player_id);
  }
  for(const p of Object.values(current.body.players||{}))if(p.team_id===team_id&&(p.expected_starter||p.role==='STARTER'||(p.rotation_evidence||[]).some(e=>e.returning)))ids.add(p.player_id);
  return {team_id,players:[...ids].sort().map(player_id=>({player_id}))};
 });
 const eligible={games:history.games.filter(g=>[2,3].includes(g.season_type)),teams:history.teams.filter(r=>[2,3].includes(r.game.season_type)),players:history.players.filter(r=>[2,3].includes(r.game.season_type))};
 const built=buildAdvanced(game,eligible,roster,stats,now),results=[built.team,...built.players].filter(f=>f.status==='OK');
 return results.map(f=>{const result={...f,model_version:INPUT_VERSION};return {forecast_id:[INPUT_VERSION,game.league,game.game_id,f.player_id||'team',fingerprint(result)].join(':'),league:game.league,game_id:game.game_id,player_id:f.player_id||null,model_version:INPUT_VERSION,kind:f.player_id?'player':'team',as_of:now.toISOString(),result};});
}
function latest(forecasts,current){const rows=forecasts.filter(f=>f.model_version===VERSION&&f.result.context?.revision===current?.body?.model_revision).sort((a,b)=>Date.parse(b.as_of)-Date.parse(a.as_of));if(!rows.length)return [];const generation=rows[0].result.context.input_revision;return rows.filter(f=>f.result.context.input_revision===generation);}
async function publishChanges(ctx,game,current){
 if(!currentOK(current,ctx.now))return 0;
 let sent=0;const body=current.body;
 for(const [tid,team]of Object.entries(require('./pregame_review').paused(ctx)?{}:body.teams)){
  if(team.lineup!=='CONFIRMED')continue;
  const names=team.starters.map(pid=>body.players[pid]?.name).filter(Boolean);if(names.length!==5)continue;
  const id=['lineup',game.league,game.game_id,tid,...team.starters.slice().sort()].join(':');
  if(await notify(ctx,id,game.league,game.league+' · quinteto confirmado por RotoWire\n'+team.team_name+'\n'+names.join(' · ')+'\nPronósticos revisados con la disponibilidad actual. Fuente: https://www.rotowire.com/'+(game.league==='NBA'?'basketball/nba-lineups.php':'wnba/lineups.php'),game.starts_at))sent++;
 }
 // A published value decision remains immutable; a later availability change gets
 // a separate warning rather than silently editing or deleting the original pick.
 const alerts=await ctx.rest('bk_value_alerts?league=eq.'+game.league+'&game_id=eq.'+game.game_id+'&select=alert_id,subject,decision');
 for(const a of alerts){const f=a.decision.forecast;if(!contextReasons(f,current,ctx.now).length)continue;
  if(await notify(ctx,'context-warning:'+a.alert_id+':'+body.model_revision,game.league,game.league+' · revisión de aviso anterior\n'+game.away_team+' @ '+game.home_team+'\nLa disponibilidad, el quinteto o las noticias han cambiado. La selección anterior requiere nueva validación; no la sigas basándote en el aviso antiguo.',game.starts_at))sent++;
 }
 return sent;
}
async function refresh(ctx){
 const r=await ctx.http(ctx.server.url+'/basketball-context/refresh',{method:'POST',headers:{Authorization:'Bearer '+ctx.server.token},timeout:120000});
 if(r.status!==200||r.body?.status==='error')throw Error('CONTEXT_CAPTURE_FAILED');
 return r.body?.status==='already_running'?r.body:require('./quote_dispatch').requestContextAnalysis(ctx,r.body);
}
module.exports={VERSION,INPUT_VERSION,POLICY,inputs,currentOK,contextReasons,derive,latest,publishChanges,refresh,unavailable};

