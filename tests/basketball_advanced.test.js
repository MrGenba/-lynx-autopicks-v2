'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {runAdvanced}=require('../basketball/advanced');
test('advanced job completion is recorded without restarting before next hour',async()=>{
 const writes=[];let starts=0;
 const now=new Date('2026-10-23T15:16:00Z');
 const ctx={now,server:{url:'https://server.example',token:'test'},rest:async(p,m,b)=>{if(!m)return [{status:'running',detail:{job_id:'one',started_at:'2026-10-23T15:11:00Z'}}];writes.push(b);},http:async(url)=>{if(url.endsWith('/start'))starts++;return {status:200,body:{status:'done',result:{reports:[]}}};}};
 assert.equal((await runAdvanced(ctx)).status,'NOT_DUE');assert.equal(starts,0);assert.equal(writes[0].status,'done');
});
test('new hour starts an authenticated advanced collection',async()=>{
 let request;
 const ctx={now:new Date('2026-10-23T16:11:00Z'),server:{url:'https://server.example',token:'test'},rest:async(p,m)=>m?null:[],http:async(url,options)=>{request={url,options};return {status:200,body:{job_id:'next'}};}};
 assert.equal((await runAdvanced(ctx)).status,'STARTED');assert.equal(request.options.method,'POST');assert.equal(request.options.headers.Authorization,'Bearer test');
});
