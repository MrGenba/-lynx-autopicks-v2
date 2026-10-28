'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),path=require('path'),{upgrade}=require('../basketball/upgrade_workflows');
const root=process.env.BASKETBALL_DEPLOY_BACKUP_DIR||path.join(__dirname,'../../recovery');
for(const [task,id]of [['analysis','1gG6VkgMr4sBvwvZ'],['research','G95Kpm97Q22KoqsU'],['context','WcYQFVEs0QZi935m']])test('live '+task+' upgrade preserves configuration and executable bundle',t=>{
 const file=path.join(root,id+'.private.json');if(!fs.existsSync(file))return t.skip('Private deployment export is not available');
 const before=JSON.parse(fs.readFileSync(file)),after=upgrade(before,task),old=before.nodes.find(n=>n.id==='run').parameters.jsCode,code=after.nodes.find(n=>n.id==='run').parameters.jsCode,marker='};const __cache={};';
 assert.equal(old.slice(old.indexOf(marker)),code.slice(code.indexOf(marker)));new vm.Script('(async function(){'+code+'})');
 after.nodes.find(n=>n.id==='run').parameters.jsCode=old;assert.deepEqual(after,before);
 if(task!=='context'){
  const end=code.indexOf('const CONFIG=',code.indexOf(marker)),prefix=code.slice(0,end);
  const ctx=vm.createContext({Date,Map,Set,JSON,Math,Number,Buffer,URL,setTimeout,clearTimeout});
  vm.runInContext(prefix+'globalThis.current=__require("context");globalThis.prior=__require("overtime_context");',ctx);
  assert.equal(ctx.current.VERSION,'bk-player-context-4');assert.equal(ctx.prior.VERSION,'bk-player-context-3');
 }
});
test('prospective comparison accepts only post-registration paired v4 vs sealed v3',()=>{
 const current=require('../basketball/context'),prior=require('../basketball/overtime_context'),{compare}=require('../basketball/context_research'),games=[],forecasts=[],players=[],candidates=[];
 const at='2026-11-02T10:00:00Z',start='2026-11-01T10:00:00Z';
 for(let i=0;i<200;i++){
  const game_id='g'+i,forecast_id='f'+i,g={league:'NBA',game_id,starts_at:'2026-11-02T12:00:00Z',status:'final',box_complete:true};
  const q={league:'NBA',game_id,player_id:'p',market:'points',line:20.5,selection:'over',odds:1.9,opposite_odds:1.9,bookmaker:'book',source:'verified',captured_at:at,expires_at:g.starts_at,period:'full_game',includes_overtime:true};
  games.push(g);forecasts.push({forecast_id,game_id,player_id:'p',model_version:prior.VERSION,result:{status:'OK',props:{points:{mean:18,variance:25}}},created_at:at,as_of:at});players.push({game_id,player_id:'p',minutes:30,stats:{points:30}});
  const c={candidate_id:'c'+i,game_id,player_id:'p',market:'points',selection:'over',model_version:current.VERSION,p_win:.8,as_of:at,created_at:at,evaluation:{base_forecast_id:forecast_id},overtime:{status:'APPLIED'},defense:{status:'APPLIED'},quote_snapshot:q};candidates.push(c,{...c,candidate_id:'u'+i,selection:'under',quote_snapshot:{...q,selection:'under'}});
 }
 let r=compare(games,forecasts,players,candidates,{registered_at:start},()=>[-.2,-.1]);assert.equal(r.n,200);assert.equal(r.model,current.VERSION);assert.equal(r.baseline_model,prior.VERSION);
 forecasts[0].model_version='bk-player-context-2';assert.equal(compare(games,forecasts,players,candidates,{registered_at:start},()=>[-.2,-.1]).n,199);
 assert.equal(compare(games,forecasts,players,candidates,{registered_at:'2026-11-03T00:00:00Z'},()=>[-.2,-.1]).n,0);
});
