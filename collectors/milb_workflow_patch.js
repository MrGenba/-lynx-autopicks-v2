'use strict';
// Applied to the existing, private n8n MiLB node. No credentials belong here.
function dailyHealth(log){
 const calendar=log.filter(l=>l.startsWith('schedule_MiLB '));
 const scheduleOk=calendar.length===2&&calendar.every(l=>/HTTP 2\d\d/.test(l)||/: 0 \(HTTP 0\)/.test(l));
 const required=[/^advanced_MiLB: team [1-9]\d* \(2\d\d\) \| bullpen [1-9]\d* \(2\d\d\)/,/^siera_MiLB: [1-9]\d* .*HTTP 2\d\d/,/^player_stats_MiLB: [1-9]\d* .*HTTP 2\d\d/,/^fip_constant_MiLB: .*HTTP 2\d\d/,/^statcast_scoped_v1: 4 scopes/];
 return {calendar:scheduleOk?'healthy':'error',stats:required.every(re=>log.some(l=>re.test(l)))?'healthy':'error'};
}
function patchMilb(code){
 if(code.includes('// MILB_CAPTURE_HEALTH_V1'))return code;
 const replace=(a,b)=>{if(!code.includes(a))throw Error('MiLB patch anchor missing: '+a.slice(0,60));code=code.replace(a,()=>b);};
 const fnStart=code.indexOf('async function mlbApiMilb('),fnEnd=code.indexOf('function round2',fnStart);
 if(fnStart<0||fnEnd<0)throw Error('MiLB transport missing');
 let transport=code.slice(fnStart,fnEnd);if(!transport.includes('  return [];'))throw Error('MiLB failure path missing');
 transport=transport.replace('  return [];',"  throw Error('MiLB source unavailable after retries');");code=code.slice(0,fnStart)+transport+code.slice(fnEnd);
 replace('    const rows=[];\n    for (const dateObj of (data.dates||[])) {',"    if(!Array.isArray(data?.dates))throw Error('MiLB invalid schedule response');\n    const rows=[];\n    for (const dateObj of data.dates) {");
 replace('if (hour === 13) {','if (hour === 13) {\n try {');
 const end='\n}\n\n// ── TURNO 20h:';
 replace(end,`\n const health=dailyHealth(log);for(const component of ['calendar','stats'])await recordMilbHealth(component,health[component],{log});
 if(Object.values(health).includes('error'))throw Error('MiLB incomplete daily statistics');
 }catch(e){for(const component of ['calendar','stats'])await recordMilbHealth(component,'error',{code:'DAILY_CAPTURE_FAILED',log});throw e;}
}\n\n// ── TURNO 20h:`);
 replace("  log.push('postgame_'+league+': '+JSON.stringify(r));return postgameSummary(league,r);","  await recordMilbHealth('postgame',r.pending===0&&r.errors.length===0?'healthy':'error',r);\n  log.push('postgame_'+league+': '+JSON.stringify(r));return postgameSummary(league,r);");
 replace(" }catch(e){log.push('postgame_'+league+': failed '"," }catch(e){await recordMilbHealth('postgame','error',{code:'POSTGAME_CAPTURE_FAILED'});log.push('postgame_'+league+': failed '");
 const header=`// MILB_CAPTURE_HEALTH_V1
${dailyHealth.toString()}
async function recordMilbHealth(component,status,detail){const at=new Date().toISOString();const r=await sbUpsert('bb_capture_health?on_conflict=league,component',[{league:'MILB',component,status,season:new Date().getUTCFullYear(),checked_at:at,...(status==='healthy'?{last_success_at:at}:{}),detail:{source:'MLB Stats API / Baseball Savant',...detail}}]);if(!(r.status>=200&&r.status<300))throw Error('MiLB health write failed');}
`;
 return header+code;
}
module.exports={dailyHealth,patchMilb};
