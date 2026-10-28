'use strict';
// Preserve the failed service and operation without recording URLs or credentials.
function scope(url,options,config){
 const method=String(options.method||'GET').toUpperCase(),read=method==='GET'||method==='HEAD';
 const rest=(config.restUrl||config.supabaseUrl&&config.supabaseUrl+'/rest/v1'||'').replace(/\/$/,'');
 const worker=(config.server?.url||'').replace(/\/$/,'');
 if(rest&&url.startsWith(rest+'/'))return {name:read?'DATABASE_READ':'DATABASE_WRITE',retry:read};
 if(worker&&url.startsWith(worker+'/')){
  const path=url.slice(worker.length).split('?')[0];
  if(/\/start$/.test(path))return {name:'WORKER_START',retry:false};
  if(path.includes('/status/'))return {name:'WORKER_STATUS',retry:read};
  return {name:'WORKER_REQUEST',retry:read&&['/healthz','/version'].includes(path)};
 }
 const workflow=(config.workflowUrl||'https://n8n-n8n.0zhp4h.easypanel.host').replace(/\/$/,'');
 if(url.startsWith(workflow+'/webhook/'))return {name:'WORKFLOW_TRIGGER',retry:false};
 if(url.startsWith('https://api.telegram.org/'))return {name:'TELEGRAM_REQUEST',retry:false};
 return {name:'HTTP_REQUEST',retry:false};
}
function reason(error){
 const chain=[error,error?.cause,error?.cause?.cause];
 const codes=chain.map(e=>String(e?.code||'').toUpperCase());
 const names=chain.map(e=>String(e?.name||''));
 if(codes.some(c=>['ETIMEDOUT','ESOCKETTIMEDOUT','ECONNABORTED','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes(c))||names.some(n=>['TimeoutError','AbortError'].includes(n))||chain.some(e=>/timed?\s*out|timeout/i.test(String(e?.message||''))))return 'TIMEOUT';
 if(codes.some(c=>['ENOTFOUND','EAI_AGAIN'].includes(c)))return 'DNS_FAILED';
 if(codes.includes('ECONNREFUSED'))return 'CONNECTION_REFUSED';
 if(codes.some(c=>['ECONNRESET','EPIPE','UND_ERR_SOCKET'].includes(c)))return 'CONNECTION_RESET';
 if(codes.some(c=>/CERT|TLS|SSL/.test(c)))return 'TLS_FAILED';
 if(names.includes('SyntaxError'))return 'INVALID_RESPONSE';
 return 'NETWORK_FAILED';
}
function create(httpRequest,config,{wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 return async(url,options={})=>{
  const target=scope(url,options,config),request={url,method:options.method||'GET',headers:options.headers||{},json:true,timeout:options.timeout||30000,returnFullResponse:true,ignoreHttpStatusErrors:true};
  if(options.body!==undefined){try{request.body=typeof options.body==='string'?JSON.parse(options.body):options.body;}catch(_){throw Error(target.name+'_INVALID_BODY');}}
  for(let attempt=0;attempt<2;attempt++){
   try{const r=await httpRequest(request);return {status:r.statusCode,headers:r.headers,body:r.body,json:async()=>r.body};}
   catch(e){const code=reason(e);
    // A lost response to start/POST may already have committed the work.
    // Only retry confirmed read operations, once, for transient transport errors.
    if(attempt===0&&target.retry&&['TIMEOUT','DNS_FAILED','CONNECTION_REFUSED','CONNECTION_RESET','NETWORK_FAILED'].includes(code)){await wait(750);continue;}
    throw Error(target.name+'_'+code);
   }
  }
 };
}
module.exports={scope,reason,create};

