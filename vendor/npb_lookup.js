'use strict';
const ALIASES={YG:['giants','yomiuri','巨人','読売'],TY:['swallows','yakult','ヤクルト'],HT:['tigers','hanshin','阪神'],CD:['dragons','chunichi','中日'],DB:['baystars','dena','yokohama','横浜'],HR:['carp','hiroshima','広島'],SW:['lions','seibu','西武'],TM:['marines','lotte','chiba','ロッテ'],TR:['eagles','rakuten','tohoku','楽天'],HF:['fighters','nipponham','hokkaido','日本ハム'],OB:['buffaloes','orix','オリックス'],FS:['hawks','softbank','ソフトバンク']};
function team(raw){const s=String(raw||'').toLowerCase().replace(/[\s　.-]/g,'');if(!s)return null;const found=Object.entries(ALIASES).filter(([id,a])=>s===id.toLowerCase()||a.some(x=>s===x||s.includes(x)));return found.length===1?found[0][0]:null;}
const sum=(rows,k)=>rows.reduce((n,r)=>n+Number(r[k]||0),0),ratio=(a,b)=>b>0?a/b:null;
function enrichNpb({inputs,games,pitchers,batters,logs,history,parks=[],weather=[],health,capture,now=new Date()}){
 const today=new Date(now.getTime()+9*3600000).toISOString().slice(0,10),season=Number(today.slice(0,4));
 const age=now-Date.parse(capture?.checked_at);
 const fresh=health?.pending_games===0&&health.final_games>0&&capture?.status==='OK'&&age>=0&&age<48*3600000;
 const used=new Set();return inputs.map(inp=>{
  if(inp.error||inp.__skip)return inp;
  const fail=error=>({...inp,error:'NPB: '+error});if(!fresh)return fail('captura incompleta o pendiente de actualización');
  const a=team(inp.awayRaw),h=team(inp.homeRaw);if(!a||!h||a===h)return fail('equipos ambiguos');
  const candidates=games.filter(g=>g.game_date===today&&g.status==='scheduled'&&!used.has(g.game_id)&&((g.away_team===a&&g.home_team===h)||(g.away_team===h&&g.home_team===a)));
  if(candidates.length!==1)return fail(candidates.length?'doble jornada: hay que identificar el partido exacto':'partido programado no encontrado');
  const g=candidates[0],swapped=g.away_team!==a;used.add(g.game_id);
  if(!Number.isFinite(Date.parse(g.game_time))||now.getTime()>=Date.parse(g.game_time))return fail('hora sin confirmar o partido ya iniciado');
  if(!g.away_starter||!g.home_starter)return fail('faltan abridores anunciados');
  const out={...inp,...(swapped?{awayRaw:inp.homeRaw,homeRaw:inp.awayRaw,away_ml:inp.home_ml,home_ml:inp.away_ml,
   away_hc:inp.home_hc,home_hc:inp.away_hc,away_hc_line:inp.home_hc_line??null,home_hc_line:inp.away_hc_line??null,hc_value:null}:{}),
   input_order_swapped:swapped,league:'NPB',game_pk:g.game_pk,game_id:g.game_pk,npb_game_id:g.game_id,game_date:g.game_date,game_start:g.game_time,game_time:g.game_time,game_time_local:g.game_time_local,
   season,scheduled_innings:9,away_team_name:g.away_team,home_team_name:g.home_team,venue_name:g.venue_name,
   stats_source:'spaia.jp',stats_checked_at:capture.checked_at,statcast_available:false,
   data_quality_notes:['Public SPAIA boxscores; pitching tracking completeness is recorded separately.','No Hawk-Eye spin or batted-ball exit velocity feed is integrated.'],
   park_factor:parks.find(p=>p.team_abbr===g.home_team)?.park_factor??null,altitude_m:parks.find(p=>p.team_abbr===g.home_team)?.altitude_m??null};
  for(const side of ['away','home']){
   const abbr=g[side+'_team'],name=g[side+'_starter'].trim();
   const found=pitchers.filter(p=>p.season===season&&p.team_abbr===abbr&&(g[side+'_starter_id']?String(p.player_id)===String(g[side+'_starter_id']):p.player_name.trim()===name)&&Number(p.outs)>0);
   if(found.length!==1)return fail('estadísticas verificadas no disponibles para '+name);
   const p=found[0],prior=logs.filter(r=>r.season===season&&r.game_date<g.game_date&&r.team_abbr===abbr);
   const recent=prior.filter(r=>r.player_id===p.player_id&&r.is_starter).sort((a,b)=>b.game_date.localeCompare(a.game_date)||b.game_id.localeCompare(a.game_id)).slice(0,5);
   const relievers=prior.filter(r=>!r.is_starter&&[1,2,26].includes(r.game_kind)),load=prior.filter(r=>!r.is_starter&&Date.parse(g.game_date)-Date.parse(r.game_date)<=3*86400000);
   const outcomes=history.filter(r=>r.game_date<g.game_date&&[1,2,26].includes(r.game_kind)&&r.status==='final'&&(r.away_team===abbr||r.home_team===abbr));
   Object.assign(out,{[side+'_pitcher_name']:name,[side+'_pitcher_id']:g[side+'_starter_id'],[side+'_starter_announced']:name,
    [side+'_p_era']:p.era,[side+'_p_ip_season']:p.pa_or_ip,[side+'_p_stats_season']:season,[side+'_p_fip']:p.fip,[side+'_p_siera']:null,
    [side+'_p_k_9']:p.k_9,[side+'_p_bb_9']:p.bb_9,
    [side+'_p_ip_l5']:sum(recent,'outs')/3,[side+'_p_era_l5']:ratio(sum(recent,'er')*27,sum(recent,'outs')),[side+'_p_starts_l5']:recent.length,
    [side+'_p_data_through']:p.data_through,[side+'_bullpen_era']:ratio(sum(relievers,'er')*27,sum(relievers,'outs')),
    [side+'_bullpen_pitchers']:new Set(relievers.map(r=>r.player_id)).size,[side+'_bullpen_season']:season,
    [side+'_bullpen_pitches_3d']:sum(load,'pitches'),[side+'_bullpen_outs_3d']:sum(load,'outs'),
    [side+'_team_games']:outcomes.length,[side+'_team_avg_runs']:ratio(outcomes.reduce((n,r)=>n+Number(r.away_team===abbr?r.away_score:r.home_score),0),outcomes.length),
    [side+'_team_woba']:null});
  }
  for(const k of ['temperature_2m','wind_speed_10m','wind_direction'])out[k]=null;
  // Park orientation is not verified; meteorological north is not the outfield.
  out.wind_tailwind=null;
  return out;
 });
}
module.exports={enrichNpb,team};
