'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {parseEventIdentity,parseBookmakerRows,pickBookmaker,marketHashFragment,pickMainLine}=require('../vendor/parser_cuotasahora');
const header={home_team:'Milwaukee Brewers',away_team:'Tampa Bay Rays'};
const event={'@type':['Event','SportsEvent'],homeTeam:{name:header.home_team},awayTeam:{name:header.away_team},startDate:'2026-10-24T02:00:00+02:00',eventStatus:{'@id':'https://schema.org/EventScheduled'}};
test('actual SportsEvent date supplies UTC date across timezones',()=>{
 assert.equal(parseEventIdentity([JSON.stringify(event)],header).start_time_utc,'2026-10-24T00:00:00.000Z');
 assert.equal(parseEventIdentity([JSON.stringify({'@graph':[event]})],header).start_time_source,'sports_event_jsonld');
});
test('unknown timezone, different teams and ambiguous dates fail closed',()=>{
 for(const change of [{startDate:'2026-10-24T02:00:00'},{homeTeam:{name:'Other'}},{startDate:'invalid'}])assert.equal(parseEventIdentity([JSON.stringify({...event,...change})],header),null);
 assert.equal(parseEventIdentity([JSON.stringify([event,{...event,startDate:'2026-10-25T02:00:00+02:00'}])],header),null);
});
test('bookmaker beyond old row cap and without an affiliate bonus is parsed',()=>{
 const lines=['Bookmakers'];for(let i=0;i<15;i++)lines.push('Example '+i,'OBTENER BONO','1.80','2.00','94.7%');
 lines.push('Bet365','1.91','1.91','95.5%','Mi cupón','Bogus','OBTENER BONO','1.90','1.90','95%');
 const rows=parseBookmakerRows(lines,0,lines.length);
 assert.equal(pickBookmaker(rows,'bet365').odds1,1.91);assert.equal(rows.length,16);
 assert.equal(pickBookmaker(rows,'Bet365.de'),null);
});
test('missing requested bookmaker never substitutes another one',()=>{
 const lines=['Cloudbet','OBTENER BONO','1.53','2.55','95.6%'];
 assert.equal(pickBookmaker(parseBookmakerRows(lines,0,lines.length),'Bet365'),null);
});


test('accented market hash uses canonical full-game route and preserves event identity',()=>{
 assert.equal(marketHashFragment('#WtTquPP9:M%C3%A1s/Menos;1','OU'),'#WtTquPP9:over-under;1');
 assert.equal(marketHashFragment('#WtTquPP9:HA;1','HC'),'#WtTquPP9:ah;1');
 assert.equal(marketHashFragment('#WtTquPP9:HA;3','HC'),null);
 assert.equal(marketHashFragment('#WtTquPP9','OU'),null);
});


test('equally covered totals prefer balanced prices over the first alternative line',()=>{
 const lines=[{line:5.5,count:6,odds1:1.74,odds2:2.42},{line:6.5,count:6,odds1:1.92,odds2:1.99}];
 assert.equal(pickMainLine(lines).line,6.5);
});
