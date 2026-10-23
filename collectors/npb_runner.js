'use strict';
const {VERSION,KINDS,game,boxscore}=require('./npb');
async function api(http,endpoint,args){let failure;for(let i=0;i<3;i++)try{
 const query=Object.entries(args).map(([k,v])=>encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&');
 const r=await http('https://spaia.jp/baseball/npb/api/'+endpoint+'?'+query,{method:'GET',headers:{},timeout:25000});
 if(r.status===401||r.status===403)throw Error('SOURCE_ACCESS_DENIED');if(r.status!==200)throw Error('SOURCE_HTTP_'+r.status);
 const data=typeof r.body==='string'?JSON.parse(r.body):r.body;if(!Array.isArray(data))throw Error('INVALID_SOURCE_DATA');return data;
 }catch(e){failure=e;if(e.message==='SOURCE_ACCESS_DENIED')break;}throw failure;}
async function all(rest,p){const rows=[];for(let offset=0;;offset+=1000){const a=await rest(p+'&limit=1000&offset='+offset);if(!Array.isArray(a))throw Error('DATABASE_UNAVAILABLE');rows.push(...a);if(a.length<1000)return rows;}}
async function runNpb({http,rest,mode='postgame',now=new Date(),fullSeason=false}){
 const today=new Date(now.getTime()+9*3600000).toISOString().slice(0,10),season=Number(today.slice(0,4));
 const result={collector:VERSION,mode,season,today,dates_checked:0,games_discovered:0,ingested:0,errors:[],warnings:[]};
 const first=fullSeason?new Date(season+'-03-01'):new Date(Date.parse(today)-(mode==='schedule'?1:14)*86400000),last=new Date(Date.parse(today)+7*86400000);
 for(let d=first;d<=last;d.setUTCDate(d.getUTCDate()+1)){
  const date=d.toISOString().slice(0,10).replace(/-/g,'');try{
   const rows=await api(http,'games_info_by_date',{gameDate:date}),games=[];
   for(const raw of rows){if(raw.gameTypeId!=null&&!KINDS.includes(Number(raw.gameTypeId)))continue;
    const ov=raw.gameStateId!==4?await api(http,'game_over_view',{gameId:raw.gameId}):undefined;
    if(raw.gameTypeId==null&&!ov?.length)throw Error('GAME_OVERVIEW_MISSING');
    const g=game({...raw,requested_date:date},ov);if(g)games.push(g);
   }
   if(games.length)await rest('rpc/npb_store_schedule','POST',{p_games:games});result.dates_checked++;result.games_discovered+=games.length;
  }catch(_){result.errors.push({date,code:'SCHEDULE_CAPTURE_FAILED'});}
 }
 if(mode==='postgame'){
  const games=await all(rest,'npb_source_games?season=eq.'+season+'&status=eq.final&select=*&order=game_date.desc,game_id.asc');
  const receipts=await all(rest,'npb_postgame_ingestion?select=game_id,captured_at,version,tracking_status&order=game_id.asc'),known=new Map(receipts.map(r=>[r.game_id,r]));
  for(const g of games){const old=known.get(g.game_id),recent=Date.parse(today)-Date.parse(g.game_date)<=14*86400000;
   if(old?.version===VERSION&&(!recent||now-Date.parse(old.captured_at)<20*3600000))continue;
   try{const [score,pitchers,batters,history]=await Promise.all([
    api(http,'current_score',{game_id:g.game_id}),api(http,'both_pitcher_game_stats',{gameId:g.game_id}),
    api(http,'both_batter_game_stats',{gameId:g.game_id,matchday:g.game_date.replace(/-/g,'')}),api(http,'flash_atbat_history',{gameId:g.game_id})]);
    const payload=boxscore(g,{score,pitchers,batters,history}),receipt=await rest('rpc/npb_ingest_boxscore','POST',{p_payload:payload});if(receipt.game_id!==g.game_id)throw Error('MISSING_RECEIPT');result.ingested++;
   }catch(e){result.errors.push({game_id:g.game_id,code:'BOXSCORE_CAPTURE_FAILED',reason:String(e.message).replace(/https?:\S+/g,'[URL]').slice(0,100)});}
  }
  result.health=(await rest('npb_capture_health?season=eq.'+season))[0]||null;
  if(result.health?.pending_games>0)result.errors.push({code:'PENDING_FINALS',count:result.health.pending_games});
  if(result.health?.tracking_partial_games>0)result.warnings.push({code:'PARTIAL_PITCH_COVERAGE',games:result.health.tracking_partial_games});
  if(!result.errors.length&&result.health?.final_games>0)result.player_stats=await rest('rpc/npb_refresh_player_stats','POST',{p_season:season});
 }
 result.status=result.errors.length?'ATTENTION':'OK';
 await rest('npb_capture_state?on_conflict=scope','POST',{scope:mode,checked_at:now.toISOString(),status:result.status,report:result},{prefer:'resolution=merge-duplicates,return=minimal'});
 await rest('bb_capture_health?on_conflict=league,component','POST',{league:'NPB',component:mode==='postgame'?'stats':'calendar',season,checked_at:now.toISOString(),
  status:result.status==='OK'?'healthy':'error',...(result.status==='OK'?{last_success_at:now.toISOString()}:{}),detail:{source:'spaia.jp',...result}},
  {prefer:'resolution=merge-duplicates,return=minimal'});
 return result;
}
module.exports={runNpb,api};
