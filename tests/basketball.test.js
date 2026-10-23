'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {counts,game,status,sourceUrl}=require('../basketball/espn');
const model=require('../basketball/model');
const {validateQuote,candidate}=require('../basketball/pipeline');
const {evaluate}=require('../basketball/research');
const {notify}=require('../basketball/notifications');
const nba=require('./fixtures/basketball/nba_final.json'),wnba=require('./fixtures/basketball/wnba_final.json');
test('NBA and WNBA captured fixtures reconcile team and player points and minutes',()=>{
 for(const f of [nba,wnba]){assert.equal(f.receipt.complete,true);assert.equal(f.teams.length,2);assert.equal(new Set(f.players.map(p=>p.player_id)).size,f.players.length);
  for(const t of f.teams){const ps=f.players.filter(p=>p.team_id===t.team_id&&!p.did_not_play);assert.equal(ps.reduce((s,p)=>s+p.stats.points,0),t.stats.points);const duration=(f.game.league==='NBA'?48:40)+Math.max(0,f.game.periods-4)*5;assert.ok(Math.abs(ps.reduce((s,p)=>s+p.minutes,0)-duration*5)<=ps.length);}
  for(const p of f.players.filter(p=>p.did_not_play)){assert.equal(p.stats,null);assert.equal(p.minutes,0);}
 }
});
test('source refuses untrusted hosts and unknown game status',()=>{assert.throws(()=>sourceUrl('https://other.test/'));assert.throws(()=>status({type:{name:'UNKNOWN',state:'post'}}));assert.equal(status({type:{name:'STATUS_POSTPONED'}}),'postponed');});
test('missing box fields cannot become zero',()=>{assert.throws(()=>counts({splits:{categories:[]}}));});
test('incomplete and future games cannot enter a training snapshot',()=>{
 const g={...nba.game,box_complete:true},date=new Date(Date.parse(g.starts_at)+5*3600000).toISOString();
 assert.equal(model.prepareHistory([g],nba.teams,nba.players,date,'NBA').games.length,1);
 assert.equal(model.prepareHistory([{...g,box_complete:false}],nba.teams,nba.players,date,'NBA').teams.length,0);
 assert.equal(model.prepareHistory([g],nba.teams,nba.players,g.starts_at,'NBA').players.length,0);
});
test('integer prop lines retain pushes and paired probabilities sum to one',()=>{
 for(const [mu,v]of [[0,0],[5,5],[23,70]])for(const line of [0,1,5.5,23,30.5]){const o=model.countDistribution(mu,v,line,'over'),u=model.countDistribution(mu,v,line,'under');assert.ok(Math.abs(o.p_win+o.p_push+o.p_loss-1)<1e-10);assert.ok(Math.abs(o.p_win-u.p_loss)<1e-10);assert.ok(Math.abs(o.p_push-u.p_push)<1e-10);if(!Number.isInteger(line))assert.equal(o.p_push,0);}
});
test('spread sign follows selected team',()=>{const f={status:'OK',margin:8,margin_variance:100};assert.ok(model.probability({market:'spread',selection:'home',line:-3.5},f).p_win>.5);assert.ok(model.probability({market:'spread',selection:'away',line:3.5},f).p_win<.5);});
const now=new Date('2026-10-23T10:00:00Z'),g={...nba.game,status:'scheduled',starts_at:'2026-10-23T14:00:00Z'},q={quote_id:'q1',league:g.league,game_id:g.game_id,market:'total',player_id:null,line:220.5,selection:'over',odds:1.9,bookmaker:'bet365',source_url:'https://www.cuotasahora.com/test',period:'full_game',includes_overtime:true,captured_at:now.toISOString(),expires_at:'2026-10-23T10:15:00Z'};
test('quote identity, freshness, period and line are hard gates',()=>{assert.deepEqual(validateQuote(q,g,now),[]);for(const change of [{game_id:'other'},{includes_overtime:false},{period:'first_half'},{expires_at:now.toISOString()},{line:null},{line:220.25},{selection:'home'}])assert.ok(validateQuote({...q,...change},g,now).length);});
test('discarded quotes are retained and unverified prices remain labelled',()=>{const c=candidate(q,g,{status:'OK',model_version:model.MODELS.baseline.version,total:180,total_variance:100},now);assert.equal(c.verdict,'NO_EDGE');assert.ok(c.reasons.includes('BOOKMAKER_UPDATE_TIME_UNKNOWN'));assert.ok(c.ev<0);});
test('notification is not acknowledged on Telegram false success',async()=>{const calls=[],ctx={owner:'1',rest:async(p,m,b)=>{calls.push({p,b});return true;},send:async()=>({ok:true,suppressed:true})};assert.equal(await notify(ctx,'test','NBA','x'),false);assert.equal(calls.at(-1).b.p_message_id,null);ctx.send=async()=>({ok:true,result:{message_id:5}});assert.equal(await notify(ctx,'test2','NBA','x'),true);assert.equal(calls.at(-1).b.p_message_id,5);});
test('research does not announce improvement before fixed 200-game prospective test',()=>{
 const gs=[],fs=[];for(let i=0;i<199;i++){const game={game_id:String(i),status:'final',box_complete:true,starts_at:new Date(now.getTime()+i*86400000).toISOString(),home_score:100,away_score:90};gs.push(game);for(const [name,cfg]of Object.entries(model.MODELS))fs.push({game_id:game.game_id,kind:'team',model_version:cfg.version,as_of:'2026-01-01',created_at:'2026-01-01',result:{margin:name==='baseline'?0:10,total:190}});}
 const r=evaluate(gs,fs,[],[]);assert.equal(r.comparison.n,199);assert.equal(r.comparison.improvement,false);gs.push({...gs[0],game_id:'199',starts_at:'2027-06-01'});fs.push(...fs.slice(0,2).map(f=>({...f,game_id:'199'})));assert.equal(evaluate(gs,fs,[],[]).comparison.improvement,true);
 const leaked=fs.map(f=>({...f,created_at:'2030-01-01'}));assert.equal(evaluate(gs,leaked,[],[]).comparison.n,0);
});
