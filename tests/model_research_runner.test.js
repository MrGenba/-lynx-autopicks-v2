'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {runModelResearch}=require('../vendor/model_research_runner');
const now=new Date('2026-10-23T08:00:00Z');
function rows(){return Array.from({length:800},(_,i)=>({league:'MLB',pipeline:1,market:'ML',model_version:'synthetic-test',game_id:i,
 prediction_at:new Date(Date.UTC(2025,0,1+Math.floor(i/3),10)).toISOString(),game_start:new Date(Date.UTC(2025,0,1+Math.floor(i/3),12)).toISOString(),
 raw:i%2?.8:.2,current:.5,market_probability:.5,y:i%2,published:i%10===0}));}
function harness(data,{grant=true,deliveryFails=false}={}){
 const state={data,reviews:new Map(),decisions:new Map(),reservations:0,calls:0,messages:[],reports:[]};
 async function rest(path,method='GET',body){
  if(path.startsWith('bb_all_candidates_evaluation?'))return state.data;
  if(path==='bb_model_evaluation_runs'){state.reports.push(body);return null;}
  if(path.startsWith('bb_model_research_context?'))return [];
  if(path.startsWith('bb_model_research_reviews?input_hash=eq.')){
   const key=path.split('eq.')[1].split('&')[0];return state.reviews.has(key)?[structuredClone(state.reviews.get(key))]:[];
  }
  if(path.startsWith('bb_model_research_reviews?on_conflict=')){state.reviews.set(body.input_hash,structuredClone(body));return null;}
  if(path==='rpc/bb_syndicate_reserve_ai'){
   assert.equal(body.p_purpose,'model_research');state.reservations++;
   return {granted:grant,reason:grant?'RESERVED':'BUDGET_REACHED'};
  }
  if(path==='rpc/bb_freeze_model_comparison'){
   if(!state.decisions.has(body.p_key))state.decisions.set(body.p_key,{comparison_key:body.p_key,report:body.p_group,assessment:body.p_assessment,telegram_state:'pending'});
   return structuredClone(state.decisions.get(body.p_key));
  }
  if(path.startsWith('bb_model_comparison_decisions?comparison_key=eq.')&&method==='PATCH'){
   Object.assign(state.decisions.get(decodeURIComponent(path.split('eq.')[1])),body);return null;
  }
  if(path==='rpc/bb_claim_model_improvement'){
   const d=state.decisions.get(body.p_key);if(d.telegram_state!=='pending')return false;d.telegram_state='claimed';return true;
  }
  throw Error('Unexpected persistence operation: '+path);
 }
 async function http(_url,opts){
  const body=JSON.parse(opts.body);assert(body.instructions.includes('investigación')||body.instructions.includes('hipótesis')||body.instructions.includes('Brier')||body.instructions.includes('sobreajuste'));
  state.calls++;
  return {status:200,json:async()=>({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({status:'OK',summary:'Synthetic evidence reviewed.',findings:[]})}]}]})};
 }
 async function notify(message){state.messages.push(message);if(deliveryFails)throw Error('Ambiguous delivery');return {ok:true,result:{message_id:123}};}
 const run=()=>runModelResearch({rest,http,notify,config:{provider:'openai',model:'test-fixture',apiKey:'test_private_key',reasoningEffort:'none'},now});
 return {state,run};
}
test('completed unchanged research reuses four reviews and never sends a readiness notification',async()=>{
 const {state,run}=harness([]);
 const first=await run(),second=await run();
 assert.equal(first.review_status,'COMPLETED');assert.equal(second.review_hash,first.review_hash);
 assert.equal(state.calls,4);assert.equal(state.reservations,1);assert.equal(state.messages.length,0);
 assert.deepEqual(first.agent_roles.map(x=>x.role),['datos','modelo','mercado','riesgo']);
});
test('exhausted shared budget makes no paid calls and caches the temporary result',async()=>{
 const {state,run}=harness([],{grant:false});
 assert.equal((await run()).review_status,'BUDGET_REACHED');await run();
 assert.equal(state.reservations,1);assert.equal(state.calls,0);assert.equal(state.messages.length,0);
});
test('a passing frozen comparison is announced once and includes unpublished evidence',async()=>{
 const {state,run}=harness(rows());const first=await run();
 assert.equal(first.improvements,1);assert.equal(first.notifications[0].status,'SENT');
 assert(state.messages[0].includes('sin publicación'));assert.equal([...state.decisions.values()][0].telegram_state,'sent');
 await run();assert.equal(state.messages.length,1);assert.equal(state.calls,4);assert.equal(state.reservations,1);
});
test('ambiguous Telegram delivery is retained for review and never automatically resent',async()=>{
 const {state,run}=harness(rows(),{deliveryFails:true});
 assert.equal((await run()).status,'NOTIFICATION_REVIEW_REQUIRED');
 assert.equal([...state.decisions.values()][0].telegram_state,'uncertain');
 await run();assert.equal(state.messages.length,1);
});
