'use strict';
const {id}=require('./pipeline');
const {lastStarted,canStart,freshCount,requestAnalysis}=require('./quote_dispatch');
const norm=s=>String(s||'').replace(/ F$/,'').replace(/^LA Clippers$/,'Los Angeles Clippers').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
function normalizeQuotes(raw,games,now=new Date()){
 const quotes=[],rejected=[];
 for(const event of raw.games||[]){
  const matched=games.filter(g=>g.league===raw.league&&norm(g.home_team)===norm(event.home_team)&&norm(g.away_team)===norm(event.away_team)&&Math.abs(Date.parse(g.starts_at)-Date.parse(event.start_time_utc))<=60000);
  if(matched.length!==1||event.bookmaker?.toLowerCase()!=='bet365'||event.period!=='full_game'||event.includes_overtime!==true){rejected.push('EVENT_OR_SCOPE_UNVERIFIED');continue;}
  const g=matched[0];if(g.status!=='scheduled'||Date.parse(g.starts_at)<=now.getTime())continue;
  for(const m of event.markets||[]){const captured=Date.parse(m.captured_at);if(!['moneyline','total','spread'].includes(m.market)||!Number.isFinite(captured)||captured>now.getTime()+60000||captured<now.getTime()-15*60000||![m.odds1,m.odds2].every(o=>Number.isFinite(o)&&o>1&&o<1000)){rejected.push('MARKET_INVALID_OR_EXPIRED');continue;}
   if(m.market!=='moneyline'&&(!Number.isFinite(m.line)||!Number.isInteger(m.line*2))){rejected.push('LINE_INVALID');continue;}
   for(const i of [0,1]){const selection=m.market==='total'?(i?'under':'over'):(i?'away':'home'),line=m.market==='moneyline'?null:m.market==='spread'&&i?-m.line:m.line;
    quotes.push({quote_id:id(g.league,g.game_id,'bet365',m.market,line,selection),league:g.league,game_id:g.game_id,player_id:null,market:m.market,line,selection,odds:i?m.odds2:m.odds1,opposite_odds:i?m.odds1:m.odds2,bookmaker:'bet365',period:'full_game',includes_overtime:true,
     source:'cuotasahora',source_url:event.source_event_url,captured_at:m.captured_at,price_updated_at:null,expires_at:new Date(Math.min(captured+15*60000,Date.parse(g.starts_at))).toISOString(),detail:{bookmaker_update_time:'unknown',observed_at:m.captured_at}});
   }
  }
 }return {quotes,rejected};
}
async function server(ctx,path,method='GET'){
 const r=await ctx.http(ctx.server.url+path,{method,headers:{Authorization:'Bearer '+ctx.server.token},timeout:20000});
 if(r.status===404&&path.includes('/status/'))return {status:'not_found'};
 if(r.status===502&&r.body?.status==='error')return r.body;
 if(r.status<200||r.status>=300)throw Error('SERVER_HTTP_'+r.status);return r.body;
}
async function runSnapshot(ctx){
 const {rest,now=new Date()}=ctx,prior=(await rest('bk_state?league=eq.NBA&component=eq.capture_job&select=*'))[0];
 if(prior?.detail?.job_id){const r=await server(ctx,'/basketball-stats/status/'+prior.detail.job_id).catch(()=>null);if(r?.status==='running')return {status:'RUNNING'};}
 if(prior&&Date.parse(prior.checked_at)>now.getTime()-55*60000)return {status:'NOT_DUE'};
 const started=await server(ctx,'/basketball-stats/start','POST');if(!started.job_id)throw Error('SNAPSHOT_NOT_STARTED');
 await rest('bk_state?on_conflict=league,component','POST',{league:'NBA',component:'capture_job',status:'running',checked_at:now.toISOString(),detail:{job_id:started.job_id}},{prefer:'resolution=merge-duplicates,return=minimal'});return {status:'STARTED'};
}
const safeError=(error,fallback)=>{const code=String(error?.message??error??'').trim();return /^[A-Z][A-Z_0-9]{1,95}$/.test(code)?code:fallback;};
const putState=(rest,league,component,status,detail,now)=>rest('bk_state?on_conflict=league,component','POST',{league,component,status,checked_at:now.toISOString(),detail},{prefer:'resolution=merge-duplicates,return=minimal'});
async function advanceOdds(ctx,league,games,detail,r){
 const {rest,now}=ctx;
 if(!games.length){detail.job_id=null;detail.checked={};detail.last_failure=null;return;}
 const active=new Set(games.map(g=>g.game_id));for(const key of Object.keys(detail.checked))if(!active.has(key))delete detail.checked[key];
 let last=lastStarted(detail,now);
 if(detail.job_id&&!last)last=Date.parse(detail.checked_at)||now.getTime();
 detail.last_started_at=last?new Date(last).toISOString():null;
 if(detail.job_id){
  const job=await server(ctx,'/scrape-odds/status/'+detail.job_id);
  if(job?.status==='running'){
   // Polls are heartbeats, not proof that quotes recovered. Keep the original
   // launch time and never create another browser for an overdue running job.
   if(now.getTime()-last>=20*60000)detail.last_failure=detail.last_failure||{error:'ODDS_JOB_STALLED',failed_at:now.toISOString()};
   return;
  }
  if(job?.status==='done'){
   if(job.result?.league!==league||!Array.isArray(job.result?.games))throw Error('ODDS_RESULT_INVALID');
   const normalized=normalizeQuotes(job.result,games,now);r.rejected=normalized.rejected;r.source_errors=job.result.errors||[];
   if(normalized.quotes.length){await rest('bk_quotes?on_conflict=quote_id','POST',normalized.quotes,{prefer:'resolution=merge-duplicates,return=minimal'});r.quotes=normalized.quotes.length;r.fresh_quotes=freshCount(normalized.quotes,now);}
   detail.latest_capture={completed_at:now.toISOString(),quotes:r.quotes,source_errors:r.source_errors,rejected:r.rejected,expires_at:normalized.quotes.length?new Date(Math.max(...normalized.quotes.map(q=>Date.parse(q.expires_at)))).toISOString():null};
   detail.last_failure=null;
  }else if(['error','not_found'].includes(job?.status)){
   detail.last_failure={error:safeError(job.error,job.status==='not_found'?'ODDS_JOB_NOT_FOUND':'ODDS_JOB_FAILED'),failed_at:now.toISOString()};
  }else throw Error('ODDS_JOB_STATUS_INVALID');
  detail.job_id=null;
 }
 if(canStart(last,now)){
  const selected=[...games].sort((a,b)=>(detail.checked[a.game_id]||'').localeCompare(detail.checked[b.game_id]||'')).slice(0,3);
  const names=selected.flatMap(g=>[g.home_team.replace(/^LA Clippers$/,'Los Angeles Clippers'),g.away_team.replace(/^LA Clippers$/,'Los Angeles Clippers')]);
  // Reserve the five-minute interval before dispatch: a lost HTTP response can
  // still mean the worker accepted the request. Do not retry it every minute.
  detail.last_started_at=now.toISOString();for(const g of selected)detail.checked[g.game_id]=now.toISOString();
  await putState(rest,league,'odds_job','running',detail,now);
  const start=await server(ctx,'/scrape-odds/start?league='+league+'&bookmaker=Bet365&teams='+encodeURIComponent(names.join(',')));
  if(!start?.job_id)throw Error('ODDS_NOT_STARTED');detail.job_id=start.job_id;
 }
}
async function runOdds(ctx){
 const {rest,now=new Date()}=ctx,report={leagues:{}};
 for(const league of ['NBA','WNBA']){
  const r={quotes:0,rejected:[],bookmaker:'bet365',player_props:'SEPARATE_WINAMAX_FR_COLLECTOR'};report.leagues[league]=r;
  let detail=null;
  try{
   const games=await rest('bk_games?league=eq.'+league+'&status=eq.scheduled&starts_at=gt.'+now.toISOString()+'&starts_at=lt.'+new Date(now.getTime()+12*3600000).toISOString()+'&order=starts_at.asc&select=*');r.games=games.length;
   const old=(await rest('bk_state?league=eq.'+league+'&component=eq.odds_job&select=*'))[0];
   detail={...old?.detail,job_id:old?.detail?.job_id||null,checked:{...old?.detail?.checked},checked_at:old?.checked_at};
   await advanceOdds({...ctx,now},league,games,detail,r);
  }catch(error){
   r.error=safeError(error,'ODDS_TASK_FAILED');
   if(detail)detail.last_failure={error:r.error,failed_at:now.toISOString()};
  }
  r.latest_capture=detail?.latest_capture||null;r.job_status=detail?.job_id?'running':null;
  if(detail?.last_failure)r.error=detail.last_failure.error;
  r.status=r.error?'error':r.games===0?'no_games':Date.parse(r.latest_capture?.expires_at)>now.getTime()?'captured':r.job_status?'running':r.latest_capture?.quotes===0?'source_unavailable':'awaiting_refresh';
  // One league's worker failure must not reach the workflow-wide catch that
  // marks BOTH leagues as error. Preserve pending job IDs for the next poll.
  try{
   if(detail){delete detail.checked_at;await putState(rest,league,'odds_job',r.status,detail,now);}
   await putState(rest,league,'odds',r.status,r,now);
  }catch(error){r.status='error';r.state_error=safeError(error,'ODDS_STATE_WRITE_FAILED');}
 }
 return requestAnalysis(ctx,report);
}
module.exports={norm,normalizeQuotes,runOdds,runSnapshot};

