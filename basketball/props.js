'use strict';
const {normalizeProps}=require('./winamax');
const {all}=require('./capture');
const {notify}=require('./notifications');
async function api(ctx,path){const r=await ctx.http(ctx.server.url+path,{headers:{Authorization:'Bearer '+ctx.server.token},timeout:20000});if(r.status===404&&path.includes('/status/'))return {status:'not_found'};if(r.status===502&&r.body?.status==='error')return r.body;if(r.status<200||r.status>=300)throw Error('PROPS_SERVER_HTTP_'+r.status);return r.body;}
const labels={points:'puntos',rebounds:'rebotes',assists:'asistencias',threes:'triples',pra:'P+R+A',pr:'P+R',pa:'P+A',ra:'R+A'};
function quoteMessage(game,quotes){
 const pairs=quotes.filter(q=>q.selection==='over'&&q.player_id).slice(0,6);if(!pairs.length)return null;
 return [game.league+' · cuotas de jugadores · Winamax.fr',game.away_team+' @ '+game.home_team,...pairs.map(q=>q.detail.player_name+' · '+labels[q.market]+' '+q.line+': más '+q.odds.toFixed(2)+' / menos '+q.opposite_odds.toFixed(2)),
 'Lectura directa de la versión francesa. No se ha verificado equivalencia con Winamax España.','Precios observados; confirma disponibilidad. Son datos para seguimiento, sin ventaja demostrada.'].join('\n');
}
async function runProps(ctx){
 const {rest,now=new Date()}=ctx;const access=(await rest('bk_state?league=eq.ALL&component=eq.props_access&select=*'))[0];
 if(access?.status==='blocked')return {status:'ACCESS_BLOCKED_NO_AUTOMATIC_RETRY'};
 const report={leagues:{}};
 for(const league of ['NBA','WNBA']){
  const games=await rest('bk_games?league=eq.'+league+'&status=eq.scheduled&starts_at=gt.'+now.toISOString()+'&starts_at=lt.'+new Date(now.getTime()+12*3600000).toISOString()+'&order=starts_at.asc&select=*');
  const prior=(await rest('bk_state?league=eq.'+league+'&component=eq.props_job&select=*'))[0],checked=prior?.detail?.checked||{},r={games:games.length,quotes:0,mapped_quotes:0,unmapped_quotes:0,rejected:[],bookmaker:'winamax.fr',jurisdiction:'FR'};report.leagues[league]=r;
  let jobId=null;
  if(prior?.detail?.job_id){const job=await api(ctx,'/scrape-odds/status/'+prior.detail.job_id);if(job.status==='running'){r.status='RUNNING';continue;}
   if(job.status==='done'){
    if(job.result?.access_denied){await rest('bk_state?on_conflict=league,component','POST',{league:'ALL',component:'props_access',checked_at:now.toISOString(),status:'blocked',detail:{source:'winamax.fr',reason:'SOURCE_ACCESS_DENIED_OR_JURISDICTION_CHANGED'}},{prefer:'resolution=merge-duplicates,return=minimal'});await notify(ctx,'winamax-fr:access-blocked:'+now.toISOString().slice(0,10),'NBA','Winamax.fr ha denegado el acceso o ha cambiado de jurisdicción. La captura de actuaciones se ha detenido; no se harán reintentos automáticos.');return {status:'ACCESS_BLOCKED'};}
    const forecasts=games.length?await all(rest,'bk_forecasts?league=eq.'+league+'&game_id=in.('+games.map(g=>g.game_id).join(',')+')&kind=eq.player&select=league,game_id,player_id,result'):[];
    const normalized=normalizeProps(job.result,games,forecasts,now);r.rejected=[...new Set(normalized.rejected)].slice(0,30);r.source_errors=job.result.errors||[];
    r.coverage=(job.result.games||[]).map(e=>({event_id:e.source_event_id,markets:[...new Set((e.markets||[]).map(m=>m.market))],partial_markets:[...new Set((e.markets||[]).filter(m=>m.coverage==='visible_rows_only').map(m=>m.market))],notes:e.notes||[]}));
    r.quotes=normalized.quotes.length;r.mapped_quotes=normalized.quotes.filter(q=>q.player_id).length;r.unmapped_quotes=r.quotes-r.mapped_quotes;
    for(let i=0;i<normalized.quotes.length;i+=150)await rest('bk_quotes?on_conflict=quote_id','POST',normalized.quotes.slice(i,i+150),{prefer:'resolution=merge-duplicates,return=minimal'});
    for(const g of games){const qs=normalized.quotes.filter(q=>q.game_id===g.game_id),text=quoteMessage(g,qs);if(text&&Date.parse(g.starts_at)<=now.getTime()+6*3600000)await notify(ctx,'props:winamax.fr:'+league+':'+g.game_id,league,text,g.starts_at);}
    for(const e of job.result.games||[])if(!e.markets?.length){const match=games.find(g=>g.home_team===e.home_team&&g.away_team===e.away_team);if(match)checked[match.game_id]=new Date(now.getTime()+45*60000).toISOString();}
   }else r.error='PROPS_JOB_FAILED';
  }
  const active=new Set(games.map(g=>g.game_id));for(const k of Object.keys(checked))if(!active.has(k))delete checked[k];
  const selected=games.filter(g=>!checked[g.game_id]||Date.parse(checked[g.game_id])<=now.getTime()-4*60000).sort((a,b)=>(checked[a.game_id]||'').localeCompare(checked[b.game_id]||'')).slice(0,3);
  if(selected.length){const names=selected.flatMap(g=>[g.home_team.replace(/^LA Clippers$/,'Los Angeles Clippers'),g.away_team.replace(/^LA Clippers$/,'Los Angeles Clippers')]);const started=await api(ctx,'/scrape-odds/start?league='+league+'&bookmaker=Winamax&teams='+encodeURIComponent(names.join(',')));if(!started.job_id)throw Error('PROPS_NOT_STARTED');jobId=started.job_id;for(const g of selected)checked[g.game_id]=now.toISOString();}
  r.status=!games.length?'no_games':r.quotes?'capturing':r.source_errors?.length?'source_error':'awaiting_available_markets';
  await rest('bk_state?on_conflict=league,component','POST',{league,component:'props_job',checked_at:now.toISOString(),status:jobId?'running':r.status,detail:{job_id:jobId,checked}},{prefer:'resolution=merge-duplicates,return=minimal'});
  await rest('bk_state?on_conflict=league,component','POST',{league,component:'props',checked_at:now.toISOString(),status:r.status,detail:r},{prefer:'resolution=merge-duplicates,return=minimal'});
 }return report;
}
module.exports={quoteMessage,runProps};
