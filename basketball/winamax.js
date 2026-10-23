'use strict';
const HEADERS=Object.freeze({points:'Nombre de points du joueur',rebounds:'Nombre de rebonds du joueur',assists:'Nombre de passes décisives du joueur',threes:'Nombre de paniers à 3 points du joueur',pra:'Total du joueur (points + rebonds + passes)',pr:'Total du joueur (points + rebonds)',pa:'Total du joueur (points + passes)',ra:'Total du joueur (passes + rebonds)'});
const RULES_URL='https://operator-front-static-cdn.winamax.fr/img/content/betting/2024/20240805_cgu/reglement-des-paris-sportifs-06_08_2024.pdf';
const norm=s=>String(s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
const teamNorm=s=>norm(String(s).replace(/^LA Clippers$/,'Los Angeles Clippers'));
const number=s=>Number(String(s).replace(',','.'));
function eventIdentity(title,body,league,names,now=new Date()){
 const pieces=title.split(' | ');if(!pieces.includes(league))throw Error('LEAGUE_UNVERIFIED');
 const teams=pieces[0].split(' - ');if(teams.length!==2||!teams.every(t=>names.some(n=>teamNorm(n)===teamNorm(t))))throw Error('TEAMS_UNVERIFIED');
 const ls=body.split('\n').map(s=>s.trim()).filter(Boolean),matches=[];
 for(let i=0;i<ls.length;i++)if(ls[i]===teams[0]){const j=ls.indexOf(teams[1],i+1);if(j<i+2||j>i+4)continue;const middle=ls.slice(i+1,j),clock=middle.at(-1);
  if(!/^\d{2}:\d{2}$/.test(clock))continue;const label=middle.slice(0,-1).join(' ');if(label&&!['Demain','Dem.'].includes(label))continue;
  const [hour,minute]=clock.split(':').map(Number);if(hour>23||minute>59)continue;
  const start=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+(label?1:0),hour,minute));
  if(start<=now||start-now>36*3600000)continue;matches.push(start.toISOString());
 }
 if(matches.length!==1)throw Error('EVENT_TIME_UNVERIFIED');
 return {home_team:teams[0],away_team:teams[1],start_time_utc:matches[0],time_basis:'visible_header_UTC',bookmaker:'winamax.fr',jurisdiction:'FR'};
}
function parsePairs(header,blocks){
 const market=Object.keys(HEADERS).find(k=>HEADERS[k]===header);if(!market)return [];
 const rows=[],seen=new Set();for(const b of blocks){if(b.disabled||!Array.isArray(b.outcome_ids)||b.outcome_ids.length!==2||!b.outcome_ids.every(x=>/^\d+$/.test(x)))continue;
  const ls=b.text.split('\n').map(s=>s.trim()).filter(Boolean),name=ls[0];
  if(!/^[\p{L}][\p{L}\p{M} .’'\-]+$/u.test(name)||!name.includes(' '))continue;
  const above=ls.findIndex(s=>/^Plus de \d+(?:[,.]\d+)?$/.test(s)),below=ls.findIndex(s=>/^Moins de \d+(?:[,.]\d+)?$/.test(s));
  if(above<1||below<1||ls.filter(s=>/^(Plus|Moins) de /.test(s)).length!==2)continue;
  const line=number(ls[above].slice(8)),underLine=number(ls[below].slice(9)),over=number(ls[above+1]),under=number(ls[below+1]);
  if(line!==underLine||line<0||line>150||!Number.isInteger(line*2)||![over,under].every(o=>Number.isFinite(o)&&o>1&&o<1000))continue;
  const key=norm(name)+':'+market+':'+line;if(seen.has(key))continue;seen.add(key);
  rows.push({player_name:name,market,line,odds1:over,odds2:under,outcome_ids:b.outcome_ids});
 }return rows;
}
function normalizeProps(raw,games,forecasts,now=new Date()){
 const quotes=[],rejected=[];
 if(raw.bookmaker!=='winamax.fr'||raw.jurisdiction!=='FR')return {quotes,rejected:['BOOKMAKER_UNVERIFIED']};
 for(const e of raw.games||[]){
  const matched=games.filter(g=>g.league===raw.league&&teamNorm(g.home_team)===teamNorm(e.home_team)&&teamNorm(g.away_team)===teamNorm(e.away_team)&&Math.abs(Date.parse(g.starts_at)-Date.parse(e.start_time_utc))<=20*60000);
  if(matched.length!==1||!/^https:\/\/www\.winamax\.fr\/paris-sportifs\/match\/\d+$/.test(e.source_event_url)||e.jurisdiction!=='FR'||e.time_basis!=='visible_header_UTC'){rejected.push('EVENT_UNVERIFIED');continue;}
  const g=matched[0],official=Date.parse(g.starts_at),book=Date.parse(e.start_time_utc);if(g.status!=='scheduled'||Math.min(official,book)<=now.getTime())continue;
  for(const m of e.markets||[]){const captured=Date.parse(m.captured_at);
   if(!HEADERS[m.market]||!Number.isFinite(captured)||captured>now.getTime()+60000||captured<now.getTime()-15*60000||!Number.isFinite(m.line)||!Number.isInteger(m.line*2)||![m.odds1,m.odds2].every(x=>Number.isFinite(x)&&x>1&&x<1000)){rejected.push('MARKET_INVALID_OR_EXPIRED');continue;}
   const refs=forecasts.filter(f=>f.game_id===g.game_id&&f.league===g.league&&f.player_id&&norm(f.result?.player_name)===norm(m.player_name)&&[g.home_team_id,g.away_team_id].includes(f.result?.team_id));
   const playerIds=[...new Set(refs.map(f=>f.player_id))],playerId=playerIds.length===1?playerIds[0]:null;
   if(!playerId)rejected.push('PLAYER_IDENTITY_OR_FORECAST_UNVERIFIED:'+m.player_name);
   for(const side of [0,1]){const selection=side?'under':'over',key=[g.league,g.game_id,'winamax.fr',norm(m.player_name),m.market,m.line,selection].join(':');
    quotes.push({quote_id:key,league:g.league,game_id:g.game_id,player_id:playerId,market:m.market,line:m.line,selection,odds:side?m.odds2:m.odds1,opposite_odds:side?m.odds1:m.odds2,bookmaker:'winamax.fr',period:'full_game',includes_overtime:true,source:'winamax_fr_direct',source_url:e.source_event_url,captured_at:m.captured_at,price_updated_at:null,expires_at:new Date(Math.min(captured+15*60000,official,book)).toISOString(),detail:{player_name:m.player_name,jurisdiction:'FR',identity_status:playerId?'EXACT_NAME_IN_GAME_FORECAST':'UNVERIFIED',bookmaker_event_id:e.source_event_id,bookmaker_start:e.start_time_utc,schedule_offset_seconds:(book-official)/1000,outcome_id:m.outcome_ids?.[side]||null,bookmaker_update_time:'unknown',rules_reference:RULES_URL,rules_reference_date:'2024-08-06',rules_current_version_verified:false}});
   }
  }
 }return {quotes,rejected};
}
module.exports={HEADERS,RULES_URL,norm,teamNorm,eventIdentity,parsePairs,normalizeProps};
