'use strict';
const previous=require('./overtime_context'),legacy=require('./legacy_context'),minutes=require('./minutes_model'),workload=require('./player_workload'),matchup=require('./player_matchup'),overtime=require('./overtime'),{fingerprint}=require('./fingerprint');
const VERSION='bk-player-context-4',INPUT_VERSION='bk-advanced-input-4',POLICY='bk-player-context-prospective-4';
function adjusted(g,h,now){return overtime.estimate(g,h,now).status==='APPLIED'?overtime.normalizeHistory(g,h,now):h;}
function inputs(g,h,current,stats,forecasts,now,rosters=[]){
 return previous.inputs(g,workload.historyForModel(h,now),current,stats,forecasts,now,rosters).map(r=>{const result={...r.result,model_version:INPUT_VERSION};return {...r,model_version:INPUT_VERSION,forecast_id:[INPUT_VERSION,g.league,g.game_id,r.player_id||'team',fingerprint(result)].join(':'),result};});
}
function derive(g,forecasts,current,h,now,comparison=[]){
 if(!previous.currentOK(current,now))return [];
 const originals=forecasts.filter(f=>[INPUT_VERSION,'bk-advanced-opportunity-1'].includes(f.model_version)),history=adjusted(g,h,now),ot=overtime.estimate(g,h,now);
 const rows=legacy.derive(g,originals.map(r=>({...r,model_version:'bk-advanced-opportunity-1'})),current,history,now).map(row=>{
  const source=originals.find(f=>(f.player_id||null)===(row.player_id||null));
  if(!row.player_id)return {...row,result:{...row.result,model_version:VERSION,context:{...row.result.context,base_model:INPUT_VERSION}}};
  const m=workload.estimate(source.result,g,history,current.body,originals.map(f=>f.result),now),f=workload.apply(source.result,m);
  f.model_version=VERSION;f.availability=current.body.players?.[row.player_id]?.availability||'UNVERIFIED';
  f.context={...row.result.context,base_model:INPUT_VERSION,role:m.role,role_source:m.role_source,blockers:m.blockers,original_minutes:source.result.projected_minutes,role_sample:m.role_sample,minutes_adjusted:Math.abs(f.projected_minutes-source.result.projected_minutes)>.01};
  return {...row,result:f};
 });
 minutes.constrainTeam(rows.filter(r=>r.player_id).map(r=>r.result),g);
 for(const row of rows){
  if(row.player_id){row.result=matchup.apply(row.result,g,history,now);if(row.result.defense.status!=='APPLIED')row.result.context.blockers.push('OPPONENT_CONTEXT_MISSING');}
  row.result=overtime.apply(row.result,g,ot);
  if(ot.status!=='APPLIED')row.result.context.blockers.push('OVERTIME_HISTORY_INSUFFICIENT');
  row.result.context.blockers=[...new Set(row.result.context.blockers)];
 }
 const team=rows.find(r=>!r.player_id);if(team&&rows.some(r=>r.player_id&&r.result.context.blockers.length))team.result.context.blockers=[...new Set([...team.result.context.blockers,'ROTATION_IMPACT_UNMODELED'])];
 const generation=fingerprint({version:VERSION,revision:current.body.model_revision,rows:rows.map(r=>({id:r.player_id,result:r.result}))});
 return rows.map(row=>({...row,forecast_id:[VERSION,g.league,g.game_id,row.player_id||'team',generation].join(':'),model_version:VERSION,as_of:now.toISOString(),result:{...row.result,model_version:VERSION,context:{...row.result.context,input_revision:generation},evaluation:{protocol:POLICY,base_forecast_id:comparison.find(f=>(f.player_id||null)===(row.player_id||null))?.forecast_id||null}}}));
}
function latest(fs,current){const rows=fs.filter(f=>f.model_version===VERSION&&f.result.context?.revision===current?.body?.model_revision).sort((a,b)=>Date.parse(b.as_of)-Date.parse(a.as_of));return rows.length?rows.filter(f=>f.result.context.input_revision===rows[0].result.context.input_revision):[];}
module.exports={...previous,VERSION,INPUT_VERSION,POLICY,PREVIOUS_VERSION:previous.VERSION,PREVIOUS_POLICY:previous.POLICY,inputs,derive,latest};
