'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const m=require('../basketball/market_balance'),ref=require('../basketball/ps3838_reference');
const {validateQuote,candidate}=require('../basketball/pipeline');
const time='2026-10-24T15:00:00Z',now=new Date(time);
const g={league:'WNBA',game_id:'g',status:'scheduled',starts_at:'2026-10-24T17:00:00Z',home_team:'Home',away_team:'Away',periods:4,box_complete:true,home_score:90,away_score:80};
const q={quote_id:'over',league:'WNBA',game_id:'g',player_id:'p',market:'points',line:20.5,selection:'over',odds:1.923,opposite_odds:1.901,bookmaker:'ps3838',source:'ps3838_public_delayed',source_url:'https://www.ps3838.com/fr/sports/basketball',period:'full_game',includes_overtime:false,captured_at:time,expires_at:'2026-10-24T15:15:00Z',detail:{delayed:true,reference_only:true,bookmaker_event_id:'event',identity_status:'EXACT_NAME_IN_GAME_FORECAST',player_name:'Example Player'}};
const pair={...q,quote_id:'under',selection:'under',odds:q.opposite_odds,opposite_odds:q.odds};
const p={league:'WNBA',game_id:'g',player_id:'p',minutes:30,stats:{points:21}};
const published={...q,bookmaker:'winamax.fr',odds:1.8,player_name:'Example Player',notification_id:'sent-pregame',result:'WIN',paper_units:.8};
test('unit accounting reconciles wins, losses, pushes and returns without counting missing/DNP as losses',()=>{
 const game={...g,status:'final'};
 const rows=[m.settle(game,{...q,odds:1.8},[p]),m.settle(game,q,[{...p,stats:{points:5}}]),m.settle(game,{...q,line:21},[p]),m.settle(game,q,[{...p,did_not_play:true}]),m.settle(game,q,[])];
 const s=m.summary(rows);assert.equal(s.paper_staked,3);assert.ok(Math.abs(s.paper_won-.8)<1e-9);assert.equal(s.paper_lost,1);
 assert.ok(Math.abs(s.paper_units+.2)<1e-9);assert.ok(Math.abs(s.paper_returned-2.8)<1e-9);assert.equal(s.DNP,1);assert.equal(s.MISSING,1);
 assert.equal(m.summary([]).paper_roi,null);
});
test('PS3838 references are visible for both leagues, preserve price precision and never bypass value gates',()=>{
 for(const league of ['NBA','WNBA']){const game={...g,league},quotes=[q,pair].map(q=>({...q,league}));
  const previews=ref.previews(game,[],quotes,now);assert.equal(previews.length,1);assert.match(previews[0].text,/REFERENCIA RETRASADA/);assert.match(previews[0].text,/@1.923/);
  assert.equal(previews[0].payload.selections,undefined);assert.equal(previews[0].payload.reference_quotes.length,2);
  assert.equal(m.publishedSelections({...game,status:'final'},[{league,sent_at:time,created_at:time,notification_id:'reference',payload:previews[0].payload}],[],[p]).informational.length,0);
  for(const price of quotes){assert.ok(validateQuote(price,game,now).includes('DELAYED_REFERENCE_PRICE'));assert.equal(candidate(price,game,{status:'OK'},now),null);}
 }
});
test('references reject stale/future observations, incomplete pairs, foreign players and mismatched spread signs',()=>{
 assert.equal(ref.previews(g,[],[q,pair],new Date('2026-10-24T15:16:00Z')).length,0);
 assert.equal(ref.previews(g,[],[q,pair],new Date('2026-10-24T14:59:00Z')).length,0);
 assert.equal(ref.pairs(g,[q]).length,0);
 assert.equal(ref.pairs(g,[q,{...pair,game_id:'other'}]).length,0);
 assert.equal(ref.pairs(g,[q,{...pair,detail:{...pair.detail,bookmaker_event_id:'other'}}]).length,0);
 assert.equal(ref.pairs(g,[q,pair].map(q=>({...q,player_id:null}))).length,0);
 assert.equal(ref.pairs(g,[q,pair].map(q=>({...q,detail:{...q.detail,identity_status:'UNVERIFIED'}}))).length,0);
 const spread={...q,player_id:null,market:'spread',selection:'home',line:-5,detail:{...q.detail,player_name:null}},other={...spread,quote_id:'away',selection:'away',line:-5,odds:spread.opposite_odds,opposite_odds:spread.odds};
 assert.equal(ref.pairs(g,[spread,other]).length,0);assert.equal(ref.pairs(g,[spread,{...other,line:5}]).length,1);
});
test('historical comparison retains the actual delivered side and line, with unresolved overtime kept out of units',()=>{
 const game={...g,status:'final'},before=JSON.stringify(published),r=m.referenceComparison(game,[published],[q,pair],[p]);
 assert.equal(r.rows.length,1);assert.equal(r.rows[0].odds,1.923);assert.equal(r.rows[0].original_odds,1.8);assert.equal(r.rows[0].result,'WIN');assert.equal(JSON.stringify(published),before);
 assert.equal(m.referenceComparison(game,[{...published,line:21.5}],[q,pair],[p]).missing.length,1);
 assert.equal(m.referenceComparison(game,[{...published,player_name:'Another Player'}],[q,pair],[p]).rows.length,0);
 assert.equal(m.referenceComparison(game,[published],[q,pair].map(q=>({...q,captured_at:g.starts_at})),[p]).rows.length,0);
 for(const periods of [5,null]){const r=m.referenceComparison({...game,periods},[published],[q,pair],[p]);assert.equal(r.rows[0].result,'RULES_UNVERIFIED');assert.equal(r.summary.paper_staked,0);assert.equal(r.rows[0].paper_units,null);}
 const loss=m.referenceComparison(game,[published],[q,pair],[{...p,stats:{points:1}}]);assert.equal(loss.rows[0].selection,'over');assert.equal(loss.rows[0].result,'LOSS');
});
test('cumulative ledger replaces revisions, requires complete receipts and never sums reference or discarded selections into delivered units',()=>{
 const b={game_id:'g',league:'WNBA',box_complete:true,published:[published],value:[],evaluated:[published],reference:{rows:[{...published,odds:2,paper_units:1}],missing:[]}};
 const receipt=(version,part,complete,balance,created=time)=>({notification_id:'market-balance-'+version+':WNBA:g:box:'+part,league:'WNBA',sent_at:time,created_at:created,payload:{kind:'basketball_market_balance',game_id:'g',complete,...(balance?{balance}:{})}});
 const old=receipt('v1',1,true,b),first=receipt('v2',1,false,b,'2026-10-24T18:00:00Z'),last=receipt('v2',2,true,null,'2026-10-24T18:01:00Z');
 const pending=m.ledger([old,first],'WNBA');assert.equal(pending.source_ids[0],old.notification_id);
 const l=m.ledger([last,old,first],'WNBA');assert.equal(l.games,1);assert.equal(l.published.total,1);assert.equal(l.reference.total,1);assert.ok(Math.abs(l.published.paper_units-.8)<1e-9);assert.equal(l.value.total,0);assert.equal(l.source_ids[0],first.notification_id);
 assert.equal(m.ledger([first,last,old],'WNBA').signature,l.signature);assert.notEqual(l.signature,pending.signature);assert.match(m.ledgerMessage(l),/neto \+0.80 u/);
 const incompleteScore={...receipt('v3',1,true,{...b,box_complete:false},'2026-10-24T19:00:00Z'),notification_id:'market-balance-v3:WNBA:g:score:1'};
 assert.equal(m.ledger([first,last,old,incompleteScore],'WNBA').source_ids[0],first.notification_id);
});
