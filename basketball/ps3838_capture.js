'use strict';
const {normalizePublicQuotes,parsePlayerPrices}=require('./ps3838');
const {notify}=require('./notifications');
const {all}=require('./capture');
async function api(ctx,path){const r=await ctx.http(ctx.server.url+path,{headers:{Authorization:'Bearer '+ctx.server.token},timeout:20000});if(r.status===404&&path.includes('/status/'))return {status:'not_found'};if(r.status===502&&r.body?.status==='error')return r.body;if(r.status<200||r.status>=300)throw Error('PS3838_SERVER_HTTP_'+r.status);return r.body;}
async function runPublicOdds(ctx){
 const {rest,now=new Date()}=ctx,access=(await rest('bk_state?league=eq.ALL&component=eq.ps3838_access&select=*'))[0];
 if(access?.status==='blocked')return {status:'ACCESS_BLOCKED_NO_AUTOMATIC_RETRY'};
 const report={leagues:{}};
 for(const league of ['NBA','WNBA']){
  const games=await rest('bk_games?league=eq.'+league+'&status=eq.scheduled&starts_at=gt.'+now.toISOString()+'&starts_at=lt.'+new Date(now.getTime()+12*3600000).toISOString()+'&order=starts_at.asc&select=*');
  const prior=(await rest('bk_state?league=eq.'+league+'&component=eq.ps3838_job&select=*'))[0],checked=prior?.detail?.checked||{},r={games:games.length,quotes:0,rejected:[],source:'ps3838_public_delayed',delayed:true,reference_only:true};report.leagues[league]=r;let jobId=null;
  if(prior?.detail?.job_id){const job=await api(ctx,'/scrape-odds/status/'+prior.detail.job_id);
   if(job.status==='running'){r.status='RUNNING';continue;}
   if(job.status==='done'){
    if(job.result?.access_denied){await rest('bk_state?on_conflict=league,component','POST',{league:'ALL',component:'ps3838_access',checked_at:now.toISOString(),status:'blocked',detail:{reason:'SOURCE_ACCESS_DENIED'}},{prefer:'resolution=merge-duplicates,return=minimal'});await notify(ctx,'ps3838:access-blocked:'+now.toISOString().slice(0,10),'NBA','PS3838 ha denegado el acceso público. La captura se ha detenido y requiere revisión.');return {status:'ACCESS_BLOCKED'};}
    const forecasts=games.length?await all(rest,'bk_forecasts?league=eq.'+league+'&game_id=in.('+games.map(g=>g.game_id).join(',')+')&kind=eq.player&select=league,game_id,player_id,result'):[];
    const n=normalizePublicQuotes(job.result,games,now,forecasts);r.quotes=n.quotes.length;r.player_quotes=n.quotes.filter(q=>q.detail.player_name).length;r.mapped_player_quotes=n.quotes.filter(q=>q.player_id).length;r.rejected=[...new Set(n.rejected)];r.source_errors=job.result.errors||[];
    r.coverage=(job.result.games||[]).map(e=>({event_id:e.source_event_id,player_markets:e.player_markets_status||'NOT_CAPTURED',visible_player_rows:e.player_rows?.length||0,accepted_player_rows:parsePlayerPrices(e).length/2}));
    for(let i=0;i<n.quotes.length;i+=150)await rest('bk_quotes?on_conflict=quote_id','POST',n.quotes.slice(i,i+150),{prefer:'resolution=merge-duplicates,return=minimal'});
    for(const e of job.result.errors||[])if(e.code==='EVENT_NOT_LISTED'){const g=games.find(g=>e.teams?.[0]===g.home_team&&e.teams?.[1]===g.away_team);if(g)checked[g.game_id]=new Date(now.getTime()+25*60000).toISOString();}
   }else r.error='PS3838_JOB_FAILED';
  }
  const active=new Set(games.map(g=>g.game_id));for(const k of Object.keys(checked))if(!active.has(k))delete checked[k];
  const selected=games.filter(g=>!checked[g.game_id]||Date.parse(checked[g.game_id])<=now.getTime()-4*60000).sort((a,b)=>(checked[a.game_id]||'').localeCompare(checked[b.game_id]||'')).slice(0,3);
  if(selected.length){const names=selected.flatMap(g=>[g.home_team,g.away_team]);const start=await api(ctx,'/scrape-odds/start?league='+league+'&bookmaker=PS3838&teams='+encodeURIComponent(names.join(',')));if(!start.job_id)throw Error('PS3838_NOT_STARTED');jobId=start.job_id;for(const g of selected)checked[g.game_id]=now.toISOString();}
  r.status=!games.length?'no_games':r.quotes?'delayed_reference_only':r.source_errors?.length?'source_unavailable':'awaiting_capture';
  await rest('bk_state?on_conflict=league,component','POST',{league,component:'ps3838_job',checked_at:now.toISOString(),status:jobId?'running':r.status,detail:{job_id:jobId,checked}},{prefer:'resolution=merge-duplicates,return=minimal'});
  await rest('bk_state?on_conflict=league,component','POST',{league,component:'ps3838',checked_at:now.toISOString(),status:r.status,detail:r},{prefer:'resolution=merge-duplicates,return=minimal'});
 }return report;
}
module.exports={runPublicOdds};
