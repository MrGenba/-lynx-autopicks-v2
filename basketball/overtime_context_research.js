'use strict';
const {VERSION,POLICY}=require('./overtime_context'),legacy=require('./previous_context'),old=require('./matchup_model'),engine=require('./matchup_research');
function compare(games,forecasts,players,candidates,protocol,pairedCI){
 const bases=new Set(forecasts.filter(f=>f.model_version===legacy.VERSION).map(f=>f.forecast_id));
 const rows=candidates.filter(c=>c.model_version===VERSION&&c.overtime?.status==='APPLIED'&&bases.has(c.evaluation?.base_forecast_id)).map(c=>({...c,model_version:old.VERSION,matchup:{status:c.defense?.status==='APPLIED'?'APPLIED':'FALLBACK',base_forecast_id:c.evaluation.base_forecast_id}}));
 // Reuse only the fixed evaluation algorithm, with a distinct registration and
 // cohort. No observations from the earlier experiment become this model's test.
 return {...engine.compare(games,forecasts,players,rows,protocol,pairedCI),protocol:POLICY,model:VERSION,baseline_model:legacy.VERSION};
}
module.exports={compare};

