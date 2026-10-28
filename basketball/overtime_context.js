'use strict';
// Preserve the previous sealed generation and its prospective cohort.
const previous=require('./previous_context'),overtime=require('./overtime');
const {fingerprint}=require('./fingerprint');
const VERSION='bk-player-context-3',INPUT_VERSION='bk-advanced-input-3',POLICY='bk-overtime-prospective-1';
function adjustedHistory(game,history,now){return overtime.estimate(game,history,now).status==='APPLIED'?overtime.normalizeHistory(game,history,now):history;}
function inputs(game,history,current,stats,forecasts,now,rosters=[]){
 return previous.inputs(game,adjustedHistory(game,history,now),current,stats,forecasts,now,rosters).map(row=>{
  const result={...row.result,model_version:INPUT_VERSION};
  return {...row,model_version:INPUT_VERSION,forecast_id:[INPUT_VERSION,game.league,game.game_id,row.player_id||'team',fingerprint(result)].join(':'),result};
 });
}
function derive(game,forecasts,current,history,now,comparison=[]){
 const converted=forecasts.map(f=>f.model_version===INPUT_VERSION?{...f,model_version:previous.INPUT_VERSION}:f),estimate=overtime.estimate(game,history,now);
 const base=previous.derive(game,converted,current,adjustedHistory(game,history,now),now);
 const rows=base.map(row=>{
  const result=overtime.apply(row.result,game,estimate);
  result.model_version=VERSION;result.context={...result.context,base_model:INPUT_VERSION};
  if(estimate.status!=='APPLIED')result.context.blockers=[...new Set([...result.context.blockers,'OVERTIME_HISTORY_INSUFFICIENT'])];
  return {...row,model_version:VERSION,result};
 });
 const generation=fingerprint({version:VERSION,revision:current?.body?.model_revision,rows:rows.map(r=>({id:r.player_id,result:r.result}))});
 return rows.map(row=>({...row,forecast_id:[VERSION,game.league,game.game_id,row.player_id||'team',generation].join(':'),
  result:{...row.result,context:{...row.result.context,input_revision:generation},evaluation:{protocol:POLICY,base_forecast_id:comparison.find(f=>(f.player_id||null)===(row.player_id||null))?.forecast_id||null}}}));
}
function latest(forecasts,current){const rows=forecasts.filter(f=>f.model_version===VERSION&&f.result.context?.revision===current?.body?.model_revision).sort((a,b)=>Date.parse(b.as_of)-Date.parse(a.as_of));if(!rows.length)return [];return rows.filter(f=>f.result.context.input_revision===rows[0].result.context.input_revision);}
module.exports={...previous,VERSION,INPUT_VERSION,POLICY,PREVIOUS_VERSION:previous.VERSION,PREVIOUS_POLICY:previous.POLICY,inputs,derive,latest};

