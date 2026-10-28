'use strict';
// Patch live exports instead of rebuilding credentials, schedules or destinations.
const fs=require('fs'),path=require('path');
const CHANGED=['context','pipeline','research','context_research','pregame_review'];
const ADDED=['overtime_context','overtime_context_research','player_workload','role_model'];
function upgrade(workflow,task){
 if(!['analysis','research','context'].includes(task))throw Error('UNSUPPORTED_UPGRADE_TASK');
 const out=JSON.parse(JSON.stringify(workflow)),run=out.nodes.find(n=>n.id==='run');if(!run?.parameters?.jsCode)throw Error('RUN_NODE_MISSING');
 const old=run.parameters.jsCode,marker='};const __cache={};',end=old.indexOf(marker);if(end<0)throw Error('BUNDLE_FORMAT_CHANGED');
 let bundle=old.slice(0,end),suffix=old.slice(end);
 if(task==='context'){
  // The capture workflow retains its current dispatch, retry and debounce logic.
  const needle="return r.body?.status==='already_running'?r.body:require('./quote_dispatch').requestContextAnalysis(ctx,r.body);";
  if(!bundle.includes(needle))throw Error('CONTEXT_DISPATCH_CHANGED');
  bundle=bundle.replace(needle,"const result=r.body?.status==='already_running'?r.body:await require('./quote_dispatch').requestContextAnalysis(ctx,r.body);return {...result,model_version:'bk-player-context-4'};");
 }else{
  const matches=[...bundle.matchAll(/"([a-z_0-9]+)":function\(module,exports,require\)\{\n/g)],modules=new Map();
  for(let i=0;i<matches.length;i++){const m=matches[i],e=i+1<matches.length?matches[i+1].index-2:bundle.length-1;modules.set(m[1],bundle.slice(m.index+m[0].length,e).replace(/\n\}$/,''));}
  for(const name of [...CHANGED,...ADDED]){
   if(name==='pregame_review'&&!modules.has(name)&&task!=='analysis')continue;
   modules.set(name,fs.readFileSync(path.join(__dirname,name+'.js'),'utf8'));
  }
  bundle='const __modules={'+[...modules].map(([name,code])=>JSON.stringify(name)+':function(module,exports,require){\n'+code+'\n}').join(',');
 }
 run.parameters.jsCode=bundle+suffix;
 if(old.slice(end)!==run.parameters.jsCode.slice(run.parameters.jsCode.indexOf(marker)))throw Error('RUNTIME_CONFIGURATION_CHANGED');
 return out;
}
module.exports={upgrade,CHANGED,ADDED};
