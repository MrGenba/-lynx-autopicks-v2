'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {assessImprovement,improvementMessage}=require('../vendor/model_improvement');
const {evaluateModels}=require('../vendor/model_evaluation');
function good(){return {group:'MLB|1|OU|v1',evidence:'prospective_sealed_predictions',status:'ready_for_review',train:400,validation:150,test:200,selected_on_validation:'logistic',
 test_scores:[{name:'current',brier:.25,log_loss:.7},{name:'market',brier:.24,log_loss:.69},{name:'logistic',brier:.20,log_loss:.6}],
 ci95_selected_minus_current:[-.07,-.02],ci95_selected_minus_market:[-.06,-.01],test_cohorts:{unpublished:{n:190}}};}
test('sample readiness alone, historical results and worse log-loss never announce improvement',()=>{
 for(const change of [g=>g.evidence='historical_exploratory_not_fresh_holdout',g=>g.test=199,g=>g.selected_on_validation='current',g=>g.ci95_selected_minus_current=[-.1,.001],g=>g.ci95_selected_minus_market=[-.1,.001],g=>g.test_scores[2].log_loss=.71]){
  const g=good();change(g);const a=assessImprovement(g);assert.equal(a.improved,false);assert.throws(()=>improvementMessage(g,a));
 }
});
test('verified improvement reports exact baselines, discarded cohort and no production change',()=>{
 const g=good(),a=assessImprovement(g);assert.equal(a.improved,true);assert.equal(a.can_auto_promote,false);
 const text=improvementMessage(g,a,{status:'COMPLETED',analysis_status:'OK'});assert(text.includes('190 sin publicación'));assert(text.includes('0.2500'));assert(text.includes('producción sin cambios'));
});
test('whole-day partitions keep at least 200 test games and suppress early peeking',()=>{
 const data=Array.from({length:800},(_,i)=>({league:'MLB',pipeline:1,market:'ML',model_version:'v',game_id:i,
  prediction_at:new Date(Date.UTC(2025,0,1+Math.floor(i/3),10)).toISOString(),game_start:new Date(Date.UTC(2025,0,1+Math.floor(i/3),12)).toISOString(),
  raw:.6,current:.55,market_probability:.52,y:i%2,published:false}));
 const full=evaluateModels(data,{prospective:true,now:new Date('2026-10-23')}).groups[0];
 assert.equal(full.train,402);assert.equal(full.validation,150);assert.equal(full.test,201);assert.equal(full.status,'ready_for_review');
 const partial=evaluateModels(data.slice(0,700),{prospective:true,now:new Date('2026-10-23')}).groups[0];
 assert.equal(partial.test_scores,undefined);assert.equal(partial.status,'accumulating_sealed_test');
 const recent=evaluateModels(data,{prospective:true,now:new Date(full.test_end)}).groups[0];assert.equal(recent.test_scores,undefined);
});
