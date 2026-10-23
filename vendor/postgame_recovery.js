'use strict';
const {buildPostgameIngest,POSTGAME_VERSION}=require('./postgame_ingest');
// Injected I/O keeps the same validation in scheduled collectors and the recovery CLI.
async function recoverPostgames({sportId,api,read,rpc,now=new Date(),sweepSeason=false,maxGames=120}) {
  const day=d=>d.toISOString().slice(0,10), start=new Date(now.getTime()-7*86400000);
  const first=sweepSeason?now.getUTCFullYear()+'-01-01':day(start);
  const schedule=await api('https://statsapi.mlb.com/api/v1/schedule?sportId='+sportId+'&startDate='+first+'&endDate='+day(now)+'&gameTypes=R,F,D,L,W');
  if(!Array.isArray(schedule?.dates))throw Error('Official schedule unavailable; capture not completed');
  const backlog=await read('bb_postgame_missing','sport_id=eq.'+sportId+'&order=date.asc&limit=20');
  if(!Array.isArray(backlog))throw Error('Backlog read failed');
  const groups=[schedule];
  if(backlog.length){
    const b=await api('https://statsapi.mlb.com/api/v1/schedule?gamePks='+backlog.map(g=>g.game_id).join(','));
    if(!Array.isArray(b?.dates))throw Error('Backlog schedule unavailable');
    groups.push(b);
  }
  const games=[...new Map(groups.flatMap(s=>s.dates.flatMap(d=>d.games||[])).filter(g=>
    ['Final','Game Over','Completed Early'].includes(g.status?.detailedState)&&!['S','E'].includes(g.gameType)
  ).map(g=>[g.gamePk,g])).values()].sort((a,b)=>b.gameDate.localeCompare(a.gameDate));
  const receipts=new Map();
  for(let i=0;i<games.length;i+=200){
    const rs=await read('bb_postgame_receipts','sport_id=eq.'+sportId+'&game_id=in.('+games.slice(i,i+200).map(g=>g.gamePk).join(',')+')&select=game_id,captured_at,collector_version');
    if(!Array.isArray(rs))throw Error('Receipt read failed');
    for(const r of rs)receipts.set(Number(r.game_id),r);
  }
  const pending=games.filter(g=>{
    const r=receipts.get(g.gamePk);
    return !r||r.collector_version!==POSTGAME_VERSION||
      (Date.parse(g.gameDate)>now.getTime()-3*86400000 && Date.parse(r.captured_at)<now.getTime()-20*3600000);
  });
  const result={sport_id:sportId,checked:games.length,attempted:0,complete:0,pitcher_rows:0,pending:Math.max(0,pending.length-maxGames),errors:[]};
  let cursor=0;const selected=pending.slice(0,maxGames);
  async function worker(){while(cursor<selected.length){
    const g=selected[cursor++];result.attempted++;
    try{
      const box=await api('https://statsapi.mlb.com/api/v1/game/'+g.gamePk+'/boxscore');
      const payload=buildPostgameIngest(g,box,sportId);
      const receipt=await rpc('bb_ingest_postgame',{p:payload});
      if(receipt?.complete!==true||Number(receipt.game_id)!==g.gamePk)throw Error('Missing atomic capture receipt');
      result.complete++;result.pitcher_rows+=receipt.pitcher_rows;
    }catch(e){result.errors.push({game_id:g.gamePk,error:String(e.message||e).slice(0,160)});}
  }}
  await Promise.all(Array.from({length:3},worker));
  result.pending+=result.errors.length;
  return result;
}
function postgameSummary(league,r){
  return '📊 '+league+': '+r.checked+' finales revisados; '+r.complete+' partidos actualizados y '+r.pitcher_rows+' registros de lanzadores guardados. '+
    (r.pending?'⚠️ '+r.pending+' pendientes; se reintentarán.':'Sin cargas pendientes en esta revisión.')+
    (r.errors.length?' Errores en partidos: '+r.errors.map(x=>x.game_id).join(', ')+'.':'');
}
async function fetchPostgameJson(url,request){
  // Preserve the entire range and gamePks query when the VPS is blocked (HTTP 406).
  for(const proxy of [false,true]){
    try{
      const r=await request({method:'GET',url:proxy?'https://r.jina.ai/'+url:url,
        headers:proxy?{Accept:'text/plain','X-Return-Format':'text'}:
          {'User-Agent':'Mozilla/5.0',Accept:'application/json',Origin:'https://www.milb.com',Referer:'https://www.milb.com/schedule'},
        returnFullResponse:true,ignoreHttpStatusErrors:true,timeout:30000});
      if(!(r.statusCode>=200&&r.statusCode<300))continue;
      const data=typeof r.body==='string'?JSON.parse(r.body):r.body;
      if(data&&typeof data==='object'&&!Array.isArray(data)&&(Array.isArray(data.dates)||data.teams))return data;
    }catch(_){/* Retry through the second transport, then leave the game pending. */}
  }
  throw Error('Official postgame source unavailable after direct and proxy attempts');
}
module.exports={recoverPostgames,postgameSummary,fetchPostgameJson};
