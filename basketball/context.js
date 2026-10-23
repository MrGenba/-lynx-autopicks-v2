'use strict';
const {VERSION:ADVANCED}=require('./advanced_model');
const {weighted,MODELS}=require('./model');
const {notify}=require('./notifications');
const VERSION='bk-context-opportunity-1';
const unavailable=s=>['OUT','SUSPENDED','INACTIVE'].includes(s);
const risky=s=>['OUT','SUSPENDED','INACTIVE','DOUBTFUL','QUESTIONABLE','CONFLICT'].includes(s);
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
function derive(game,forecasts,current,history,now){
 if(!currentOK(current,now))return [];
 const originals=forecasts.filter(f=>f.model_version===ADVANCED),body=current.body,revision=body.model_revision;
 const affected=originals.filter(f=>f.player_id&&f.result.projected_minutes>=10&&Date.parse(f.result.last_played_at)>now.getTime()-7*86400000&&risky(body.players[f.player_id]?.availability));
 return originals.map(row=>{
  const f=JSON.parse(JSON.stringify(row.result)),p=body.players[row.player_id],team=body.teams[f.team_id],blockers=[];
  f.model_version=VERSION;
  f.context={revision,snapshot_id:current.snapshot_id,observed_at:current.observed_at,base_forecast_id:row.forecast_id,base_model:ADVANCED,report_url:body.report_url,lineup:team?.lineup||'UNKNOWN',blockers,news:p?.news||[],minutes_adjusted:false};
  if(row.player_id){
   f.availability=p?.availability||'UNVERIFIED';f.context.role=p?.role||'UNKNOWN';f.context.injury_reason=p?.injury_reason||null;
   if(unavailable(f.availability)){f.projected_minutes=0;for(const prop of Object.values(f.props)){prop.mean=0;prop.variance=0;}blockers.push('PLAYER_UNAVAILABLE');}
   else if(p?.role&&p.role!=='UNKNOWN'){
    const rows=(history?.players||[]).filter(x=>x.player_id===row.player_id&&x.team_id===f.team_id&&!x.did_not_play&&x.minutes>0&&x.starter===(p.role==='STARTER')).slice(-10);
    f.context.role_sample=rows.length;
    if(rows.length>=5){const minutes=weighted(rows,x=>x.minutes,MODELS.baseline.decay),target=Math.min(game.league==='NBA'?48:40,Math.max(f.projected_minutes*.5,Math.min(f.projected_minutes*1.5,minutes.mean))),ratio=target/f.projected_minutes;
     for(const prop of Object.values(f.props)){prop.mean*=ratio;prop.variance=Math.max(prop.mean,prop.variance*ratio*ratio);}
     f.context.original_minutes=f.projected_minutes;f.projected_minutes=target;f.minutes_sd=Math.sqrt(minutes.variance);f.context.minutes_adjusted=true;
    }else blockers.push('ROLE_SAMPLE_INSUFFICIENT');
   }
   if(affected.some(a=>a.player_id!==row.player_id&&a.result.team_id===f.team_id))blockers.push('ROTATION_IMPACT_UNMODELED');
  }else{
   f.context.lineups=body.teams;
   if(affected.length)blockers.push('ROTATION_IMPACT_UNMODELED');
   if(Object.values(body.players).some(p=>p.news_unresolved))blockers.push('NEWS_UNRESOLVED');
  }
  return {...row,forecast_id:['context',game.league,game.game_id,row.player_id||'team',revision].join(':'),model_version:VERSION,as_of:now.toISOString(),result:f};
 });
}
function latest(forecasts,current){return forecasts.filter(f=>f.model_version===VERSION&&f.result.context?.revision===current?.body?.model_revision);}
async function publishChanges(ctx,game,current){
 if(!currentOK(current,ctx.now))return 0;
 let sent=0;const body=current.body;
 for(const [tid,team]of Object.entries(body.teams)){
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
 if(r.body?.status!=='already_running'&&ctx.requestAnalysis)await ctx.requestAnalysis();return r.body;
}
module.exports={VERSION,currentOK,contextReasons,derive,latest,publishChanges,refresh,unavailable};
