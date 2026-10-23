'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {evaluateModels}=require('../vendor/model_evaluation');
function data(){return Array.from({length:200},(_,i)=>({league:'MLB',pipeline:1,market:'ML',model_version:'v1',game_id:i,
 prediction_at:new Date(Date.UTC(2026,0,1+i,10)).toISOString(),game_start:new Date(Date.UTC(2026,0,1+i,12)).toISOString(),
 raw:.55+(i%3)*.03,current:.54,market_probability:.51,y:i%2,published:i%10===0}));}
test('unpublished candidates participate and repeated snapshots do not multiply games',()=>{
 const rows=data(),r=evaluateModels([...rows,...rows]).groups[0];
 assert.equal(r.eligible_games,200);assert.equal(r.cohorts.unpublished_pair,180);
 assert.equal(r.train+r.validation+r.test,200);assert.equal(r.policy,'SHADOW_NO_AUTO_PROMOTION');
});
test('changing final test outcomes cannot alter fitting or model selection',()=>{
 const rows=data(),a=evaluateModels(rows).groups[0];
 const changed=rows.map((r,i)=>({...r,y:i>=160?1-r.y:r.y}));const b=evaluateModels(changed).groups[0];
 assert.deepEqual(a.params,b.params);assert.equal(a.selected_on_validation,b.selected_on_validation);
 assert.notDeepEqual(a.test_scores,b.test_scores);
});
test('prospective protocol cannot report readiness before the fixed partitions exist',()=>{
 const r=evaluateModels(data(),{prospective:true}).groups[0];
 assert.equal(r.train,200);assert.equal(r.validation,0);assert.equal(r.test,0);assert.equal(r.status,'insufficient_data');
});
test('different pipelines and model versions are not pooled',()=>{
 const rows=data();const r=evaluateModels([...rows,...rows.map(x=>({...x,pipeline:2})),...rows.map(x=>({...x,model_version:'v2'}))]);
 assert.equal(r.groups.length,3);assert(r.groups.every(g=>g.eligible_games===200));
});
