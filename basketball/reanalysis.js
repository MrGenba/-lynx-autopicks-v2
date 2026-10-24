'use strict';
const context=require('./context');
const {notify}=require('./notifications');
const fixed=x=>Number(x).toFixed(1);
function lineupKey(game,current,now){
 if(game.status!=='scheduled'||Date.parse(game.starts_at)<=now.getTime()||!context.currentOK(current,now)||current.body.sources?.lineups!=='OK')return null;
 const teams=[game.away_team_id,game.home_team_id].map(id=>[id,current.body.teams?.[id]]);
 if(teams.some(([,t])=>t?.lineup!=='CONFIRMED'||t.starters?.length!==5||new Set(t.starters).size!==5))return null;
 return teams.map(([id,t])=>id+'-'+t.starters.slice().sort().join('-')).join(':');
}
function buildReanalysis(game,forecasts,current,now,valueCheck){
 const key=lineupKey(game,current,now);if(!key)return null;
 const rows=context.latest(forecasts,current),team=rows.find(f=>f.kind==='team');if(!team)return null;
 const t=team.result,lines=[game.league+' · reanálisis con ambos quintetos confirmados',game.away_team+' @ '+game.home_team,
  'Revisión '+now.toLocaleTimeString('es-ES',{timeZone:'Europe/Madrid',hour:'2-digit',minute:'2-digit'})+' (Madrid).',
  'Modelo de equipo: '+game.away_team+' '+fixed(100*t.p_away)+'% / '+game.home_team+' '+fixed(100*t.p_home)+'%.',
  'Marcador medio: '+fixed(t.away_points)+' — '+fixed(t.home_points)+'; total '+fixed(t.total)+'.'];
 let adjusted=0,missing=0;const forecastIds=[team.forecast_id];
 for(const tid of [game.away_team_id,game.home_team_id]){
  lines.push('\n'+current.body.teams[tid].team_name+' · puntos / rebotes / asistencias');
  for(const pid of current.body.teams[tid].starters){
   const row=rows.find(f=>f.player_id===pid),p=current.body.players[pid];
   if(!row){missing++;lines.push((p?.name||pid)+': historial insuficiente para proyectar.');continue;}
   const f=row.result;forecastIds.push(row.forecast_id);adjusted+=Number(f.context.minutes_adjusted);
   const base=forecasts.find(r=>r.forecast_id===f.context.base_forecast_id)?.result;
   const minutes=(base?fixed(base.projected_minutes)+' → ':'')+fixed(f.projected_minutes)+' min'+(f.minutes?.range?' (rango '+f.minutes.range.map(fixed).join('–')+(f.minutes.staff_cap?'; límite '+f.minutes.staff_cap:'')+')':'');
   lines.push(f.player_name+': '+['points','rebounds','assists'].map(k=>fixed(f.props[k].mean)).join(' / ')+'; '+minutes+(context.unavailable(f.availability)?' · BAJA, revisar contradicción':'')+(f.context.blockers?.includes('RETURN_MINUTES_UNCERTAIN')?' · regreso incierto: SIN APUESTA':'')+'.');
  }
 }
 lines.push('\n'+adjusted+' proyecciones de minutos ajustadas al rol con historial suficiente'+(missing?'; '+missing+' titulares sin proyección':'')+'.');
 const reasons=context.contextReasons(t,current,now);
 if(current.body.sources?.injuries!=='OK')lines.push('Parte oficial no disponible: apuestas bloqueadas.');
 if(current.body.sources?.news!=='OK')lines.push('Noticias incompletas: apuestas bloqueadas.');
 if(reasons.includes('ROTATION_IMPACT_UNMODELED'))lines.push('Impacto de bajas en la rotación sin validar: apuestas bloqueadas.');
 if(valueCheck?.qualified)lines.push(valueCheck.qualified+' selecciones superan los filtros; los avisos de valor se envían por separado con su cuota.');
 else lines.push('SIN APUESTA DE VALOR VALIDADA en esta revisión'+(!valueCheck?.assessed?': sin cuotas evaluables.':'.'));
 lines.push('EV mínimo 10%. Rangos de minutos orientativos. Proyecciones experimentales condicionadas a participar; la probabilidad de equipo conserva el modelo histórico. Límites del staff: fuente y fecha guardadas con cada pronóstico.');
 return {key:key+':'+context.VERSION+':'+current.body.model_revision,text:lines.join('\n'),expires_at:new Date(Math.min(Date.parse(game.starts_at),Date.parse(current.checked_at)+10*60000)).toISOString(),payload:{kind:'basketball_lineup_reanalysis',game_id:game.game_id,lineup_key:key,context_revision:current.body.model_revision,forecast_ids:forecastIds}};
}
async function publishReanalysis(ctx,game,forecasts,current,valueCheck){
 const item=buildReanalysis(game,forecasts,current,ctx.now,valueCheck);if(!item)return false;
 return notify(ctx,'lineup-analysis-v1:'+game.league+':'+game.game_id+':'+item.key,game.league,item.text,item.expires_at,item.payload);
}
async function canRetry(ctx,payload,now){
 const g=(await ctx.rest('bk_games?game_id=eq.'+payload.game_id+'&select=*'))[0];if(!g)return false;
 const c=(await ctx.rest('bk_context_current?league=eq.'+g.league+'&game_id=eq.'+g.game_id+'&select=*'))[0];
 return lineupKey(g,c,now)===payload.lineup_key&&c?.body.model_revision===payload.context_revision;
}
module.exports={lineupKey,buildReanalysis,publishReanalysis,canRetry};
