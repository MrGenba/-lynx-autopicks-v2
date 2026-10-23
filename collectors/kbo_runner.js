'use strict';
const {VERSION,schedule,boxscore,pitchProfiles}=require('./kbo');
const BASE='https://www.koreabaseball.com/ws/';
const bodyForm=p=>Object.entries(p).map(([k,v])=>encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&');
async function api(http,endpoint,args){
 let failure;
 for(let i=0;i<3;i++)try{
  const r=await http(BASE+endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8',Referer:'https://www.koreabaseball.com/Schedule/GameCenter/Main.aspx'},body:bodyForm(args),timeout:25000});
  if(r.status<200||r.status>=300)throw Error('KBO_HTTP_'+r.status);return typeof r.body==='string'?JSON.parse(r.body):r.body;
 }catch(e){failure=e;}
 throw failure;
}
async function all(rest,path){const out=[];for(let offset=0;;offset+=1000){const rows=await rest(path+'&limit=1000&offset='+offset);if(!Array.isArray(rows))throw Error('KBO_DATABASE_UNAVAILABLE');out.push(...rows);if(rows.length<1000)return out;}}
async function runKbo({http,rest,mode='postgame',now=new Date(),fullSeason=false}){
 const today=new Date(now.getTime()+9*3600000).toISOString().slice(0,10),season=Number(today.slice(0,4));
 const result={collector:VERSION,mode,season,today,dates_checked:0,games_discovered:0,ingested:0,pitch_profiles:0,errors:[]};
 if(mode!=='tracking'){
  const first=fullSeason?new Date(season+'-03-01T00:00:00Z'):new Date(Date.parse(today+'T00:00:00Z')-(mode==='schedule'?2:14)*86400000);
  const last=new Date(Date.parse(today+'T00:00:00Z')+7*86400000);
  for(let d=first;d<=last;d.setUTCDate(d.getUTCDate()+1)){
   const date=d.toISOString().slice(0,10).replace(/-/g,'');
   try{const raw=await api(http,'Main.asmx/GetKboGameList',{leId:1,srId:'0,3,4,5,6,7',date});const games=schedule(raw);
    if(games.length)await rest('rpc/kbo_store_schedule','POST',{p_games:games});result.dates_checked++;result.games_discovered+=games.length;
   }catch(_){result.errors.push({date,code:'SCHEDULE_CAPTURE_FAILED'});}
  }
 }
 if(mode==='postgame'){
  const games=await all(rest,'kbo_official_games?season=eq.'+season+'&status=eq.final&select=*&order=game_date.desc,game_id.asc');
  const receipts=await all(rest,'kbo_postgame_ingestion?select=game_id,captured_at,collector_version&order=game_id.asc');const known=new Map(receipts.map(r=>[r.game_id,r]));
  for(const g of games){
   const old=known.get(g.game_id),recent=Date.parse(today)-Date.parse(g.game_date)<=14*86400000;
   if(old?.collector_version===VERSION&&(!recent||now.getTime()-Date.parse(old.captured_at)<20*3600000))continue;
   try{const raw=await api(http,'Schedule.asmx/GetBoxScoreScroll',{leId:1,srId:g.series_id,seasonId:g.season,gameId:g.game_id});
    const receipt=await rest('rpc/kbo_ingest_boxscore','POST',{p_payload:boxscore(g,raw)});if(receipt.game_id!==g.game_id)throw Error('MISSING_RECEIPT');result.ingested++;
   }catch(e){result.errors.push({game_id:g.game_id,code:'BOXSCORE_CAPTURE_FAILED',reason:String(e.message).replace(/https?:\S+/g,'[URL]').slice(0,140)});}
  }
  result.health=(await rest('kbo_capture_health?season=eq.'+season))[0]||null;
  if(result.health?.pending_games>0)result.errors.push({code:'PENDING_FINALS',count:result.health.pending_games});
  if(!result.errors.length&&result.health?.final_games>0)result.player_stats=await rest('rpc/kbo_refresh_player_stats','POST',{p_season:season});
 }
 if(mode==='tracking'){
  const games=await all(rest,'kbo_official_games?season=eq.'+season+'&status=neq.cancelled&select=*&order=game_date.desc,game_id.desc');
  const seen=new Set();
  // Each pitcher at most once per run; names/IDs are official announced starters.
  for(const g of games){
   const players=[{id:g.away_starter_id,name:g.away_starter,team:g.away_team},{id:g.home_starter_id,name:g.home_starter,team:g.home_team}];
   if(players.some(p=>!p.id||!p.name)||players.every(p=>seen.has(p.id)))continue;
   try{const raw=await api(http,'Schedule.asmx/GetPitKindAnalysis',{leId:1,srId:0,seasonId:season,awayPitId:players[0].id,homePitId:players[1].id});
    const freshIds=players.filter(p=>!seen.has(p.id)).map(p=>p.id),rows=pitchProfiles(raw,players,season).filter(r=>freshIds.includes(r.player_id));
    await rest('rpc/kbo_store_pitch_profiles','POST',{p_season:season,p_player_ids:freshIds,p_rows:rows});
    players.forEach(p=>seen.add(p.id));result.pitch_profiles+=rows.length;
   }catch(_){result.errors.push({game_id:g.game_id,code:'PITCH_PROFILE_CAPTURE_FAILED'});players.forEach(p=>seen.add(p.id));}
  }
  result.pitchers_checked=seen.size;
 }
 if(mode==='schedule'){
  const games=await all(rest,'kbo_official_games?game_date=gte.'+today+'&status=eq.scheduled&select=*&order=game_date.asc');
  const parks=await rest('kbo_park_factors?lat_deg=not.is.null&select=team_abbr,lat_deg,lon_deg'),cache=new Map();result.weather_saved=0;
  for(const g of games){
   const park=parks.find(p=>p.team_abbr===g.home_team);if(!park||!g.game_start||Date.parse(g.game_start)-now.getTime()>6*86400000)continue;
   try{
    if(!cache.has(g.home_team)){
     const response=await http('https://api.open-meteo.com/v1/forecast?latitude='+park.lat_deg+'&longitude='+park.lon_deg+'&hourly=temperature_2m,wind_speed_10m,wind_direction_10m&timezone=UTC&forecast_days=7',{method:'GET',headers:{},timeout:20000});
     if(response.status!==200)throw Error('WEATHER_UNAVAILABLE');cache.set(g.home_team,typeof response.body==='string'?JSON.parse(response.body):response.body);
    }
    const hourly=cache.get(g.home_team).hourly;let best=-1,diff=Infinity;
    hourly.time.forEach((t,i)=>{const delta=Math.abs(Date.parse(t+'Z')-Date.parse(g.game_start));if(delta<diff){best=i;diff=delta;}});
    if(best<0||diff>3600000)throw Error('WEATHER_TIME_UNAVAILABLE');
    const temp=hourly.temperature_2m[best],speed=hourly.wind_speed_10m[best],direction=hourly.wind_direction_10m[best];
    if(![temp,speed,direction].every(x=>typeof x==='number'&&Number.isFinite(x)))throw Error('WEATHER_VALUES_UNAVAILABLE');
    await rest('kbo_game_weather?on_conflict=game_pk','POST',{game_pk:g.game_pk,game_date:g.game_date,temperature_2m:temp,wind_speed_10m:speed,
     wind_direction:direction,wind_tailwind:null,forecast_time_utc:hourly.time[best]+'Z'},
     {prefer:'resolution=merge-duplicates,return=minimal'});result.weather_saved++;
   }catch(_){result.errors.push({game_id:g.game_id,code:'WEATHER_CAPTURE_FAILED'});}
  }
 }
 result.status=result.errors.length?'ATTENTION':'OK';
 await rest('kbo_capture_state?on_conflict=scope','POST',{scope:mode,checked_at:now.toISOString(),status:result.status,report:result},{prefer:'resolution=merge-duplicates,return=minimal'});
 return result;
}
module.exports={runKbo,api};
