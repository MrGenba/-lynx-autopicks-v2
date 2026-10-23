'use strict';
const fs=require('node:fs'),path=require('node:path');
function collector(mode,settings){
 const files=mode==='calendar'?['npb2_calendar']:['npb2_stats','npb2_runner'];
 const bundle=`const factories={${files.map(name=>JSON.stringify('./'+name)+':function(module,exports,require){\n'+fs.readFileSync(path.join(__dirname,name+'.js'),'utf8')+'\n}').join(',')}};const loaded={};function localRequire(k){if(!loaded[k]){const m={exports:{}};loaded[k]=m;factories[k](m,m.exports,localRequire);}return loaded[k].exports;}\n`;
 return bundle+`const settings=${JSON.stringify(settings)};
async function rest(p,method='GET',body){return helpers.httpRequest({url:settings.url+'/rest/v1/'+p,method,headers:{apikey:settings.key,Authorization:'Bearer '+settings.key,'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=minimal'},json:true,timeout:30000,...(body===undefined?{}:{body})});}
async function http(url){const r=await helpers.httpRequest({url,method:'GET',json:false,returnFullResponse:true,ignoreHttpStatusErrors:true,timeout:25000});return {status:r.statusCode,body:r.body};}
const state=$getWorkflowStaticData('global');
try{const result=await localRequire(${JSON.stringify(mode==='calendar'?'./npb2_calendar':'./npb2_runner')}).${mode==='calendar'?'run':'runStats'}({http,rest,fullSeason:new Date().getUTCDay()===0&&new Date().getUTCHours()===0});state.failure_notified=false;return [{json:result}];}
catch(_){try{await rest('bb_capture_health?on_conflict=league,component','POST',{league:'NPB2',component:${JSON.stringify(mode)},checked_at:new Date().toISOString(),status:'error',detail:{code:'CAPTURE_FAILED'}});}catch(_){}
 if(!state.failure_notified){await helpers.httpRequest({url:'https://api.telegram.org/bot'+settings.bot+'/sendMessage',method:'POST',json:true,body:{chat_id:settings.chat,text:'⚠️ NPB2: fallo de captura ${mode}. Se conserva la última versión y se bloquea el uso de datos sin verificar.'},timeout:15000});state.failure_notified=true;}throw Error('NPB2_CAPTURE_FAILED');}`;
}
function lookup(settings){return 'const settings='+JSON.stringify(settings)+';\n'+fs.readFileSync(path.join(__dirname,'npb2_lookup_runtime.js'),'utf8');}
module.exports={collector,lookup};
