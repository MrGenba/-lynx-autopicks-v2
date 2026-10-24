'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {VERSION}=require('../basketball/context');
const {latestBefore,evaluateBalance,message}=require('../basketball/balance');
const {lineupKey,buildReanalysis}=require('../basketball/reanalysis');
const g={league:'NBA',game_id:'g',home_team_id:'h',away_team_id:'a',home_team:'Home',away_team:'Away',status:'final',starts_at:'2026-10-23T20:00:00Z',home_score:100,away_score:90,box_complete:true};
const row=(id,time,player_id=null)=>({forecast_id:id,league:'NBA',game_id:'g',model_version:VERSION,player_id,kind:player_id?'player':'team',as_of:time,created_at:time,result:{status:'OK',player_id,model_version:VERSION,player_name:'Example',p_home:.6,p_away:.4,margin:5,total:200,home_points:102.5,away_points:97.5,projected_minutes:30,props:{points:{mean:20},rebounds:{mean:6},assists:{mean:5}},context:{revision:'r',lineup:'CONFIRMED',role:'STARTER',minutes_adjusted:true,lineups:{h:{lineup:'CONFIRMED'},a:{lineup:'CONFIRMED'}}}}});
test('balance counts one last pregame revision and excludes later or retroactively created forecasts',()=>{
 const early=row('a','2026-10-23T18:00:00Z'),last=row('b','2026-10-23T19:00:00Z'),late=row('c','2026-10-23T21:00:00Z'),retro={...early,forecast_id:'retro',created_at:'2026-10-24T00:00:00Z'};
 early.result.p_home=.1;last.result.p_home=.6;late.result.p_home=1;
 assert.equal(latestBefore(g,[early,last,late,retro],VERSION)[0].forecast_id,'b');
 const r=evaluateBalance([g],[early,last,late,retro],[]).models[VERSION];assert.equal(r.games,1);assert.equal(r.winner_correct,1);assert.ok(Math.abs(r.brier-.16)<1e-9);
});
test('player errors exclude DNP and missing rows rather than treating them as zero',()=>{
 const fs=[row('t','2026-10-23T19:00:00Z'),row('p','2026-10-23T19:00:00Z','p'),row('d','2026-10-23T19:00:00Z','d'),row('m','2026-10-23T19:00:00Z','m')];
 const players=[{league:'NBA',game_id:'g',player_id:'p',player_name:'Example',minutes:25,stats:{points:17,rebounds:8,assists:4}},{league:'NBA',game_id:'g',player_id:'d',did_not_play:true,minutes:0}];
 const r=evaluateBalance([g],fs,players).models[VERSION];assert.equal(r.props.points.n,1);assert.equal(r.props.points.mae,3);assert.equal(r.excluded_dnp,1);assert.equal(r.missing_players,1);
 assert.match(message(g,fs,players,0),/no un balance de apuestas realizadas/);
});
test('confirmed cohort stays distinct from latest snapshot and never changes the original rows',()=>{
 const a=row('a','2026-10-23T18:00:00Z'),b=row('b','2026-10-23T19:00:00Z');b.result.context.lineups.h.lineup='UNKNOWN';const before=JSON.stringify([a,b]);
 assert.equal(latestBefore(g,[a,b],VERSION,true)[0].forecast_id,'a');assert.equal(JSON.stringify([a,b]),before);
});
test('reanalyis waits for both real quintets, has a stable key and shows adjusted projections',()=>{
 const now=new Date('2026-10-23T19:00:00Z'),game={...g,status:'scheduled'},teams={},players={},fs=[row('team',now.toISOString())];
 for(const tid of ['h','a']){const ids=Array.from({length:5},(_,i)=>tid+i);teams[tid]={lineup:'CONFIRMED',starters:ids,team_name:tid,injury_report_submitted:true};for(const id of ids){players[id]={name:id,availability:'AVAILABLE'};fs.push(row(id,now.toISOString(),id));}}
 const current={checked_at:now.toISOString(),body:{model_revision:'r',sources:{lineups:'OK',news:'OK',injuries:'OK'},report_published_at:now.toISOString(),teams,players}};
 const key=lineupKey(game,current,now),r=buildReanalysis(game,fs,current,now,{assessed:0,qualified:0});assert.ok(key);assert.equal(r.payload.forecast_ids.length,11);assert.match(r.text,/SIN APUESTA/);assert.match(r.text,/10 proyecciones/);assert.ok(r.text.length<4096);
 teams.h.starters.reverse();assert.equal(lineupKey(game,current,now),key);teams.h.lineup='EXPECTED';assert.equal(buildReanalysis(game,fs,current,now),null);assert.equal(lineupKey(g,current,now),null);
});

