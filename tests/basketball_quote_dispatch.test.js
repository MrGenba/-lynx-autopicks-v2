'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {runOdds}=require('../basketball/odds'),{runProps}=require('../basketball/props');
const {lastStarted,canStart}=require('../basketball/quote_dispatch');
const {assess}=require('../basketball/value'),{validateQuote}=require('../basketball/pipeline');
const {VERSION}=require('../basketball/advanced_model');
const now=new Date('2026-10-23T15:01:00Z'),captured='2026-10-23T15:00:15Z';
const game={league:'NBA',game_id:'g',home_team:'Home Club',away_team:'Away Club',home_team_id:'h',away_team_id:'a',status:'scheduled',starts_at:'2026-10-23T22:00:00Z'};
function harness(task){
 const state={NBA:{league:'NBA',component:task+'_job',detail:{job_id:'old',checked:{g:'2026-10-23T15:00:00Z'}}}};
 const stored=[],calls=[];let analyses=0;
 const market={market:'moneyline',line:null,odds1:1.9,odds2:1.9,captured_at:captured};
 const event={...game,start_time_utc:game.starts_at,bookmaker:'bet365',period:'full_game',includes_overtime:true,source_event_url:'https://www.cuotasahora.com/test',markets:[market]};
 const propsEvent={...event,bookmaker:'winamax.fr',jurisdiction:'FR',time_basis:'visible_header_UTC',source_event_url:'https://www.winamax.fr/paris-sportifs/match/123',source_event_id:'123',markets:[{...market,market:'points',player_name:'Player Example',line:20.5,outcome_ids:['1','2']}]};
 const result=task==='odds'?{league:'NBA',games:[event]}:{league:'NBA',bookmaker:'winamax.fr',jurisdiction:'FR',games:[propsEvent]};
 const ctx={now,server:{url:'https://server.test',token:'test'},requestAnalysis:async()=>{assert.equal(stored.length,2);analyses++;return true;},http:async(url)=>{calls.push(url);return {status:200,body:url.includes('/status/')?{status:'done',result}:{job_id:'new'}};},rest:async(p,m='GET',b)=>{
  if(m==='POST'){if(p.startsWith('bk_quotes?'))stored.push(...b);if(p.startsWith('bk_state?')&&b.component===task+'_job')state[b.league]=b;return false;}
  if(p.includes('component=eq.props_access'))return [];
  if(p.startsWith('bk_games?'))return p.includes('league=eq.NBA')?[game]:[];
  if(p.startsWith('bk_forecasts?'))return [{league:'NBA',game_id:'g',player_id:'p',result:{player_name:'Player Example',team_id:'h'}}];
  if(p.startsWith('bk_state?'))return state[p.includes('league=eq.NBA')?'NBA':'WNBA']?[state[p.includes('league=eq.NBA')?'NBA':'WNBA']]:[];
  throw Error('Unexpected request '+p);
 }};return {ctx,state,stored,calls,analyses:()=>analyses};
}
for(const [task,run]of [['odds',runOdds],['props',runProps]])test(task+' consumes captures promptly while preserving its browser launch interval',async()=>{
 const h=harness(task),r=await run(h.ctx);assert.equal(h.stored.length,2);assert.equal(h.stored[0].captured_at,captured);assert.equal(h.analyses(),1);assert.equal(r.analysis_requested,true);assert.equal(h.calls.filter(u=>u.includes('/start?')).length,0);assert.equal(h.state.NBA.detail.job_id,null);
 await run({...h.ctx,now:new Date('2026-10-23T15:02:00Z')});assert.equal(h.analyses(),1);assert.equal(h.calls.filter(u=>u.includes('/status/')).length,1);
 await run({...h.ctx,now:new Date(task==='props'?'2026-10-23T16:00:00Z':'2026-10-23T15:05:00Z')});assert.equal(h.calls.filter(u=>u.includes('/start?')).length,1);
});
test('a price published hours ago qualifies when newly observed; stale captures still fail',()=>{
 const q={quote_id:'q',league:'NBA',game_id:'g',player_id:null,market:'moneyline',line:null,selection:'home',odds:1.9,opposite_odds:1.9,bookmaker:'bet365',source:'cuotasahora',source_url:'https://example.test',period:'full_game',includes_overtime:true,captured_at:captured,price_updated_at:'2026-10-23T05:00:00Z',expires_at:'2026-10-23T15:15:15Z'};
 const pair={...q,quote_id:'opposite',selection:'away'},f={status:'OK',model_version:VERSION,advanced:{status:'APPLIED'},margin:6,margin_variance:100,p_home:.73,p_away:.27};
 assert.equal(assess(q,game,f,f,[q,pair],now,validateQuote).qualifies,true);
 assert.equal(assess(q,game,f,f,[q,pair],new Date('2026-10-23T15:06:00Z'),validateQuote).qualifies,false);
});
test('legacy checkpoints ignore future empty-market backoffs when finding the last browser launch',()=>{
 const last=lastStarted({checked:{old:'2026-10-23T14:55:00Z',empty:'2026-10-23T15:45:00Z'}},now);assert.equal(last,Date.parse('2026-10-23T14:55:00Z'));assert.equal(canStart(last,now),true);
});

test('empty capture evidence survives idle ticks without presenting old odds as fresh',async()=>{
 const h=harness('odds');h.ctx.http=async()=>({status:200,body:{status:'done',result:{league:'NBA',games:[],errors:[{code:'NO_BET365_MARKETS'}]}}});
 const first=await runOdds(h.ctx);
 assert.equal(first.leagues.NBA.status,'source_unavailable');
 const next=await runOdds({...h.ctx,now:new Date('2026-10-23T15:02:00Z')});
 assert.equal(next.leagues.NBA.status,'source_unavailable');
 assert.equal(next.leagues.NBA.latest_capture.completed_at,now.toISOString());
 assert.equal(next.leagues.NBA.latest_capture.source_errors[0].code,'NO_BET365_MARKETS');
 assert.equal(next.leagues.NBA.fresh_quotes,undefined);
 assert.equal(h.analyses(),0);
});
