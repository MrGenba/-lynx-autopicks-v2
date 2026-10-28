'use strict';
const {notify}=require('./notifications');
async function run(ctx){
 const now=ctx.now||new Date(),response=await ctx.http(ctx.server.url+'/basketball-storage/maintain',{method:'POST',headers:{Authorization:'Bearer '+ctx.server.token},timeout:210000});
 const result=response.body||{status:'error'},prior=(await ctx.rest('bk_state?league=eq.ALL&component=eq.storage&select=*'))[0];
 await ctx.rest('bk_state?on_conflict=league,component','POST',{league:'ALL',component:'storage',checked_at:now.toISOString(),status:result.status,detail:result},{prefer:'resolution=merge-duplicates,return=minimal'});
 if(response.status!==200||['attention','critical','error'].includes(result.status))await notify(ctx,'storage:incident:'+now.toISOString().slice(0,10),'NBA','Baloncesto · almacenamiento del VPS\n'+(result.error||'Revisar capacidad: base '+(result.database_bytes/1024**3).toFixed(2)+' GiB; disco '+(100*result.disk_used_fraction).toFixed(1)+'% ocupado.')+'\nLas predicciones y decisiones históricas no se borran automáticamente.');
 else if(prior&&['attention','critical','error'].includes(prior.status))await notify(ctx,'storage:recovered:'+now.toISOString().slice(0,10),'NBA','Baloncesto · almacenamiento y copia diaria vuelven a estar verificados.');
 return result;
}
module.exports={run};

