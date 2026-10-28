'use strict';
// A publication check, not a new calibrated probability or a change to sealed
// forecasts. Unresolved news must not turn into extra confidence in a pick.
const POLICY='bk-pregame-news-review-2';
const {roleNews,resolve}=require('./role_model');
const day=t=>new Date(t).toLocaleDateString('en-CA',{timeZone:'America/New_York'});
const unique=a=>[...new Set(a)],escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function paused(ctx){return ctx.pregameReview?.lineupReanalysis===false;}
function bothConfirmed(g,current){return [g.home_team_id,g.away_team_id].every(id=>{const t=current?.body?.teams?.[id];return t?.lineup==='CONFIRMED'&&t.starters?.length===5&&new Set(t.starters).size===5;});}
function lineupNotification(id,p={}){
 return p.kind==='basketball_lineup_reanalysis'||!!p.lineup_key||id.startsWith('lineup:')||id.startsWith('lineup-analysis-v1:')||id.startsWith('props-lineup-v1:')||
  id.startsWith('team-odds-v1:')&&!id.includes(':initial:')||p.kind==='basketball_filtered_channel'&&p.revision!=='initial';
}
function assess(g,f,current,now){
 const reasons=[],body=current?.body,at=now.getTime(),checked=Date.parse(current?.checked_at),result={policy:POLICY,checked_at:now.toISOString(),source_checked_at:current?.checked_at||null,context_snapshot_id:current?.snapshot_id||null,context_revision:body?.model_revision||null,role:'UNKNOWN',role_source:null,news:[],reasons};
 if(!f)return {...result,reasons:['FORECAST_MISSING'],eligible:false};
 if(g.status!=='scheduled'||!(Date.parse(g.starts_at)>at))reasons.push('GAME_NOT_PREGAME');
 if(!body||current.league!==g.league||current.game_id!==g.game_id||!Number.isFinite(checked)||checked>at+60000||checked<at-10*60000)reasons.push('NEWS_CONTEXT_STALE_OR_MISSING');
 if(!body||['news','injuries','lineups'].some(k=>body.sources?.[k]!=='OK'))reasons.push('NEWS_SOURCE_UNAVAILABLE');
 if(!body||f.context?.revision!==body.model_revision)reasons.push('NEWS_CONTEXT_CHANGED');
 const reportAt=Date.parse(body?.report_published_at);
 if(!Number.isFinite(reportAt)||reportAt>at||reportAt<at-6*3600000)reasons.push('INJURY_REPORT_STALE');
 if(!body)return {...result,eligible:false};
 const blocks=f.context?.blockers||[];
 reasons.push(...blocks);
 if((body.unmapped||[]).some(p=>p.source==='injury'&&p.status!=='AVAILABLE'&&(!f.player_id||p.team_id===f.team_id)))reasons.push('INJURY_IDENTITY_UNRESOLVED');
 if(f.player_id){
  const p=body.players?.[f.player_id],team=body.teams?.[f.team_id];
  if(!p||p.team_id!==f.team_id||!['AVAILABLE','NOT_LISTED','PROBABLE'].includes(p.availability))reasons.push('PARTICIPATION_UNCERTAIN');
  if(p?.news_unresolved)reasons.push('PLAYER_NEWS_UNRESOLVED');
  const resolved=resolve(g,{...p,player_id:f.player_id},team,now);
  result.role=resolved.role;result.role_source=resolved.source;result.news=resolved.news;reasons.push(...resolved.reasons);
  if(f.context?.role!==result.role||f.minutes?.role!==result.role)reasons.push('EXPECTED_ROLE_NOT_MODELED');
  const range=f.minutes?.range;
  if(!Number.isFinite(f.projected_minutes)||f.projected_minutes<=0||!Array.isArray(range)||range.length!==2||!range.every(Number.isFinite)||range[0]<0||range[1]<range[0])reasons.push('MINUTES_UNVERIFIED');
  for(const e of p?.rotation_evidence||[]){
   if(e.target_date!==day(g.starts_at))continue;
   if(e.numeric_evidence==='EXPLICIT_STAFF_CAP'&&e.staff_attributed&&Number.isFinite(e.minutes_cap)&&f.projected_minutes>e.minutes_cap+.01)reasons.push('MINUTES_CAP_NOT_MODELED');
   else if(e.rotation_risk&&e.numeric_evidence!=='EXPLICIT_STAFF_CAP')reasons.push('WORKLOAD_NEWS_UNRESOLVED');
  }
  result.projected_minutes=f.projected_minutes;result.minute_range=f.minutes?.range;
 }else if(Object.values(body.players||{}).some(p=>p.news_unresolved))reasons.push('ROSTER_NEWS_UNRESOLVED');
 result.reasons=unique(reasons);result.eligible=!result.reasons.length;return result;
}
module.exports={POLICY,paused,bothConfirmed,lineupNotification,roleNews,assess};

