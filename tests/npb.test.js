'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {game,boxscore}=require('../collectors/npb');const {enrichNpb}=require('../vendor/npb_lookup');
const fixture=require('./fixtures/npb_boxscore.json');
test('NPB final includes identified pitchers, batters and reconciled pitch history',()=>{
 const out=boxscore(game(fixture.calendar),fixture);assert.equal(out.pitchers.length,11);assert.equal(out.batters.length,39);assert.equal(out.pitches.length,312);assert.equal(out.receipt.tracking_status,'COMPLETE');
 assert.equal(out.game.away_team,'DB');assert.equal(out.game.home_team,'HT');assert.equal(out.game.away_starter_id,'1700058');
 assert(out.pitchers.some(p=>p.outs===1&&p.ip===1/3));
 const zero=structuredClone(fixture);zero.pitchers[0].ip='0';zero.pitchers[0].ip3=null;assert.equal(boxscore(game(zero.calendar),zero).pitchers[0].outs,0);
});
test('missing lineup, altered game identity or changed player totals are rejected',()=>{
 for(const change of [x=>x.batters.shift(),x=>x.score[0].gameId='0',x=>x.pitchers[0].h='99']){const f=structuredClone(fixture);change(f);assert.throws(()=>boxscore(game(f.calendar),f));}
});
test('missing pitch observations remain partial; scoreboard disagreements retain evidence',()=>{
 const f=structuredClone(fixture);f.history=f.history.filter(h=>!(h.fiveDigitSerialNumber==='01101'&&h.atBatBallCount==='1'));f.score[0].totalHitHome='13';
 const out=boxscore(game(f.calendar),f);assert.equal(out.receipt.tracking_status,'PARTIAL');assert.equal(out.receipt.quality_flags.length,1);assert.equal(out.receipt.quality_flags[0].player_hits,14);
});
test('scheduled overview supplies real date, start time and announced pitcher IDs',()=>{
 const raw={gameId:2021039492,requested_date:'20261024',startTime:'1830'};
 const g=game(raw,[{gameId:2021039492,gameKindId:'3',gameDate:'20261024',homeTeamId:'3',visitorTeamId:'12',homePrePitcherId:'1',visitorPrePitcherId:'2',homePrePitcherName:'A',visitorPrePitcherName:'B'}]);
 assert.equal(g.game_time,'2026-10-24T09:30:00.000Z');assert.equal(g.status,'scheduled');assert.equal(g.away_team,'FS');assert.equal(game({...fixture.calendar,gameTypeId:5}),null);
 assert.equal(game({...fixture.calendar,gameStateId:9,gameStateName:'試合中止'}).status,'cancelled');
});
test('unmeasured zero velocity never depresses pitch speed averages',()=>{
 const f=structuredClone(fixture),pitch=f.history.find(h=>Number(h.atBatBallCount)>0);pitch.ballSpeed='0';
 const out=boxscore(game(f.calendar),f);assert.equal(out.pitches[0].velocity_kmh,null);assert.equal(out.pitches.length,312);
 pitch.ballSpeed='unavailable';assert.equal(boxscore(game(f.calendar),f).pitches[0].velocity_kmh,null);
});
function packet(){const now=new Date('2026-10-24T08:00:00Z');return {now,inputs:[{awayRaw:'Baystars',homeRaw:'Softbank',away_ml:2,home_ml:1.8,hc_value:1.5}],games:[{game_id:'2021039492',game_pk:'2026_2021039492',season:2026,game_date:'2026-10-24',status:'scheduled',game_time:'2026-10-24T09:30:00Z',away_team:'FS',home_team:'DB',away_starter:'B',home_starter:'A',away_starter_id:'2',home_starter_id:'1'}],pitchers:[['FS','2'],['DB','1']].map(([team_abbr,player_id])=>({season:2026,team_abbr,player_id,player_name:'Same name',outs:300,pa_or_ip:100,era:0,fip:3,k_9:9,bb_9:2})),batters:[],logs:[],history:[],health:{pending_games:0,final_games:870},capture:{status:'OK',checked_at:now.toISOString()}};}
test('NPB lookup matches exact player IDs and actual home/away, never a substitute',()=>{
 const p=packet(),o=enrichNpb(p)[0];assert.equal(o.error,undefined);assert.equal(o.away_team_name,'FS');assert.equal(o.home_team_name,'DB');assert.equal(o.away_ml,1.8);assert.equal(o.hc_value,null);assert.equal(o.away_p_bb_9,2);assert.equal(o.away_p_era,0);
 p.games[0].away_starter_id='wrong';assert.match(enrichNpb(p)[0].error,/estadísticas verificadas/);
});
test('incomplete/stale capture, started games and ambiguous games block calculation',()=>{
 for(const change of [p=>p.health.pending_games=1,p=>p.capture.status='ATTENTION',p=>p.capture.checked_at='2026-10-01',p=>p.games[0].game_time=null,p=>p.games[0].game_time='2026-10-24T07:00:00Z',p=>p.games.push({...p.games[0]})]){const p=packet();change(p);assert(enrichNpb(p)[0].error);}
});
test('NPB engine uses actual recent start count, and generated lookup executes its transport',async()=>{
 const engine=require('../vendor/quant_engine_npb'),g={away_p_ip_season:100,away_p_ip_l5:14,away_p_starts_l5:2};assert(Math.abs(engine.estimateStarterShare(g,'away')-.63)<1e-12);
 const {lookup}=require('../collectors/npb_workflows'),AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;let calls=0;
 const helpers={httpRequest:async o=>{calls++;assert(o.url.startsWith('https://database.invalid/rest/v1/'));return [];}};
 const output=await new AsyncFunction('helpers','$input',lookup({url:'https://database.invalid/',key:'test'}))(helpers,{all:()=>[{json:{awayRaw:'FS',homeRaw:'DB'}}]});assert.equal(calls,8);assert(output[0].json.error);
});
