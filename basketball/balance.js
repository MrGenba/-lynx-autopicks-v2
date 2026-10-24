'use strict';
const {VERSION:CONTEXT}=require('./context');
const {VERSION:LEGACY_CONTEXT}=require('./legacy_context');
const {VERSION:ADVANCED}=require('./advanced_model');
const {MODELS,PROPS}=require('./model');
const avg=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
const metrics=a=>({n:a.length,mae:avg(a.map(Math.abs)),bias:avg(a),rmse:a.length?Math.sqrt(avg(a.map(x=>x*x))):null});
function eligible(g,f){return f.league===g.league&&f.game_id===g.game_id&&[f.as_of,f.created_at].every(t=>Number.isFinite(Date.parse(t))&&Date.parse(t)<Date.parse(g.starts_at));}
// Fixed descriptive selection: latest sealed PRE-GAME row per model and subject.
// Never choose a revision by its observed result or count revisions as new games.
function latestBefore(g,forecasts,version,confirmed=false){
 const rows=forecasts.filter(f=>eligible(g,f)&&f.model_version===version&&(!confirmed||(f.player_id?f.result.context?.lineup==='CONFIRMED':[g.home_team_id,g.away_team_id].every(id=>f.result.context?.lineups?.[id]?.lineup==='CONFIRMED'))));
 rows.sort((a,b)=>Date.parse(a.as_of)-Date.parse(b.as_of)||Date.parse(a.created_at)-Date.parse(b.created_at)||a.forecast_id.localeCompare(b.forecast_id));
 const by=new Map();for(const f of rows)by.set(f.player_id||'team',f);return [...by.values()];
}
function gameBalance(g,forecasts,players,version=CONTEXT,confirmed=false){
 if(g.status!=='final'||![g.home_score,g.away_score].every(Number.isFinite))return null;
 const rows=latestBefore(g,forecasts,version,confirmed),team=rows.find(f=>f.kind==='team');if(!team)return null;
 const f=team.result,homeWin=g.home_score>g.away_score,playerRows=[],excluded={dnp:0,missing:0};
 for(const row of rows.filter(f=>f.kind==='player')){
  const p=players.find(p=>p.league===g.league&&p.game_id===g.game_id&&p.player_id===row.player_id);
  if(!g.box_complete||!p){excluded.missing++;continue;}if(p.did_not_play||p.minutes<=0){excluded.dnp++;continue;}
  const errors={minutes:row.result.projected_minutes-p.minutes};
  for(const [k,fields]of Object.entries(PROPS))if(row.result.props[k]&&fields.every(k=>Number.isFinite(p.stats?.[k])))errors[k]=row.result.props[k].mean-fields.reduce((s,k)=>s+p.stats[k],0);
  playerRows.push({player_id:p.player_id,name:p.player_name,forecast_id:row.forecast_id,role:row.result.context?.role,minutes_adjusted:row.result.context?.minutes_adjusted||false,projected_minutes:row.result.projected_minutes,actual_minutes:p.minutes,errors});
 }
 return {league:g.league,game_id:g.game_id,starts_at:g.starts_at,away:g.away_team,home:g.home_team,score:[g.away_score,g.home_score],box_complete:g.box_complete,source_url:g.source_url,model_version:version,confirmed_only:confirmed,
  team:{forecast_id:team.forecast_id,as_of:team.as_of,p_home:f.p_home,predicted_home:f.p_home>=.5,winner:f.p_home>=.5?g.home_team:g.away_team,correct:(f.p_home>=.5)===homeWin,brier:(f.p_home-Number(homeWin))**2,margin_error:f.margin-(g.home_score-g.away_score),total_error:f.total-g.home_score-g.away_score,predicted_score:[f.away_points,f.home_points]},players:playerRows,excluded};
}
function evaluateBalance(games,forecasts,players){
 const result={policy:'bk-descriptive-balance-1',selection:'LAST_SEALED_PREGAME_PER_MODEL_GAME_PLAYER',models:{},games:[]};
 for(const version of [MODELS.baseline.version,MODELS.challenger.version,ADVANCED,LEGACY_CONTEXT,CONTEXT])for(const confirmed of [CONTEXT,LEGACY_CONTEXT].includes(version)?[false,true]:[false]){
  const rows=games.map(g=>gameBalance(g,forecasts,players,version,confirmed)).filter(Boolean),key=version+(confirmed?':confirmed':'');
  const ps=rows.flatMap(r=>r.players),props={};for(const k of ['minutes',...Object.keys(PROPS)])props[k]=metrics(ps.map(p=>p.errors[k]).filter(Number.isFinite));
  result.models[key]={games:rows.length,winner_correct:rows.filter(r=>r.team.correct).length,winner_accuracy:avg(rows.map(r=>Number(r.team.correct))),brier:avg(rows.map(r=>r.team.brier)),margin:metrics(rows.map(r=>r.team.margin_error)),total:metrics(rows.map(r=>r.team.total_error)),props,excluded_dnp:rows.reduce((s,r)=>s+r.excluded.dnp,0),missing_players:rows.reduce((s,r)=>s+r.excluded.missing,0)};
  result.games.push(...rows);
 }
 return result;
}
function message(g,forecasts,players,published=0){
 const b=gameBalance(g,forecasts,players)||gameBalance(g,forecasts,players,LEGACY_CONTEXT)||gameBalance(g,forecasts,players,ADVANCED)||gameBalance(g,forecasts,players,MODELS.baseline.version);if(!b)return null;
 const fix=x=>Number(x).toFixed(1),lines=[g.league+' · balance del partido',g.away_team+' '+g.away_score+' — '+g.home_team+' '+g.home_score,
  'Último pronóstico guardado antes del inicio: '+b.team.winner+' · '+fix(100*(b.team.predicted_home?b.team.p_home:1-b.team.p_home))+'% · '+(b.team.correct?'ACIERTO':'FALLO')+'.',
  'Marcador previsto: '+b.team.predicted_score.map(fix).join(' — ')+'.',
  'Error absoluto: margen '+fix(Math.abs(b.team.margin_error))+'; total '+fix(Math.abs(b.team.total_error))+' puntos.'];
 if(b.players.length)lines.push('Jugadores ('+b.players.length+' que participaron): error medio absoluto P/R/A '+['points','rebounds','assists'].map(k=>fix(avg(b.players.map(p=>Math.abs(p.errors[k])).filter(Number.isFinite)))).join(' / ')+'.',
  'Minutos: error medio absoluto '+fix(avg(b.players.map(p=>Math.abs(p.errors.minutes))))+'.');
 if(b.excluded.dnp||b.excluded.missing)lines.push('Excluidos: '+b.excluded.dnp+' sin participación; '+b.excluded.missing+' sin datos completos.');
 lines.push('Alertas de valor publicadas: '+published+'. '+(published?'Las selecciones se liquidan por separado.':'Son predicciones descriptivas; no un balance de apuestas realizadas.'),
  'Una predicción por jugador; incluye no publicados. Este balance no demuestra superioridad del modelo.');
 return lines.join('\n');
}
module.exports={latestBefore,gameBalance,evaluateBalance,message,metrics};
