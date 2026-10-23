'use strict';
const {evaluateModels}=require('./model_evaluation');
const {assessImprovement,improvementMessage}=require('./model_improvement');
const {fingerprint}=require('./research_hash');
const {reviewWithAgents}=require('./research_agents');
async function runModelResearch({rest,notify,http,config,now=new Date()}){
 const data=[];
 for(let offset=0;;offset+=1000){
  const batch=await rest('bb_all_candidates_evaluation?select=*&order=league.asc,game_id.asc,pipeline.asc,market.asc&limit=1000&offset='+offset);
  if(!Array.isArray(batch))throw Error('EVALUATION_DATA_UNAVAILABLE');data.push(...batch);if(batch.length<1000)break;
 }
 const report=evaluateModels(data,{prospective:true,now});
 await rest('bb_model_evaluation_runs','POST',{protocol_id:report.protocol,report});
 const decisions=[];
 for(const group of report.groups.filter(g=>g.status==='ready_for_review')){
  const frozen=await rest('rpc/bb_freeze_model_comparison','POST',{p_key:report.protocol+'|'+group.group,p_protocol:report.protocol,p_group:group,p_assessment:assessImprovement(group)});
  if(!frozen?.comparison_key)throw Error('COMPARISON_NOT_FROZEN');decisions.push(frozen);
 }
 const history=await rest('bb_model_research_context?context_id=eq.historical-20261023&select=summary&limit=1');
 const packet={task:'model_research',protocol:report.protocol,include_unpublished:true,
  rules:{selection:'training and chronological validation only',test:'first 200+ whole-day prospective games, wait 7 days, one final assessment per group',
   improvement:'Brier at least 2% better than current, both paired 95% intervals below zero versus current and no-vig market, log-loss no worse',
   new_hypotheses:'new candidate families require new registration and fresh future test data',production_changes:false},
  cohorts:report.groups.slice(0,18).map(g=>({group:g.group,status:g.status,eligible_games:g.eligible_games,cohorts:g.cohorts,train:g.train,validation:g.validation,test:g.test,
   ...(g.status==='ready_for_review'?{selected:g.selected_on_validation,scores:g.test_scores.filter(s=>[g.selected_on_validation,'current','market'].includes(s.name)).map(s=>({name:s.name,brier:s.brier,log_loss:s.log_loss})),ci_current:g.ci95_selected_minus_current,ci_market:g.ci95_selected_minus_market}:{})})),
  frozen_assessments:decisions.slice(0,18).map(d=>d.assessment),historical_exploratory:history[0]?.summary||null};
 const inputHash=fingerprint({packet,reviewer:'model-research-v1',model:config?.model});
 const cached=await rest('bb_model_research_reviews?input_hash=eq.'+inputHash+'&select=review,updated_at&limit=1');
 let review=cached[0]?.review;
 if(!review||review.status!=='COMPLETED'){
  if(!config?.apiKey)review={status:'NOT_CONFIGURED',agents:[],calls:0};
  else if(cached[0]&&now.getTime()-Date.parse(cached[0].updated_at)<12*3600000)review=cached[0].review;
  else {
   const budget=await rest('rpc/bb_syndicate_reserve_ai','POST',{p_input_hash:inputHash,p_purpose:'model_research'});
   review=budget.granted?await reviewWithAgents({packet,decision:{mode:'paper',verdict:'WAITING_DATA',can_publish:false,can_place_bet:false},
    config:{...config,reviewContext:'model_research'},http}):{status:budget.reason||'BUDGET_REACHED',agents:[],calls:0};
  }
  await rest('bb_model_research_reviews?on_conflict=input_hash','POST',{input_hash:inputHash,updated_at:now.toISOString(),packet,review},{prefer:'resolution=merge-duplicates,return=minimal'});
 }
 const notifications=[];
 for(const frozen of decisions.filter(d=>d.assessment.improved&&d.telegram_state==='pending')){
  const path='bb_model_comparison_decisions?comparison_key=eq.'+encodeURIComponent(frozen.comparison_key);
  await rest(path,'PATCH',{review_hash:inputHash});
  const claimed=await rest('rpc/bb_claim_model_improvement','POST',{p_key:frozen.comparison_key});if(claimed!==true)continue;
  try{
   const sent=await notify(improvementMessage(frozen.report,frozen.assessment,review));
   if(sent?.ok!==true||!Number.isInteger(sent.result?.message_id))throw Error('TELEGRAM_RECEIPT_MISSING');
   await rest(path,'PATCH',{telegram_state:'sent',telegram_message_id:sent.result.message_id,notified_at:now.toISOString()});
   notifications.push({comparison_key:frozen.comparison_key,status:'SENT',message_id:sent.result.message_id});
  }catch(_){await rest(path,'PATCH',{telegram_state:'uncertain'});notifications.push({comparison_key:frozen.comparison_key,status:'DELIVERY_REQUIRES_REVIEW'});}
 }
 return {status:notifications.some(n=>n.status==='DELIVERY_REQUIRES_REVIEW')?'NOTIFICATION_REVIEW_REQUIRED':review.status==='COMPLETED'?'RESEARCH_ACTIVE':'RESEARCH_REVIEW_PENDING',protocol:report.protocol,eligible_pairs:data.length,
  cohorts:report.groups.length,frozen_tests:decisions.length,improvements:decisions.filter(d=>d.assessment.improved).length,
  review_status:review.status,agent_roles:(review.agents||[]).map(a=>({role:a.role,status:a.status})),review_hash:inputHash,notifications};
}
module.exports={runModelResearch};
