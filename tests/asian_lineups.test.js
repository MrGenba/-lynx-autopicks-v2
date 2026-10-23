'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {game:npbGame}=require('../collectors/npb'),{game:cpblGame}=require('../collectors/cpbl');
const {validNine,inWindow,kboLineups,npbLineups,cpblLineups,message}=require('../collectors/asian_lineups');
const {deliver,runAsianLineups,fetchLineups}=require('../collectors/asian_lineups_runner');
const kbo=require('./fixtures/kbo_lineup_final.json'),unconfirmed=require('./fixtures/kbo_lineup_unconfirmed.json'),npb=require('./fixtures/npb_lineup_final.json'),cpbl=require('./fixtures/cpbl_c4.json');
const kg={game_id:'20261020HTLG0',game_pk:'20261020_KIA_LG',game_date:'2026-10-20',season:2026,series_id:3,away_team:'KIA',home_team:'LG',status:'scheduled',game_start:'2026-10-20T09:30:00Z'};
const ng=npbGame(require('./fixtures/npb_boxscore.json').calendar);
test('KBO requires explicit announcement and validates the exact match',()=>{
 assert.deepEqual(kboLineups(kg,unconfirmed),[]);
 const es=kboLineups(kg,kbo);assert.equal(es.length,2);assert.equal(es[0].players.length,9);assert.equal(es[1].players[0].name,'박해민');
 assert.throws(()=>kboLineups({...kg,game_id:'20261020HTLG1'},kbo),/IDENTITY/);
 const wrong=structuredClone(kbo);wrong[0][0].LINEUP_CK='false';assert.throws(()=>kboLineups(kg,wrong),/RESPONSE/);
});
test('NPB keeps only original starters; bench and wrong games are rejected',()=>{
 const es=npbLineups(ng,npb);assert.equal(es.length,2);assert.deepEqual(es.map(e=>e.players.length),[9,9]);assert.equal(es[0].pitcher,'東　克樹');
 assert.equal(es[1].players[0].name,'近本　光司');assert.deepEqual(npbLineups(ng,[]),[]);
 const partial=npb.filter(p=>Number(p.startBatNo)!==9);assert.deepEqual(npbLineups(ng,partial),[]);
 assert.throws(()=>npbLineups({...ng,game_id:'2021039492'},npb),/IDENTITY/);
});
test('CPBL discards substitutes and never alerts a final/cancelled game',()=>{
 const raw=structuredClone(cpbl),g=cpblGame(raw.Data.Game),now=new Date(g.game_time);
 assert.deepEqual(cpblLineups(g,raw,now).events,[]);
 raw.Data.Game.GameStatus='START';const es=cpblLineups(g,raw,now).events;
 assert.equal(es.length,2);assert.deepEqual(es.map(e=>e.players.length),[9,9]);assert(!es[0].players.some(p=>p.name==='王順和'));
 raw.Data.Game.GameStatus='POSTPONED';assert.deepEqual(cpblLineups(g,raw,now).events,[]);
 raw.Data.Game.GameStatus='SCHEDULED';raw.Data.Game.Home.Hitters=[];raw.Data.Game.Visiting.Hitters=[];assert.deepEqual(cpblLineups(g,raw,now).events,[]);
});
test('duplicate identities, orders and positions cannot become confirmed lineups',()=>{
 const es=npbLineups(ng,npb),p=es[0].players;
 assert.throws(()=>validNine([...p.slice(0,8),p[0]]),/INVALID_CONFIRMED_NINE/);
 assert.throws(()=>validNine(p.map((x,i)=>i===1?{...x,id:p[0].id}:x)),/INVALID_CONFIRMED_NINE/);
 assert.throws(()=>validNine(p.map((x,i)=>i===1?{...x,position:p[0].position}:x)),/INVALID_CONFIRMED_NINE/);
});
test('window handles UTC, unknown times, finals and stale postponed schedules',async()=>{
 const now=new Date(kg.game_start);assert(inWindow(kg,now));assert(!inWindow({...kg,status:'final'},now));assert(!inWindow({...kg,game_start:null},now));
 assert(!inWindow(kg,new Date(now.getTime()+31*60000)));assert(!inWindow(kg,new Date(now.getTime()-301*60000)));
 let calls=0;
 const http=async()=>{calls++;return {status:200,body:[{...require('./fixtures/npb_boxscore.json').calendar,gameStateName:'中止',gameStateId:1}]};};
 const r=await fetchLineups('NPB',{...ng,status:'scheduled'},http,new Date(ng.game_time));assert.deepEqual(r.events,[]);assert.equal(calls,1);
});
test('a failed Telegram response is not acknowledged; next attempt can deliver',async()=>{
 const e=npbLineups(ng,npb)[0],calls=[];let sent=false,leased=false;
 const rest=async(p,m,b)=>{calls.push(b);if(p.includes('claim')){if(sent||leased)return null;leased=true;return {payload:e};}leased=false;if(b.p_message_id)sent=true;return true;};
 await assert.rejects(deliver(rest,async()=>({ok:false}),e,'first'),/DELIVERY_FAILED/);assert.equal(sent,false);assert.equal(calls.at(-1).p_message_id,null);
 assert.equal(await deliver(rest,async()=>({ok:true,result:{message_id:123}}),e,'second'),'sent');assert(sent);
 assert.equal(await deliver(rest,async()=>{throw Error('must not resend');},e,'third'),'already_claimed_or_sent');
});
test('NPB pregame calendar with null metadata resolves the game-specific overview',async()=>{
 const calendar={gameId:Number(ng.game_id),startTime:'1400',gameTypeId:null,gameDate:null,homeTeamId:null,visitorTeamId:null};
 const overview=[{gameId:Number(ng.game_id),gameDate:ng.game_date.replace(/-/g,''),gameKindId:36,homeTeamId:5,visitorTeamId:3,startTime:'1400'}];
 const urls=[],http=async url=>{urls.push(url);return {status:200,body:url.includes('games_info')?[calendar]:url.includes('game_over_view')?overview:npb};};
 const result=await fetchLineups('NPB',{...ng,status:'scheduled'},http,new Date(ng.game_time));assert.equal(result.events.length,2);assert.equal(urls.length,3);
});
test('simultaneous executions cannot both send and failed acknowledgments keep the lease',async()=>{
 const e=npbLineups(ng,npb)[0];let leased=false,sends=0;
 const rest=async p=>{if(p.includes('claim')){if(leased)return null;leased=true;return {payload:e};}throw Error('database unavailable');};
 const send=async()=>{sends++;return {ok:true,result:{message_id:456}};};
 const r=await Promise.allSettled([deliver(rest,send,e,'one'),deliver(rest,send,e,'two')]);assert.equal(sends,1);assert.equal(r.filter(x=>x.status==='rejected').length,1);assert.equal(leased,true);
});
test('empty calendars produce no alerts; NPB2 is explicitly unsupported',async()=>{
 const writes=[];const rest=async(p,m,b)=>{if(m==='POST'){writes.push(b);return null;}return [];};
 const r=await runAsianLineups({rest,http:async()=>{throw Error('should not fetch');},send:async()=>{throw Error('should not send');},owner:'test'});
 assert.equal(r.sent,0);assert.deepEqual(r.errors,[]);assert.equal(writes.length,4);assert.equal(r.leagues.NPB2.enabled,false);assert.equal(writes.at(-1).status,'unsupported');
});
test('calendar outage is visible without preventing the other leagues from polling',async()=>{
 const writes=[];const rest=async(p,m,b)=>{if(m==='POST'){writes.push(b);return null;}if(p.startsWith('kbo_'))throw Error('offline');return [];};
 const r=await runAsianLineups({rest,owner:'test'});assert.equal(r.errors.length,1);assert.equal(writes[0].status,'error');assert.equal(writes[1].status,'healthy');
});
test('message carries league, side, nine players, local time and source',()=>{
 const e=kboLineups(kg,kbo)[0],s=message(e);assert.match(s,/LINEUP CONFIRMADO — KBO/);assert.match(s,/20\/10/);assert.match(s,/Madrid/);assert.match(s,/9\./);assert.match(s,/Fuente:/);
});
test('workflow compiles with private settings injected by the deployer',()=>{
 const {code}=require('../collectors/asian_lineups_workflow');const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 assert.doesNotThrow(()=>new AsyncFunction(code({url:'https://example.invalid',key:'placeholder',bot:'placeholder',chat:'placeholder'})));
});
