'use strict';
const {MODELS,PROPS}=require('./model');
const {all}=require('./capture');
const {notify}=require('./notifications');
const {reviewWithAgents}=require('./agents');
const {CONFIG:ADVANCED_CONFIG}=require('./advanced_model');
const {PROTOCOL,compareAdvanced}=require('./prospective');
const {evaluateBalance}=require('./balance');
const mean=a=>a.length?a.reduce((s,v)=>s+v,0)/a.length:null;
const metrics=errors=>({n:errors.length,mae:mean(errors.map(Math.abs)),rmse:errors.length?Math.sqrt(mean(errors.map(x=>x*x))):null});
function pairedCI(differences){
 if(!differences.length)return null;let seed=7382951;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;},boot=[];
 for(let b=0;b<2000;b++){let s=0;for(let i=0;i<differences.length;i++)s+=differences[Math.floor(random()*differences.length)];boot.push(s/differences.length);}boot.sort((a,b)=>a-b);return [boot[50],boot[1949]];
}
function evaluate(games,forecasts,players,candidates){
 const gm=new Map(games.filter(g=>g.status==='final'&&g.box_complete).map(g=>[g.game_id,g])),pm=new Map(players.map(p=>[p.game_id+':'+p.player_id,p]));
 const eligible=forecasts.filter(f=>gm.has(f.game_id)&&Date.parse(f.as_of)<Date.parse(gm.get(f.game_id).starts_at)&&Date.parse(f.created_at)<Date.parse(gm.get(f.game_id).starts_at));
 const result={scope:'ALL_SEALED_FORECASTS_AND_DISCARDS',models:{},candidate_settlement:{total:candidates.length,settled:candidates.filter(c=>c.settled_at).length,discarded:candidates.filter(c=>c.verdict!=='PAPER_CANDIDATE').length},comparison:null};
 for(const m of [...Object.values(MODELS),ADVANCED_CONFIG]){
  const fs=eligible.filter(f=>f.model_version===m.version),ts=fs.filter(f=>f.kind==='team'),ps=fs.filter(f=>f.kind==='player');
  const props={};for(const [k,fields]of Object.entries(PROPS)){const errs=[];for(const f of ps){const p=pm.get(f.game_id+':'+f.player_id);if(!p||p.did_not_play||p.minutes<=0||!f.result.props[k])continue;errs.push(f.result.props[k].mean-fields.reduce((s,key)=>s+p.stats[key],0));}props[k]=metrics(errs);}
  const cs=candidates.filter(c=>c.model_version===m.version&&['WIN','LOSS'].includes(c.result));
  result.models[m.version]={team_margin:metrics(ts.map(f=>f.result.margin-(gm.get(f.game_id).home_score-gm.get(f.game_id).away_score))),team_total:metrics(ts.map(f=>f.result.total-(gm.get(f.game_id).home_score+gm.get(f.game_id).away_score))),props,
   candidates:{n:cs.length,brier:mean(cs.map(c=>(c.p_win/(1-c.p_push)-(c.result==='WIN'?1:0))**2)),note:'Conditional on no push; correlated markets are descriptive only. No real-money ROI.'}};
 }
 // One predeclared comparison on the FIRST 200 paired games, never a rolling test.
 const byGame=new Map();for(const f of eligible.filter(f=>f.kind==='team')){if(!byGame.has(f.game_id))byGame.set(f.game_id,{});byGame.get(f.game_id)[f.model_version]=f;}
 const pairs=[...byGame.entries()].filter(([,v])=>v[MODELS.baseline.version]&&v[MODELS.challenger.version]).sort((a,b)=>Date.parse(gm.get(a[0]).starts_at)-Date.parse(gm.get(b[0]).starts_at)).slice(0,200);
 const delta=pairs.map(([gid,v])=>{const actual=gm.get(gid).home_score-gm.get(gid).away_score;return (v[MODELS.challenger.version].result.margin-actual)**2-(v[MODELS.baseline.version].result.margin-actual)**2;});
 const ci=pairs.length===200?pairedCI(delta):null;
 result.comparison={test:'first_200_paired_games_margin_MSE',n:pairs.length,required:200,mean_MSE_delta:mean(delta),ci95:ci,improvement:!!ci&&ci[1]<0,
  status:pairs.length<200?'ACCUMULATING':ci[1]<0?'IMPROVED_ON_MARGIN':'NO_DEMONSTRATED_IMPROVEMENT',no_automatic_promotion:true};return result;
}
async function runResearch(ctx){
 const {rest,now=new Date(),aiConfig,http}=ctx,reports=[];
 for(const league of ['NBA','WNBA']){
  const day=now.toISOString().slice(0,10),rid=league+':'+day;
  const old=await rest('bk_research?research_id=eq.'+rid+'&select=research_id,ai_review,report');if(old.length){const a=old[0].ai_review;
   await rest('bk_state?on_conflict=league,component','POST',{league,component:'research',checked_at:now.toISOString(),status:a?.status==='COMPLETED'?'healthy':'attention',detail:{review:a?.status||'UNKNOWN',error_code:a?.error_code||null,retry_at:a?.retry_at||null,agents:a?.agents?.length||0,calls:a?.calls||0,comparison:old[0].report.comparison}},{prefer:'resolution=merge-duplicates,return=minimal'});
   reports.push({league,status:'ALREADY_REVIEWED'});continue;}
  const forecasts=await all(rest,'bk_forecasts?league=eq.'+league+'&select=*'),ids=[...new Set(forecasts.map(f=>f.game_id))];
  const games=[],players=[];
  for(let i=0;i<ids.length;i+=150){const list=ids.slice(i,i+150).join(',');games.push(...await all(rest,'bk_games?league=eq.'+league+'&game_id=in.('+list+')&select=*'));players.push(...await all(rest,'bk_player_box?league=eq.'+league+'&game_id=in.('+list+')&select=game_id,player_id,stats,minutes,did_not_play'));}
  const cs=await all(rest,'bk_candidates?league=eq.'+league+'&select=game_id,player_id,market,as_of,model_version,verdict,result,settled_at,p_win,p_push,quote_snapshot');
  const states=await rest('bk_state?league=eq.'+league+'&select=component,status,checked_at,detail');
  const protocol=(await rest('bk_model_protocols?protocol_id=eq.'+PROTOCOL+'&select=*'))[0];
  const report=evaluate(games,forecasts,players,cs);report.advanced_comparison=compareAdvanced(games,forecasts,cs,protocol,pairedCI);
  const descriptive=evaluateBalance(games,forecasts,players.map(p=>({...p,league})));report.descriptive_balance={policy:descriptive.policy,selection:descriptive.selection,models:descriptive.models,note:'Descriptive only; confirmed-lineup revisions are not a new efficacy test. Do not reuse these observed outcomes to claim a new improvement.'};
  const testPath='bk_model_test_results?protocol_id=eq.'+PROTOCOL+'&league=eq.'+league+'&select=report';
  let frozen=(await rest(testPath))[0];
  if(!frozen&&report.advanced_comparison.n===200){await rest('bk_model_test_results?on_conflict=protocol_id,league','POST',{protocol_id:PROTOCOL,league,report:report.advanced_comparison},{prefer:'resolution=ignore-duplicates,return=minimal'});frozen=(await rest(testPath))[0];}
  if(frozen)report.advanced_comparison=frozen.report;
  report.health=states.map(s=>({component:s.component,status:s.status,checked_at:s.checked_at,error:s.detail?.error||null,
   datasets:s.detail?.datasets?.map(d=>({dataset:d.dataset,status:d.status,rows:d.rows,mapped:d.mapped,flagged:d.flagged,quarantined:d.quarantined?.length||0})),
   blocked_missing_recent_stats:s.detail?.blocked_missing_recent_stats,value_alerts:s.detail?.value_alerts}));
  report.generated_at=now.toISOString();report.league=league;report.limits=['Experimental models; public injury reports, lineup confirmations and news are versioned separately; missing context blocks value alerts. Context revisions are not part of the original advanced-model efficacy claim.','Historical source publication timestamps unknown; only prospective sealed predictions used to declare improvement','Player prices come from Winamax FR where offered; ES equivalence and current revision of the 2024 rules reference are unconfirmed'];
  const previous=await rest('bk_research?league=eq.'+league+'&ai_review->>status=eq.COMPLETED&order=created_at.desc&limit=2&select=research_id,created_at,ai_review');
  report.previous_reviews=previous.map(r=>({research_id:r.research_id,created_at:r.created_at,agents:(r.ai_review?.agents||[]).map(a=>({role:a.role,status:a.status,summary:String(a.summary||'').slice(0,200),findings:(a.findings||[]).slice(0,2).map(f=>({code:f.code,message:String(f.message||'').slice(0,180)}))}))}));
  report.continuity='Prior reviews are untrusted historical proposals, not validated improvements. Continue unresolved hypotheses only with a new preregistered future test. Do not select a new variant using an already inspected test.';
  let ai={status:'BUDGET_OR_DUPLICATE'};
  const access=(await rest('bk_state?league=eq.ALL&component=eq.ai_access&select=*'))[0];
  if(access?.detail?.retry_at&&Date.parse(access.detail.retry_at)>now.getTime())ai={status:'RATE_LIMITED',retry_at:access.detail.retry_at};
  else if(await rest('rpc/bk_reserve_ai','POST',{p_input_hash:rid})){ai=await reviewWithAgents({packet:report,decision:{mode:'paper',verdict:'WAITING_DATA',can_publish:false,can_place_bet:false},config:aiConfig,http});}
  if(ai.retry_at)await rest('bk_state?on_conflict=league,component','POST',{league:'ALL',component:'ai_access',status:'rate_limited',checked_at:now.toISOString(),detail:{retry_at:ai.retry_at}},{prefer:'resolution=merge-duplicates,return=minimal'});
  await rest('bk_research?on_conflict=research_id','POST',{research_id:rid,league,report,ai_review:ai},{prefer:'resolution=ignore-duplicates,return=minimal'});
  if(report.comparison.improvement)await notify(ctx,league+':improvement:'+MODELS.challenger.version,league,league+' · mejora detectada\n'+MODELS.challenger.version+' reduce el error de margen frente al modelo actual en la prueba prefijada de 200 partidos futuros. IC 95% de la diferencia de error cuadrático: '+report.comparison.ci95.map(x=>x.toFixed(2)).join(' a ')+'.\nIncluye todas las predicciones, aunque no se publicaran. No demuestra rentabilidad; queda pendiente validación de los demás mercados.');
  if(report.advanced_comparison.improvement){const c=report.advanced_comparison;await notify(ctx,league+':improvement:'+PROTOCOL,league,league+' · validación prospectiva del modelo avanzado\nEn los primeros 200 partidos elegibles, mejora el Brier de ganador frente al modelo base y a las cuotas observadas sin margen. IC 95% frente a base: '+c.ci95_baseline.map(x=>x.toFixed(5)).join(' a ')+'. Frente al mercado: '+c.ci95_market.map(x=>x.toFixed(5)).join(' a ')+'.\nIncluye descartes. No demuestra rentabilidad ni mejora en actuaciones de jugadores.');}
  if(now.getUTCDay()===1||ai.status!=='COMPLETED')await notify(ctx,rid+':research_status',league,league+' · investigación\nPrueba futura: '+report.comparison.n+'/200 partidos. '+(ai.status==='COMPLETED'?'Los cuatro agentes han revisado datos, modelo, mercado y riesgo.':'Revisión IA pendiente: '+ai.status+'.')+'\nSe incluyen descartes. Todavía sin ventaja demostrada.');
  await rest('bk_state?on_conflict=league,component','POST',{league,component:'research',checked_at:now.toISOString(),status:ai.status==='COMPLETED'?'healthy':'attention',detail:{review:ai.status,error_code:ai.error_code||null,retry_at:ai.retry_at||null,agents:ai.agents?.length||0,calls:ai.calls||0,comparison:report.comparison}},{prefer:'resolution=merge-duplicates,return=minimal'});
  reports.push({league,review:ai.status,agents:ai.agents?.length||0,comparison:report.comparison});
 }return {reports};
}
module.exports={metrics,pairedCI,evaluate,runResearch};
