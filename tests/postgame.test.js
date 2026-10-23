'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {buildPostgameIngest}=require('../vendor/postgame_ingest');
const {recoverPostgames,fetchPostgameJson}=require('../vendor/postgame_recovery');
function fixture(){
 const g={gamePk:1,gameDate:'2026-10-20T16:00:00Z',season:'2026',scheduledInnings:9,gameType:'R',
  status:{abstractGameState:'Final',detailedState:'Final'},teams:{away:{team:{id:10},score:1},home:{team:{id:20},score:2}}};
 const box={teams:{}};
 for(const [side,id,ip] of [['away',10,'8.1'],['home',20,'9.0']]){
  box.teams[side]={team:{id},pitchers:[id,id+1],teamStats:{pitching:{inningsPitched:ip}},players:{}};
  for(const [pid,innings] of [[id,ip],[id+1,'0.0']])box.teams[side].players['ID'+pid]={person:{fullName:'P'+pid},stats:{pitching:{inningsPitched:innings,numberOfPitches:pid,baseOnBalls:1}}};
 }
 return {g,box};
}
test('baseball innings become outs/3 and zero-out appearances survive',()=>{
 const {g,box}=fixture(),p=buildPostgameIngest(g,box,1);
 assert.equal(p.rows.length,4);assert.equal(p.rows[0].innings_pitched,25/3);assert.equal(p.rows[1].innings_pitched,0);
 assert.equal(p.rows[1].pitches,11);assert.equal(p.rows[1].walks,1);assert.equal(p.known_pregame,false);
});
test('partial official boxscores and cancelled games cannot be marked complete',()=>{
 for(const change of [({box})=>delete box.teams.home.players.ID21,
  ({box})=>box.teams.away.teamStats.pitching.inningsPitched='9.0',
  ({box})=>box.teams.away.team.id=99,
  ({g})=>g.status.detailedState='Cancelled']){
  const f=fixture();change(f);assert.throws(()=>buildPostgameIngest(f.g,f.box,1));
 }
});
test('retry includes postseason, de-duplicates resumed games and never reports failed writes as success',async()=>{
 const {g,box}=fixture();g.gameType='L';
 const calls=[];const options={sportId:1,now:new Date('2026-10-21T08:00:00Z'),
  api:async u=>u.includes('boxscore')?box:{dates:[{games:[g,g]}]},read:async()=>[],
  rpc:async(_,{p})=>{calls.push(p);throw Error('HTTP 500');}};
 const failed=await recoverPostgames(options);assert.equal(failed.attempted,1);assert.equal(failed.complete,0);assert.equal(failed.pending,1);
 options.rpc=async(_,{p})=>({game_id:p.game.game_id,complete:true,pitcher_rows:p.rows.length});
 const good=await recoverPostgames(options);assert.equal(good.complete,1);assert.equal(good.pitcher_rows,4);
});
test('fresh receipts skip redundant work while stale recent receipts are refreshed',async()=>{
 const {g,box}=fixture();const now=new Date('2026-10-21T08:00:00Z');let captured=now.toISOString();
 const options={sportId:1,now,api:async u=>u.includes('boxscore')?box:{dates:[{games:[g]}]},
  read:async t=>t==='bb_postgame_receipts'?[{game_id:1,captured_at:captured,collector_version:'postgame-complete-v1'}]:[],
  rpc:async()=>({game_id:1,complete:true,pitcher_rows:4})};
 assert.equal((await recoverPostgames(options)).attempted,0);
 captured='2026-10-20T09:00:00Z';assert.equal((await recoverPostgames(options)).complete,1);
});
test('VPS HTTP 406 fallback preserves multi-day schedule and accepts an empty off-season',async()=>{
 const url='https://statsapi.mlb.com/api/v1/schedule?sportId=11&startDate=2026-10-16&endDate=2026-10-23';const seen=[];
 const data=await fetchPostgameJson(url,async o=>{seen.push(o.url);return seen.length===1?{statusCode:406,body:'blocked'}:{statusCode:200,body:'{"dates":[]}'};});
 assert.deepEqual(data,{dates:[]});assert.equal(seen[1],'https://r.jina.ai/'+url);
 await assert.rejects(()=>fetchPostgameJson(url,async()=>({statusCode:503})),/unavailable/);
});
