'use strict';
// Research only. No write path to production model parameters or betting stakes.
const avg=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
const clip=p=>Math.max(.001,Math.min(.999,p));
const logit=p=>Math.log(clip(p)/(1-clip(p)));
const sigmoid=x=>1/(1+Math.exp(-Math.max(-30,Math.min(30,x))));
function fitBlend(rows){
 const d=rows.reduce((s,r)=>s+(r.raw-r.market_probability)**2,0);
 return d?Math.max(0,Math.min(1,rows.reduce((s,r)=>s+(r.y-r.market_probability)*(r.raw-r.market_probability),0)/d)):0;
}
function fitLogistic(rows){
 // Market offset + regularized raw-vs-market signal; train rows only.
 const theta=[0,0];
 for(let j=0;j<600;j++){
  const grad=[.04*theta[0],.08*theta[1]];
  for(const r of rows){const x=logit(r.raw)-logit(r.market_probability),e=sigmoid(logit(r.market_probability)+theta[0]+theta[1]*x)-r.y;
   grad[0]+=e/rows.length;grad[1]+=e*x/rows.length;}
  theta[0]-=.1*grad[0];theta[1]-=.1*grad[1];
 }
 return theta;
}
function predict(name,r,params){
 if(name==='market')return r.market_probability;if(name==='raw')return r.raw;if(name==='current')return r.current;
 if(name==='fitted_blend')return r.market_probability+params.blend*(r.raw-r.market_probability);
 return sigmoid(logit(r.market_probability)+params.logistic[0]+params.logistic[1]*(logit(r.raw)-logit(r.market_probability)));
}
function scores(rows,name,params){
 const ps=rows.map(r=>predict(name,r,params));
 return {n:rows.length,brier:avg(rows.map((r,i)=>(ps[i]-r.y)**2)),log_loss:avg(rows.map((r,i)=>-r.y*Math.log(clip(ps[i]))-(1-r.y)*Math.log(1-clip(ps[i])))),
  predicted:avg(ps),observed:avg(rows.map(r=>r.y))};
}
function ci(rows,name,params){
 if(rows.length<2)return null;
 const grouped=new Map();for(const r of rows){const key=r.game_id;const d=(predict(name,r,params)-r.y)**2-(r.market_probability-r.y)**2;grouped.set(key,[...(grouped.get(key)||[]),d]);}
 const groups=[...grouped.values()];let seed=23102026;const rng=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296;};const samples=[];
 for(let j=0;j<1000;j++){let sum=0,n=0;for(let i=0;i<groups.length;i++){const g=groups[Math.floor(rng()*groups.length)];sum+=g.reduce((a,b)=>a+b,0);n+=g.length;}samples.push(sum/n);}
 samples.sort((a,b)=>a-b);return [samples[25],samples[974]];
}
function evaluateModels(input,{prospective=false}={}){
 const grouped=new Map();
 for(const r of input){
  if(![r.raw,r.current,r.market_probability].every(x=>typeof x==='number'&&x>0&&x<1)||![0,1].includes(r.y))continue;
  const k=[r.league,r.pipeline,r.market,r.model_version||'legacy_unknown'].join('|');grouped.set(k,[...(grouped.get(k)||[]),r]);
 }
 const report=[];
 for(const [group,all] of grouped){
  // One earliest canonical market/line per game; no game crosses partitions.
  all.sort((a,b)=>a.prediction_at.localeCompare(b.prediction_at));const unique=new Map();for(const r of all)if(!unique.has(r.game_id))unique.set(r.game_id,r);
  const rows=[...unique.values()].sort((a,b)=>a.game_start.localeCompare(b.game_start)||a.game_id-b.game_id);
  const dates=[...new Set(rows.map(r=>r.game_start.slice(0,10)))].sort();
  // Historical dates were already inspected: explicitly exploratory, not a fresh final test.
  // Prospective protocol fixes training/validation/test sizes in advance (400/150/200).
  let train,validation,test;
  if(prospective){
   const boundary=n=>rows[n]?.game_start.slice(0,10)||'9999';const a=boundary(400),b=boundary(550),c=boundary(750);
   train=rows.filter(r=>r.game_start.slice(0,10)<a);validation=rows.filter(r=>r.game_start.slice(0,10)>=a&&r.game_start.slice(0,10)<b);test=rows.filter(r=>r.game_start.slice(0,10)>=b&&r.game_start.slice(0,10)<c);
  }else{
   const a=dates[Math.floor(dates.length*.6)]||'9999',b=dates[Math.floor(dates.length*.8)]||'9999';
   train=rows.filter(r=>r.game_start.slice(0,10)<a);validation=rows.filter(r=>r.game_start.slice(0,10)>=a&&r.game_start.slice(0,10)<b);test=rows.filter(r=>r.game_start.slice(0,10)>=b);
  }
  const info={group,eligible_games:rows.length,cohorts:{published_pair:rows.filter(r=>r.published).length,unpublished_pair:rows.filter(r=>!r.published).length},train:train.length,validation:validation.length,test:test.length,
   policy:'SHADOW_NO_AUTO_PROMOTION',evidence:prospective?'prospective_sealed_predictions':'historical_exploratory_not_fresh_holdout'};
  if(train.length<30||validation.length<15||test.length<15){report.push({...info,status:'insufficient_data'});continue;}
  const params={blend:fitBlend(train),logistic:fitLogistic(train)};
  const names=['market','current','raw','fitted_blend','logistic'];
  const val=names.map(name=>({name,...scores(validation,name,params)}));val.sort((a,b)=>a.brier-b.brier);
  const selected=val[0].name;const span=(Date.parse(test.at(-1).game_start)-Date.parse(rows[0].game_start))/86400000;
  report.push({...info,status:prospective&&test.length>=200&&span>=60?'ready_for_review':'exploratory_small_or_incomplete_test',params,selected_on_validation:selected,
   validation_scores:val,test_scores:names.map(name=>({name,...scores(test,name,params)})),ci95_selected_minus_market:ci(test,selected,params),
   test_cohorts:{published:scores(test.filter(r=>r.published),selected,params),unpublished:scores(test.filter(r=>!r.published),selected,params)},
   test_start:test[0].game_start,test_end:test.at(-1).game_start});
 }
 return {protocol:'all-candidates-v1',at:new Date().toISOString(),prospective,groups:report};
}
module.exports={evaluateModels,fitBlend,fitLogistic,predict};
