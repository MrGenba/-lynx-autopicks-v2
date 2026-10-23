'use strict';
const {teamNorm,norm}=require('./winamax');
const PROP_TYPES={'Total Points':['points','Points'],'Total Rebounds':['rebounds','Rebonds'],'Total Assists':['assists','Passes décisives'],'Total Threes Made':['threes','Threes Made'],'Total Pts & Rebs & Asts':['pra','Pts & Rebs & Asts'],
 'Total des points':['points','Points'],'Total des rebonds':['rebounds','Rebonds'],'Total des passes décisives':['assists','Passes décisives'],'Nombre total de tirs à trois points réalisés':['threes','Threes Made'],'Total des points, des rebonds et des passes décisives':['pra','Pts & Rebs & Asts']};
// Anonymous PS3838 pages explicitly advertise delayed prices. Capture time is
// observation time, never the bookmaker's update time or proof of an executable price.
function parseGamePrices(event){
 const groups=new Map();
 for(const o of event.odds||[]){
  const parts=String(o.id||'').split('|');
  if(parts.length!==6||parts[0]!==event.source_event_id||parts[1]!=='0'||o.period!=='0'||o.disabled||!o.visible||o.status!=='status_1'||o.parent_id!==event.source_event_id)continue;
  const [,,type,side,alternate,lineText]=parts,price=Number(o.price),line=Number(lineText);
  if(!/^[01]$/.test(alternate)||!Number.isFinite(price)||price<=1||price>=1000||!Number.isFinite(line)||!Number.isInteger(line*2))continue;
  const market={'1':'moneyline','2':'spread','3':'total'}[type];if(!market)continue;
  const selection=market==='total'?{'3':'over','4':'under'}[side]:{'0':'home','1':'away'}[side];if(!selection)continue;
  if(o.team_type!==(['home','over'].includes(selection)?'1':'0'))continue;
  if(market==='total'&&line<=0)continue;
  const normalizedLine=market==='moneyline'?null:line;
  const key=[market,alternate,o.odds_id,market==='spread'?(selection==='home'?line:-line):normalizedLine].join(':');
  const group=groups.get(key)||[];group.push({market,line:normalizedLine,selection,odds:price,outcome_id:o.id,start_ms:Number(o.start_ms)});groups.set(key,group);
 }
 const result=[];
 for(const rows of groups.values()){
  if(rows.length!==2||rows[0].selection===rows[1].selection||rows[0].start_ms!==rows[1].start_ms)continue;
  for(const [i,row] of rows.entries())result.push({...row,opposite_odds:rows[1-i].odds});
 }return result;
}
function parsePlayerPrices(event){
 const out=[];
 for(const row of event.player_rows||[]){
  if(row.period!=='Match'||row.disabled||row.outcomes?.length!==2)continue;
  const title=String(row.title),suffix=Object.keys(PROP_TYPES).find(k=>title.endsWith(' '+k));if(!suffix)continue;
  const name=title.slice(0,-suffix.length-1),type=PROP_TYPES[suffix];if(!name.includes(' ')||!/^\p{L}[\p{L}\p{M} .’'\-]+$/u.test(name))continue;
  const rows=[];
  for(const o of row.outcomes){
   const id=String(o.id).split('|'),label=String(o.label||'').replace(/\s+/g,' ').trim(),m=label.match(/^(Plus de|Inférieur à) (\d+(?:\.\d+)?) (.+)$/);
   if(!m||m[3]!==type[1]||id.length!==7||id[1]!=='0'||id[2]!=='99'||id[3]!=='10'||id[4]!=='0'||![id[0],id[6]].every(s=>/^\d+$/.test(s))||!o.visible||o.disabled)continue;
   const line=Number(m[2]),price=Number(o.price);if(line!==Number(id[5])||line<0||line>150||!Number.isInteger(line*2)||!Number.isFinite(price)||price<=1||price>=1000)continue;
   rows.push({player_name:name,market:type[0],line,selection:m[1]==='Plus de'?'over':'under',odds:price,outcome_id:o.id,source_market_id:id[0]});
  }
  if(rows.length!==2||rows[0].selection===rows[1].selection||rows[0].line!==rows[1].line||rows[0].source_market_id!==rows[1].source_market_id||rows[0].outcome_id===rows[1].outcome_id)continue;
  for(const [i,row]of rows.entries())out.push({...row,opposite_odds:rows[1-i].odds,start_ms:Date.parse(event.start_time_utc)});
 }return out;
}
function normalizePublicQuotes(raw,games,now=new Date(),forecasts=[]){
 const quotes=[],rejected=[],seen=new Set();
 if(raw.bookmaker!=='ps3838'||raw.anonymous!==true||raw.delayed!==true||raw.access_denied)return {quotes,rejected:['PUBLIC_SOURCE_UNVERIFIED']};
 for(const e of raw.games||[]){
  const matches=games.filter(g=>g.league===raw.league&&teamNorm(g.home_team)===teamNorm(e.home_team)&&teamNorm(g.away_team)===teamNorm(e.away_team)&&Math.abs(Date.parse(g.starts_at)-Date.parse(e.start_time_utc))<=20*60000);
  if(matches.length!==1||e.league!==raw.league||e.live!=='0'||!/^\d+$/.test(e.source_event_id)||!/^https:\/\/www\.ps3838\.com\/[a-z]{2}\/sports\/basketball$/.test(e.source_event_url)){rejected.push('EVENT_UNVERIFIED');continue;}
  const g=matches[0],official=Date.parse(g.starts_at),book=Date.parse(e.start_time_utc),captured=Date.parse(e.captured_at);
  if(g.status!=='scheduled'||Math.min(official,book)<=now.getTime())continue;
  if(!Number.isFinite(captured)||captured>now.getTime()+60000||captured<now.getTime()-15*60000){rejected.push('OBSERVATION_EXPIRED');continue;}
  for(const m of [...parseGamePrices(e),...parsePlayerPrices(e)]){
   if(m.start_ms!==book){rejected.push('PRICE_EVENT_TIME_MISMATCH');continue;}
   const observedAt=m.player_name?(e.player_captured_at||e.captured_at):e.captured_at,observed=Date.parse(observedAt);
   if(!Number.isFinite(observed)||observed>now.getTime()+60000||observed<now.getTime()-15*60000){rejected.push('OBSERVATION_EXPIRED');continue;}
   const key=[g.league,g.game_id,'ps3838',norm(m.player_name)||'team',m.market,m.line,m.selection].join(':');if(seen.has(key))continue;seen.add(key);
   const refs=m.player_name?forecasts.filter(f=>f.league===g.league&&f.game_id===g.game_id&&f.player_id&&norm(f.result?.player_name)===norm(m.player_name)&&[g.home_team_id,g.away_team_id].includes(f.result?.team_id)):[],ids=[...new Set(refs.map(f=>f.player_id))],playerId=ids.length===1?ids[0]:null;
   quotes.push({quote_id:key,league:g.league,game_id:g.game_id,player_id:playerId,market:m.market,line:m.line,selection:m.selection,odds:m.odds,opposite_odds:m.opposite_odds,bookmaker:'ps3838',period:'full_game',includes_overtime:false,
    source:'ps3838_public_delayed',source_url:e.source_event_url,captured_at:observedAt,price_updated_at:null,expires_at:new Date(Math.min(observed+15*60000,official,book)).toISOString(),
    detail:{delayed:true,delay_seconds:null,delay_basis:'SOURCE_ANONYMOUS_PRICE_NOTICE',reference_only:true,anonymous:true,bookmaker_update_time:'unknown',bookmaker_event_id:e.source_event_id,bookmaker_start:e.start_time_utc,schedule_offset_seconds:(book-official)/1000,outcome_id:m.outcome_id,rules_status:'OVERTIME_UNVERIFIED',player_markets_status:e.player_markets_status||'NOT_CAPTURED',...(m.player_name?{player_name:m.player_name,identity_status:playerId?'EXACT_NAME_IN_GAME_FORECAST':'UNVERIFIED'}:{})}});
  }
 }return {quotes,rejected};
}
module.exports={parseGamePrices,parsePlayerPrices,normalizePublicQuotes};
