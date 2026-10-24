'use strict';
const {normalizeProps}=require('./winamax');
const {all}=require('./capture');
const {notify}=require('./notifications');
const {lastStarted,freshCount,requestAnalysis}=require('./quote_dispatch');
const schedule=require('./winamax_schedule');
async function api(ctx,path){const r=await ctx.http(ctx.server.url+path,{headers:{Authorization:'Bearer '+ctx.server.token},timeout:20000});if(r.status===404&&path.includes('/status/'))return {status:'not_found'};if(r.status===502&&r.body?.status==='error')return r.body;if(r.status<200||r.status>=300)throw Error('PROPS_SERVER_HTTP_'+r.status);return r.body;}
async function runProps(ctx){
 const {rest,now=new Date()}=ctx;const access=(await rest('bk_state?league=eq.ALL&component=eq.props_access&select=*'))[0];
 if(access?.status==='blocked')return {status:'ACCESS_BLOCKED_NO_AUTOMATIC_RETRY'};
 const put=(league,component,status,detail)=>rest('bk_state?on_conflict=league,component','POST',{league,component,checked_at:now.toISOString(),status,detail},{prefer:'resolution=merge-duplicates,return=minimal'});
 const rawBudget=(await rest('bk_state?league=eq.ALL&component=eq.props_browser_budget&select=*'))[0]?.detail;
 const browser=schedule.budget(rawBudget,now),report={policy:schedule.POLICY,leagues:{}},items=[];
 // This tick polls our VPS. Only the guarded launch opens Winamax.
 for(const league of ['NBA','WNBA']){
  const games=await rest('bk_games?league=eq.'+league+'&status=eq.scheduled&starts_at=gt.'+now.toISOString()+'&starts_at=lt.'+new Date(now.getTime()+18*3600000).toISOString()+'&order=starts_at.asc&select=*');
  const prior=(await rest('bk_state?league=eq.'+league+'&component=eq.props_job&select=*'))[0],detail={...(prior?.detail||{})},checked={...(detail.checked||{})};
  let learning=(await rest('bk_state?league=eq.'+league+'&component=eq.props_publication&select=*'))[0]?.detail||{};
  const r={games:games.length,quotes:0,mapped_quotes:0,unmapped_quotes:0,rejected:[],bookmaker:'winamax.fr',jurisdiction:'FR'};report.leagues[league]=r;
  const last=lastStarted(detail,now);if(last>Date.parse(browser.last_started_at||'1970-01-01'))browser.last_started_at=new Date(last).toISOString();
  if(detail.job_id){const job=await api(ctx,'/scrape-odds/status/'+detail.job_id);if(job.status==='running'){r.status='RUNNING';items.push({league,games,detail,checked,learning,r,running:true});continue;}
   if(job.status==='done'){
    if(job.result?.access_denied){await put('ALL','props_access','blocked',{source:'winamax.fr',reason:'SOURCE_ACCESS_DENIED_OR_JURISDICTION_CHANGED'});await notify(ctx,'winamax-fr:access-blocked:'+now.toISOString().slice(0,10),'NBA','Winamax.fr ha denegado el acceso o ha cambiado de jurisdicción. La captura de actuaciones se ha detenido; no se harán reintentos automáticos.');return {status:'ACCESS_BLOCKED'};}
    const forecasts=games.length?await all(rest,'bk_forecasts?league=eq.'+league+'&game_id=in.('+games.map(g=>g.game_id).join(',')+')&kind=eq.player&select=league,game_id,player_id,result'):[];
    const normalized=normalizeProps(job.result,games,forecasts,now);r.rejected=[...new Set(normalized.rejected)].slice(0,30);r.source_errors=job.result.errors||[];
    r.coverage=(job.result.games||[]).map(e=>({event_id:e.source_event_id,markets:[...new Set((e.markets||[]).map(m=>m.market))],notes:e.notes||[]}));
    r.quotes=normalized.quotes.length;r.fresh_quotes=freshCount(normalized.quotes,now);r.mapped_quotes=normalized.quotes.filter(q=>q.player_id).length;r.unmapped_quotes=r.quotes-r.mapped_quotes;
    for(let i=0;i<normalized.quotes.length;i+=150)await rest('bk_quotes?on_conflict=quote_id','POST',normalized.quotes.slice(i,i+150),{prefer:'resolution=merge-duplicates,return=minimal'});
    learning=schedule.observe(learning,games,job.result,normalized.quotes,now,detail.job_id);
    await put(league,'props_publication','healthy',learning);
    if(r.source_errors.length)browser.cooldown_until=new Date(now.getTime()+60*60000).toISOString();
   }else {r.error='PROPS_JOB_FAILED';browser.cooldown_until=new Date(now.getTime()+60*60000).toISOString();}
   detail.job_id=null;
  }
  const active=new Set(games.map(g=>g.game_id));for(const k of Object.keys(checked))if(!active.has(k))delete checked[k];
  items.push({league,games,detail,checked,learning,r,running:false});
 }
 // Rotate leagues; share the IP/session budget and forbid overlapping browser jobs.
 const order=items.slice().sort((a,b)=>Number(a.league===browser.last_league)-Number(b.league===browser.last_league));
 let reason=items.some(x=>x.running)?'BROWSER_RUNNING':schedule.launchReason(browser,now);
 for(const item of order){const {league,games,detail,checked,learning,r}=item;if(item.running)continue;
  const gap=schedule.gameGapMinutes(learning,now);
  const selected=!reason?games.filter(g=>!checked[g.game_id]||Date.parse(checked[g.game_id])<=now.getTime()-gap*60000).sort((a,b)=>(checked[a.game_id]||'').localeCompare(checked[b.game_id]||'')||Date.parse(a.starts_at)-Date.parse(b.starts_at)).slice(0,schedule.POLICY.maxGames):[];
  if(selected.length){
   // Reserve before the worker call. An ambiguous start still consumes the budget.
   browser.sessions++;browser.last_started_at=now.toISOString();browser.last_league=league;browser.policy=schedule.POLICY.version;
   await put('ALL','props_browser_budget','healthy',browser);
   const names=selected.flatMap(g=>[g.home_team.replace(/^LA Clippers$/,'Los Angeles Clippers'),g.away_team.replace(/^LA Clippers$/,'Los Angeles Clippers')]);
   const started=await api(ctx,'/scrape-odds/start?league='+league+'&bookmaker=Winamax&teams='+encodeURIComponent(names.join(',')));if(!started.job_id)throw Error('PROPS_NOT_STARTED');
   detail.job_id=started.job_id;detail.last_started_at=now.toISOString();for(const g of selected)checked[g.game_id]=now.toISOString();reason='BROWSER_INTERVAL';
  }
  r.status=detail.job_id?'running':!games.length?'no_games':!schedule.inWindow(now)?'afternoon_only':r.quotes?'captured':reason?'scheduled_wait':'awaiting_available_markets';
  r.browser_policy=schedule.POLICY;r.browser_sessions_today=browser.sessions;r.wait_reason=reason;r.publication_profile=learning.profile||schedule.profile({});
  await put(league,'props_job',r.status,{...detail,checked});await put(league,'props',r.status,r);
  const p=learning.profile;
  if(p?.status==='LEARNED_INTERVAL')await notify(ctx,'winamax-window:'+league+':'+p.startMinute+':'+p.endMinute,league,'Winamax · horario observado\nEn '+p.bracketed_events+' partidos de '+p.independent_days+' días, las cuotas aparecieron entre comprobaciones dentro de '+schedule.hour(p.startMinute)+'–'+schedule.hour(p.endMinute)+' (Madrid).\nSe reducen las comprobaciones por partido fuera de esa franja a una cada dos horas, siempre dentro de 15:00–22:00. Es una estimación, no la hora exacta de publicación.');
 }
 await put('ALL','props_browser_budget','healthy',browser);
 return requestAnalysis(ctx,report);
}
module.exports={runProps};
