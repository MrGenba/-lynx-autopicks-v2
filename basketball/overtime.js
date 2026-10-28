'use strict';
const POLICY='bk-overtime-mixture-1';
const num=Number.isFinite,clone=x=>JSON.parse(JSON.stringify(x));
const regulation=g=>g.league==='WNBA'?40:48;
const periods=g=>Number.isInteger(g.periods)&&g.periods>=4&&g.periods<=20?g.periods-4:null;
function eligible(g,h,now){
 const seen=new Set();return (h?.games||[]).filter(x=>x.league===g.league&&x.status==='final'&&x.box_complete&&x.season>=g.season-1&&x.season<=g.season&&[2,3].includes(x.season_type)&&periods(x)!==null&&
  Date.parse(x.starts_at)+4*3600000<now.getTime()&&Date.parse(x.starts_at)<Date.parse(g.starts_at)&&!seen.has(x.game_id)&&seen.add(x.game_id));
}
// Empirical league frequencies, shrunk phase and matchup samples. No final
// margin of the target game, bookmaker prices, or inspected test outcomes enter.
function estimate(g,h,now){
 const all=eligible(g,h,now),phase=all.filter(x=>x.season_type===g.season_type);
 if(all.length<100)return {policy:POLICY,status:'INSUFFICIENT_HISTORY',games:all.length,p_any:null};
 const counts=rows=>{const out={};for(const x of rows)out[periods(x)]=(out[periods(x)]||0)+1;return out;};
 const leagueCounts=counts(all),phaseCounts=counts(phase),matchup=new Map();
 for(const id of [g.home_team_id,g.away_team_id])for(const x of phase.filter(x=>[x.home_team_id,x.away_team_id].includes(id)).sort((a,b)=>Date.parse(a.starts_at)-Date.parse(b.starts_at)).slice(-20))matchup.set(x.game_id,x);
 const localCounts=counts([...matchup.values()]),weights=Object.keys(leagueCounts).map(Number).sort((a,b)=>a-b).map(k=>{
  const prior=leagueCounts[k]/all.length,phaseRate=((phaseCounts[k]||0)+100*prior)/(phase.length+100);
  return {periods:k,weight:((localCounts[k]||0)+100*phaseRate)/(matchup.size+100)};
 });
 const expected=weights.reduce((s,x)=>s+x.periods*x.weight,0);
 return {policy:POLICY,status:'APPLIED',games:all.length,phase_games:phase.length,matchup_games:matchup.size,phase:g.season_type,
  p_any:weights.filter(x=>x.periods>0).reduce((s,x)=>s+x.weight,0),expected_periods:expected,expected_extra_minutes:5*expected,weights,
  league_overtime_games:all.filter(x=>periods(x)>0).length,prior_strength:100,method:'LEAGUE_PHASE_TEAM_FREQUENCIES',calibration:'EXPERIMENTAL_NOT_CALIBRATED'};
}
// An exposure equivalent is not the player's actual regulation-only boxscore.
// Scaling counts AND minutes keeps observed per-minute rates intact. The old
// generation continues to consume its original history unchanged.
function normalizeHistory(g,h,now){
 const games=eligible(g,h,now),map=new Map(),length=regulation(g);
 for(const old of games){const k=periods(old),scale=length/(length+5*k),x={...old,periods:4,overtime_source_periods:old.periods,overtime_exposure_scale:scale};
  if(k&&num(old.home_score)&&num(old.away_score)){
   const exact=regulationScore(old),total=exact?exact.home+exact.away:(old.home_score+old.away_score)*scale;
   x.home_score=x.away_score=total/2;
  }
  map.set(x.game_id,x);
 }
 const scaleStats=(s,scale)=>s&&Object.fromEntries(Object.entries(s).map(([k,v])=>[k,num(v)?v*scale:v]));
 return {games:[...map.values()],teams:(h?.teams||[]).filter(t=>map.has(t.game_id)).map(t=>{const game=map.get(t.game_id);return {...t,game,stats:scaleStats(t.stats,game.overtime_exposure_scale)};}),
  players:(h?.players||[]).filter(p=>map.has(p.game_id)).map(p=>{const game=map.get(p.game_id),scale=game.overtime_exposure_scale;return {...p,game,minutes:p.minutes*scale,stats:scaleStats(p.stats,scale)};})};
}
function moments(rows,get){const mean=rows.reduce((s,r)=>s+r.weight*get(r).mean,0);return {mean,variance:Math.max(0,rows.reduce((s,r)=>{const x=get(r);return s+r.weight*(x.variance+(x.mean-mean)**2);},0))};}
function fullMargin(q,f,base){
 const zero=base({market:'spread',selection:'home',line:0},f),tie=zero.p_push,denom=1-tie;
 if(q.market==='moneyline')return {p_win:(q.selection==='home'?zero.p_win:zero.p_loss)/denom,p_push:0,p_loss:(q.selection==='home'?zero.p_loss:zero.p_win)/denom};
 const p=base(q,f),field=q.line>0?'p_win':q.line<0?'p_loss':'p_push';
 return Object.fromEntries(Object.entries(p).map(([k,v])=>[k,Math.max(0,v-(k===field?tie:0))/denom]));
}
function apply(f,g,estimate){
 const out=clone(f),length=regulation(g);
 if(estimate.status!=='APPLIED'){out.overtime={...estimate,regulation_minutes:length};return out;}
 const reg=f.player_id?{projected_minutes:f.projected_minutes,minutes_sd:f.minutes_sd,props:clone(f.props)}:
  {home_points:f.home_points,away_points:f.away_points,total:f.total,total_variance:f.total_variance,margin:f.margin,margin_variance:f.margin_variance,p_home:f.p_home,p_away:f.p_away};
 const scenarios=estimate.weights.map(({periods:k,weight})=>{
  const extra=5*k,factor=1+extra/length;
  if(f.player_id){
   const cap=num(f.minutes?.staff_cap)?f.minutes.staff_cap:Infinity,minutes=Math.min(cap,f.projected_minutes*factor),a=f.projected_minutes>0?minutes/f.projected_minutes:0;
   const props=Object.fromEntries(Object.entries(f.props).map(([key,s])=>[key,{mean:s.mean*a,variance:s.mean*a+Math.max(0,s.variance-s.mean)*a*a}]));
   return {periods:k,weight,projected_minutes:minutes,minutes_variance:(f.minutes_sd||0)**2*a*a,props};
  }
  // Every earlier OT ended tied. Only the last five-minute period determines
  // the final margin; total points include all periods.
  const total=f.total*factor,totalVariance=f.total_variance*factor*factor,margin=k?f.margin*5/length:f.margin,marginVariance=k?f.margin_variance*5/length:f.margin_variance;
  return {periods:k,weight,total,total_variance:totalVariance,margin,margin_variance:marginVariance};
 });
 out.overtime={...estimate,regulation_minutes:length,regulation:reg,scenarios,
  assumptions:['OT_ROTATION_PROPORTIONAL_TO_REGULATION_MINUTES','SCORING_RATES_CONSTANT_ACROSS_PERIODS','TOTAL_AND_TIE_DEPENDENCE_NOT_FITTED'],history_adjustment:'EXPOSURE_EQUIVALENT_NOT_ACTUAL_REGULATION_SPLIT'};
 if(f.player_id){
  const m=moments(scenarios,s=>({mean:s.projected_minutes,variance:s.minutes_variance}));out.projected_minutes=m.mean;out.minutes_sd=Math.sqrt(m.variance);
  out.props=Object.fromEntries(Object.keys(f.props).map(key=>[key,moments(scenarios,s=>s.props[key])]));
 }else{
  const t=moments(scenarios,s=>({mean:s.total,variance:s.total_variance})),m=moments(scenarios,s=>({mean:s.margin,variance:s.margin_variance}));
  out.total=t.mean;out.total_variance=t.variance;out.margin=m.mean;out.margin_variance=m.variance;out.home_points=(t.mean+m.mean)/2;out.away_points=(t.mean-m.mean)/2;
  const base=require('./model').baseProbability;out.p_home=probability({market:'moneyline',selection:'home',includes_overtime:true},out,base).p_win;out.p_away=1-out.p_home;
 }
 return out;
}
function scope(q){return q.includes_overtime===true?'INCLUDING_OVERTIME':q.detail?.rules_status==='REGULATION_ONLY_VERIFIED'?'REGULATION_ONLY':'ASSUMING_OVERTIME_INCLUDED';}
function probability(q,f,base){
 const ot=f.overtime;
 if(ot?.status!=='APPLIED')return base(q,f);
 const mode=scope(q),scenarios=mode==='REGULATION_ONLY'?[{...ot.regulation,periods:0,weight:1}]:ot.scenarios;
 // Stress checks modify public forecast moments. Apply the same perturbation
 // to every scenario so the mixture cannot silently bypass the adverse test.
 let ratio=1,varRatio=1,marginDelta=0;
 if(q.player_id){const m=moments(ot.scenarios,s=>s.props[q.market]);ratio=m.mean>0?f.props[q.market].mean/m.mean:1;varRatio=m.variance>0?f.props[q.market].variance/m.variance:1;}
 else if(q.market==='total'){const m=moments(ot.scenarios,s=>({mean:s.total,variance:s.total_variance}));ratio=m.mean>0?f.total/m.mean:1;varRatio=m.variance>0?f.total_variance/m.variance:1;}
 else {const m=moments(ot.scenarios,s=>({mean:s.margin,variance:s.margin_variance}));marginDelta=f.margin-m.mean;varRatio=m.variance>0?f.margin_variance/m.variance:1;}
 const result={p_win:0,p_push:0,p_loss:0};
 for(const s of scenarios){let x={...f,...s};
  if(q.player_id){const p=s.props[q.market];x.props={[q.market]:{mean:p.mean*ratio,variance:p.variance*varRatio}};}
  else if(q.market==='total'){x.total=s.total*ratio;x.total_variance=s.total_variance*varRatio;}
  else {x.margin=s.margin+marginDelta*(s.periods?5/ot.regulation_minutes:1);x.margin_variance=s.margin_variance*varRatio;}
  const p=!q.player_id&&['moneyline','spread'].includes(q.market)?mode==='REGULATION_ONLY'?(q.market==='moneyline'?base({market:'spread',selection:q.selection,line:0},x):base(q,x)):fullMargin(q,x,base):base(q,x);
  for(const key of Object.keys(result))result[key]+=s.weight*p[key];
 }
 return result;
}
function regulationScore(g){
 if(periods(g)===0&&[g.home_score,g.away_score].every(num))return {home:g.home_score,away:g.away_score,source:'FINAL_NO_OVERTIME'};
 const p=g.receipt?.period_scores;if(!p||![p.home,p.away].every(a=>Array.isArray(a)&&a.length===g.periods&&a.every(x=>Number.isInteger(x)&&x>=0)))return null;
 const sum=a=>a.reduce((s,x)=>s+x,0);
 if(sum(p.home)!==g.home_score||sum(p.away)!==g.away_score)return null;
 const home=sum(p.home.slice(0,4)),away=sum(p.away.slice(0,4));return home===away?{home,away,source:'VERIFIED_PERIOD_SCORES'}:null;
}
function diagnostic(g){const k=periods(g),reg=regulationScore(g);return {periods:k,regulation_minutes:regulation(g),actual_duration:k===null?null:regulation(g)+5*k,regulation_score:reg,
  overtime_points:reg?g.home_score+g.away_score-reg.home-reg.away:null,player_regulation_split:'UNAVAILABLE_UNLESS_PERIOD_STATS_CAPTURED'};}
function notice(f){const o=f?.overtime;if(!o)return null;return o.status==='APPLIED'?'⏱ Prórroga estimada: '+(100*o.p_any).toFixed(1)+'% · medias y probabilidades incluyen escenarios de prórroga.':'⏱ Prórroga: historial insuficiente para estimar su probabilidad.';}
module.exports={POLICY,regulation,periods,estimate,normalizeHistory,moments,apply,scope,probability,regulationScore,diagnostic,notice};

