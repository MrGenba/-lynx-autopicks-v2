'use strict';
const {schedule:kboSchedule}=require('./kbo');
const {game:npbGame}=require('./npb');
const {VERSION,inWindow,sameGame,kboLineups,npbLineups,cpblLineups,message}=require('./asian_lineups');
const CONFIG={KBO:{table:'kbo_official_games',time:'game_start'},NPB:{table:'npb_source_games',time:'game_time'},CPBL:{table:'cpbl_source_games',time:'game_time'}};
async function json(http,url,opts={}){
 const r=await http(url,{method:'GET',headers:{},timeout:20000,...opts});
 if(r.status!==200)throw Error('SOURCE_HTTP_'+r.status);return typeof r.body==='string'?JSON.parse(r.body):r.body;
}
async function kboApi(http,method,args){return json(http,'https://www.koreabaseball.com/ws/'+method,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8',Referer:'https://www.koreabaseball.com/Schedule/GameCenter/Main.aspx'},body:Object.entries(args).map(([k,v])=>encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&')});}
async function fetchLineups(league,g,http,now,cache=new Map()){
 if(league==='CPBL')return cpblLineups(g,await json(http,'https://stats.cpbl.com.tw/api/proxy/v1/games/'+encodeURIComponent(g.game_id)),now);
 const key=league+'|'+g.game_date;let games=cache.get(key);
 if(!games){
  const date=g.game_date.replace(/-/g,'');
  if(league==='KBO')games=kboSchedule(await kboApi(http,'Main.asmx/GetKboGameList',{leId:1,srId:'0,3,4,5,6,7',date}));
  else {
   const rows=await json(http,'https://spaia.jp/baseball/npb/api/games_info_by_date?gameDate='+date);if(!Array.isArray(rows))throw Error('NPB_CALENDAR_RESPONSE');
   games=[];
   for(const r of rows){
    // Before first pitch this endpoint can contain only a gameId/startTime.
    // The game-specific overview supplies date, competition and both team IDs.
    const ov=r.gameTypeId==null||r.homeTeamId==null||r.visitorTeamId==null||r.gameDate==null?
     await json(http,'https://spaia.jp/baseball/npb/api/game_over_view?gameId='+encodeURIComponent(r.gameId)):undefined;
    if(ov&&!ov.length)throw Error('NPB_GAME_OVERVIEW_MISSING');
    const parsed=npbGame({...r,requested_date:date},ov);if(parsed)games.push(parsed);
   }
  }
  cache.set(key,games);
 }
 const fresh=games.find(x=>x.game_id===g.game_id);sameGame(g,fresh);
 if(!inWindow(fresh,now))return {game:fresh,events:[]};
 const events=league==='KBO'?kboLineups(fresh,await kboApi(http,'Schedule.asmx/GetLineUpAnalysis',{leId:1,srId:fresh.series_id,seasonId:fresh.season,gameId:fresh.game_id}),now):
  npbLineups(fresh,await json(http,'https://spaia.jp/baseball/npb/api/starting_members_for_flash?gameId='+encodeURIComponent(fresh.game_id)),now);
 return {game:fresh,events};
}
async function deliver(rest,send,event,owner){
 const claim=await rest('rpc/bb_claim_asian_lineup','POST',{p_event:event,p_owner:owner});if(!claim)return 'already_claimed_or_sent';
 let reply;
 try{reply=await send(message(event));if(reply?.ok!==true||!Number.isInteger(reply.result?.message_id))throw Error('TELEGRAM_DELIVERY_UNCONFIRMED');}
 catch(_){await rest('rpc/bb_finish_asian_lineup','POST',{p_league:event.league,p_game_pk:event.game_pk,p_side:event.side,p_owner:owner,p_message_id:null});throw Error('TELEGRAM_DELIVERY_FAILED');}
 // Acknowledge only after Telegram confirmed delivery. If this DB write fails,
 // retain the lease instead of immediately resending a possibly delivered alert.
 const ack=await rest('rpc/bb_finish_asian_lineup','POST',{p_league:event.league,p_game_pk:event.game_pk,p_side:event.side,p_owner:owner,p_message_id:reply.result.message_id});
 if(ack!==true)throw Error('TELEGRAM_ACK_PERSIST_FAILED');return 'sent';
}
async function runAsianLineups({rest,http,send,owner,now=new Date()}){
 if(!owner)throw Error('EXECUTION_OWNER_REQUIRED');
 const report={version:VERSION,checked_at:now.toISOString(),leagues:{},sent:0,errors:[]};const cache=new Map();
 for(const [league,cfg]of Object.entries(CONFIG)){
  const result={enabled:true,candidates:0,confirmed_sides:0,sent:0,errors:[]};report.leagues[league]=result;
  try{
   const lower=encodeURIComponent(new Date(now.getTime()-30*60000).toISOString()),upper=encodeURIComponent(new Date(now.getTime()+5*3600000).toISOString());
   const games=await rest(cfg.table+'?select=*&status=in.(scheduled,live)&'+cfg.time+'=gte.'+lower+'&'+cfg.time+'=lte.'+upper+'&order='+cfg.time+'.asc&limit=100');
   if(!Array.isArray(games)||games.length===100)throw Error('CALENDAR_RESPONSE_INVALID');
   result.candidates=games.length;
   for(const g of games){try{
    if(!inWindow(g,now))continue;
    const known=await rest('bb_asian_lineup_notifications?select=side&league=eq.'+league+'&game_pk=eq.'+encodeURIComponent(g.game_pk)+'&sent_at=not.is.null');
    if(!Array.isArray(known))throw Error('NOTIFICATION_STATE_INVALID');
    if(known.some(x=>x.side==='away')&&known.some(x=>x.side==='home'))continue;
    const {events}=await fetchLineups(league,g,http,now,cache);result.confirmed_sides+=events.length;
    for(const e of events)if(!known.some(x=>x.side===e.side)){
     const status=await deliver(rest,send,e,owner);if(status==='sent'){result.sent++;report.sent++;}
    }
   }catch(e){result.errors.push({game_id:g.game_id,code:safeError(e)});}}
  }catch(e){result.errors.push({code:safeError(e)});}
  report.errors.push(...result.errors.map(e=>({league,...e})));
  await rest('bb_lineup_health?on_conflict=league','POST',{league,checked_at:now.toISOString(),enabled:true,status:result.errors.length?'error':'healthy',detail:result},{prefer:'resolution=merge-duplicates,return=minimal'});
 }
 const unsupported={enabled:false,reason:'NO_VERIFIED_PREGAME_LINEUP_SOURCE'};report.leagues.NPB2=unsupported;
 await rest('bb_lineup_health?on_conflict=league','POST',{league:'NPB2',checked_at:now.toISOString(),enabled:false,status:'unsupported',detail:unsupported},{prefer:'resolution=merge-duplicates,return=minimal'});
 return report;
}
function safeError(e){return /^[A-Z][A-Z_0-9]+$/.test(e?.message||'')?e.message:'LINEUP_CAPTURE_FAILED';}
module.exports={CONFIG,json,kboApi,fetchLineups,deliver,runAsianLineups};
