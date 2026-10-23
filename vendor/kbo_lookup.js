'use strict';
const ALIASES={LG:['lg','twins'],SSG:['ssg','sk','landers'],KIA:['kia','ht','tigers'],KT:['kt','wiz'],NC:['nc','dinos'],OB:['ob','doosan','bears','두산'],SS:['ss','samsung','lions','삼성'],HH:['hh','hanwha','eagles','한화'],LT:['lt','lotte','giants','롯데'],WO:['wo','kiwoom','heroes','키움']};
function team(raw){const s=String(raw||'').toLowerCase().replace(/[^a-z0-9\uac00-\ud7a3]/g,' ').trim();if(!s)return null;const hits=Object.entries(ALIASES).filter(([k,a])=>k.toLowerCase()===s||a.some(x=>s===x||s.split(/\s+/).includes(x)));return hits.length===1?hits[0][0]:null;}
const sum=(rows,k)=>rows.reduce((n,r)=>n+Number(r[k]||0),0),ratio=(a,b)=>b>0?a/b:null;
function enrichKbo({inputs,games,pitchers,batters,logs,history,parks=[],weather=[],health,capture,now=new Date()}){
 const today=new Date(now.getTime()+9*3600000).toISOString().slice(0,10),season=Number(today.slice(0,4));
 const age=now-Date.parse(capture?.checked_at);
 const fresh=health?.pending_games===0&&health.final_games>0&&capture?.status==='OK'&&age>=0&&age<48*3600000;
 const used=new Set();return inputs.map(inp=>{
  if(inp.error||inp.__skip)return inp;
  const fail=error=>({...inp,error:'KBO: '+error});if(!fresh)return fail('captura oficial incompleta o pendiente de actualización');
  const a=team(inp.awayRaw),h=team(inp.homeRaw);if(!a||!h||a===h)return fail('equipos ambiguos');
  const candidates=games.filter(g=>g.game_date===today&&g.status==='scheduled'&&!used.has(g.game_id)&&((g.away_team===a&&g.home_team===h)||(g.away_team===h&&g.home_team===a)));
  if(candidates.length!==1)return fail(candidates.length?'doble jornada: hay que identificar el partido exacto':'partido programado no encontrado');
  const g=candidates[0],swapped=g.away_team!==a;used.add(g.game_id);
  if(!Number.isFinite(Date.parse(g.game_start))||now.getTime()>=Date.parse(g.game_start))return fail('hora sin confirmar o partido ya iniciado');
  if(!g.away_starter||!g.home_starter)return fail('faltan abridores anunciados');
  const out={...inp,...(swapped?{awayRaw:inp.homeRaw,homeRaw:inp.awayRaw,away_ml:inp.home_ml,home_ml:inp.away_ml,
   away_hc:inp.home_hc,home_hc:inp.away_hc,away_hc_line:inp.home_hc_line??null,home_hc_line:inp.away_hc_line??null}:{}),
   input_order_swapped:swapped,league:'KBO',game_pk:g.game_pk,game_id:g.game_pk,kbo_game_id:g.game_id,game_date:g.game_date,game_start:g.game_start,game_time_kst:g.game_time_kst,
   season,scheduled_innings:9,away_team_name:g.away_team,home_team_name:g.home_team,venue_name:g.venue_name,
   stats_source:'kbo_official_boxscores',stats_checked_at:capture.checked_at,statcast_available:false,
   data_quality_notes:['Pitcher BB and HBP are combined by the source; BB/9 is unavailable.','wOBA uses disclosed fixed weights and is an approximation.'],
   park_factor:parks.find(p=>p.team_abbr===g.home_team)?.park_factor??null,altitude_m:parks.find(p=>p.team_abbr===g.home_team)?.altitude_m??null};
  for(const side of ['away','home']){
   const abbr=g[side+'_team'],name=g[side+'_starter'].trim();
   const found=pitchers.filter(p=>p.season===season&&p.team_abbr===abbr&&p.player_name.trim()===name&&Number(p.outs)>0);
   if(found.length!==1)return fail('estadísticas verificadas no disponibles para '+name);
   const p=found[0],prior=logs.filter(r=>r.season===season&&r.game_date<g.game_date&&r.team_abbr===abbr);
   const recent=prior.filter(r=>r.player_name.trim()===name&&r.is_starter).sort((a,b)=>b.game_date.localeCompare(a.game_date)||b.game_id.localeCompare(a.game_id)).slice(0,5);
   const relievers=prior.filter(r=>!r.is_starter&&r.series_id===0),load=prior.filter(r=>!r.is_starter&&Date.parse(g.game_date)-Date.parse(r.game_date)<=3*86400000);
   const outcomes=history.filter(r=>r.game_date<g.game_date&&r.series_id===0&&r.status==='final'&&(r.away_team===abbr||r.home_team===abbr));
   const hitters=batters.filter(b=>b.season===season&&b.team_abbr===abbr),pa=sum(hitters,'pa_or_ip');
   Object.assign(out,{[side+'_pitcher_name']:name,[side+'_pitcher_id']:g[side+'_starter_id'],[side+'_starter_announced']:name,
    [side+'_p_era']:p.era,[side+'_p_ip_season']:p.pa_or_ip,[side+'_p_stats_season']:season,[side+'_p_fip']:p.fip,[side+'_p_siera']:null,
    [side+'_p_k_9']:p.k_9,[side+'_p_bb_9']:null,[side+'_p_bb_hbp_9']:p.bb_hbp_9,
    [side+'_p_ip_l5']:sum(recent,'outs')/3,[side+'_p_era_l5']:ratio(sum(recent,'er')*27,sum(recent,'outs')),[side+'_p_starts_l5']:recent.length,
    [side+'_p_data_through']:p.data_through,[side+'_bullpen_era']:ratio(sum(relievers,'er')*27,sum(relievers,'outs')),
    [side+'_bullpen_pitchers']:new Set(relievers.map(r=>r.player_name)).size,[side+'_bullpen_season']:season,
    [side+'_bullpen_pitches_3d']:sum(load,'pitches'),[side+'_bullpen_outs_3d']:sum(load,'outs'),
    [side+'_team_games']:outcomes.length,[side+'_team_avg_runs']:ratio(outcomes.reduce((n,r)=>n+Number(r.away_team===abbr?r.away_score:r.home_score),0),outcomes.length),
    [side+'_team_woba']:ratio(hitters.reduce((n,b)=>n+Number(b.woba||0)*Number(b.pa_or_ip||0),0),pa),[side+'_team_woba_method']:'fixed_weights_approximation'});
  }
  const wx=weather.find(w=>w.game_pk===g.game_pk);for(const k of ['temperature_2m','wind_speed_10m','wind_direction'])out[k]=wx?.[k]??null;
  // Park orientation is not verified; meteorological north is not the outfield.
  out.wind_tailwind=null;
  return out;
 });
}
module.exports={enrichKbo,team};
