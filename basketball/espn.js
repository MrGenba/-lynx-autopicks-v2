'use strict';
const VERSION='basketball-espn-core-1';
const LEAGUES={NBA:{slug:'nba',minutes:48},WNBA:{slug:'wnba',minutes:40}};
const FIELDS={points:'points',rebounds:'rebounds',assists:'assists',steals:'steals',blocks:'blocks',turnovers:'turnovers',
 fgm:'fieldGoalsMade',fga:'fieldGoalsAttempted',fg3m:'threePointFieldGoalsMade',fg3a:'threePointFieldGoalsAttempted',ftm:'freeThrowsMade',fta:'freeThrowsAttempted',orb:'offensiveRebounds',drb:'defensiveRebounds',fouls:'fouls'};
const root=league=>'https://sports.core.api.espn.com/v2/sports/basketball/leagues/'+LEAGUES[league].slug;
function sourceUrl(url){const u=String(url||'').replace(/^http:/,'https:');if(!/^https:\/\/sports\.core\.api\.espn\.com\/v2\/sports\/basketball\/leagues\/(?:nba|wnba)(?:\/[A-Za-z0-9_-]+)*(?:\?[A-Za-z0-9_%=&.,:-]*)?$/.test(u))throw Error('UNEXPECTED_SOURCE_URL');return u;}
function idFrom(url,kind){const m=String(url||'').match(new RegExp('/'+kind+'/([0-9]+)(?:/|\\?|$)'));return m?.[1]||null;}
function counts(raw){const all=Object.fromEntries((raw?.splits?.categories||[]).flatMap(c=>(c.stats||[]).map(s=>[s.name,s.value]))),out={};
 for(const [key,name]of Object.entries(FIELDS)){const v=all[name]??(key==='rebounds'?all.totalRebounds:undefined);if(!Number.isInteger(v)||v<0)throw Error('MISSING_OR_INVALID_BOX_STAT');out[key]=v;}
 if(out.fgm>out.fga||out.fg3m>out.fg3a||out.fg3m>out.fgm||out.ftm>out.fta||out.points!==2*out.fgm+out.fg3m+out.ftm||out.orb+out.drb!==out.rebounds)throw Error('INCONSISTENT_BOX_STAT');
 if(Number.isFinite(all.minutes))out.minutes=all.minutes;
 // Team turnovers can include a team turnover not attributed to a player.
 if(Number.isInteger(all.totalTurnovers))out.total_turnovers=all.totalTurnovers;
 return out;
}
function status(raw){const t=raw?.type;if(!t?.name)throw Error('GAME_STATUS_UNAVAILABLE');
 if(/POSTPON|CANCEL|SUSPEND|ABANDON/.test(t.name))return /POSTPON/.test(t.name)?'postponed':/SUSPEND/.test(t.name)?'suspended':'cancelled';
 if(t.completed===true&&t.state==='post')return 'final';if(t.state==='in')return 'live';if(t.state==='pre')return 'scheduled';throw Error('UNKNOWN_GAME_STATUS');}
function game(league,event,rawStatus,teams){
 const c=event.competitions?.[0],season=Number(idFrom(event.season?.$ref,'seasons')),type=Number(idFrom(event.seasonType?.$ref,'types'));
 if(!LEAGUES[league]||!/^\d+$/.test(event.id)||!c||c.id!==event.id||!season||![2,3].includes(type))throw Error('GAME_IDENTITY_OR_COMPETITION');
 if(teams.length!==2||new Set(teams.map(t=>t.competitor.homeAway)).size!==2)throw Error('GAME_TEAMS_INVALID');
 const home=teams.find(t=>t.competitor.homeAway==='home'),away=teams.find(t=>t.competitor.homeAway==='away'),state=status(rawStatus);
 for(const t of teams)if(t.team.id!==t.competitor.id||!t.team.displayName)throw Error('TEAM_IDENTITY');
 const start=Date.parse(c.date||event.date);if(!Number.isFinite(start))throw Error('INVALID_GAME_TIME');
 const score=t=>{if(state!=='final')return null;const v=t.score?.value;if(!Number.isInteger(v)||v<0)throw Error('FINAL_SCORE_MISSING');return v;};
 return {league,game_id:event.id,season,season_type:type,starts_at:new Date(start).toISOString(),status:state,neutral_site:!!c.neutralSite,
  home_team_id:home.team.id,away_team_id:away.team.id,home_team:home.team.displayName,away_team:away.team.displayName,
  home_score:score(home),away_score:score(away),periods:Number(rawStatus.period)||null,source:'espn_core',source_url:sourceUrl(event.$ref),source_checked_at:new Date().toISOString()};
}
async function createClient(http){const cache=new Map();return async function get(url,{cacheable=false,optional=false}={}){
 url=sourceUrl(url);if(cacheable&&cache.has(url))return cache.get(url);
 let r;try{r=await http(url,{method:'GET',headers:{Accept:'application/json'},timeout:20000});}catch(_){throw Error('ESPN_NETWORK_FAILED');}
 if(optional&&r.status===404)return null;if(r.status!==200)throw Error('ESPN_HTTP_'+r.status);
 const d=typeof r.body==='string'?JSON.parse(r.body):r.body;if(!d||typeof d!=='object')throw Error('ESPN_INVALID_RESPONSE');if(cacheable)cache.set(url,d);return d;
};}
async function schedule(league,get,from,to){const refs=[];let page=1;
 do {const d=await get(root(league)+'/events?dates='+from.replace(/-/g,'')+'-'+to.replace(/-/g,'')+'&limit=100&page='+page);
  if(!Array.isArray(d.items)||!Number.isInteger(d.pageCount)||d.pageCount>20)throw Error('ESPN_EVENT_PAGE_INVALID');refs.push(...d.items.map(x=>x.$ref));if(page>=d.pageCount)break;page++;
 }while(page<=20);return [...new Set(refs)];}
async function loadGame(league,url,get,{box=false,rosters=false}={}){
 const event=await get(url),type=Number(idFrom(event.seasonType?.$ref,'types'));if(![2,3].includes(type))return null;
 const c=event.competitions?.[0];if(!c?.status?.$ref)throw Error('GAME_STATUS_REFERENCE_MISSING');
 const registry=await get(root(league)+'/teams?limit=100',{cacheable:true});
 if(!Array.isArray(registry.items)||registry.pageCount>1||registry.items.length<10)throw Error('TEAM_REGISTRY_UNAVAILABLE');
 const allowed=new Set(registry.items.map(x=>idFrom(x.$ref,'teams')));
 // The season feed also includes All-Star exhibitions under season type 2.
 if(c.competitors?.some(t=>!allowed.has(t.id)))return null;
 const rawStatus=await get(c.status.$ref),state=status(rawStatus),teams=[];
 for(const competitor of c.competitors||[]){const team=await get(competitor.team.$ref,{cacheable:true}),score=state==='final'?await get(competitor.score.$ref):null;teams.push({competitor,team,score});}
 if(teams.some(t=>t.team.isAllStar===true||t.team.isActive===false))return null;
 const g=game(league,event,rawStatus,teams);const result={game:g,teams:[],players:[],rosters:[]};
 if(rosters&&state==='scheduled'&&Date.parse(g.starts_at)<Date.now()+36*3600000){
  for(const t of teams)try{
   const roster=await get(t.team.athletes.$ref+'&limit=100',{cacheable:true});
   if(!Array.isArray(roster.items)||roster.pageCount>1||roster.items.length<5)throw Error('CURRENT_ROSTER_INCOMPLETE');
   const ids=roster.items.map(p=>idFrom(p.$ref,'athletes'));if(ids.some(id=>!id)||new Set(ids).size!==ids.length)throw Error('CURRENT_ROSTER_IDENTITY');
   result.rosters.push({league,game_id:g.game_id,team_id:t.team.id,players:ids.map(player_id=>({player_id})),confirmed:false,observed_at:new Date().toISOString(),source:'espn_core_team_roster'});
  }catch(_){result.roster_errors=(result.roster_errors||0)+1;}
 }
 if(!box||state!=='final')return result;
 for(const t of teams){
  const raw=await get(t.competitor.statistics.$ref),stats=counts(raw);delete stats.minutes;
  if(stats.points!==t.score.value)throw Error('TEAM_BOXSCORE_SCORE_MISMATCH');
  const teamId=t.team.id,opp=teams.find(x=>x.team.id!==teamId).team.id;
  const teamBox={league,game_id:g.game_id,team_id:teamId,opponent_id:opp,stats,source:'espn_core'};result.teams.push(teamBox);
  const roster=await get(t.competitor.roster.$ref);if(!Array.isArray(roster.entries))throw Error('ROSTER_MISSING');
  const entries=roster.entries.filter(p=>p.period===0),seen=new Set();
  for(const p of entries){
   const pid=String(p.playerId);if(seen.has(pid)||idFrom(p.athlete?.$ref,'athletes')!==pid)throw Error('PLAYER_IDENTITY');seen.add(pid);
   const athlete=await get(p.athlete.$ref,{cacheable:true});if(athlete.id!==pid||!athlete.displayName)throw Error('PLAYER_IDENTITY');
   let stat=null,minutes=0;
   if(p.didNotPlay!==true){const data=await get(p.statistics.$ref);stat=counts(data);minutes=stat.minutes;delete stat.minutes;if(!Number.isFinite(minutes)||minutes<0||minutes>90)throw Error('PLAYER_MINUTES_INVALID');}
   result.players.push({league,game_id:g.game_id,team_id:teamId,player_id:pid,player_name:athlete.displayName,position:athlete.position?.abbreviation||null,
    starter:p.starter===true,did_not_play:p.didNotPlay===true,minutes,stats:stat,source:'espn_core'});
  }
  const played=result.players.filter(p=>p.team_id===teamId&&!p.did_not_play);
  if(played.length<5)throw Error('INCOMPLETE_PLAYERS');
  for(const key of ['points','fgm','fga','fg3m','fg3a','ftm','fta','assists','steals','blocks'])if(played.reduce((s,p)=>s+p.stats[key],0)!==stats[key])throw Error('PLAYER_TEAM_TOTAL_MISMATCH_'+key.toUpperCase());
  // ESPN rounds individual minutes; a small cumulative rounding difference is expected.
  const duration=LEAGUES[league].minutes+Math.max(0,(g.periods||4)-4)*5;
  if(Math.abs(played.reduce((s,p)=>s+p.minutes,0)-5*duration)>played.length)throw Error('TEAM_MINUTES_MISMATCH');
 }
 result.receipt={collector:VERSION,player_count:result.players.length,team_count:2,complete:true};return result;
}
module.exports={VERSION,LEAGUES,FIELDS,root,sourceUrl,idFrom,counts,status,game,createClient,schedule,loadGame};
