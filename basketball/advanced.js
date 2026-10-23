'use strict';
const {notify}=require('./notifications');
async function runAdvanced(ctx){
 const {rest,now=new Date()}=ctx;
 const server=async(path,method='GET')=>{const r=await ctx.http(ctx.server.url+'/basketball-advanced'+path,{method,headers:{Authorization:'Bearer '+ctx.server.token},timeout:20000});if(r.status===404)return {status:'not_found'};if(r.status!==200)throw Error('ADVANCED_SERVER_HTTP_'+r.status);return r.body;};
 const old=(await rest('bk_state?league=eq.NBA&component=eq.advanced_job&select=*'))[0];
 const detail=old?.detail||{};
 if(detail.job_id){
  const job=await server('/status/'+detail.job_id);
  if(job.status==='running')return {status:'RUNNING'};
  if(old.status==='running'){
   await rest('bk_state?on_conflict=league,component','POST',{league:'NBA',component:'advanced_job',checked_at:now.toISOString(),status:job.status,detail},{prefer:'resolution=merge-duplicates,return=minimal'});
   if(job.status==='error'){
    for(const league of ['NBA','WNBA']){
     const report=job.result?.reports?.find(r=>r.league===league);
     if(!report||report.status==='error')await notify(ctx,league+':advanced:error:'+now.toISOString().slice(0,10),league,league+' · fallo al actualizar estadísticas avanzadas. Los datos quedan marcados en Supabase y se reintentará en el próximo ciclo.');
    }
   }
  }
 }
 if(detail.started_at&&Date.parse(detail.started_at)>now.getTime()-55*60000)return {status:'NOT_DUE'};
 const started=await server('/start','POST');if(!started.job_id)throw Error('ADVANCED_NOT_STARTED');
 await rest('bk_state?on_conflict=league,component','POST',{league:'NBA',component:'advanced_job',status:'running',checked_at:now.toISOString(),detail:{job_id:started.job_id,started_at:now.toISOString()}},{prefer:'resolution=merge-duplicates,return=minimal'});
 return {status:'STARTED'};
}
module.exports={runAdvanced};
