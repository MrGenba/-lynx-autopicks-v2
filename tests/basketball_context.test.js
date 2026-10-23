'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {VERSION,derive,contextReasons,currentOK}=require('../basketball/context');
const {VERSION:ADVANCED}=require('../basketball/advanced_model');
const {assess}=require('../basketball/value');
const {validateQuote}=require('../basketball/pipeline');
const now=new Date('2026-10-23T17:00:00Z');
function fixture(){
 const game={league:'NBA',game_id:'g',home_team_id:'h',away_team_id:'a',status:'scheduled',starts_at:'2026-10-23T20:00:00Z'};
 const f={status:'OK',player_id:'p',team_id:'h',model_version:ADVANCED,advanced:{status:'APPLIED'},projected_minutes:20,minutes_sd:2,last_played_at:'2026-10-22T20:00:00Z',sample:30,props:{points:{mean:12,variance:24}}};
 const forecasts=[{forecast_id:'original',league:'NBA',game_id:'g',player_id:'p',kind:'player',model_version:ADVANCED,result:f}];
 const current={snapshot_id:'s',observed_at:'2026-10-23T16:59:00Z',checked_at:now.toISOString(),body:{model_revision:'r',report_published_at:'2026-10-23T16:45:00Z',sources:{injuries:'OK',lineups:'OK',news:'OK'},teams:{h:{lineup:'CONFIRMED',injury_report_submitted:true}},players:{p:{team_id:'h',availability:'AVAILABLE',role:'STARTER',news:[]}}}};
 const history={players:Array.from({length:6},()=>({player_id:'p',team_id:'h',starter:true,minutes:30,did_not_play:false}))};
 return {game,forecasts,current,history};
}
test('confirmed starter role changes minutes and distribution in a new immutable forecast',()=>{
 const x=fixture(),before=JSON.stringify(x.forecasts),[f]=derive(x.game,x.forecasts,x.current,x.history,now);
 assert.equal(f.model_version,VERSION);assert.equal(f.result.projected_minutes,30);assert.equal(f.result.props.points.mean,18);assert.equal(f.result.props.points.variance,54);assert.equal(f.result.context.base_forecast_id,'original');assert.equal(JSON.stringify(x.forecasts),before);assert.deepEqual(contextReasons(f.result,x.current,now),[]);
});
test('expected lineups do not confirm role or participation and stale context cannot qualify',()=>{
 const x=fixture();x.current.body.teams.h.lineup='EXPECTED';x.current.body.players.p.role='UNKNOWN';
 const [f]=derive(x.game,x.forecasts,x.current,x.history,now);assert.equal(f.result.projected_minutes,20);assert.ok(contextReasons(f.result,x.current,now).includes('LINEUP_UNCONFIRMED'));
 assert.equal(currentOK({...x.current,checked_at:'2026-10-23T16:49:00Z'},now),false);
 assert.ok(contextReasons(f.result,{...x.current,body:{...x.current.body,model_revision:'changed'}},now).includes('CONTEXT_CHANGED'));
});
test('known absence cannot become an under recommendation and unresolved news blocks value',()=>{
 const x=fixture();x.current.body.players.p.availability='OUT';const [f]=derive(x.game,x.forecasts,x.current,x.history,now);
 assert.equal(f.result.projected_minutes,0);assert.ok(contextReasons(f.result,x.current,now).includes('PLAYER_UNAVAILABLE'));
 x.current.body.players.p.availability='AVAILABLE';x.current.body.players.p.news_unresolved=true;
 assert.ok(contextReasons(derive(x.game,x.forecasts,x.current,x.history,now)[0].result,x.current,now).includes('NEWS_UNRESOLVED'));
});
test('small role samples and missing source data fail closed',()=>{
 const x=fixture();x.history.players=x.history.players.slice(0,4);const [f]=derive(x.game,x.forecasts,x.current,x.history,now);
 assert.equal(f.result.projected_minutes,20);assert.ok(contextReasons(f.result,x.current,now).includes('ROLE_SAMPLE_INSUFFICIENT'));
 x.current.body.sources.news='SOURCE_FAILED';assert.ok(contextReasons(f.result,x.current,now).includes('CONTEXT_SOURCE_UNAVAILABLE'));
});
test('prices observed before new lineup evidence cannot generate a value alert',()=>{
 const x=fixture(),[f]=derive(x.game,x.forecasts,x.current,x.history,now);
 const q={quote_id:'q',league:'NBA',game_id:'g',player_id:'p',market:'points',line:12.5,selection:'over',odds:1.9,opposite_odds:1.9,bookmaker:'test',source:'test',source_url:'https://example.test',period:'full_game',includes_overtime:true,captured_at:'2026-10-23T16:58:00Z',expires_at:'2026-10-23T17:10:00Z'},pair={...q,quote_id:'u',selection:'under'};
 const a=assess(q,x.game,f.result,x.forecasts[0].result,[q,pair],now,validateQuote,x.current);assert.equal(a.qualifies,false);assert.ok(a.reasons.includes('PRICE_BEFORE_CONTEXT'));
});
