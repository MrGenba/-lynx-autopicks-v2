'use strict';
const fs=require('node:fs'),path=require('node:path');
function code(settings){
 const files=['kbo','npb','cpbl','asian_lineups','asian_lineups_runner'];
 const bundle=`const factories={${files.map(f=>JSON.stringify('./'+f)+':function(module,exports,require){\n'+fs.readFileSync(path.join(__dirname,f+'.js'),'utf8')+'\n}').join(',')}};const loaded={};function localRequire(k){if(!loaded[k]){const m={exports:{}};loaded[k]=m;factories[k](m,m.exports,localRequire);}return loaded[k].exports;}\n`;
 return bundle+`const settings=${JSON.stringify(settings)};
async function rest(p,method='GET',body,opts={}){return helpers.httpRequest({url:settings.url.replace(/\\/$/,'')+'/rest/v1/'+p,method,headers:{apikey:settings.key,Authorization:'Bearer '+settings.key,'Content-Type':'application/json',...(opts.prefer?{Prefer:opts.prefer}:{})},json:true,timeout:30000,...(body===undefined?{}:{body})});}
async function http(url,o){const r=await helpers.httpRequest({url,method:o.method,headers:o.headers,...(o.body===undefined?{}:{body:o.body}),json:false,returnFullResponse:true,ignoreHttpStatusErrors:true,timeout:o.timeout});return {status:r.statusCode,body:r.body};}
async function send(text){return helpers.httpRequest({url:'https://api.telegram.org/bot'+settings.bot+'/sendMessage',method:'POST',json:true,body:{chat_id:settings.chat,text,link_preview_options:{is_disabled:true}},timeout:15000});}
const report=await localRequire('./asian_lineups_runner').runAsianLineups({rest,http,send,owner:String($execution.id)});
const state=$getWorkflowStaticData('global'),fingerprint=JSON.stringify(report.errors),last=state.asian_lineup_error;
if(report.errors.length&&(!last||last.fingerprint!==fingerprint||Date.now()-last.at>6*3600000)){
 const reply=await send('⚠️ Avisos de lineups asiáticos: '+report.errors.map(e=>e.league+' '+e.code).slice(0,5).join('; ')+'. Se reintentará en el próximo sondeo.');
 if(reply?.ok===true&&Number.isInteger(reply.result?.message_id))state.asian_lineup_error={fingerprint,at:Date.now()};
}else if(!report.errors.length)delete state.asian_lineup_error;
return [{json:report}];`;
}
module.exports={code};
