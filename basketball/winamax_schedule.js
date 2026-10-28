'use strict';
const {teamNorm}=require('./winamax');
const POLICY=Object.freeze({version:'winamax-pregame-2',timezone:'Europe/Madrid',startHour:15,endHour:22,minSessionGapMinutes:30,maxDailySessions:96,maxPublicationSessions:14,pregameMinutes:90,pregameGapMinutes:5,pregameMaxGames:2,maxSessionSeconds:90,maxGames:3,perGameGapMinutes:60,outsideLearnedGapMinutes:120,minIntervals:20,minDays:7});
function localTime(now){const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:POLICY.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).map(p=>[p.type,p.value]));return {day:p.year+'-'+p.month+'-'+p.day,minutes:Number(p.hour)*60+Number(p.minute)};}
function inWindow(now){const {minutes}=localTime(now);return minutes>=POLICY.startHour*60&&minutes<POLICY.endHour*60;}
function sessionMs(now,pregame=false){if(pregame)return POLICY.maxSessionSeconds*1000;if(!inWindow(now))return 0;return Math.min(POLICY.maxSessionSeconds*1000,(POLICY.endHour*60-localTime(now).minutes)*60000-now.getUTCSeconds()*1000-now.getUTCMilliseconds());}
function budget(raw={},now){const same=raw.day===localTime(now).day;return {...raw,day:localTime(now).day,sessions:same?Number(raw.sessions)||0:0,publication_sessions:same?Number(raw.publication_sessions??raw.sessions)||0:0,pregame_sessions:same?Number(raw.pregame_sessions)||0:0};}
function launchReason(state,now,pregame=false){
 if(!inWindow(now)&&!pregame)return 'OUTSIDE_AFTERNOON';
 if(Date.parse(state.cooldown_until)>now.getTime())return 'SOURCE_COOLDOWN';
 if(state.sessions>=POLICY.maxDailySessions||(!pregame&&state.publication_sessions>=POLICY.maxPublicationSessions))return 'DAILY_BROWSER_LIMIT';
 if(now.getTime()-Date.parse(state.last_started_at)<(pregame?POLICY.pregameGapMinutes:POLICY.minSessionGapMinutes)*60000)return 'BROWSER_INTERVAL';
 return null;
}
function profile(observations){
 const rows=Object.values(observations).filter(r=>r.first_seen_at),intervals=rows.filter(r=>r.last_absent_at&&Date.parse(r.last_absent_at)<Date.parse(r.first_seen_at)&&Date.parse(r.first_seen_at)-Date.parse(r.last_absent_at)<=3*3600000&&localTime(new Date(r.last_absent_at)).day===localTime(new Date(r.first_seen_at)).day);
 const days=new Set(intervals.map(r=>localTime(new Date(r.first_seen_at)).day)).size,ready=intervals.length>=POLICY.minIntervals&&days>=POLICY.minDays;
 const firstMinutes=rows.map(r=>localTime(new Date(r.first_seen_at)).minutes),result={status:ready?'LEARNED_INTERVAL':'LEARNING',events_seen:rows.length,bracketed_events:intervals.length,independent_days:days,first_seen_range:rows.length?[Math.min(...firstMinutes),Math.max(...firstMinutes)]:null,exact_publication_time_known:false};
 if(ready){result.startMinute=Math.max(POLICY.startHour*60,Math.floor(Math.min(...intervals.map(r=>localTime(new Date(r.last_absent_at)).minutes))/30)*30-30);result.endMinute=Math.min(POLICY.endHour*60,Math.ceil(Math.max(...intervals.map(r=>localTime(new Date(r.first_seen_at)).minutes))/30)*30+30);}
 return result;
}
function gameGapMinutes(learning,now){const p=learning?.profile,minute=localTime(now).minutes;return p?.status==='LEARNED_INTERVAL'&&(minute<p.startMinute||minute>=p.endMinute)?POLICY.outsideLearnedGapMinutes:POLICY.perGameGapMinutes;}
function selectGames(games,checked,learning,now){
 const upcoming=games.filter(g=>g.status==='scheduled'&&Date.parse(g.starts_at)>now.getTime());
 const near=g=>Date.parse(g.starts_at)-now.getTime()<=POLICY.pregameMinutes*60000;
 const due=(g,gap)=>!checked[g.game_id]||Date.parse(checked[g.game_id])<=now.getTime()-gap*60000;
 const order=(a,b)=>(checked[a.game_id]||'').localeCompare(checked[b.game_id]||'')||Date.parse(a.starts_at)-Date.parse(b.starts_at);
 const urgent=upcoming.filter(g=>near(g)&&due(g,POLICY.pregameGapMinutes)).sort(order);
 if(urgent.length)return {pregame:true,games:urgent.slice(0,POLICY.pregameMaxGames)};
 return {pregame:false,games:inWindow(now)?upcoming.filter(g=>!near(g)&&due(g,gameGapMinutes(learning,now))).sort(order).slice(0,POLICY.maxGames):[]};
}
function observe(old={},games,raw,quotes,now,jobId){
 const observations={...(old.observations||{})};
 for(const g of games){
  const event=(raw.games||[]).find(e=>teamNorm(e.home_team)===teamNorm(g.home_team)&&teamNorm(e.away_team)===teamNorm(g.away_team)&&e.jurisdiction==='FR'&&e.time_basis==='visible_header_UTC'&&/^https:\/\/www\.winamax\.fr\/paris-sportifs\/match\/\d+$/.test(e.source_event_url)&&Math.abs(Date.parse(e.start_time_utc)-Date.parse(g.starts_at))<=20*60000);
  if(!event)continue;
  const qs=quotes.filter(q=>q.game_id===g.game_id&&q.league===g.league),markets=[...new Set(qs.map(q=>q.market))];
  // Only an inspected, complete empty player section supplies a lower bound.
  const empty=!event.markets?.length&&(event.notes||[]).every(n=>n==='NO_SUPPORTED_PLAYER_MARKETS_VISIBLE');
  if(!qs.length&&!empty)continue;
  const at=qs.length?new Date(Math.min(...qs.map(q=>Date.parse(q.captured_at)))).toISOString():raw.fetched_at||now.toISOString();
  const r={...(observations[g.game_id]||{game_id:g.game_id,starts_at:g.starts_at,first_seen_at:null,last_absent_at:null,checks:[]})};
  if(r.checks.some(c=>c.job_id===jobId))continue;
  r.checks=[...r.checks,{job_id:jobId,at,markets}].slice(-12);r.last_checked_at=at;
  if(qs.length&&!r.first_seen_at)r.first_seen_at=at;
  if(empty&&!r.first_seen_at)r.last_absent_at=at;
  r.markets_seen=[...new Set([...(r.markets_seen||[]),...markets])];observations[g.game_id]=r;
 }
 const kept=Object.fromEntries(Object.entries(observations).filter(([,r])=>Date.parse(r.starts_at)>now.getTime()-45*86400000).sort((a,b)=>Date.parse(b[1].starts_at)-Date.parse(a[1].starts_at)).slice(0,300));
 return {policy:POLICY.version,observations:kept,profile:profile(kept)};
}
const hour=m=>String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0');
module.exports={POLICY,localTime,inWindow,sessionMs,budget,launchReason,profile,gameGapMinutes,selectGames,observe,hour};

