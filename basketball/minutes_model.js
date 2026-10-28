'use strict';
const {weighted}=require('./model');
const POLICY='bk-minutes-return-1',num=Number.isFinite,clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const unavailable=s=>['OUT','SUSPENDED','INACTIVE'].includes(s);
const stamp=r=>Date.parse(r.game?.starts_at);
function played(f,g,h,now){return (h?.players||[]).filter(p=>p.player_id===f.player_id&&p.team_id===f.team_id&&p.game?.season>=g.season-1&&[2,3].includes(p.game.season_type)&&stamp(p)+4*3600000<now.getTime()&&stamp(p)<Date.parse(g.starts_at)&&!p.did_not_play&&p.minutes>0).sort((a,b)=>stamp(a)-stamp(b));}
function regulationMinutes(p,g){return Math.min(g.league==='NBA'?48:40,p.minutes*(g.league==='NBA'?48:40)/((g.league==='NBA'?48:40)+5*Math.max(0,(p.game.periods||4)-4)));}
function returnState(f,g,h,now){
 const rows=played(f,g,h,now),teamGames=(h?.games||[]).filter(x=>x.season===g.season&&[2,3].includes(x.season_type)&&[x.home_team_id,x.away_team_id].includes(f.team_id)&&Date.parse(x.starts_at)>now.getTime()-60*86400000&&Date.parse(x.starts_at)+4*3600000<now.getTime()).sort((a,b)=>Date.parse(a.starts_at)-Date.parse(b.starts_at));
 const ids=new Set(rows.map(r=>r.game_id));let missed=0,lastGap=null;
 for(const game of teamGames){if(ids.has(game.game_id)){if(missed>=2)lastGap={game_id:game.game_id,at:game.starts_at,missed};missed=0;}else missed++;}
 const last=rows.at(-1),missedSince=last?teamGames.filter(x=>Date.parse(x.starts_at)>stamp(last)&&!ids.has(x.game_id)).length:0;
 const returned=lastGap?rows.filter(r=>stamp(r)>=Date.parse(lastGap.at)):[];
 return {status:missedSince>=2?'RETURN_PENDING':lastGap&&returned.length<=3?'RECENT_RETURN':'NORMAL',missed_games:missedSince>=2?missedSince:lastGap?.missed||0,return_game:lastGap?.game_id||null,returned_games:returned.length,rows:returned};
}
function evidence(p,g){
 const day=new Date(g.starts_at).toLocaleDateString('en-CA',{timeZone:'America/New_York'});
 return (p.rotation_evidence||[]).filter(e=>e.policy==='bk-rotation-news-1'&&e.target_date===day&&/^https:\/\/www\.rotowire\.com\/(basketball|wnba)\//.test(e.source_url||'')&&e.published_date<=day&&Date.parse(day)-Date.parse(e.published_date)<=2*86400000);
}
function estimate(f,g,h,body,originals,now){
 const p=body.players?.[f.player_id]||{},limit=g.league==='NBA'?48:40,rows=played(f,g,h,now).slice(-30),signals=evidence(p,g),blocks=[],reasons=[];
 const state=returnState(f,g,h,now);let target=f.projected_minutes,sd=num(f.minutes_sd)?f.minutes_sd:8;
 const result={policy:POLICY,original_minutes:f.projected_minutes,return_status:state.status,missed_games:state.missed_games,returned_games:state.returned_games,return_game:state.return_game,staff_evidence:signals,blockers:blocks,reasons,sample:rows.length};
 if(unavailable(p.availability))return {...result,minutes:0,sd:0,range:[0,0],blockers:['PLAYER_UNAVAILABLE']};
 const role=['STARTER','BENCH'].includes(p.role)?p.role:null;
 const recent=(role?rows.filter(x=>x.starter===(role==='STARTER')):rows).slice(-10);
 if(recent.length>=5){const m=weighted(recent,r=>regulationMinutes(r,g),.94);target=m.mean;sd=Math.max(2,Math.sqrt(m.variance));reasons.push(role?'OBSERVED_ROLE_MINUTES':'RECENT_TEAM_MINUTES');}
 else if(role)blocks.push('ROLE_SAMPLE_INSUFFICIENT');
 const returning=state.status!=='NORMAL'||signals.some(e=>e.returning);
 if(state.status==='RECENT_RETURN'&&state.rows.length){const m=weighted(state.rows,r=>regulationMinutes(r,g),.8);target=m.mean;sd=Math.max(sd,4,Math.sqrt(m.variance));reasons.push('OBSERVED_POST_RETURN_MINUTES');}
 if(returning){blocks.push('RETURN_MINUTES_UNCERTAIN');sd=Math.max(sd,state.returned_games?5:8);reasons.push('RETURN_NOT_NORMAL_WORKLOAD');}
 const impacted=originals.filter(o=>o.player_id&&o.player_id!==f.player_id&&o.team_id===f.team_id&&o.projected_minutes>=10).filter(o=>unavailable(body.players?.[o.player_id]?.availability)||returnState(o,g,h,now).status!=='NORMAL'||evidence(body.players?.[o.player_id]||{},g).some(e=>e.returning));
 if(impacted.length){
  const byPlayer=new Map(impacted.map(o=>[o.player_id,new Set(played(o,g,h,now).filter(x=>x.minutes>0).map(x=>x.game_id))]));
  const matched=recent.filter(r=>impacted.every(o=>byPlayer.get(o.player_id).has(r.game_id)!==unavailable(body.players?.[o.player_id]?.availability)));
  result.rotation={players:impacted.map(o=>({player_id:o.player_id,unavailable:unavailable(body.players?.[o.player_id]?.availability)})),sample:matched.length};
  if(matched.length>=5&&!returning){const m=weighted(matched,r=>regulationMinutes(r,g),.94),weight=matched.length/(matched.length+8);target+=clamp(weight*(m.mean-target),-6,6);sd=Math.max(sd,Math.sqrt(m.variance));reasons.push('OBSERVED_COMPARABLE_ROTATION');}
  else blocks.push('ROTATION_IMPACT_UNMODELED');
 }
 const caps=signals.filter(e=>e.staff_attributed&&e.numeric_evidence==='EXPLICIT_STAFF_CAP'&&num(e.minutes_cap)&&e.minutes_cap>0&&e.minutes_cap<=limit).map(e=>e.minutes_cap);
 if(caps.length){const cap=Math.min(...caps);target=Math.min(target,cap);result.staff_cap=cap;reasons.push('EXPLICIT_STAFF_CAP');if(new Set(caps).size>1||signals.some(e=>e.unrestricted_reported))blocks.push('STAFF_REPORTS_CONFLICT');}
 if(signals.some(e=>e.rotation_risk)&&!caps.length){sd=Math.max(sd,6);blocks.push('STAFF_WORKLOAD_UNQUANTIFIED');}
 target=clamp(target,0,limit);result.minutes=target;result.sd=Math.max(0,sd);result.range=[Math.max(0,target-sd),Math.min(result.staff_cap??limit,target+sd)];
 return result;
}
function apply(f,estimate){
 const out=JSON.parse(JSON.stringify(f)),ratio=f.projected_minutes>0?estimate.minutes/f.projected_minutes:0,extra=Math.max(0,estimate.sd**2-(f.minutes_sd||0)**2);
 out.projected_minutes=estimate.minutes;out.minutes_sd=estimate.sd;out.minutes=estimate;
 for(const [key,s]of Object.entries(f.props||{})){const mean=s.mean*ratio;out.props[key]={mean,variance:estimate.minutes===0?0:Math.max(mean,s.variance*ratio*ratio+(s.mean/Math.max(1,f.projected_minutes))**2*extra)};}
 return out;
}
function constrainTeam(rows,g){
 const budget=5*(g.league==='NBA'?48:40);
 for(const tid of [g.home_team_id,g.away_team_id]){const players=rows.filter(f=>f.player_id&&f.team_id===tid),total=players.reduce((s,f)=>s+f.projected_minutes,0);if(total<=budget)continue;
  for(const f of players){const estimate={...f.minutes,minutes:f.projected_minutes*budget/total,sd:f.minutes_sd,team_budget:budget,team_unconstrained_minutes:total,reasons:[...f.minutes.reasons,'TEAM_MINUTE_BUDGET']};estimate.range=[Math.max(0,estimate.minutes-estimate.sd),Math.min(estimate.staff_cap??(g.league==='NBA'?48:40),estimate.minutes+estimate.sd)];Object.assign(f,apply(f,estimate));}
 }
 return rows;
}
module.exports={POLICY,played,returnState,evidence,estimate,apply,constrainTeam};

