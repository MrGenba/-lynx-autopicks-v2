'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parseGamePrices,parsePlayerPrices,normalizePublicQuotes}=require('../basketball/ps3838');
const {validateQuote,candidate}=require('../basketball/pipeline');
const {runPublicOdds}=require('../basketball/ps3838_capture');
const now=new Date('2026-10-23T14:00:00Z'),time=1792786200000;
const g={league:'NBA',game_id:'test',home_team:'Milwaukee Bucks',away_team:'Chicago Bulls',home_team_id:'15',away_team_id:'4',starts_at:'2026-10-23T20:00:00Z',status:'scheduled'};
const odds=(id,price,team_type,odds_id)=>({id,price,team_type,odds_id,period:'0',start_ms:String(time),parent_id:'1638951759',visible:true,disabled:false,status:'status_1'});
// Sanitized observations from the anonymous public event table, 2026-10-23.
const e={league:'NBA',source_event_id:'1638951759',home_team:g.home_team,away_team:g.away_team,live:'0',start_time_utc:new Date(time).toISOString(),captured_at:now.toISOString(),source_event_url:'https://www.ps3838.com/fr/sports/basketball',odds:[
 odds('1638951759|0|1|0|0|0','1.909','1','3775934488'),odds('1638951759|0|1|1|0|0','2.000','0','3775934488'),
 odds('1638951759|0|2|0|1|-1.5','1.990','1','57433780021'),odds('1638951759|0|2|1|1|1.5','1.900','0','57433780021'),
 odds('1638951759|0|3|3|1|240','1.990','1','57433780020'),odds('1638951759|0|3|4|1|240','1.884','0','57433780020')],player_rows:[{title:'Josh Giddey Total Points',period:'Match',disabled:false,outcomes:[
 {id:'1639036632|0|99|10|0|13.5|1639036633',label:'Plus de 13.5 Points',price:'1.869',visible:true},
 {id:'1639036632|0|99|10|0|13.5|1639036634',label:'Inférieur à 13.5 Points',price:'1.869',visible:true}]}]};
const raw={bookmaker:'ps3838',league:'NBA',anonymous:true,delayed:true,games:[e]},forecast={league:'NBA',game_id:g.game_id,player_id:'4871145',result:{player_name:'Josh Giddey',team_id:'4'}};
test('public game prices preserve team order, signed handicaps and paired totals',()=>{
 const p=parseGamePrices(e);assert.equal(p.length,6);assert.deepEqual(p.filter(x=>x.market==='spread').map(x=>[x.selection,x.line,x.odds,x.opposite_odds]),[['home',-1.5,1.99,1.9],['away',1.5,1.9,1.99]]);
 assert.equal(p.find(x=>x.market==='moneyline'&&x.selection==='home').odds,1.909);
 for(const change of [{period:'1'},{disabled:true},{visible:false},{status:'status_0'},{team_type:'0'},{parent_id:'other'},{start_ms:String(time+60000)}])assert.equal(parseGamePrices({...e,odds:[{...e.odds[0],...change},e.odds[1]]}).length,0);
 assert.equal(parseGamePrices({...e,odds:[e.odds[4],{...e.odds[5],id:e.odds[5].id.replace('|240','|239.5')}]}).length,0);
});
test('public player prices require matching line, full game, visible pair and stat label',()=>{
 const p=parsePlayerPrices(e);assert.equal(p.length,2);assert.equal(p[0].player_name,'Josh Giddey');assert.equal(p[0].line,13.5);assert.equal(p[1].selection,'under');
 assert.equal(parsePlayerPrices({...e,player_rows:[{...e.player_rows[0],title:'Josh Giddey Total des points'}]}).length,2);
 const row=e.player_rows[0];for(const change of [{period:'1re mi-temps'},{title:'Josh Giddey Total Double Double'},{disabled:true},{outcomes:[row.outcomes[0],{...row.outcomes[1],label:'Inférieur à 14.5 Points'}]},{outcomes:[row.outcomes[0],{...row.outcomes[1],visible:false}]}])assert.equal(parsePlayerPrices({...e,player_rows:[{...row,...change}]}).length,0);
});
test('delayed observations cannot produce EV candidates even if captured just now',()=>{
 const n=normalizePublicQuotes(raw,[g],now,[forecast]);assert.equal(n.quotes.length,8);assert.equal(n.quotes.filter(q=>q.player_id).length,2);
 for(const q of n.quotes){assert.equal(q.detail.delayed,true);assert.equal(q.price_updated_at,null);assert.equal(q.detail.delay_seconds,null);assert.ok(validateQuote({...q,includes_overtime:true},g,now).includes('DELAYED_REFERENCE_PRICE'));assert.equal(candidate({...q,includes_overtime:true},g,{status:'OK'},now),null);}
 assert.equal(normalizePublicQuotes({...raw,anonymous:false},[g],now).quotes.length,0);
 assert.equal(normalizePublicQuotes({...raw,access_denied:true},[g],now).quotes.length,0);
 for(const change of [{league:'WNBA'},{home_team:g.away_team,away_team:g.home_team},{start_time_utc:'2026-10-24T20:10:00Z'},{live:'1'},{source_event_url:'https://other.example/'}])assert.equal(normalizePublicQuotes({...raw,games:[{...e,...change}]},[g],now).quotes.length,0);
 assert.equal(normalizePublicQuotes(raw,[g],new Date(now.getTime()+16*60000)).quotes.length,0);
 const missing=normalizePublicQuotes(raw,[g],now);assert.ok(missing.quotes.filter(q=>q.detail.player_name).every(q=>q.player_id===null));
});
test('public source circuit stops browser requests after an access denial',async()=>{
 let calls=0;const result=await runPublicOdds({now,rest:async()=>[{status:'blocked'}],http:async()=>{calls++;}});assert.equal(calls,0);assert.equal(result.status,'ACCESS_BLOCKED_NO_AUTOMATIC_RETRY');
});
