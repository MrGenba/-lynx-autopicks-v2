'use strict';
const {VERSION,SOURCE,game,boxscore}=require('./cpbl');
async function api(http,path){let failure;for(let i=0;i<3;i++)try{
 const r=await http('https://'+SOURCE+'/api/proxy/v1/'+path,{method:'GET',headers:{},timeout:25000});
 if([401,403].includes(r.status))throw Error('SOURCE_ACCESS_DENIED');if(r.status!==200)throw Error('SOURCE_HTTP_'+r.status);
 const data=typeof r.body==='string'?JSON.parse(r.body):r.body;if(!data?.Data)throw Error('INVALID_SOURCE_DATA');return data.Data;
 }catch(e){failure=e;if(e.message==='SOURCE_ACCESS_DENIED')break;}throw failure;}
async function all(rest,p){const rows=[];for(let offset=0;;offset+=1000){const a=await rest(p+'&limit=1000&offset='+offset);if(!Array.isArray(a))throw Error('DATABASE_UNAVAILABLE');rows.push(...a);if(a.length<1000)return rows;}}
async function runCpbl({http,rest,mode='postgame',now=new Date(),fullSeason=false}){
 const local=new Date(now.getTime()+8*3600000),today=local.toISOString().slice(0,10),season=local.getUTCFullYear(),month=local.getUTCMonth()+1;
 const months=fullSeason?Array.from({length:12},(_,i)=>i+1):[...new Set([Math.max(1,month-1),month,Math.min(12,month+1)])];
 const result={collector:VERSION,mode,season,today,months_checked:0,games_discovered:0,ingested:0,errors:[],warnings:[]},found=new Map();
 for(const kind of ['A','C','E'])for(const m of months)try{
  const data=await api(http,'games/schedule?kindCode='+kind+'&year='+season+'&month='+m);if(!Array.isArray(data.Games))throw Error('INVALID_CALENDAR');
  for(const raw of data.Games){const g=game(raw);if(g.season!==season||g.game_kind!==kind)throw Error('WRONG_COMPETITION');const old=found.get(g.game_id);
   if(!old||(g.status==='final'&&old.status!=='final')||(g.status===old.status&&g.game_date>old.game_date)||(old.status!=='final'&&g.game_date>old.game_date))found.set(g.game_id,g);
  }result.months_checked++;
 }catch(e){result.errors.push({month:m,kind,code:'SCHEDULE_CAPTURE_FAILED',reason:String(e.message).replace(/https?:\S+/g,'[URL]').slice(0,100)});}
 const games=[...found.values()];
 for(let i=0;i<games.length;i+=100)await rest('rpc/cpbl_store_schedule','POST',{p_games:games.slice(i,i+100)});result.games_discovered=games.length;
 // The detail endpoint can contain announced starters absent from the monthly calendar.
 for(const g of games.filter(g=>g.status==='scheduled'&&g.game_date>=today&&Date.parse(g.game_date)-Date.parse(today)<=2*86400000))try{
  const data=await api(http,'games/'+g.game_id);if(!data.Game)throw Error('MISSING_GAME');const detail=game(data.Game);if(detail.game_id!==g.game_id)throw Error('GAME_MISMATCH');await rest('rpc/cpbl_store_schedule','POST',{p_games:[detail]});
 }catch(_){result.errors.push({game_id:g.game_id,code:'STARTER_REFRESH_FAILED'});}
 if(mode==='postgame'){
  const finals=await all(rest,'cpbl_source_games?season=eq.'+season+'&status=eq.final&select=*&order=game_date.desc,game_id.asc');
  const receipts=await all(rest,'cpbl_postgame_ingestion?select=game_id,captured_at,version&order=game_id.asc'),known=new Map(receipts.map(r=>[r.game_id,r]));
  for(const g of finals){const old=known.get(g.game_id),recent=Date.parse(today)-Date.parse(g.game_date)<=14*86400000;
   if(old?.version===VERSION&&(!recent||now-Date.parse(old.captured_at)<20*3600000))continue;
   try{const data=await api(http,'games/'+g.game_id);if(!data.Game)throw Error('MISSING_GAME');const payload=boxscore(data.Game);if(payload.game.game_id!==g.game_id)throw Error('GAME_MISMATCH');
    const receipt=await rest('rpc/cpbl_ingest_boxscore','POST',{p_payload:payload});if(receipt.game_id!==g.game_id)throw Error('MISSING_RECEIPT');result.ingested++;
   }catch(e){result.errors.push({game_id:g.game_id,code:'BOXSCORE_CAPTURE_FAILED',reason:String(e.message).replace(/https?:\S+/g,'[URL]').slice(0,100)});}
  }
  result.health=(await rest('cpbl_capture_health?season=eq.'+season))[0]||null;
  if(result.health?.pending_games>0)result.errors.push({code:'PENDING_FINALS',count:result.health.pending_games});
  if(result.health?.tracking_partial_games>0)result.warnings.push({code:'PARTIAL_PITCH_HISTORY',games:result.health.tracking_partial_games});
  if(!result.errors.length&&result.health?.final_games>0)result.player_stats=await rest('rpc/cpbl_refresh_player_stats','POST',{p_season:season});
 }
 result.status=result.errors.length?'ATTENTION':'OK';
 const opts={prefer:'resolution=merge-duplicates,return=minimal'};
 await rest('cpbl_capture_state?on_conflict=scope','POST',{scope:mode,checked_at:now.toISOString(),status:result.status,report:result},opts);
 await rest('bb_capture_health?on_conflict=league,component','POST',{league:'CPBL',component:mode==='postgame'?'stats':'calendar',season,checked_at:now.toISOString(),status:result.status==='OK'?'healthy':'error',...(result.status==='OK'?{last_success_at:now.toISOString()}:{}),detail:{source:SOURCE,...result}},opts);
 return result;
}
module.exports={runCpbl,api};
