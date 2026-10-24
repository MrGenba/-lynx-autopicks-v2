'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const s=require('../basketball/winamax_schedule'),{runProps}=require('../basketball/props');
test('Madrid afternoon gate handles the October clock change and closes before 22:00',()=>{
 for(const day of ['2026-10-24','2026-10-25']){const hour=day.endsWith('24')?13:14;assert.equal(s.inWindow(new Date(day+'T'+hour+':00:00Z')),true);assert.equal(s.inWindow(new Date(day+'T'+(hour-1)+':59:59Z')),false);assert.equal(s.inWindow(new Date(day+'T'+(hour+7)+':00:00Z')),false);assert.equal(s.sessionMs(new Date(day+'T'+(hour+6)+':59:40Z')),20000);}
 assert.equal(s.sessionMs(new Date('2026-10-24T13:00:00Z')),90000);
});
test('shared budget survives restarts, resets on the Madrid date and honors cooldowns',()=>{
 const now=new Date('2026-10-24T13:00:00Z');
 assert.equal(s.launchReason(s.budget({day:'2026-10-24',sessions:14},now),now),'DAILY_BROWSER_LIMIT');
 assert.equal(s.launchReason(s.budget({last_started_at:'2026-10-24T12:45:00Z'},now),now),'BROWSER_INTERVAL');
 assert.equal(s.launchReason(s.budget({cooldown_until:'2026-10-24T14:00:00Z'},now),now),'SOURCE_COOLDOWN');
 assert.equal(s.launchReason(s.budget({day:'2026-10-23',sessions:14},now),now),null);
});
const g={league:'NBA',game_id:'g',home_team:'LA Clippers',away_team:'Away',status:'scheduled',starts_at:'2026-10-24T22:00:00Z'};
const e={home_team:'Los Angeles Clippers',away_team:'Away',start_time_utc:g.starts_at,source_event_url:'https://www.winamax.fr/paris-sportifs/match/1',jurisdiction:'FR',time_basis:'visible_header_UTC',markets:[],notes:['NO_SUPPORTED_PLAYER_MARKETS_VISIBLE']};
test('publication history brackets first visibility, preserves evidence and never treats failed reads as empty',()=>{
 const now=new Date('2026-10-24T14:00:00Z'),raw={games:[e],fetched_at:now.toISOString()};
 let r=s.observe({},[g],raw,[],now,'a');assert.equal(r.observations.g.last_absent_at,now.toISOString());
 const later=new Date('2026-10-24T15:00:00Z'),quotes=[{league:'NBA',game_id:'g',market:'points',captured_at:later.toISOString()}];
 r=s.observe(r,[g],{games:[{...e,markets:[{}]}]},quotes,later,'b');assert.equal(r.observations.g.first_seen_at,later.toISOString());assert.equal(r.profile.bracketed_events,1);
 const repeat=s.observe(r,[g],{games:[{...e,markets:[{}]}]},quotes,later,'b');assert.equal(repeat.observations.g.checks.length,2);
 const late=s.observe(r,[g],raw,[],new Date('2026-10-24T16:00:00Z'),'c');assert.equal(late.observations.g.last_absent_at,now.toISOString());
 assert.deepEqual(s.observe({},[g],{games:[{...e,notes:['STATS_TAB_NOT_CLICKABLE']}]},[],now,'a').observations,{});
 assert.deepEqual(s.observe({},[g],{games:[{...e,jurisdiction:'ES'}]},[],now,'a').observations,{});
 assert.equal(s.observe({},[g],{games:[{...e,markets:[{}]}]},quotes,later,'first').profile.bracketed_events,0);
});
test('a learned window requires 20 bounded observations over seven distinct days',()=>{
 const observations={};for(let d=1;d<=7;d++)for(let i=0;i<3;i++){const day='2026-10-'+String(d).padStart(2,'0');observations[d+':'+i]={last_absent_at:day+'T14:00:00Z',first_seen_at:day+'T15:00:00Z'};}
 const p=s.profile(observations);assert.equal(p.status,'LEARNED_INTERVAL');assert.equal(p.independent_days,7);assert.equal(p.startMinute,930);assert.equal(p.endMinute,1050);
 assert.equal(s.gameGapMinutes({profile:p},new Date('2026-10-24T13:00:00Z')),120);assert.equal(s.gameGapMinutes({profile:p},new Date('2026-10-24T14:00:00Z')),60);
 for(const key of Object.keys(observations).filter(k=>k.startsWith('7:')))delete observations[key];assert.equal(s.profile(observations).status,'LEARNING');
});
function harness(now){
 const states=new Map(),calls=[];let job=0;
 const ctx={now,owner:'test',server:{url:'https://server.test',token:'x'},http:async url=>{calls.push(url);return {status:200,body:url.includes('/status/')?{status:'done',result:{bookmaker:'winamax.fr',jurisdiction:'FR',games:[],errors:[]}}:{job_id:'j'+(++job)}};},rest:async(p,m='GET',b)=>{
  if(m==='POST'){if(p.startsWith('bk_state?'))states.set(b.league+':'+b.component,structuredClone(b));return false;}
  if(p.startsWith('bk_games?'))return [{...g,league:p.includes('NBA&')?'NBA':'WNBA'}];
  if(p.startsWith('bk_forecasts?'))return [];
  if(p.startsWith('bk_state?')){const league=/league=eq\.([^&]+)/.exec(p)?.[1],component=/component=eq\.([^&]+)/.exec(p)?.[1],r=states.get(league+':'+component);return r?[r]:[];}
  throw Error('Unexpected '+p);
 }};
 return {ctx,states,calls};
}
test('both leagues share one launch budget, alternate turns and never open browsers outside afternoons',async()=>{
 const h=harness(new Date('2026-10-24T06:00:00Z'));
 await runProps(h.ctx);assert.equal(h.calls.length,0);
 await runProps({...h.ctx,now:new Date('2026-10-24T13:00:00Z')});assert.equal(h.calls.filter(x=>x.includes('/start?')).length,1);assert.match(h.calls[0],/league=NBA/);
 await runProps({...h.ctx,now:new Date('2026-10-24T13:01:00Z')});assert.equal(h.calls.filter(x=>x.includes('/start?')).length,1);
 await runProps({...h.ctx,now:new Date('2026-10-24T13:30:00Z')});assert.equal(h.calls.filter(x=>x.includes('/start?')).length,2);assert.match(h.calls.at(-1),/league=WNBA/);
 assert.equal(h.states.get('ALL:props_browser_budget').detail.sessions,2);
 await runProps({...h.ctx,now:new Date('2026-10-24T20:00:00Z')});assert.equal(h.calls.filter(x=>x.includes('/start?')).length,2);
});
test('an active browser prevents another league opening a concurrent session',async()=>{
 const h=harness(new Date('2026-10-24T13:00:00Z'));h.states.set('NBA:props_job',{detail:{job_id:'active'}});h.ctx.http=async url=>{h.calls.push(url);return {status:200,body:{status:'running'}};};
 await runProps(h.ctx);assert.equal(h.calls.length,1);assert.ok(h.calls[0].includes('/status/'));
});
