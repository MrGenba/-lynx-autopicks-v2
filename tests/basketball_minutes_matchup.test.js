'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const minutes=require('../basketball/minutes_model'),defense=require('../basketball/player_matchup'),context=require('../basketball/previous_context'),legacy=require('../basketball/legacy_context'),{PROPS}=require('../basketball/model');
const {compare}=require('../basketball/previous_context_research');
const now=new Date('2026-10-24T12:00:00Z'),g={league:'WNBA',season:2026,season_type:3,game_id:'today',home_team_id:'a',away_team_id:'b',starts_at:'2026-10-24T17:00:00Z',status:'scheduled'};
const stats={points:80,rebounds:40,assists:20,turnovers:12,fgm:30,fga:70,fg3m:8,fg3a:25,ftm:12,fta:15,orb:10,drb:30};
const personal={points:20,rebounds:5,assists:4,fgm:7,fga:15,fg3m:2,fg3a:6,ftm:4,fta:5,orb:1,drb:4};
const f={status:'OK',model_version:'bk-advanced-opportunity-1',advanced:{status:'APPLIED'},player_id:'p',player_name:'Example Player',team_id:'a',projected_minutes:30,minutes_sd:3,availability:'AVAILABLE',props:Object.fromEntries(Object.entries(PROPS).map(([k,fields])=>[k,{mean:fields.reduce((s,k)=>s+personal[k],0),variance:60}]))};
function fixture(){
 const games=Array.from({length:60},(_,i)=>({...g,game_id:'g'+i,status:'final',box_complete:true,season_type:i>=52?3:2,starts_at:new Date(now.getTime()-(61-i)*86400000).toISOString()}));
 const teams=games.flatMap(game=>['a','b'].map(team_id=>({team_id,opponent_id:team_id==='a'?'b':'a',game_id:game.game_id,game,stats:{...stats}})));
 const players=games.slice(-30).map(game=>({player_id:'p',player_name:'Example Player',team_id:'a',starter:true,minutes:30,did_not_play:false,game_id:game.game_id,game,stats:{...personal}}));
 return {h:{games,teams,players},body:{players:{p:{player_id:'p',name:'Example Player',team_id:'a',availability:'AVAILABLE',role:'STARTER',news:[]}},teams:{a:{lineup:'CONFIRMED',injury_report_submitted:true}}}};
}
function cap(n){return {policy:'bk-rotation-news-1',staff_attributed:true,rotation_risk:true,numeric_evidence:'EXPLICIT_STAFF_CAP',minutes_cap:n,target_date:'2026-10-24',published_date:'2026-10-24',source_url:'https://www.rotowire.com/wnba/player/example-1'};}
test('a recent return uses observed ramp-up games, not the old 30-minute average',()=>{
 const {h,body}=fixture();h.players=h.players.filter(p=>!['g56','g57','g58'].includes(p.game_id));h.players.at(-1).minutes=12;
 const m=minutes.estimate(f,g,h,body,[f],now);assert.equal(m.return_status,'RECENT_RETURN');assert.equal(m.missed_games,3);assert.equal(m.returned_games,1);assert.equal(m.minutes,12);assert.ok(m.blockers.includes('RETURN_MINUTES_UNCERTAIN'));
 const out=minutes.apply(f,m);assert.equal(out.props.points.mean,8);assert.equal(f.projected_minutes,30);
});
test('staff caps apply only to the right game and contradictory reports stay blocked',()=>{
 const {h,body}=fixture();body.players.p.rotation_evidence=[cap(18)];
 let m=minutes.estimate(f,g,h,body,[f],now);assert.equal(m.minutes,18);assert.ok(m.range[1]<=18);
 body.players.p.rotation_evidence=[{...cap(18),target_date:'2026-10-25'}];assert.ok(Math.abs(minutes.estimate(f,g,h,body,[f],now).minutes-30)<1e-8);
 body.players.p.rotation_evidence=[cap(18),{...cap(24),unrestricted_reported:true}];m=minutes.estimate(f,g,h,body,[f],now);assert.equal(m.minutes,18);assert.ok(m.blockers.includes('STAFF_REPORTS_CONFLICT'));
});
test('a returning teammate changes minutes through observed comparable rotations',()=>{
 const {h,body}=fixture(),other={...f,player_id:'q'};body.players.q={team_id:'a',availability:'AVAILABLE',role:'STARTER'};
 const missing=new Set(['g56','g57','g58']);h.players.forEach(p=>p.minutes=missing.has(p.game_id)?34:20);
 h.players.push(...h.players.filter(p=>!missing.has(p.game_id)).map(p=>({...p,player_id:'q',minutes:30})));
 const a=minutes.estimate(f,g,h,body,[f],now),b=minutes.estimate(f,g,h,body,[f,other],now);
 assert.ok(b.minutes<a.minutes);assert.ok(b.reasons.includes('OBSERVED_COMPARABLE_ROTATION'));assert.ok(b.rotation.sample>=5);
});
test('team minutes respect the WNBA budget and an injured player is never an under pick',()=>{
 const {h,body}=fixture();body.players.p.availability='OUT';const out=minutes.apply(f,minutes.estimate(f,g,h,body,[f],now));assert.equal(out.projected_minutes,0);assert.equal(out.props.points.mean,0);
 body.players.p.availability='AVAILABLE';const rows=Array.from({length:10},(_,i)=>({...minutes.apply(f,minutes.estimate(f,g,h,body,[f],now)),player_id:String(i)}));minutes.constrainTeam(rows,g);
 assert.ok(Math.abs(rows.reduce((s,r)=>s+r.projected_minutes,0)-200)<1e-8);
});
test('WNBA playoff projections can use an explicitly labelled regular-season prior and verified opponent boxes',()=>{
 const {h}=fixture(),normal=defense.apply(f,g,h,now);assert.equal(normal.defense.status,'APPLIED');assert.equal(normal.defense.opponent.prior_scope,'CURRENT_SEASON_REGULAR_AND_PLAYOFFS');
 for(const t of h.teams.filter(t=>t.opponent_id==='b').slice(-20)){t.stats.fg3m=3;t.stats.fgm=25;}
 const hard=defense.apply(f,g,h,now);assert.ok(hard.props.threes.mean<normal.props.threes.mean);assert.ok(hard.props.points.mean<normal.props.points.mean);
 assert.ok(Math.abs(hard.props.pra.mean-hard.props.points.mean-hard.props.rebounds.mean-hard.props.assists.mean)<1e-8);
 const before=JSON.stringify(hard);h.teams.push({team_id:'a',opponent_id:'b',stats:{...stats,fg3m:24},game:{...g,starts_at:'2026-10-25T00:00:00Z'}});assert.equal(JSON.stringify(defense.apply(f,g,h,now)),before);
});
test('new context generations retain old forecasts and change identity when staff constraints change',()=>{
 const {h,body}=fixture(),current={snapshot_id:'s',observed_at:now.toISOString(),checked_at:now.toISOString(),body:{...body,model_revision:'r',report_published_at:now.toISOString(),sources:{injuries:'OK',lineups:'OK',news:'OK'}}};
 const seed=[{forecast_id:'original',league:'WNBA',game_id:g.game_id,player_id:'p',kind:'player',model_version:f.model_version,result:f}],saved=JSON.stringify(seed);
 const old=legacy.derive(g,seed,current,h,now),a=context.derive(g,seed,current,h,now,old),again=context.derive(g,seed,current,h,new Date(now.getTime()+60000),old);
 assert.equal(a[0].forecast_id,again[0].forecast_id);assert.equal(a[0].result.evaluation.base_forecast_id,old[0].forecast_id);assert.equal(JSON.stringify(seed),saved);
 current.body.players.p.rotation_evidence=[cap(18)];const b=context.derive(g,seed,current,h,new Date(now.getTime()+60000),old);assert.notEqual(a[0].forecast_id,b[0].forecast_id);assert.equal(b[0].result.projected_minutes,18);
 assert.equal(context.latest([...a,...b],current)[0].forecast_id,b[0].forecast_id);
 assert.equal(compare([],[],[],[],null,()=>[-1,-.1]).status,'AWAITING_REGISTERED_PROTOCOL');
});

test('fresh roster players and recent bench appearances are included without an earlier forecast',()=>{
 const {h,body}=fixture(),current={checked_at:now.toISOString(),body:{...body,model_revision:'r'}};
 body.players.p.role='BENCH';
 const base=context.inputs(g,h,current,[],[],now);assert.ok(base.some(r=>r.player_id==='p'));
 const fresh=[{game_id:g.game_id,team_id:'a',observed_at:now.toISOString(),players:[{player_id:'q'}]}];
 assert.equal(context.inputs(g,h,current,[],[],now,fresh).some(r=>r.player_id==='p'),false);
 fresh[0].players=[{player_id:'p'}];assert.ok(context.inputs(g,h,current,[],[],now,fresh).some(r=>r.player_id==='p'));
});

test('the new prospective comparison uses only its own generation and immutable legacy baseline',()=>{
 const games=[],forecasts=[],players=[],candidates=[],stamp='2026-10-24T13:00:00Z';
 for(let i=0;i<200;i++){
  const game_id='future'+i,forecast_id='legacy'+i;
  const quote={league:'WNBA',game_id,player_id:'p',market:'points',line:20.5,selection:'over',odds:1.9,opposite_odds:1.9,bookmaker:'book',source:'verified',captured_at:stamp,expires_at:g.starts_at,period:'full_game',includes_overtime:true};
  games.push({...g,game_id,status:'final',box_complete:true});forecasts.push({forecast_id,game_id,player_id:'p',model_version:legacy.VERSION,result:f,as_of:stamp,created_at:stamp});players.push({game_id,player_id:'p',minutes:30,stats:{points:30}});
  const c={candidate_id:'over'+i,game_id,player_id:'p',market:'points',selection:'over',model_version:context.VERSION,p_win:.9,as_of:stamp,created_at:stamp,evaluation:{base_forecast_id:forecast_id},defense:{status:'APPLIED'},quote_snapshot:quote};
  candidates.push(c,{...c,candidate_id:'under'+i,selection:'under',p_win:.1,quote_snapshot:{...quote,selection:'under'}});
 }
 const protocol={registered_at:now.toISOString()},ci=()=>[-.3,-.1];
 const result=compare(games,forecasts,players,candidates,protocol,ci);assert.equal(result.n,200);assert.equal(result.improvement,true);assert.equal(result.model,context.VERSION);
 forecasts[0].model_version='bk-advanced-opportunity-1';assert.equal(compare(games,forecasts,players,candidates,protocol,ci).n,199);
 assert.equal(compare(games,forecasts,players,candidates,null,ci).improvement,false);
});
