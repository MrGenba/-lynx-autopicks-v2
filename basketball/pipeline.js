'use strict';
const {MODELS,PROPS,prepareHistory,teamForecast,playerForecast,probability}=require('./model');
const {all}=require('./capture');
const {notify,retryNotifications}=require('./notifications');
const {VERSION:ADVANCED_VERSION,buildAdvanced}=require('./advanced_model');
const {notifyValues,canRetryValue,LIMITS}=require('./value');
const {marketPreviews,teamMarketPreviews}=require('./market_preview');
const context=require('./context');
const legacyContext=require('./legacy_context');
const previousContext=require('./previous_context');
const overtimeContext=require('./overtime_context');
const overtime=require('./overtime');
const reanalysis=require('./reanalysis');
const balance=require('./balance');
const marketBalance=require('./market_balance');
const ps3838Reference=require('./ps3838_reference');
const filteredChannel=require('./filtered_channel');
const pregameReview=require('./pregame_review');
const view=require('./pick_format');
const matchup=require('./matchup_model');
const versions=[...Object.values(MODELS).map(x=>x.version),ADVANCED_VERSION];
const id=(...parts)=>parts.map(p=>String(p??'team').replace(/[^A-Za-z0-9_.:-]/g,'_')).join(':');
const fixed=n=>Number(n).toFixed(1);
// Share n8n's event loop with HTTP callbacks between bounded model stages.
const cooperate=()=>new Promise(resolve=>setTimeout(resolve,0));
function validateQuote(q,g,now){
 const reasons=[];
 if(q.league!==g.league||q.game_id!==g.game_id)reasons.push('EVENT_MISMATCH');
 if(q.detail?.delayed===true||q.detail?.reference_only===true||q.source==='ps3838_public_delayed')reasons.push('DELAYED_REFERENCE_PRICE');
 if(q.period!=='full_game'||q.includes_overtime!==true)reasons.push('RULES_UNVERIFIED');
 if(!(q.odds>1&&q.odds<=1000)||!q.bookmaker||!q.source_url)reasons.push('PRICE_INVALID');
 if(!Number.isFinite(Date.parse(q.captured_at))||Date.parse(q.captured_at)>now.getTime()+60000||Date.parse(q.captured_at)<now.getTime()-15*60000||Date.parse(q.expires_at)<=now.getTime())reasons.push('STALE_QUOTE');
 if(q.player_id?!PROPS[q.market]:!['moneyline','spread','total'].includes(q.market))reasons.push('MARKET_UNSUPPORTED');
 if((q.player_id||q.market==='total')?!['over','under'].includes(q.selection):!['home','away'].includes(q.selection))reasons.push('SELECTION_INVALID');
 if(q.market!=='moneyline'&&(!Number.isFinite(Number(q.line))||q.line===null||Math.abs(Number(q.line)*2-Math.round(Number(q.line)*2))>0.00001))reasons.push('LINE_INVALID');
 if(g.status!=='scheduled'||Date.parse(g.starts_at)<=now.getTime())reasons.push('NOT_PREGAME');return reasons;
}
function candidate(q,g,f,now){
 const invalid=validateQuote(q,g,now);if(invalid.length||f?.status!=='OK')return null;
 const p=probability(q,f),ev=p.p_win*(q.odds-1)-p.p_loss,reasons=['MODEL_EXPERIMENTAL'];
 if(!q.price_updated_at)reasons.push('BOOKMAKER_UPDATE_TIME_UNKNOWN');
 if(q.source==='winamax_fr_direct'){reasons.push('WINAMAX_FR_NOT_VERIFIED_EQUIVALENT_TO_ES');if(q.detail?.schedule_offset_seconds)reasons.push('BOOKMAKER_START_DIFFERS_FROM_CALENDAR');if(!q.detail?.rules_current_version_verified)reasons.push('RULES_REFERENCE_2024_CURRENT_VERSION_UNCONFIRMED');}
 if(q.player_id&&f.availability!=='CONFIRMED')reasons.push('PLAYER_AVAILABILITY_UNVERIFIED');
 if(ev<=0)reasons.push('NO_EDGE');
 return {candidate_id:id(g.league,g.game_id,q.bookmaker,q.player_id,q.market,q.line,q.selection,f.model_version)+(f.context?.revision?':'+(f.context.input_revision||f.context.revision):''),league:g.league,game_id:g.game_id,player_id:q.player_id||null,model_version:f.model_version,quote_id:q.quote_id,
  as_of:now.toISOString(),market:q.market,line:q.line,selection:q.selection,odds:q.odds,...p,ev,verdict:ev>0?'PAPER_CANDIDATE':'NO_EDGE',reasons,quote_snapshot:q,forecast:f};
}
function gameMessage(g,team,players,quotes){
 const lines=[...view.heading(g,'VISTA PREVIA'),'',view.divider,
  '📊 Media prevista: '+g.away_team+' '+fixed(team.away_points)+' — '+g.home_team+' '+fixed(team.home_points),
  'Victoria: visitante '+fixed(team.p_away*100)+'% · local '+fixed(team.p_home*100)+'%',
  'Total medio: '+fixed(team.total)+' puntos.'];
 if(overtime.notice(team))lines.push(overtime.notice(team));
 const top=players.filter(p=>p.projected_minutes>=15).sort((a,b)=>b.projected_minutes-a.projected_minutes).slice(0,4);
 if(top.length)lines.push('',view.divider,'👤 Jugadores · medias si participan (P/R/A)',...top.map(p=>'• '+p.player_name+': '+fixed(p.props.points.mean)+' / '+fixed(p.props.rebounds.mean)+' / '+fixed(p.props.assists.mean)+'; '+fixed(p.projected_minutes)+' min.'));
 const ml=quotes.filter(q=>q.market==='moneyline'&&!q.player_id);
 lines.push(ml.length?'\n💰 Cuotas observadas '+view.book(ml[0].bookmaker)+': '+ml.map(q=>(q.selection==='home'?'local':'visitante')+' '+q.odds).join(' · '):'\n⏳ Sin cuotas verificadas en esta lectura.');
 const teams=Object.values(team.context?.lineups||{});
 if(teams.length===2){
  lines.push('👥 Quintetos: '+teams.map(t=>t.team_name+' '+view.lineup(t.lineup)).join(' · ')+'.');
  lines.push(teams.every(t=>t.injury_report_submitted)?'Partes de lesiones con información para ambos equipos.':'Disponibilidad incompleta: falta un parte válido para al menos un equipo.');
 }else lines.push('Jugadores y minutos basados en historial; lesiones y quintetos sin confirmar.');
 lines.push('Proyecciones condicionadas a participar. Confirmar quintetos no elimina las demás validaciones.','Modelo en evaluación, sin ventaja demostrada.');return lines.join('\n');
}
async function runAnalysis(ctx){
 const {rest,now=new Date()}=ctx,report={at:now.toISOString(),leagues:{}};
 try{report.fresh_channel=await filteredChannel.publishFresh(ctx);}catch(e){report.fresh_channel={error:/^[A-Z][A-Z_0-9]+$/.test(e.message||'')?e.message:'FRESH_CHANNEL_FAILED'};}
 ctx.canRetryValue=(payload,when)=>canRetryValue(ctx,payload,when);
 ctx.canRetryReanalysis=(payload,when)=>reanalysis.canRetry(ctx,payload,when);
 report.notifications_retried=await retryNotifications(ctx,now);report.settled=await rest('rpc/bk_settle_candidates','POST',{});
 for(const league of ['NBA','WNBA']){
  const to=new Date(now.getTime()+12*3600000).toISOString(),upcoming=await rest('bk_games?league=eq.'+league+'&status=eq.scheduled&starts_at=gt.'+now.toISOString()+'&starts_at=lte.'+to+'&order=starts_at.asc&select=*');
  const missing=await rest('bk_games?league=eq.'+league+'&box_complete=eq.false&status=in.(scheduled,live,final)&starts_at=gt.'+new Date(now.getTime()-7*86400000).toISOString()+'&starts_at=lt.'+new Date(now.getTime()-5*3600000).toISOString()+'&select=home_team_id,away_team_id');
  const blocked=new Set(missing.flatMap(g=>[g.home_team_id,g.away_team_id])),games=upcoming.filter(g=>!blocked.has(g.home_team_id)&&!blocked.has(g.away_team_id));
  const r={games:games.length,blocked_missing_recent_stats:upcoming.length-games.length,forecasts_sealed:0,candidates_sealed:0,notifications:0,insufficient_history:0,advanced_players:0,advanced_teams:0,value_alerts:0,value_checks:[],coverage:[],filtered_channel:report.fresh_channel.leagues?.[league]||{qualified:0,sent:0,selections_sent:0}};report.leagues[league]=r;
  if(games.length){
   const ids=games.map(g=>g.game_id).join(','),existing=await rest('rpc/bk_analysis_forecasts','POST',{p_league:league,p_game_ids:games.map(g=>g.game_id)});
   const needs=games.filter(g=>versions.some(v=>!existing.some(f=>f.game_id===g.game_id&&f.model_version===v&&f.kind==='team')));
   if(needs.length){
    const data=await rest('rpc/bk_history','POST',{p_league:league,p_team_ids:[...new Set(needs.flatMap(g=>[g.home_team_id,g.away_team_id]))]}),h=prepareHistory(data.games,data.teams,data.players,now,league);
    const rosters=await rest('bk_rosters?league=eq.'+league+'&game_id=in.('+ids+')&observed_at=gt.'+new Date(now.getTime()-3*3600000).toISOString()+'&select=*');
    const advancedRows=await all(rest,'bk_player_advanced_current?league=eq.'+league+'&select=*');
    for(const g of needs){
     await cooperate();
     const rows=[];
     let current=rosters.filter(ro=>ro.game_id===g.game_id);
     if(current.length!==2){current=[g.home_team_id,g.away_team_id].map(team_id=>{const recent=h.teams.filter(t=>t.team_id===team_id&&t.game.season===g.season&&Date.parse(t.game.starts_at)>now.getTime()-30*86400000).at(-1);return {team_id,players:recent?h.players.filter(p=>p.game_id===recent.game_id&&p.team_id===team_id).map(p=>({player_id:p.player_id})):[]};});}
     for(const config of Object.values(MODELS)){
      const t=teamForecast(g,h,config);if(t.status!=='OK'){r.insufficient_history++;continue;}
      const add=(result,player_id=null)=>rows.push({forecast_id:id(league,g.game_id,player_id,config.version),league,game_id:g.game_id,player_id,model_version:config.version,as_of:now.toISOString(),kind:player_id?'player':'team',result});
      add(t);
      for(const ro of current)for(const p of ro.players){const f=playerForecast(p.player_id,g,h,t,config);if(f.status==='OK'&&f.team_id===ro.team_id)add(f,p.player_id);}
     }
     const advanced=buildAdvanced(g,h,current,advancedRows,now);
     if(advanced.team.status==='OK'){
      const add=(result,player_id=null)=>rows.push({forecast_id:id(league,g.game_id,player_id,ADVANCED_VERSION),league,game_id:g.game_id,player_id,model_version:ADVANCED_VERSION,as_of:now.toISOString(),kind:player_id?'player':'team',result});
      add(advanced.team);if(advanced.team.advanced.status==='APPLIED')r.advanced_teams++;
      for(const p of advanced.players){add(p,p.player_id);if(p.advanced.status==='APPLIED')r.advanced_players++;}
      for(let i=0;i<advanced.validations.length;i+=100)await rest('bk_model_validations?on_conflict=validation_id','POST',advanced.validations.slice(i,i+100),{prefer:'resolution=ignore-duplicates,return=minimal'});
     }
     if(rows.length){r.forecasts_sealed+=await rest('rpc/bk_seal_forecasts','POST',{p_rows:rows});existing.push(...rows);}
    }
   }
   const quotes=await all(rest,'bk_quotes?league=eq.'+league+'&game_id=in.('+ids+')&expires_at=gt.'+now.toISOString()+'&order=captured_at.desc&select=*');
   const contexts=await rest('bk_context_current?league=eq.'+league+'&game_id=in.('+ids+')&select=*');
   let contextHistory,contextStats,contextRosters;
   if(contexts.some(c=>context.currentOK(c,now))){
    const data=await rest('rpc/bk_history_context4','POST',{p_league:league,p_team_ids:[...new Set(games.flatMap(g=>[g.home_team_id,g.away_team_id]))]});contextHistory=prepareHistory(data.games,data.teams,data.players,now,league);
    contextStats=await all(rest,'bk_player_advanced_current?league=eq.'+league+'&select=*');
    contextRosters=await rest('bk_rosters?league=eq.'+league+'&game_id=in.('+ids+')&observed_at=gt.'+new Date(now.getTime()-3*3600000).toISOString()+'&select=*');
   }
   const matchupProtocol=(await rest('bk_model_protocols?protocol_id=eq.'+matchup.POLICY+'&select=registered_at'))[0];
   let matchupHistory,matchupStats;
   if(matchupProtocol&&games.some(g=>Date.parse(g.starts_at)>Date.parse(matchupProtocol.registered_at)&&!existing.some(f=>f.game_id===g.game_id&&f.model_version===matchup.VERSION))){
    if(contextHistory)matchupHistory=contextHistory;else{const data=await rest('rpc/bk_history','POST',{p_league:league,p_team_ids:[...new Set(games.flatMap(g=>[g.home_team_id,g.away_team_id]))]});matchupHistory=prepareHistory(data.games,data.teams,data.players,now,league);}
    matchupStats=contextStats||await all(rest,'bk_player_advanced_current?league=eq.'+league+'&select=*');
   }
   for(const g of games){
    await cooperate();
    const fs=existing.filter(f=>f.game_id===g.game_id),qs=quotes.filter(q=>q.game_id===g.game_id&&!validateQuote(q,g,now).length),candidates=[];
    const current=contexts.find(c=>c.game_id===g.game_id);
    if(contextHistory&&!legacyContext.latest(fs,current).length){const rows=legacyContext.derive(g,fs,current,contextHistory,now);if(rows.length){r.forecasts_sealed+=await rest('rpc/bk_seal_forecasts','POST',{p_rows:rows});fs.push(...rows);}}
    if(contextHistory&&context.currentOK(current,now)){
     const previousInputs=previousContext.inputs(g,contextHistory,current,contextStats,fs,now,contextRosters),newPreviousInputs=previousInputs.filter(r=>!fs.some(f=>f.forecast_id===r.forecast_id));
     if(newPreviousInputs.length){r.forecasts_sealed+=await rest('rpc/bk_seal_forecasts','POST',{p_rows:newPreviousInputs});fs.push(...newPreviousInputs);}
     await cooperate();
     const previousRows=previousContext.derive(g,previousInputs,current,contextHistory,now,legacyContext.latest(fs,current)).filter(r=>!fs.some(f=>f.forecast_id===r.forecast_id));
     if(previousRows.length){r.forecasts_sealed+=await rest('rpc/bk_seal_forecasts','POST',{p_rows:previousRows});fs.push(...previousRows);}
     await cooperate();
     const otInputs=overtimeContext.inputs(g,contextHistory,current,contextStats,fs,now,contextRosters),newOtInputs=otInputs.filter(r=>!fs.some(f=>f.forecast_id===r.forecast_id));
     if(newOtInputs.length){r.forecasts_sealed+=await rest('rpc/bk_seal_forecasts','POST',{p_rows:newOtInputs});fs.push(...newOtInputs);}
     const otRows=overtimeContext.derive(g,otInputs,current,contextHistory,now,previousContext.latest(fs,current)).filter(r=>!fs.some(f=>f.forecast_id===r.forecast_id));
     if(otRows.length){r.forecasts_sealed+=await rest('rpc/bk_seal_forecasts','POST',{p_rows:otRows});fs.push(...otRows);}
     await cooperate();
     const inputs=context.inputs(g,contextHistory,current,contextStats,fs,now,contextRosters),newInputs=inputs.filter(r=>!fs.some(f=>f.forecast_id===r.forecast_id));
     if(newInputs.length){r.forecasts_sealed+=await rest('rpc/bk_seal_forecasts','POST',{p_rows:newInputs});fs.push(...newInputs);}
     await cooperate();
     const rows=context.derive(g,inputs,current,contextHistory,now,overtimeContext.latest(fs,current)).filter(r=>!fs.some(f=>f.forecast_id===r.forecast_id));
     if(rows.length){r.forecasts_sealed+=await rest('rpc/bk_seal_forecasts','POST',{p_rows:rows});fs.push(...rows);}
    }
    const contextual=context.latest(fs,current),valueCtx={...ctx,gameContext:current};
    if(matchupHistory&&!fs.some(f=>f.model_version===matchup.VERSION)){
     const previous=legacyContext.latest(fs,current),inputs=[...previous,...fs.filter(f=>f.model_version===ADVANCED_VERSION&&!previous.some(c=>c.player_id===f.player_id))];
     const shadow=matchup.build(g,matchupHistory,inputs.map(f=>f.result),matchupStats,now).filter(f=>f.matchup.status==='APPLIED').map(f=>({forecast_id:id(league,g.game_id,f.player_id,matchup.VERSION),league,game_id:g.game_id,player_id:f.player_id,model_version:matchup.VERSION,as_of:now.toISOString(),kind:'player',result:{...f,matchup:{...f.matchup,base_forecast_id:inputs.find(b=>b.player_id===f.player_id)?.forecast_id}}}));
     if(shadow.length){r.forecasts_sealed+=await rest('rpc/bk_seal_forecasts','POST',{p_rows:shadow});fs.push(...shadow);}
    }
    for(const q of qs)for(const v of versions){const f=fs.find(f=>f.model_version===v&&(f.player_id||null)===(q.player_id||null));const c=candidate(q,g,f?.result,now);if(c)candidates.push(c);}
    for(const q of qs){const f=previousContext.latest(fs,current).find(f=>(f.player_id||null)===(q.player_id||null));const c=f&&candidate(q,g,f.result,now);if(c){c.verdict='RESEARCH_ONLY';c.reasons.push('PREVIOUS_GENERATION_SHADOW');candidates.push(c);}}
    for(const q of qs){const f=overtimeContext.latest(fs,current).find(f=>(f.player_id||null)===(q.player_id||null));const c=f&&candidate(q,g,f.result,now);if(c){c.verdict='RESEARCH_ONLY';c.reasons.push('PREVIOUS_GENERATION_SHADOW');candidates.push(c);}}
    for(const q of qs){const f=contextual.find(f=>(f.player_id||null)===(q.player_id||null));if(!f)continue;const c=candidate(q,g,f.result,now);if(c){const blocked=context.contextReasons(f.result,current,now);c.reasons.push(...blocked);if(blocked.length)c.verdict='CONTEXT_BLOCKED';candidates.push(c);}}
    for(const q of qs.filter(q=>q.player_id)){const f=fs.find(f=>f.model_version===matchup.VERSION&&f.player_id===q.player_id);if(!f)continue;const c=candidate(q,g,f.result,now);if(c){c.verdict='RESEARCH_ONLY';c.reasons.push('NO_AUTOMATIC_PROMOTION');candidates.push(c);}}
    for(let i=0;i<candidates.length;i+=200)r.candidates_sealed+=await rest('rpc/bk_seal_candidates','POST',{p_rows:candidates.slice(i,i+200)});
    const base=contextual.length?contextual:fs.filter(f=>f.model_version===MODELS.baseline.version),team=base.find(f=>f.kind==='team')?.result;
    r.coverage.push({game_id:g.game_id,preview_due_at:new Date(Date.parse(g.starts_at)-6*3600000).toISOString(),team_forecast:team?.status||'MISSING',player_forecasts:base.filter(f=>f.kind==='player').length,valid_quotes:qs.length,bookmakers:[...new Set(qs.map(q=>q.bookmaker))],context_sources:current?.body?.sources||{},lineups:Object.values(current?.body?.teams||{}).map(t=>({team:t.team_name,status:t.lineup,injury_report_submitted:t.injury_report_submitted}))});
    const lineupSuppressed=pregameReview.paused(ctx)&&pregameReview.bothConfirmed(g,current);
    if(!lineupSuppressed&&team&&Date.parse(g.starts_at)<=now.getTime()+6*3600000&&await notify(ctx,id('preview',league,g.game_id),league,gameMessage(g,team,base.filter(f=>f.kind==='player').map(f=>f.result),qs),g.starts_at))r.notifications++;
    if(!lineupSuppressed&&Date.parse(g.starts_at)<=now.getTime()+6*3600000){const checked=await notifyValues(valueCtx,g,fs,quotes.filter(q=>q.game_id===g.game_id),validateQuote);r.value_alerts+=checked.sent;r.value_checks.push({game_id:g.game_id,...checked});
     const lineupKey=reanalysis.lineupKey(g,current,now);
     const pricedForecasts=[...fs.filter(f=>f.model_version!==context.VERSION),...contextual];
     const channelResult=await filteredChannel.publish(ctx,g,pricedForecasts,quotes.filter(q=>q.game_id===g.game_id),lineupKey||'initial');
     r.filtered_channel||={qualified:0,sent:0,selections_sent:0};for(const key of ['qualified','sent','selections_sent'])r.filtered_channel[key]+=channelResult[key];
     if(channelResult.held_reasons){r.filtered_channel.held_reasons||={};for(const [reason,n]of Object.entries(channelResult.held_reasons))r.filtered_channel.held_reasons[reason]=(r.filtered_channel.held_reasons[reason]||0)+n;}
     for(const preview of marketPreviews(g,pricedForecasts,qs,now,validateQuote,current))if(await notify(ctx,lineupKey?id('props-lineup-v1',league,g.game_id,lineupKey,preview.key):id('props-analysis-v1',league,g.game_id,preview.key),league,lineupKey?preview.text.replace('pronósticos y cuotas','reanálisis con quintetos · cuotas'):preview.text,preview.expires_at,preview.payload))r.notifications++;
     for(const preview of teamMarketPreviews(g,pricedForecasts,qs,now,validateQuote,current))if(await notify(ctx,id('team-odds-v1',league,g.game_id,lineupKey||'initial',preview.key),league,preview.text,preview.expires_at,preview.payload))r.notifications++;
     if(!lineupKey)r.notifications+=await ps3838Reference.publish(ctx,g,pricedForecasts,quotes.filter(q=>q.game_id===g.game_id),now,id('ps3838-reference-v1',league,g.game_id,lineupKey||'initial'));
     r.notifications+=await context.publishChanges(ctx,g,current);
     if(await reanalysis.publishReanalysis(ctx,g,fs,current,checked,quotes.filter(q=>q.game_id===g.game_id)))r.notifications++;
    }
   }
  }
  const finals=await rest('bk_games?league=eq.'+league+'&status=eq.final&starts_at=gt.'+new Date(now.getTime()-2*86400000).toISOString()+'&select=*');
  for(const g of finals){const nid=id('balance-v1',league,g.game_id,g.box_complete?'box':'score'),marketId=id('market-balance-v2',league,g.game_id,g.box_complete?'box':'score');
   const generalDone=(await rest('bk_notifications?notification_id=eq.'+nid+'&sent_at=not.is.null&select=notification_id')).length;
   const marketPages=await rest('bk_notifications?notification_id=like.'+marketId+':*&order=created_at.asc&select=*');
   if(generalDone&&marketPages.some(n=>n.sent_at&&n.payload.complete))continue;
   const f=await all(rest,'bk_forecasts?league=eq.'+league+'&game_id=eq.'+g.game_id+'&select=*');if(!f.length)continue;
   const players=g.box_complete?await rest('bk_player_box?league=eq.'+league+'&game_id=eq.'+g.game_id+'&select=*'):[];
   const alerts=await rest('bk_value_alerts?league=eq.'+league+'&game_id=eq.'+g.game_id+'&select=*');
   const delivered=alerts.length?await rest('bk_notifications?notification_id=in.('+alerts.map(a=>a.alert_id).join(',')+')&sent_at=not.is.null&select=notification_id'):[];
   const text=balance.message(g,f,players,delivered.length);if(!generalDone&&text&&await notify(ctx,nid,league,text,null,{kind:'basketball_result_balance',game_id:g.game_id,policy:'bk-descriptive-balance-1'}))r.notifications++;
   let priced=marketPages[0]?.payload.balance;
   if(!priced){const candidates=await all(rest,'bk_candidates?league=eq.'+league+'&game_id=eq.'+g.game_id+'&select=*');
    const notifications=await all(rest,'bk_notifications?league=eq.'+league+'&sent_at=not.is.null&created_at=gte.'+new Date(Date.parse(g.starts_at)-24*3600000).toISOString()+'&created_at=lt.'+new Date(g.starts_at).toISOString()+'&select=*');
    const references=await all(rest,'bk_quotes?league=eq.'+league+'&game_id=eq.'+g.game_id+'&bookmaker=eq.ps3838&captured_at=lt.'+new Date(g.starts_at).toISOString()+'&select=*');
    priced=marketBalance.build(g,f,players,candidates,notifications,alerts,references);}
   const pages=marketBalance.messages(g,priced);
   for(let i=0;i<pages.length;i++){const pageId=marketId+':'+(i+1);if(marketPages.some(n=>n.notification_id===pageId&&n.sent_at))continue;
    if(await notify(ctx,pageId,league,pages[i],null,{kind:'basketball_market_balance',game_id:g.game_id,policy:marketBalance.POLICY,complete:i===pages.length-1,...(i===0?{balance:priced}:{})}))r.notifications++;else break;}
  }
  const receipts=await all(rest,'bk_notifications?league=eq.'+league+'&payload->>kind=eq.basketball_market_balance&sent_at=not.is.null&select=notification_id,league,created_at,sent_at,payload');
  const units=marketBalance.ledger(receipts,league);
  if(units.games){
   await rest('bk_state?on_conflict=league,component','POST',{league,component:'units_ledger',checked_at:now.toISOString(),status:'healthy',detail:units},{prefer:'resolution=merge-duplicates,return=minimal'});
   if(await notify(ctx,id('units-ledger-v1',league,units.signature),league,marketBalance.ledgerMessage(units),null,{kind:'basketball_units_ledger',ledger:units}))r.notifications++;
  }
  await rest('bk_state?on_conflict=league,component','POST',{league,component:'analysis',checked_at:now.toISOString(),status:r.insufficient_history||r.blocked_missing_recent_stats?'partial':'healthy',detail:r},{prefer:'resolution=merge-duplicates,return=minimal'});
  if(await notify(ctx,id('value-enabled',league,ADVANCED_VERSION),league,league+' · avisos de valor estimado activados\nEl análisis corre en el VPS cada 5 minutos y utiliza estadísticas avanzadas validadas.\nFiltro: cuota observada hace menos de 5 minutos, EV estimado ≥'+(100*LIMITS.minEV)+'%, ventaja ≥4 puntos porcentuales frente al mercado sin margen y escenario adverso positivo.\nLas alertas indicarán las condiciones de participación y la fuente de la cuota. Modelo experimental: rentabilidad aún no demostrada.'))r.notifications++;
 }return report;
}
module.exports={id,validateQuote,candidate,gameMessage,runAnalysis};

