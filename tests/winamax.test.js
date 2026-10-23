'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {eventIdentity,parsePairs,normalizeProps}=require('../basketball/winamax');
const {validateQuote,candidate}=require('../basketball/pipeline');
const {runProps,quoteMessage}=require('../basketball/props');
const now=new Date('2026-10-23T13:00:00Z');
const g={league:'NBA',game_id:'1',home_team:'Milwaukee Bucks',away_team:'Chicago Bulls',home_team_id:'15',away_team_id:'4',starts_at:'2026-10-23T20:00:00Z',status:'scheduled'};
const e={...eventIdentity('Milwaukee Bucks - Chicago Bulls | NBA | Basketball | Parier sur Winamax','NBA\nMilwaukee Bucks\n20:15\nChicago Bulls','NBA',[g.home_team,g.away_team],now),source_event_url:'https://www.winamax.fr/paris-sportifs/match/73719360',source_event_id:'73719360',markets:[{player_name:'Josh Giddey',market:'points',line:15.5,odds1:1.8,odds2:1.9,outcome_ids:['100','101'],captured_at:now.toISOString()}]};
const raw={league:'NBA',bookmaker:'winamax.fr',jurisdiction:'FR',games:[e]},f={league:'NBA',game_id:'1',player_id:'4871145',result:{player_name:'Josh Giddey',team_id:'4'}};
test('Winamax header uses UTC day and requires exact league, participants and one future time',()=>{
 assert.equal(e.start_time_utc,'2026-10-23T20:15:00.000Z');
 const title='Atlanta Dream - Golden State Valkyries | Finale (4/7) | WNBA | Basketball';
 assert.equal(eventIdentity(title,'Atlanta Dream\nDemain\n17:10\nGolden State Valkyries','WNBA',['Atlanta Dream','Golden State Valkyries'],now).start_time_utc,'2026-10-24T17:10:00.000Z');
 for(const text of ['Milwaukee Bucks\n25 Déc.\n20:15\nChicago Bulls','Milwaukee Bucks\n12:00\nChicago Bulls'])assert.throws(()=>eventIdentity('Milwaukee Bucks - Chicago Bulls | NBA',text,'NBA',[g.home_team,g.away_team],now));
 assert.throws(()=>eventIdentity('Milwaukee Bucks - Chicago Bulls | WNBA','Milwaukee Bucks\n20:15\nChicago Bulls','NBA',[g.home_team,g.away_team],now));
});
test('paired player lines reject suspended, mixed lines, palier markets and anonymous prices',()=>{
 const block={text:'Tyler Herro\nPlus de 22,5\n1,70\nMoins de 22,5\n1,74',outcome_ids:['100','101']};
 assert.deepEqual(parsePairs('Nombre de points du joueur',[block])[0],{player_name:'Tyler Herro',market:'points',line:22.5,odds1:1.7,odds2:1.74,outcome_ids:['100','101']});
 for(const change of [{disabled:true},{text:block.text.replace('Moins de 22,5','Moins de 23,5')},{text:block.text.replace('1,70','-')},{text:block.text.replace('Tyler Herro','Total équipe') ,outcome_ids:[]}])assert.equal(parsePairs('Nombre de points du joueur',[{...block,...change}]).length,0);
 assert.equal(parsePairs('Nombre de points du joueur (paliers)',[block]).length,0);
});
test('source identity, game time and player mapping fail closed while unmatched raw prices are retained',()=>{
 const r=normalizeProps(raw,[g],[f],now);assert.equal(r.quotes.length,2);assert.equal(r.quotes[0].player_id,f.player_id);assert.equal(r.quotes[0].detail.schedule_offset_seconds,900);assert.deepEqual(validateQuote(r.quotes[0],g,now),[]);
 for(const change of [{jurisdiction:'ES'},{start_time_utc:'2026-10-23T20:30:00Z'},{source_event_url:'https://www.winamax.es/paris-sportifs/match/73719360'},{home_team:g.away_team,away_team:g.home_team}])assert.equal(normalizeProps({...raw,games:[{...e,...change}]},[g],[f],now).quotes.length,0);
 const missing=normalizeProps(raw,[g],[],now);assert.equal(missing.quotes.length,2);assert.equal(missing.quotes[0].player_id,null);assert.ok(validateQuote(missing.quotes[0],g,now).includes('MARKET_UNSUPPORTED'));
 assert.equal(normalizeProps(raw,[g],[f,{...f,player_id:'other'}],now).quotes[0].player_id,null);
 assert.equal(normalizeProps(raw,[g],[f],new Date(now.getTime()+16*60000)).quotes.length,0);
});
test('access-denied state performs no further server requests',async()=>{
 let calls=0;const r=await runProps({now,rest:async()=>[{status:'blocked'}],http:async()=>{calls++;throw Error('Unexpected request')}});assert.equal(calls,0);assert.equal(r.status,'ACCESS_BLOCKED_NO_AUTOMATIC_RETRY');
});
test('FR identity and rules uncertainty remain in research candidates and Telegram text',()=>{
 const q=normalizeProps(raw,[g],[f],now).quotes[0],forecast={status:'OK',model_version:'test',availability:'UNVERIFIED',props:{points:{mean:16,variance:30}}};
 const c=candidate(q,g,forecast,now);assert.ok(c.reasons.includes('WINAMAX_FR_NOT_VERIFIED_EQUIVALENT_TO_ES'));assert.ok(c.reasons.includes('RULES_REFERENCE_2024_CURRENT_VERSION_UNCONFIRMED'));assert.match(quoteMessage(g,[q]),/Winamax.fr/);assert.equal(quoteMessage(g,[{...q,player_id:null}]),null);
});
