'use strict';
// Poll completed work quickly without increasing the frequency of browser launches.
function lastStarted(detail={},now=new Date()){
 const explicit=Date.parse(detail.last_started_at);if(Number.isFinite(explicit))return explicit;
 // Older checkpoints stored only per-game checks. Future checks are no-market backoffs.
 return Math.max(0,...Object.values(detail.checked||{}).map(Date.parse).filter(t=>Number.isFinite(t)&&t<=now.getTime()));
}
const canStart=(last,now)=>now.getTime()-last>=5*60000;
const freshCount=(quotes,now)=>quotes.filter(q=>Date.parse(q.captured_at)>=now.getTime()-5*60000).length;
async function requestAnalysis(ctx,report){
 if(Object.values(report.leagues).some(r=>r.fresh_quotes>0)&&ctx.requestAnalysis){
  try{report.analysis_requested=await ctx.requestAnalysis();}catch(_){report.analysis_requested=false;}
 }
 return report;
}
module.exports={lastStarted,canStart,freshCount,requestAnalysis};
