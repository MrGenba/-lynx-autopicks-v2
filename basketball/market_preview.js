'use strict';
const {MODELS,probability}=require('./model');
const {VERSION}=require('./advanced_model');
const {assess,pairFor,LIMITS}=require('./value');
const context=require('./context');
const labels={points:'puntos',rebounds:'rebotes',assists:'asistencias',threes:'triples',pra:'P+R+A',pr:'P+R',pa:'P+A',ra:'R+A'};
const fixed=n=>Number(n).toFixed(1),percent=n=>fixed(100*n)+'%';
const reasons={ADVANCED_NOT_APPLIED:'estadísticas avanzadas insuficientes',BASELINE_UNAVAILABLE:'falta contraste con modelo base',ODDS_OUTSIDE_POLICY:'cuota fuera del rango permitido',MARKET_MARGIN_INVALID:'margen de la bookie fuera del límite',MINUTES_OR_SAMPLE_UNCERTAIN:'minutos o muestra insuficientes',NO_RECENT_PARTICIPATION:'sin participación reciente',PLAYER_UNAVAILABLE:'baja o participación dudosa',EV_BELOW_THRESHOLD:'EV inferior al '+(100*LIMITS.minEV)+'%',EDGE_BELOW_THRESHOLD:'ventaja insuficiente sobre el mercado',STRESS_TEST_FAILED:'no supera el escenario adverso',BASELINE_DISAGREES:'el modelo base no confirma valor',PROBABILITY_OUTSIDE_POLICY:'probabilidad fuera del rango admitido'};
reasons.INJURY_IDENTITY_UNRESOLVED='baja pendiente de identificar';
Object.assign(reasons,{RETURN_MINUTES_UNCERTAIN:'carga de minutos tras el regreso sin estabilizar',STAFF_REPORTS_CONFLICT:'información del staff contradictoria',STAFF_WORKLOAD_UNQUANTIFIED:'restricción de carga sin minutos concretos',OPPONENT_CONTEXT_MISSING:'historial defensivo rival insuficiente'});
Object.assign(reasons,{CONTEXT_STALE_OR_MISSING:'falta información reciente de disponibilidad',CONTEXT_CHANGED:'la información ha cambiado',CONTEXT_SOURCE_UNAVAILABLE:'fuente de disponibilidad incompleta',INJURY_REPORT_STALE:'informe de lesiones desactualizado',PARTICIPATION_UNCONFIRMED:'participación sin confirmar',LINEUP_UNCONFIRMED:'quinteto pendiente',LINEUP_OR_REPORT_UNCONFIRMED:'quinteto o informe pendiente',NEWS_UNRESOLVED:'noticia pendiente de contrastar',ROLE_SAMPLE_INSUFFICIENT:'historial insuficiente para este rol',ROTATION_IMPACT_UNMODELED:'impacto de las bajas en la rotación sin validar',PRICE_BEFORE_CONTEXT:'cuota leída antes del cambio de disponibilidad'});
function forecastsFor(rows,playerId){
 const matches=rows.filter(f=>(f.player_id||null)===(playerId||null));
 const current=matches.find(f=>f.model_version===context.VERSION)?.result,advanced=matches.find(f=>f.model_version===VERSION)?.result,base=matches.find(f=>f.model_version===MODELS.baseline.version)?.result;
 return {base,forecast:current|| (advanced?.status==='OK'&&advanced.advanced?.status==='APPLIED'?advanced:base)};
}
function marketPreviews(game,forecasts,quotes,now,validateQuote,current){
 const rows=forecasts.filter(f=>f.league===game.league&&f.game_id===game.game_id),groups=new Map();
 for(const q of quotes){
  if(!q.player_id||q.selection!=='over'||!labels[q.market]||validateQuote(q,game,now).length||Date.parse(q.captured_at)<now.getTime()-LIMITS.maxAgeMinutes*60000)continue;
  const pair=pairFor(q,quotes);
  if(!pair||validateQuote(pair,game,now).length||Date.parse(pair.captured_at)<now.getTime()-LIMITS.maxAgeMinutes*60000||pair.odds!==q.opposite_odds||pair.opposite_odds!==q.odds)continue;
  const {forecast:f,base}=forecastsFor(rows,q.player_id),stat=f?.props?.[q.market];
  if(context.unavailable(f?.availability))continue;
  if(f?.status!=='OK'||!stat||![stat.mean,stat.variance,f.projected_minutes].every(Number.isFinite)||stat.mean<0||stat.variance<0)continue;
  const key=q.bookmaker+':'+q.source;if(!groups.has(key))groups.set(key,[]);
  const assessments=[q,pair].map(price=>{const p=probability(price,f),gate=assess(price,game,f,base,quotes,now,validateQuote,current);if(f.model_version!==context.VERSION){gate.qualifies=false;gate.reasons.push('CONTEXT_STALE_OR_MISSING');}return {q:price,p,ev:p.p_win*price.odds-(1-p.p_push),gate};});
  if(assessments.some(a=>![a.ev,a.p.p_win,a.p.p_push,a.p.p_loss].every(Number.isFinite)))continue;
  groups.get(key).push({q,f,assessments});
 }
 const messages=[];
 for(const [key,entries]of groups){
  // One line per player, preferring points; value alerts still evaluate every market.
  entries.sort((a,b)=>b.f.projected_minutes-a.f.projected_minutes||Number(b.q.market==='points')-Number(a.q.market==='points')||a.q.market.localeCompare(b.q.market));
  const seen=new Set(),selected=entries.filter(e=>{if(seen.has(e.q.player_id))return false;seen.add(e.q.player_id);return true;}).slice(0,4);
  const start=new Date(game.starts_at).toLocaleString('es-ES',{timeZone:'Europe/Madrid',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
  const lines=[game.league+' · pronósticos y cuotas · '+selected[0].q.bookmaker,game.away_team+' @ '+game.home_team,start+' (Madrid)'];
  const {forecast:team}=forecastsFor(rows,null);
  if(team?.status==='OK'&&[team.p_home,team.p_away,team.home_points,team.away_points,team.total].every(Number.isFinite)){
   const home=team.p_home>=team.p_away;lines.push('Ganador más probable: '+(home?game.home_team:game.away_team)+' ('+percent(home?team.p_home:team.p_away)+').',
    'Marcador medio: '+game.home_team+' '+fixed(team.home_points)+' — '+game.away_team+' '+fixed(team.away_points)+'. Total: '+fixed(team.total)+'.');
  }
  for(const {q,f,assessments:a}of selected){
   const likely=a[0].p.p_win>=a[1].p.p_win?a[0]:a[1],best=a[0].ev>=a[1].ev?a[0]:a[1],qualified=a.some(x=>x.gate.qualifies),time=new Date(q.captured_at).toLocaleTimeString('es-ES',{timeZone:'Europe/Madrid',hour:'2-digit',minute:'2-digit'});
   lines.push('\n'+f.player_name+' · '+labels[q.market]+' '+q.line+' · lectura '+time,
    'Proyección: '+fixed(f.props[q.market].mean)+' · '+fixed(f.projected_minutes)+' min ('+([VERSION,context.VERSION].includes(f.model_version)?'avanzado':'modelo base')+').',
    'Más: cuota '+q.odds.toFixed(2)+' · prob. '+percent(a[0].p.p_win)+' · EV '+percent(a[0].ev)+'.',
    'Menos: cuota '+q.opposite_odds.toFixed(2)+' · prob. '+percent(a[1].p.p_win)+' · EV '+percent(a[1].ev)+'.',
    'Pronóstico del modelo: '+(likely.q.selection==='over'?'más':'menos')+' de '+q.line+'.');
   if(a[0].p.p_push>0)lines.push('Devolución: '+percent(a[0].p.p_push)+'.');
   if(f.context)lines.push('Disponibilidad: '+f.availability+' · quinteto '+f.context.lineup+' · rol '+f.context.role+'.');
   if(f.minutes){lines.push('Minutos: rango orientativo '+f.minutes.range.map(fixed).join('–')+(f.minutes.staff_cap?' · límite anunciado '+f.minutes.staff_cap:'')+(f.minutes.return_status!=='NORMAL'?' · regreso tras ausencia':'')+'.');
    const e=f.minutes.staff_evidence.find(e=>e.numeric_evidence==='EXPLICIT_STAFF_CAP');if(e)lines.push('Fuente del límite ('+e.published_date+'): '+e.source_url);}
   if(f.defense)lines.push(f.defense.status==='APPLIED'?'Incluye ajuste por tiros permitidos, asistencias y rebotes ante la defensa rival.':'Defensa rival: historial insuficiente para aplicar el ajuste.');
   const failed=[...best.gate.reasons];if(best.ev<LIMITS.minEV&&!failed.includes('EV_BELOW_THRESHOLD'))failed.push('EV_BELOW_THRESHOLD');
   lines.push(qualified?'Supera los filtros de valor; sujeto al límite de avisos por partido.':'SIN APUESTA: '+[...new Set(failed.map(r=>r==='MARKET_MARGIN_INVALID'?'margen de la bookie '+percent(1/q.odds+1/q.opposite_odds-1)+' fuera de 0–'+percent(LIMITS.maxOverround-1):reasons[r]||'validación pendiente'))].slice(0,3).join('; ')+'.');
  }
  lines.push('\nResumen de '+selected.length+' jugadores. Las alertas de valor revisan todos los mercados y exigen EV ≥'+(100*LIMITS.minEV)+'% y el resto de filtros.',
   'Proyecciones condicionadas a participar. La disponibilidad y el quinteto solo están confirmados cuando se indica expresamente. Horas de Madrid. Modelo experimental.');
  if(selected.some(e=>e.q.source==='winamax_fr_direct'))lines.push('Winamax.fr: equivalencia con España y versión actual de las reglas sin verificar.');
  const selections=selected.map(({q,f,assessments:a})=>{const likely=a[0].p.p_win>=a[1].p.p_win?a[0]:a[1];return {player_name:f.player_name,forecast_id:rows.find(r=>r.result===f)?.forecast_id,model_version:f.model_version,projected:f.props[q.market].mean,p_win:likely.p.p_win,quote_snapshot:likely.q};});
  messages.push({key,text:lines.join('\n'),payload:{kind:'basketball_market_preview',game_id:game.game_id,selections},expires_at:new Date(Math.min(Date.parse(game.starts_at),...selected.flatMap(e=>[Date.parse(e.q.expires_at),Date.parse(e.q.captured_at)+LIMITS.maxAgeMinutes*60000]))).toISOString()});
 }
 return messages;
}
function teamMarketPreviews(game,forecasts,quotes,now,validateQuote,current){
 const {forecast:f,base}=forecastsFor(forecasts.filter(r=>r.league===game.league&&r.game_id===game.game_id),null);if(f?.status!=='OK')return [];
 const groups=new Map();
 for(const q of quotes){
  if(q.player_id||!['home','over'].includes(q.selection)||validateQuote(q,game,now).length||Date.parse(q.captured_at)<now.getTime()-LIMITS.maxAgeMinutes*60000)continue;
  const pair=pairFor(q,quotes);if(!pair||validateQuote(pair,game,now).length||pair.odds!==q.opposite_odds||pair.opposite_odds!==q.odds)continue;
  const key=q.bookmaker+':'+q.source;if(!groups.has(key))groups.set(key,[]);groups.get(key).push({q,pair});
 }
 const messages=[];
 for(const [key,entries]of groups){
  entries.sort((a,b)=>Date.parse(b.q.captured_at)-Date.parse(a.q.captured_at)||String(a.q.quote_id).localeCompare(String(b.q.quote_id)));
  const seen=new Set(),selected=entries.filter(e=>{if(seen.has(e.q.market))return false;seen.add(e.q.market);return true;});
  const lines=[game.league+' · pronósticos y cuotas de partido · '+selected[0].q.bookmaker,game.away_team+' @ '+game.home_team],selections=[];
  for(const {q,pair}of selected){
   const a=[q,pair].map(price=>({q:price,p:probability(price,f),gate:assess(price,game,f,base,quotes,now,validateQuote,current)}));
   if(a.some(x=>!Number.isFinite(x.p.p_win)))continue;
   const likely=a[0].p.p_win>=a[1].p.p_win?a[0]:a[1],name=price=>price.market==='total'?(price.selection==='over'?'Más de ':'Menos de ')+price.line:(price.selection==='home'?game.home_team:game.away_team)+(price.market==='spread'?' '+(price.line>0?'+':'')+price.line:'');
   const time=new Date(q.captured_at).toLocaleTimeString('es-ES',{timeZone:'Europe/Madrid',hour:'2-digit',minute:'2-digit'});
   lines.push('\n'+({moneyline:'Ganador',spread:'Hándicap',total:'Total'}[q.market])+' · lectura '+time+' (Madrid)',name(q)+' @'+q.odds.toFixed(2)+' / '+name(pair)+' @'+pair.odds.toFixed(2),
    'Pronóstico: '+name(likely.q)+' · '+percent(likely.p.p_win)+'.',a.some(x=>x.gate.qualifies)&&f.model_version===context.VERSION?'Supera los filtros; aviso de valor por separado.':'SIN APUESTA DE VALOR VALIDADA.');
   selections.push({forecast_id:forecasts.find(r=>r.result===f)?.forecast_id,model_version:f.model_version,p_win:likely.p.p_win,quote_snapshot:likely.q});
  }
  if(!selections.length)continue;
  lines.push('\nCuotas observadas prepartido; pronósticos informativos. EV mínimo 10% y todos los filtros para publicar una apuesta.');
  messages.push({key,text:lines.join('\n'),payload:{kind:'basketball_team_market_preview',game_id:game.game_id,selections},expires_at:new Date(Math.min(Date.parse(game.starts_at),...selections.map(s=>Date.parse(s.quote_snapshot.captured_at)+LIMITS.maxAgeMinutes*60000))).toISOString()});
 }
 return messages;
}
module.exports={marketPreviews,teamMarketPreviews};
