'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),m=require('../basketball/matchup_model'),{PROPS}=require('../basketball/model');
const {assess}=require('../basketball/value'),{compare}=require('../basketball/matchup_research');
const now=new Date('2026-10-24T12:00:00Z'),g={league:'NBA',season:2027,season_type:2,game_id:'g',starts_at:'2026-10-24T20:00:00Z',home_team_id:'a',away_team_id:'b'};
const stamp='2026-10-24T11:00:00Z';
const row=(dataset,stats)=>({league:'NBA',season:2027,season_type:'Regular Season',per_mode:'Totals',dataset,version_id:dataset,player_id:'p',provider_player_id:'provider',provider_team_id:'team',mapping:{status:'mapped'},quality:{flags:[],boxscore_comparison:{games_match:true,points_match:true}},observed_at:stamp,source_published_at:stamp,latest_publication_at:stamp,source_checked_at:stamp,source_status:'ok',stats});
const base=row('stats_base',{gp:20,min:600,fgm:120,fga:260,fg3_m:30,fg3_a:90,ftm:75,fta:100,pts:345,ast:90,reb:100,oreb:20,dreb:80,stl:20,blk:10,pf:40,tov:30});
const bundle={eligible:true,base,advanced:row('stats_advanced',{gp:20,min:30,usg_pct:.24,off_rating:112,def_rating:105}),tracking:{}};
const f={status:'OK',model_version:'bk-advanced-opportunity-1',player_id:'p',team_id:'a',projected_minutes:30,props:Object.fromEntries(Object.entries(PROPS).map(([k,parts])=>[k,{mean:parts.length>1?parts.reduce((s,k)=>s+({points:20,rebounds:5,assists:4}[k]||0),0):({points:20,rebounds:5,assists:4,threes:1.5}[k]),variance:100}])),availability:'NOT_LISTED'};
const prior={two:.52,three:.36,ft:.78,passing:.5,rebounding:.65},opp={two_factor:1,three_factor:1,own_miss_factor:1,opponent_miss_factor:1,assisted_basket_factor:1},def={factor:1,players:[],status:'INSUFFICIENT_ROSTER_COVERAGE'};
test('shot model separates expected makes, opponent defense and variance without mutating production inputs',()=>{
 const before=JSON.stringify(f),a=m.enrich(f,bundle,[],prior,opp,def,g,now),hard=m.enrich(f,bundle,[],prior,{...opp,two_factor:.9,three_factor:.9},def,g,now);
 assert.equal(a.matchup.status,'APPLIED');assert.ok(hard.props.points.mean<a.props.points.mean);assert.ok(a.matchup.features.expected_field_goals>0);assert.equal(a.matchup.research_only,true);assert.equal(JSON.stringify(f),before);
 for(const k in a.props)assert.ok(a.props[k].variance>=f.props[k].variance);
 assert.ok(Math.abs(a.props.pra.mean-a.props.points.mean-a.props.rebounds.mean-a.props.assists.mean)<1e-8);
 const gate=assess({odds:2,captured_at:stamp},g,a,f,[],now,()=>[],null);assert.ok(gate.reasons.includes('ADVANCED_NOT_APPLIED'));
});
test('optional shot categories reject impossible overlap and observations unavailable at prediction time',()=>{
 const c=row('tracking_catchshoot',{gp:20,min:600,catch_shoot_fga:100,catch_shoot_fgm:50,catch_shoot_fg3_a:60,catch_shoot_fg3_m:20});
 const a=m.enrich(f,bundle,[c],prior,opp,def,g,now);assert.equal(a.matchup.features.shots.length,2);assert.ok(a.matchup.version_ids.includes(c.version_id));
 const bad={...c,stats:{...c.stats,catch_shoot_fg3_a:100}};assert.equal(m.enrich(f,bundle,[bad],prior,opp,def,g,now).matchup.features.shots.length,1);
 assert.equal(m.optional([{...c,observed_at:g.starts_at}],c.dataset,bundle,g,now),null);
 assert.equal(m.optional([{...c,provider_team_id:'wrong'}],c.dataset,bundle,g,now),null);
});
test('WNBA missing tracking remains null while verified seasonal rates and opponent context remain usable',()=>{
 const a=m.enrich(f,bundle,[],prior,opp,def,{...g,league:'WNBA'},now);
 assert.equal(a.matchup.features.potential_assists,null);assert.equal(a.matchup.features.rebound_chances,null);assert.ok(Number.isFinite(a.props.assists.mean));
 assert.equal(m.enrich(f,{eligible:false},[],prior,opp,def,g,now).matchup.status,'FALLBACK');
 assert.equal(m.enrich(f,bundle,[],prior,null,def,g,now).matchup.status,'FALLBACK');
});
test('opponent features require valid same-competition history and change with defensive shot conversion',()=>{
 const stats={fga:90,fgm:42,fg3a:30,fg3m:11,fta:20,orb:10,drb:30,assists:22,turnovers:12};
 const history={teams:Array.from({length:60},(_,i)=>({team_id:i%2?'b':'a',opponent_id:i%2?'a':'b',stats:{...stats},game:{season:2026,season_type:2,starts_at:'2026-01-01T00:00:00Z'}}))};
 assert.ok(m.opponentHistory(g,history,'a'));
 assert.equal(m.opponentHistory(g,{teams:history.teams.map(t=>({...t,game:{...t.game,season_type:3}}))},'a'),null);
 assert.equal(m.opponentHistory(g,{teams:history.teams.map(t=>({...t,game:{...t.game,starts_at:'2026-10-25T00:00:00Z'}}))},'a'),null);
});
test('new experiment cannot reuse inspected games or claim improvement before the registered cohort completes',()=>{
 const result=compare([],[],[],[],{registered_at:now.toISOString()},()=>[-1,-.1]);assert.equal(result.status,'ACCUMULATING');assert.equal(result.improvement,false);assert.equal(result.n,0);
 const games=[{...g,status:'final',box_complete:true,starts_at:'2026-10-23T20:00:00Z'}];assert.equal(compare(games,[],[],[],{registered_at:now.toISOString()},()=>[-1,-.1]).n,0);
});
test('prospective comparison needs 200 paired games and rejects a missing or late opposite quote',()=>{
 const games=[],forecasts=[],players=[],candidates=[];
 for(let i=0;i<200;i++){
  const gid='future'+i,game={...g,game_id:gid,status:'final',box_complete:true},fid='base'+i;
  const quote={league:'NBA',game_id:gid,player_id:'p',market:'points',line:20.5,selection:'over',odds:1.9,opposite_odds:1.9,bookmaker:'book',source:'verified',captured_at:stamp,expires_at:g.starts_at,period:'full_game',includes_overtime:true};
  const candidate={candidate_id:'over'+i,game_id:gid,player_id:'p',market:'points',selection:'over',model_version:m.VERSION,p_win:.9,created_at:stamp,as_of:stamp,matchup:{status:'APPLIED',base_forecast_id:fid},quote_snapshot:quote};
  games.push(game);forecasts.push({forecast_id:fid,game_id:gid,player_id:'p',result:f,as_of:stamp,created_at:stamp});players.push({game_id:gid,player_id:'p',minutes:30,stats:{points:30}});
  candidates.push(candidate,{...candidate,candidate_id:'under'+i,selection:'under',p_win:.1,quote_snapshot:{...quote,selection:'under'}});
 }
 const protocol={registered_at:'2026-10-24T00:00:00Z'},ci=()=>[-.3,-.1];
 assert.equal(compare(games,forecasts,players,candidates,protocol,ci).improvement,true);
 assert.equal(compare(games,forecasts,players,candidates.slice(0,-1),protocol,ci).n,199);
 candidates.at(-1).created_at=g.starts_at;
 const late=compare(games,forecasts,players,candidates,protocol,ci);assert.equal(late.n,199);assert.equal(late.improvement,false);
});
test('all workflow bundles parse with the independent basketball REST URL',()=>{
 const {code}=require('../basketball/build_workflows'),AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 for(const task of ['capture','advanced','context','analysis','research','storage','supervisor'])assert.doesNotThrow(()=>new AsyncFunction(code(task,{restUrl:'https://basketball.example',supabaseKey:'test'})));
});
