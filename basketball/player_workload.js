'use strict';
// Fixed prospective coefficients; no allocation of a missing teammate's minutes.
const old=require('./minutes_model'),{weighted,PROPS}=require('./model'),{resolve}=require('./role_model');
const POLICY='bk-player-workload-4',MIN=5,clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const unavailable=s=>['OUT','INACTIVE','SUSPENDED'].includes(s),num=Number.isFinite;
function explicitExit(r){
 const e=r.injury_exit;
 return e?.policy==='bk-explicit-injury-exit-1'&&e.status==='EXITED_INJURY_NO_RETURN'&&e.player_id===r.player_id&&e.game_id===r.game_id&&/^https:\/\/www\.rotowire\.com\/(basketball|wnba)\//.test(e.source_url||'')&&num(Date.parse(e.published_at));
}
function historyForModel(h,now=new Date()){return {...h,players:h.players.filter(r=>!(explicitExit(r)&&Date.parse(r.injury_exit.observed_at)<=now.getTime()&&Date.parse(r.injury_exit.published_at)<=now.getTime()))};}
function observed(f,g,h,now){return old.played(f,g,h,now).filter(r=>typeof r.starter==='boolean').slice(-40);}
function presence(pid,tid,id,h){
 const game=h.games.find(g=>g.game_id===id);if(!game?.box_complete||![game.home_team_id,game.away_team_id].includes(tid))return null;
 const rows=h.players.filter(r=>r.player_id===pid&&r.team_id===tid),r=rows.find(r=>r.game_id===id);
 if(r)return r.did_not_play===true?false:r.minutes>0?true:null;
 // A complete box alone cannot distinguish an absence from a different roster.
 const before=rows.some(r=>Date.parse(r.game.starts_at)<Date.parse(game.starts_at)),after=rows.some(r=>Date.parse(r.game.starts_at)>Date.parse(game.starts_at));
 return before&&after?false:null;
}
function rotation(f,g,h,body,originals,now){
 const candidates=new Map(originals.filter(o=>o.player_id&&o.team_id===f.team_id).map(o=>[o.player_id,o]));
 for(const p of Object.values(body.players||{}))if(p.team_id===f.team_id&&!candidates.has(p.player_id))candidates.set(p.player_id,{player_id:p.player_id,team_id:p.team_id});
 const impacted=[];
 for(const o of candidates.values()){
  if(o.player_id===f.player_id)continue;
  const p=body.players?.[o.player_id]||{},rows=observed(o,g,h,now),recent=rows.slice(-10);
  const minutes=recent.length?weighted(recent,r=>old.regulationMinutes?old.regulationMinutes(r,g):r.minutes,.94).mean:o.projected_minutes;
  if(!(minutes>=10)&&!(o.projected_minutes>=10))continue;
  const state=old.returnState(o,g,h,now),signals=old.evidence(p,g),returning=state.status!=='NORMAL'||signals.some(e=>e.returning),absent=unavailable(p.availability),uncertain=['QUESTIONABLE','DOUBTFUL','CONFLICT','UNVERIFIED'].includes(p.availability)||p.news_unresolved;
  if(absent||returning||uncertain)impacted.push({player_id:o.player_id,absent,returning,uncertain:!!uncertain,baseline_minutes:minutes,return_status:state.status});
 }
 return impacted;
}
function pace(r,h,g){const ts=h.teams.filter(t=>t.game_id===r.game_id);if(ts.length!==2)return null;const a=ts.map(t=>t.stats).map(s=>s.fga-s.orb+(s.total_turnovers??s.turnovers)+.44*s.fta);return a.every(x=>num(x)&&x>0)?(a[0]+a[1])/2*(g.league==='NBA'?48:40)/((g.league==='NBA'?48:40)+5*Math.max(0,(r.game.periods||4)-4)):null;}
function rate(rows,field,h,g){
 if(!rows.every(r=>num(r.stats?.[field])&&r.stats[field]>=0&&r.minutes>0&&pace(r,h,g)>0))return null;
 return weighted(rows,r=>r.stats[field]/r.minutes/pace(r,h,g),.94).mean;
}
function production(matched,control,h,g){
 const fields=['fga','fg3a','fta','points','rebounds','assists','fg3m'],rates={},factors={},weight=Math.min(matched.length,control.length)/(Math.min(matched.length,control.length)+12);
 for(const k of fields){const a=rate(matched,k,h,g),b=rate(control,k,h,g);rates[k]={matched:a,reference:b};if(a!==null&&b>0)factors[k]=clamp(1+weight*(a/b-1),.85,1.15);}
 // Points follow shot opportunities at pooled conversion, not a hot shooting run.
 const all=[...matched,...control],sum=k=>all.reduce((s,r)=>s+(r.stats?.[k]||0),0);
 const twoA=sum('fga')-sum('fg3a'),threeA=sum('fg3a'),ftA=sum('fta');
 let pointsFactor=null;
 if(all.every(r=>['fgm','fg3m','ftm'].every(k=>num(r.stats?.[k])))&&twoA>0&&threeA>0&&ftA>0&&['fga','fg3a','fta'].every(k=>rates[k].reference!==null&&rates[k].matched!==null)){
  const p2=(sum('fgm')-sum('fg3m'))/twoA,p3=sum('fg3m')/threeA,pft=sum('ftm')/ftA;
  const score=kind=>2*(rates.fga[kind]-rates.fg3a[kind])*p2+3*rates.fg3a[kind]*p3+rates.fta[kind]*pft;
  if(score('reference')>0)pointsFactor=clamp(1+weight*(score('matched')/score('reference')-1),.85,1.15);
 }
 return {status:'APPLIED',method:'PACE_NORMALIZED_ROLE_AND_ROTATION_COMPARISON',sample:matched.length,reference_sample:control.length,weight,rates,
  opportunity_factors:{fga:factors.fga??null,fg3a:factors.fg3a??null,fta:factors.fta??null},
  factors:{points:pointsFactor??1,threes:factors.fg3a??1,rebounds:factors.rebounds??1,assists:factors.assists??1},
  missing:['points','threes','rebounds','assists'].filter(k=>k==='points'?pointsFactor===null:k==='threes'?factors.fg3a===undefined:factors[k]===undefined),
  interpretation:'Shot attempts; rebound/assist boxscore rates are proxies, not tracking opportunities'};
}
function estimate(f,g,h,body,originals,now){
 const p=body.players?.[f.player_id]||{},role=resolve(g,{...p,player_id:f.player_id},body.teams?.[f.team_id],now),resolved={...body,players:{...body.players,[f.player_id]:{...p,role:role.role}}};
 const clean=historyForModel(h,now),m=old.estimate(f,g,clean,resolved,[],now);m.policy=POLICY;m.role=role.role;m.role_source=role.source;m.role_evidence=role.news;m.blockers.push(...role.reasons);
 m.excluded_explicit_exits=h.players.filter(r=>r.player_id===f.player_id&&explicitExit(r)).map(r=>r.game_id);
 if(unavailable(p.availability))return m;
 const rows=observed(f,g,clean,now),same=rows.filter(r=>r.starter===(role.role==='STARTER')),other=rows.filter(r=>r.starter!==(role.role==='STARTER'));
 m.role_sample=same.length;
 if(same.length>=MIN&&role.role!=='UNKNOWN'&&m.return_status==='NORMAL'){
  const x=weighted(same.slice(-15),r=>r.minutes,.94);m.minutes=x.mean;m.sd=Math.max(2,Math.sqrt(x.variance));m.reasons.push('PROJECTED_ROLE_MINUTES');
 }
 const impacted=rotation(f,g,clean,body,originals,now);m.rotation={players:impacted,sample:0,reference_sample:0};
 if(impacted.some(p=>p.uncertain))m.blockers.push('TEAMMATE_STATUS_UNCERTAIN');
 const matched=same.filter(r=>impacted.every(p=>presence(p.player_id,f.team_id,r.game_id,clean)===!p.absent));
 const control=same.filter(r=>impacted.some(p=>presence(p.player_id,f.team_id,r.game_id,clean)===p.absent)&&impacted.every(p=>presence(p.player_id,f.team_id,r.game_id,clean)!==null));
 m.rotation.sample=matched.length;m.rotation.reference_sample=control.length;
 m.production={status:'UNCHANGED',factors:{points:1,threes:1,rebounds:1,assists:1}};
 if(impacted.length){
  if(matched.length>=MIN&&control.length>=MIN&&!impacted.some(p=>p.uncertain)&&m.return_status==='NORMAL'){
   const x=weighted(matched,r=>r.minutes,.94),w=matched.length/(matched.length+8);m.minutes+=clamp(w*(x.mean-m.minutes),-6,6);m.sd=Math.max(m.sd,Math.sqrt(x.variance));m.reasons.push('COMPARABLE_ROTATION_MINUTES');
   m.production=production(matched,control,clean,g);
  }else m.blockers.push('ROTATION_IMPACT_UNMODELED');
  if(impacted.some(p=>p.returning))m.blockers.push('TEAMMATE_RETURN_WORKLOAD_UNCERTAIN');
 }else if(same.length>=MIN&&other.length>=MIN){m.production=production(same,other,clean,g);m.production.method='PACE_NORMALIZED_ROLE_COMPARISON';}
 const signals=old.evidence(p,g);if(signals.some(e=>e.returning))m.blockers.push('RETURN_MINUTES_UNCERTAIN');
 const cap=m.staff_cap??(g.league==='NBA'?48:40);m.minutes=clamp(m.minutes,0,cap);m.range=[Math.max(0,m.minutes-m.sd),Math.min(cap,m.minutes+m.sd)];m.blockers=[...new Set(m.blockers)];return m;
}
function apply(f,m){
 const out=old.apply(f,m),delta={};
 for(const k of ['points','rebounds','assists','threes']){const s=out.props[k],factor=m.production?.factors?.[k]??1;delta[k]=s.mean*(factor-1);out.props[k]={mean:s.mean*factor,variance:Math.max(s.mean*factor,s.variance*factor*factor)+delta[k]**2};}
 for(const [k,parts]of Object.entries(PROPS))if(parts.length>1){const d=parts.reduce((s,p)=>s+(delta[p]||0),0);out.props[k]={mean:out.props[k].mean+d,variance:Math.max(out.props[k].mean+d,out.props[k].variance)+d*d};}
 out.production=m.production;return out;
}
module.exports={POLICY,MIN,explicitExit,historyForModel,presence,rotation,production,estimate,apply};
