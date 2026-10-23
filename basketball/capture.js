'use strict';
const {VERSION,LEAGUES,root,createClient,schedule,loadGame}=require('./espn');
async function all(rest,path){const rows=[];for(let offset=0;;offset+=1000){const r=await rest(path+(path.includes('?')?'&':'?')+'limit=1000&offset='+offset);if(!Array.isArray(r))throw Error('DATABASE_RESPONSE_INVALID');rows.push(...r);if(r.length<1000)return rows;if(offset>200000)throw Error('DATABASE_PAGE_LIMIT');}}
async function mapLimit(items,limit,fn){const result=new Array(items.length);let next=0;await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(next<items.length){const i=next++;result[i]=await fn(items[i],i);}}));return result;}
const safe=e=>/^[A-Z][A-Z_0-9]+$/.test(e?.message||'')?e.message:'SOURCE_CAPTURE_FAILED';
async function runCapture({http,rest,now=new Date(),maxBoxes=6}){
 const get=await createClient(http),report={version:VERSION,at:now.toISOString(),leagues:{}};
 for(const league of Object.keys(LEAGUES)){
  const r={scheduled_checked:0,boxes_ingested:0,errors:[]};report.leagues[league]=r;
  const date=delta=>new Date(now.getTime()+delta*86400000).toISOString().slice(0,10);
  try{
   const refs=await schedule(league,get,date(-3),date(7));
   const discovered=await mapLimit(refs,3,async url=>{try{const p=await loadGame(league,url,get,{rosters:true});if(p){r.scheduled_checked++;if(p.roster_errors)r.errors.push({game_id:p.game.game_id,code:'CURRENT_ROSTER_UNAVAILABLE'});return p;}return null;}catch(e){r.errors.push({code:safe(e)});return null;}});
   const payloads=discovered.filter(Boolean);for(let i=0;i<payloads.length;i+=20)await rest('rpc/bk_import_batch','POST',{p_payloads:payloads.slice(i,i+20)});
   const deferred=await rest('bk_box_attempts?league=eq.'+league+'&retry_at=gt.'+now.toISOString()+'&select=game_id');
   const skip=new Set(deferred.map(g=>g.game_id));
   const pending=(await rest('bk_games?league=eq.'+league+'&status=eq.final&box_complete=eq.false&select=*&order=starts_at.desc&limit=100')).filter(g=>!skip.has(g.game_id)).slice(0,maxBoxes);
   if(!Array.isArray(pending))throw Error('DATABASE_RESPONSE_INVALID');
   for(const g of pending)try{
    const p=await loadGame(league,root(league)+'/events/'+g.game_id,get,{box:true});if(!p?.receipt?.complete)throw Error('FINAL_BOXSCORE_NOT_COMPLETE');
    const receipt=await rest('rpc/bk_store_game','POST',{p_payload:p});if(receipt?.box_complete!==true)throw Error('BOXSCORE_NOT_PERSISTED');r.boxes_ingested++;
   }catch(e){r.errors.push({game_id:g.game_id,code:safe(e)});await rest('bk_box_attempts?on_conflict=league,game_id','POST',{league,game_id:g.game_id,checked_at:now.toISOString(),retry_at:new Date(now.getTime()+6*3600000).toISOString(),error_code:safe(e)},{prefer:'resolution=merge-duplicates,return=minimal'});}
   const missing=await rest('bk_games?league=eq.'+league+'&status=eq.final&box_complete=eq.false&select=game_id,starts_at&order=starts_at.desc&limit=100');
   r.pending_finals=missing.length;r.pending_count_capped=missing.length===100;r.recent_pending=missing.filter(g=>Date.parse(g.starts_at)>now.getTime()-3*86400000).length;
  }catch(e){r.errors.push({code:safe(e)});}
  r.status=r.errors.length||r.recent_pending?'attention':'healthy';
  await rest('bk_state?on_conflict=league,component','POST',{league,component:'capture',checked_at:now.toISOString(),status:r.status,detail:r},{prefer:'resolution=merge-duplicates,return=minimal'});
 }return report;
}
module.exports={all,mapLimit,safe,runCapture};
