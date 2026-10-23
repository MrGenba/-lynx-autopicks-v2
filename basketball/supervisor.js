'use strict';
// Durable server coordinator. Recovery tools are fixed, authenticated workflows.
// Model reviews retain their own budget and never receive deployment credentials.
const {notify}=require('./notifications');
const VERSION='bk-supervisor-1';
const TASKS={context:{component:'context',minutes:15,market:true},capture:{component:'capture',minutes:90},advanced:{component:'advanced_stats',minutes:110},analysis:{component:'analysis',minutes:15},odds:{component:'odds',minutes:20,market:true},props:{component:'props',minutes:20,market:true},research:{component:'research',minutes:30*60}};
const bad=s=>!s||['error','failed','source_error'].includes(s.status);
function plan(states,games,locks,now){
 const issues=[],blocked=[],access=states.find(s=>s.league==='ALL'&&s.component==='ai_access');
 for(const [task,rule]of Object.entries(TASKS)){
  const sourceAccess=states.find(s=>s.league==='ALL'&&s.component===task+'_access'&&s.status==='blocked');
  if(sourceAccess){blocked.push({task,reason:'SOURCE_ACCESS_DENIED'});continue;}
  if(task==='research'&&Date.parse(access?.detail?.retry_at)>now.getTime()){blocked.push({task,reason:'API_COOLDOWN',retry_at:access.detail.retry_at});continue;}
  const affected=[];
  for(const league of ['NBA','WNBA']){
   if(rule.market&&!games.some(g=>g.league===league&&g.status==='scheduled'&&Date.parse(g.starts_at)>now.getTime()&&Date.parse(g.starts_at)<=now.getTime()+12*3600000))continue;
   const s=states.find(s=>s.league===league&&s.component===rule.component),age=now.getTime()-Date.parse(s?.checked_at);
   const researchRetry=task==='research'&&s?.status==='attention'&&['RATE_LIMITED','BUDGET_OR_DUPLICATE'].includes(s.detail?.review)&&s.checked_at.slice(0,10)<now.toISOString().slice(0,10);
   if(bad(s)||!Number.isFinite(age)||age>rule.minutes*60000||researchRetry)affected.push({league,component:rule.component,status:s?.status||'MISSING',checked_at:s?.checked_at||null,reason:researchRetry?'RESUME_AI':bad(s)?'FAILED_OR_MISSING':'STALE'});
  }
  if(affected.length){const locked=locks.some(l=>l.name===task&&Date.parse(l.expires_at)>now.getTime());issues.push({task,affected,locked});}
 }
 return {issues,blocked};
}
function recovered(action,states){return action.evidence.affected.every(before=>{const s=states.find(s=>s.league===before.league&&s.component===before.component);return s&&!bad(s)&&s.status!=='attention'&&Date.parse(s.checked_at)>Date.parse(action.requested_at);});}
function targetFor(task,targets){const t=targets?.[task];if(!TASKS[task]||!t||!/^basketball-[a-z]+-[a-f0-9-]{36}$/.test(t.webhookPath)||!/^[a-f0-9]{64}$/.test(t.webhookToken))throw Error('SUPERVISOR_TARGET_INVALID');return t;}
async function runSupervisor(ctx){
 const {rest,now=new Date()}=ctx;
 const states=await rest('bk_state?select=league,component,status,checked_at,detail');
 const games=await rest('bk_games?status=eq.scheduled&starts_at=gt.'+now.toISOString()+'&starts_at=lte.'+new Date(now.getTime()+12*3600000).toISOString()+'&select=league,status,starts_at');
 const locks=await rest('bk_locks?select=name,expires_at');
 const prior=(await rest('bk_state?league=eq.ALL&component=eq.supervisor&select=detail'))[0]?.detail;
 const actions=await rest('bk_agent_actions?status=in.(claimed,requested,dispatch_unknown)&select=*');
 for(const a of actions){if(recovered(a,states))await rest('rpc/bk_agent_finish','POST',{p_id:a.action_id,p_status:'recovered'});else if(Date.parse(a.requested_at)<now.getTime()-75*60000)await rest('rpc/bk_agent_finish','POST',{p_id:a.action_id,p_status:'unresolved'});}
 const assessment=plan(states,games,locks,now),dispatched=[];
 for(const issue of assessment.issues){
  if(issue.locked)continue;
  const target=targetFor(issue.task,ctx.supervisorTargets);
  const claim=await rest('rpc/bk_agent_claim','POST',{p_task:issue.task,p_evidence:issue});if(!claim)continue;
  let status='dispatch_unknown';try{const r=await ctx.http('https://n8n-n8n.0zhp4h.easypanel.host/webhook/'+target.webhookPath,{method:'POST',headers:{'X-Maintenance-Key':target.webhookToken,'Content-Type':'application/json'},body:{},timeout:10000});if(r.status===200)status='requested';}catch(_){}
  await rest('rpc/bk_agent_finish','POST',{p_id:claim,p_status:status});dispatched.push({task:issue.task,status});
 }
 const since={};for(const issue of assessment.issues){since[issue.task]=prior?.since?.[issue.task]||now.toISOString();
  if(Date.parse(since[issue.task])<=now.getTime()-20*60000)for(const item of issue.affected)await notify(ctx,'supervisor:incident:'+item.league+':'+issue.task+':'+since[issue.task],item.league,item.league+' · supervisor persistente\nLa tarea '+issue.task+' sigue sin recuperarse después de 20 minutos. Estado: '+item.status+'. Los reintentos están limitados y el incidente queda guardado en Supabase. Se requiere revisar esta fuente o servicio.');
 }
 for(const task of Object.keys(prior?.since||{}))if(!assessment.issues.some(i=>i.task===task)&&!assessment.blocked.some(i=>i.task===task))for(const league of ['NBA','WNBA']){
  const incident='supervisor:incident:'+league+':'+task+':'+prior.since[task];
  const sent=await rest('bk_notifications?notification_id=eq.'+encodeURIComponent(incident)+'&sent_at=not.is.null&select=notification_id');
  if(sent.length)await notify(ctx,incident+':recovered',league,league+' · supervisor persistente\nLa tarea '+task+' vuelve a estar actualizada. Recuperación comprobada en el servidor.');
 }
 const detail={version:VERSION,goal:'Capture and validate NBA/WNBA data, evaluate sealed models and notify estimated value; recover permitted workflows.',runtime:'VPS_N8N',state_store:'SUPABASE',since,issues:assessment.issues,blocked:assessment.blocked,dispatched,ai_budget:'EXISTING_RESEARCH_BUDGET_UNCHANGED',research_schedule:'09:00 UTC daily; resume after API cooldown',auto_model_promotion:false,can_place_bet:false};
 await rest('bk_state?on_conflict=league,component','POST',{league:'ALL',component:'supervisor',checked_at:now.toISOString(),status:assessment.issues.length?'recovering':'healthy',detail},{prefer:'resolution=merge-duplicates,return=minimal'});
 for(const league of ['NBA','WNBA'])await notify(ctx,'supervisor:enabled:'+VERSION+':'+league,league,league+' · supervisor persistente activo en el VPS\nComprueba las tareas cada 10 minutos, conserva su estado en Supabase y reintenta fallos sin depender del PC. Los cuatro revisores de IA continúan con su presupuesto y pausa de API actuales.\nAvisará de incidencias persistentes, recuperación y mejoras que superen la prueba registrada.');
 return {status:assessment.issues.length?'RECOVERING':'HEALTHY',issues:assessment.issues.map(i=>i.task),blocked:assessment.blocked,dispatched};
}
module.exports={VERSION,TASKS,plan,recovered,targetFor,runSupervisor};
