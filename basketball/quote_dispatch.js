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
async function requestContextAnalysis(ctx,report){
 if(!ctx.requestAnalysis)return report;
 const checked_at=new Date().toISOString(),detail={fallback:'SCHEDULED_ANALYSIS',capture_completed:true};let status='dispatch_unknown';
 try{
  const locks=await ctx.rest('bk_locks?name=eq.analysis&expires_at=gt.'+checked_at+'&select=name');
  if(locks.length)status='already_running';
  else if(await ctx.requestAnalysis())status='requested';
  else detail.error='WORKFLOW_TRIGGER_NOT_ACKNOWLEDGED';
 }catch(e){detail.error=/^[A-Z][A-Z_0-9]+$/.test(e.message||'')?e.message:'WORKFLOW_TRIGGER_FAILED';}
 // Capture has already persisted its source health. A failed handoff must not
 // overwrite that successful checkpoint or retry a possibly accepted webhook.
 try{await ctx.rest('bk_state?on_conflict=league,component','POST',{league:'ALL',component:'context_analysis_dispatch',checked_at,status,detail},{prefer:'resolution=merge-duplicates,return=minimal'});}
 catch(e){detail.checkpoint_error=/^[A-Z][A-Z_0-9]+$/.test(e.message||'')?e.message:'DISPATCH_CHECKPOINT_FAILED';}
 return {...report,analysis_dispatch:{status,...detail}};
}
module.exports={lastStarted,canStart,freshCount,requestAnalysis,requestContextAnalysis};

