'use strict';
const {probability}=require('./model');
const {VERSION}=require('./advanced_model');
const {notify}=require('./notifications');
const {VERSION:CONTEXT_VERSION,contextReasons,latest}=require('./context');
const POLICY='bk-value-estimate-2';
const LIMITS={minEV:.10,minEdge:.04,minStressEV:.01,maxAgeMinutes:5,minOdds:1.5,maxOdds:3.5,minOverround:1,maxOverround:1.12,maxPerGame:3};
const opposite=q=>q.selection==='over'?'under':q.selection==='under'?'over':q.selection==='home'?'away':'home';
function pairFor(q,quotes){return quotes.find(p=>p.quote_id!==q.quote_id&&p.game_id===q.game_id&&p.league===q.league&&p.bookmaker===q.bookmaker&&p.source===q.source&&(p.player_id||null)===(q.player_id||null)&&p.market===q.market&&p.selection===opposite(q)&&p.period===q.period&&p.includes_overtime===q.includes_overtime&&
 (q.market==='moneyline'||Math.abs(Number(p.line)-(q.market==='spread'?-Number(q.line):Number(q.line)))<1e-8)&&Math.abs(Date.parse(p.captured_at)-Date.parse(q.captured_at))<=1000);}
function assess(q,g,forecast,baseline,quotes,now,validateQuote,current){
 const reasons=[...validateQuote(q,g,now)];
 if(![VERSION,CONTEXT_VERSION].includes(forecast?.model_version)||forecast?.advanced?.status!=='APPLIED')reasons.push('ADVANCED_NOT_APPLIED');
 if(forecast?.model_version===CONTEXT_VERSION){reasons.push(...contextReasons(forecast,current,now));if(Date.parse(q.captured_at)<Date.parse(forecast.context?.observed_at))reasons.push('PRICE_BEFORE_CONTEXT');}
 if(baseline?.status!=='OK')reasons.push('BASELINE_UNAVAILABLE');
 if(q.odds<LIMITS.minOdds||q.odds>LIMITS.maxOdds)reasons.push('ODDS_OUTSIDE_POLICY');
 if(Date.parse(q.captured_at)<now.getTime()-LIMITS.maxAgeMinutes*60000)reasons.push('VALUE_PRICE_STALE');
 const pair=pairFor(q,quotes);
 if(!pair||validateQuote(pair,g,now).length||!Number.isFinite(q.opposite_odds)||Math.abs(pair.odds-q.opposite_odds)>1e-8||Math.abs(pair.opposite_odds-q.odds)>1e-8)reasons.push('PAIRED_MARKET_UNVERIFIED');
 const overround=pair?1/q.odds+1/pair.odds:null;
 if(overround===null||overround<LIMITS.minOverround||overround>LIMITS.maxOverround)reasons.push('MARKET_MARGIN_INVALID');
 if(q.player_id&&(forecast?.sample<15||forecast?.projected_minutes<20||forecast?.minutes_sd>8))reasons.push('MINUTES_OR_SAMPLE_UNCERTAIN');
 if(q.player_id&&(!Number.isFinite(Date.parse(forecast?.last_played_at))||Date.parse(forecast.last_played_at)<now.getTime()-7*86400000))reasons.push('NO_RECENT_PARTICIPATION');
 if(q.player_id&&['OUT','DOUBTFUL','QUESTIONABLE','CONFLICT','SUSPENDED','INACTIVE'].includes(forecast?.availability))reasons.push('PLAYER_UNAVAILABLE');
 if(reasons.length)return {qualifies:false,reasons:[...new Set(reasons)]};
 const p=probability(q,forecast),base=probability(q,baseline),conditional=p.p_win/(1-p.p_push),market=(1/q.odds)/overround,ev=p.p_win*q.odds-(1-p.p_push),baseEV=base.p_win*q.odds-(1-base.p_push);
 const stress=JSON.parse(JSON.stringify(forecast));
 if(q.player_id){const s=stress.props[q.market];s.mean*=q.selection==='over'?.95:1.05;s.variance*=1.15;}
 else if(q.market==='total'){stress.total+=q.selection==='over'?-2:2;stress.total_variance*=1.15;}
 else {stress.margin+=q.selection==='home'?-2:2;stress.margin_variance*=1.15;if(q.market==='moneyline'){const spread={...q,market:'spread',line:0};const pp=probability(spread,stress);const pc=pp.p_win/(1-pp.p_push);stress.p_home=q.selection==='home'?pc:1-pc;stress.p_away=1-stress.p_home;}}
 const s=probability(q,stress),stressEV=s.p_win*q.odds-(1-s.p_push);
 if(![conditional,market,ev,baseEV,stressEV,p.p_win,p.p_push,p.p_loss].every(Number.isFinite)||Math.abs(p.p_win+p.p_push+p.p_loss-1)>1e-6)reasons.push('INVALID_PROBABILITY');
 if(ev<LIMITS.minEV)reasons.push('EV_BELOW_THRESHOLD');
 if(conditional-market<LIMITS.minEdge)reasons.push('EDGE_BELOW_THRESHOLD');
 if(stressEV<LIMITS.minStressEV)reasons.push('STRESS_TEST_FAILED');
 if(baseEV<=0)reasons.push('BASELINE_DISAGREES');
 if(conditional<.45||conditional>.80)reasons.push('PROBABILITY_OUTSIDE_POLICY');
 return {qualifies:!reasons.length,reasons,ev,stress_ev:stressEV,baseline_ev:baseEV,market_probability:market,model_probability:conditional,edge:conditional-market,overround,...p,
  conditional_on_participation:!!q.player_id};
}
const labels={points:'puntos',rebounds:'rebotes',assists:'asistencias',threes:'triples',pra:'P+R+A',pr:'P+R',pa:'P+A',ra:'R+A',total:'total',spread:'hándicap',moneyline:'ganador'};
function message(g,q,f,a){
 const selection=q.player_id?f.player_name+' · '+(q.selection==='over'?'Más de ':'Menos de ')+q.line+' '+labels[q.market]:q.market==='total'?(q.selection==='over'?'Más de ':'Menos de ')+q.line+' puntos':(q.selection==='home'?g.home_team:g.away_team)+(q.market==='spread'?' '+(q.line>0?'+':'')+q.line:' gana');
 const time=new Date(q.captured_at).toLocaleTimeString('es-ES',{timeZone:'Europe/Madrid',hour:'2-digit',minute:'2-digit'});
 const lines=[g.league+' · valor estimado · modelo experimental',g.away_team+' @ '+g.home_team,selection,
  q.bookmaker+' · cuota '+q.odds.toFixed(2)+' · lectura '+time+' (Madrid)',
  'Probabilidad sin empate: modelo '+(100*a.model_probability).toFixed(1)+'% / mercado sin margen '+(100*a.market_probability).toFixed(1)+'%.',
  'EV estimado: '+(100*a.ev).toFixed(1)+'%; escenario adverso: '+(100*a.stress_ev).toFixed(1)+'%.'];
 if(a.p_push>0)lines.push('Probabilidad de devolución: '+(100*a.p_push).toFixed(1)+'%.');
 if(a.conditional_on_participation)lines.push('Condicionado a que participe. Estado: '+f.availability+'; quinteto '+(f.context?.lineup||'sin confirmar')+'; minutos estimados '+f.projected_minutes.toFixed(1)+'.');
 if(q.source==='winamax_fr_direct')lines.push('Fuente Winamax.fr; equivalencia con España y revisión actual de reglas sin verificar.');
 lines.push('Confirma cuota y disponibilidad. Estimación en evaluación prospectiva; rentabilidad no demostrada.');
 return lines.join('\n');
}
async function notifyValues(ctx,g,forecasts,quotes,validateQuote){
 const {now=new Date(),rest}=ctx,report={assessed:0,qualified:0,sent:0,rejected:{}};
 const prior=await rest('bk_value_alerts?league=eq.'+g.league+'&game_id=eq.'+g.game_id+'&select=alert_id,subject');
 const advanced=latest(forecasts,ctx.gameContext),qualified=[];
 for(const q of quotes){const f=advanced.find(f=>(f.player_id||null)===(q.player_id||null)),b=forecasts.find(f=>f.model_version==='bk-pace-minutes-1'&&(f.player_id||null)===(q.player_id||null));
  const a=assess(q,g,f?.result,b?.result,quotes,now,validateQuote,ctx.gameContext);report.assessed++;
  for(const r of a.reasons)report.rejected[r]=(report.rejected[r]||0)+1;
  if(a.qualifies){report.qualified++;qualified.push({q,f,a});}
 }
 qualified.sort((a,b)=>b.a.stress_ev-a.a.stress_ev);const subjects=new Set(prior.map(p=>p.subject));let total=prior.length;
 for(const {q,f,a}of qualified){const subject=q.player_id||'game';if(total>=LIMITS.maxPerGame||subjects.has(subject))continue;
  const alert_id=[POLICY,g.league,g.game_id,subject].join(':'),expires=new Date(Math.min(Date.parse(q.expires_at),Date.parse(q.captured_at)+LIMITS.maxAgeMinutes*60000,Date.parse(g.starts_at))).toISOString();
  const item={alert_id,league:g.league,game_id:g.game_id,subject,forecast_id:f.forecast_id,as_of:now.toISOString(),expires_at:expires,
   policy:POLICY,decision:{...a,model_version:CONTEXT_VERSION,limits:LIMITS,forecast:f.result},quote_snapshot:q,text:message(g,q,f.result,a)};
  const stored=await rest('rpc/bk_seal_value_alert','POST',{p_row:item});if(!stored)continue;
  subjects.add(subject);total++;
  if(await notify(ctx,alert_id,g.league,item.text,expires,{kind:'basketball_value',alert_id}))report.sent++;
 }
 return report;
}
async function canRetryValue(ctx,payload,now){
 const rows=await ctx.rest('bk_value_alerts?alert_id=eq.'+encodeURIComponent(payload.alert_id)+'&select=*'),a=rows[0];if(!a||Date.parse(a.expires_at)<=now.getTime())return false;
 if(!Number.isFinite(a.decision?.ev)||a.decision.ev<LIMITS.minEV)return false;
 if(a.decision.forecast?.model_version!==CONTEXT_VERSION)return false;
 const current=(await ctx.rest('bk_context_current?league=eq.'+a.league+'&game_id=eq.'+a.game_id+'&select=*'))[0];
 if(contextReasons(a.decision.forecast,current,now).length)return false;
 const q=(await ctx.rest('bk_quotes?quote_id=eq.'+encodeURIComponent(a.quote_snapshot.quote_id)+'&select=*'))[0];
 const g=(await ctx.rest('bk_games?league=eq.'+a.league+'&game_id=eq.'+a.game_id+'&select=status,starts_at'))[0];
 return !!q&&g?.status==='scheduled'&&Date.parse(g.starts_at)>now.getTime()&&q.detail?.delayed!==true&&q.detail?.reference_only!==true&&q.odds===a.quote_snapshot.odds&&q.opposite_odds===a.quote_snapshot.opposite_odds&&Date.parse(q.expires_at)>now.getTime()&&Date.parse(q.captured_at)>now.getTime()-LIMITS.maxAgeMinutes*60000;
}
module.exports={POLICY,LIMITS,pairFor,assess,message,notifyValues,canRetryValue};
