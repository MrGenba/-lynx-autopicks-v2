'use strict';
const reference=require('./ps3838_reference'),view=require('./pick_format');
const {fingerprint}=require('./fingerprint'),{notifyReference}=require('./notifications');
const {all}=require('./capture');
const review=require('./pregame_review');
const POLICY='bk-channel-edge20-prob60-1',KIND='basketball_filtered_channel';
const FORMAT='compact-pick-3';
const LIMITS=Object.freeze({probability:.60,edge:.20,messageLength:3800});
const pct=x=>(100*x).toFixed(1)+'%',pp=x=>(x>=0?'+':'')+(100*x).toFixed(1)+' pp';
const labels={points:'puntos',rebounds:'rebotes',assists:'asistencias',threes:'triples',pra:'P+R+A',pr:'P+R',pa:'P+A',ra:'R+A'};
const currentTime=ctx=>new Date(ctx.referenceClock?Math.max(ctx.now?.getTime()||0,ctx.referenceClock()):(ctx.now||new Date()).getTime());
function passes(row){return Number.isFinite(row.model?.conditional)&&Number.isFinite(row.edge_price)&&row.model.conditional>LIMITS.probability+1e-12&&row.edge_price>LIMITS.edge+1e-12;}
function identity(q){return fingerprint([q.league,q.game_id,q.bookmaker,q.player_id||null,q.market,q.line,q.selection]);}
function destination(config,league){return config?.enabled===true&&config.botLeague==='NBA'&&Number.isSafeInteger(config.chatId)&&config.chatId<0&&config.leagues?.includes(league);}
function select(g,forecasts,quotes,now){
 const result=[],seen=new Set(),fm=new Map(forecasts.map(f=>[f.forecast_id,f]));
 for(const page of reference.previews(g,forecasts,quotes,now))for(const comp of page.payload.bookmaker_comparisons){
  const f=fm.get(comp.forecast_id);if(!f)continue;
  if(comp.player_id&&(!(f.result.projected_minutes>0)||['OUT','SUSPENDED','INACTIVE'].includes(f.result.availability)))continue;
  for(const book of comp.books)for(const row of book.lines){
   if(!passes(row))continue;const q=row.quote,key=identity(q);if(seen.has(key))continue;
   const expires=Math.min(Date.parse(g.starts_at),Date.parse(q.expires_at),Date.parse(q.captured_at)+(q.bookmaker==='ps3838'?15:5)*60000);
   if(!Number.isFinite(expires)||expires<=now.getTime())continue;seen.add(key);
   const projection=row.model.scope==='REGULATION_ONLY'?f.result.overtime.regulation:f.result;
   const expected_mean=q.player_id?projection.props?.[q.market]?.mean:q.market==='total'?projection.total:q.market==='spread'?projection.margin*(q.selection==='home'?1:-1):null;
   result.push({...row,key,forecast_id:f.forecast_id,model_version:f.model_version,availability:f.result.availability,player_name:f.result.player_name,projected_minutes:f.result.projected_minutes,expected_mean,expected_score:q.market==='moneyline'?{home:projection.home_points,away:projection.away_points}:null,expires_at:new Date(expires).toISOString()});
  }
 }
 return result.sort((a,b)=>b.edge_price-a.edge_price||a.key.localeCompare(b.key));
}
function selection(g,row){const q=row.quote;
 if(q.player_id)return row.player_name+' · '+reference.selectionLabel(q)+' '+labels[q.market];
 if(q.market==='total')return reference.selectionLabel(q)+' puntos totales';
 return (q.selection==='home'?g.home_team:g.away_team)+(q.market==='spread'?' '+(q.line>0?'+':'')+q.line:' gana');
}
function block(g,row){const q=row.quote,lines=['🎯 '+selection(g,row)];
 if(Number.isFinite(row.expected_mean))lines.push('📈 Media esperada: '+(q.market==='spread'&&row.expected_mean>0?'+':'')+row.expected_mean.toFixed(1)+' '+(q.player_id?labels[q.market]:q.market==='total'?'puntos totales':'puntos de margen'));
 else if(q.market==='moneyline'&&[row.expected_score?.away,row.expected_score?.home].every(Number.isFinite))lines.push('📈 Marcador esperado: '+g.away_team+' '+row.expected_score.away.toFixed(1)+' — '+g.home_team+' '+row.expected_score.home.toFixed(1));
 if(q.player_id&&row.pregame_review){const r=row.pregame_review;lines.push('👤 '+(r.role==='STARTER'?'Titular previsto':'Suplente previsto')+' · ⏱ '+row.projected_minutes.toFixed(1)+' min estimados',
  '📰 Noticias revisadas '+view.time(r.checked_at)+' (Madrid)');}
 lines.push('🏦 '+view.book(q.bookmaker)+' · @'+reference.price(q.odds)+(q.bookmaker==='ps3838'?' · ⏳ retrasada':''),
 '📊 Acierto est. '+pct(row.model.conditional)+' · Edge '+pp(row.edge_price));
 const details=[];
 if(Number.isFinite(row.model.p_overtime))details.push('Prórroga est. '+pct(row.model.p_overtime));
 if(row.model.p_push>0)details.push('devolución '+pct(row.model.p_push));
 if(details.length)lines.push('⏱ '+details.join(' · '));
 if(row.regulation_model)lines.push('Sin prórroga: '+pct(row.regulation_model.conditional)+' · edge '+pp(row.edge_regulation)+' (reglas pendientes).');
 if(q.player_id&&!['AVAILABLE','CONFIRMED','NOT_LISTED'].includes(row.availability))lines.push('👤 '+view.availability(row.availability));
 const caveats=[];
 if(q.bookmaker==='ps3838')caveats.push('solo referencia');
 if(q.bookmaker==='betano'&&q.detail?.reference_only)caveats.push('Ontario · reglas de participación pendientes');
 if(q.bookmaker==='winamax.fr')caveats.push('reglas actuales / equivalencia ES sin verificar');
 if(caveats.length)lines.push('ℹ️ '+caveats.join(' · '));
 lines.push('🕒 Cuota '+view.time(q.captured_at)+' · hasta '+view.time(row.expires_at)+' (Madrid)');return lines.join('\n');
}
function pages(g,rows,revision='initial'){
 const header=view.heading(g,revision==='initial'?'PICK':'PICK · REANÁLISIS DE QUINTETOS').join('\n');
 return rows.map(row=>{
  const footer='Modelo experimental · % sin devolución'+(row.quote.player_id?' y si participa.':'.');
  const text=header+'\n\n'+block(g,row)+'\n\n'+footer;
  if(text.length>LIMITS.messageLength)throw Error('FILTERED_CHANNEL_MESSAGE_TOO_LONG');
  return {text,rows:[row],expires_at:row.expires_at};
 });
}
async function publish(ctx,g,forecasts,quotes,revision='initial'){
 const config=ctx.filteredChannel,now=currentTime(ctx),report={qualified:0,sent:0,selections_sent:0};
 if(!destination(config,g.league)||typeof ctx.sendFiltered!=='function')return report;
 if(review.paused(ctx)&&revision!=='initial')return report;
 const loadCurrent=async()=> (await ctx.rest('bk_context_current?league=eq.'+g.league+'&game_id=eq.'+encodeURIComponent(g.game_id)+'&select=*'))[0];
 const enabled=ctx.pregameReview?.enabled===true,current=enabled||review.paused(ctx)?await loadCurrent():null;
 if(review.paused(ctx)&&review.bothConfirmed(g,current))return report;
 const fm=new Map(forecasts.map(f=>[f.forecast_id,f.result]));
 let rows=select(g,forecasts,quotes,now);
 if(enabled){const held={};rows=rows.filter(row=>{const check=review.assess(g,fm.get(row.forecast_id),current,now);row.pregame_review=check;for(const reason of check.reasons)held[reason]=(held[reason]||0)+1;return check.eligible;});report.held_reasons=held;}
 report.qualified=rows.length;if(!rows.length)return report;
 const prefix=[POLICY,String(config.chatId),g.league,g.game_id,fingerprint(revision)].join(':');
 const old=await all(ctx.rest,'bk_notifications?notification_id=like.'+encodeURIComponent(prefix+':*')+'&order=created_at.asc,notification_id.asc&select=notification_id,sent_at,attempts,payload');
 const delivered=new Set(old.filter(n=>n.sent_at).flatMap(n=>n.payload.selection_keys||[])),currentQuotes=new Map(rows.map(r=>[r.key,r]));
 const same=row=>{const fresh=currentQuotes.get(row.key);return fresh&&fresh.forecast_id===row.forecast_id&&fresh.quote.quote_id===row.quote.quote_id&&fresh.quote.captured_at===row.quote.captured_at&&fresh.quote.odds===row.quote.odds;};
 // This route is explicit for both leagues. Generic retries must never send these
 // messages to the original NBA/WNBA destination.
 const channel={...ctx,referenceRateKey:'filtered:'+config.chatId,referenceNotBefore:ctx.filteredChannelNotBefore||{},send:(league,text)=>ctx.sendFiltered(league,text)};ctx.filteredChannelNotBefore=channel.referenceNotBefore;
 // NBA and WNBA share the same physical channel and its delivery budget.
 const publishPage=async(id,payload)=>{
  if(Date.parse(payload.expires_at)<=currentTime(ctx).getTime())return false;
  if(enabled)channel.send=async(league,text)=>{
   const latest=await loadCurrent(),at=currentTime(ctx);
   if(Date.parse(payload.expires_at)<=at.getTime()||review.paused(ctx)&&review.bothConfirmed(g,latest)||payload.rows.some(row=>!review.assess(g,fm.get(row.forecast_id),latest,at).eligible))return {ok:false};
   return ctx.sendFiltered(league,text);
  };
  const sent=await notifyReference(channel,id,g.league,payload.text,payload.expires_at,payload);
  if(sent){report.sent++;report.selections_sent+=payload.rows.length;payload.selection_keys.forEach(k=>delivered.add(k));}return sent;
 };
 for(const n of old.filter(n=>!n.sent_at)){
  const p=n.payload;
  if(n.attempts>=5||p.format_version!==FORMAT||p.kind!==KIND||p.destination_chat_id!==config.chatId||p.revision!==revision||Date.parse(p.expires_at)<=now.getTime()||!p.rows?.length||p.rows.some(r=>delivered.has(r.key)||!same(r)))continue;
  if(!await publishPage(n.notification_id,p))return report;
 }
 for(const page of pages(g,rows.filter(r=>!delivered.has(r.key)),revision)){
  const id=prefix+':'+fingerprint([FORMAT,page.rows.map(r=>[r.key,r.forecast_id,r.quote.quote_id,r.quote.captured_at,r.quote.odds])]);
  if(old.some(n=>n.notification_id===id&&(n.sent_at||n.attempts>=5)))continue;
  const payload={kind:KIND,format_version:FORMAT,policy:POLICY,game_id:g.game_id,league:g.league,destination_chat_id:config.chatId,bot_league:'NBA',revision,reference_only:true,news_review_policy:enabled?review.POLICY:null,selection_keys:page.rows.map(r=>r.key),...page};
  if(!await publishPage(id,payload))break;
 }
 return report;
}
// Evaluate newly captured Winamax prices before historical recalculation and
// long comparison pages. Reuse only a sealed generation for the current context.
async function publishFresh(ctx){
 const report={checked:0,qualified:0,sent:0,selections_sent:0,leagues:{}};
 if(!['NBA','WNBA'].some(l=>destination(ctx.filteredChannel,l))||typeof ctx.sendFiltered!=='function')return report;
 const now=currentTime(ctx),{rest}=ctx,context=require('./context'),{lineupKey}=require('./reanalysis');
 const quotes=await all(rest,'bk_quotes?bookmaker=eq.winamax.fr&captured_at=gte.'+new Date(now.getTime()-5*60000).toISOString()+'&captured_at=lte.'+now.toISOString()+'&expires_at=gt.'+now.toISOString()+'&order=captured_at.asc,quote_id.asc&select=*');
 if(!quotes.length)return report;
 const ids=[...new Set(quotes.map(q=>q.game_id))].map(encodeURIComponent).join(',');
 const [games,missing,contexts]=await Promise.all([
  rest('bk_games?league=in.(NBA,WNBA)&game_id=in.('+ids+')&status=eq.scheduled&starts_at=gt.'+now.toISOString()+'&starts_at=lte.'+new Date(now.getTime()+6*3600000).toISOString()+'&order=starts_at.asc&select=*'),
  rest('bk_games?league=in.(NBA,WNBA)&box_complete=eq.false&status=in.(scheduled,live,final)&starts_at=gt.'+new Date(now.getTime()-7*86400000).toISOString()+'&starts_at=lt.'+new Date(now.getTime()-5*3600000).toISOString()+'&select=league,home_team_id,away_team_id'),
  rest('bk_context_current?league=in.(NBA,WNBA)&game_id=in.('+ids+')&select=*')
 ]);
 const blocked=new Set(missing.flatMap(g=>[g.league+':'+g.home_team_id,g.league+':'+g.away_team_id]));
 for(const g of games){
  const at=currentTime(ctx),current=contexts.find(c=>c.league===g.league&&c.game_id===g.game_id);
  if(!destination(ctx.filteredChannel,g.league)||blocked.has(g.league+':'+g.home_team_id)||blocked.has(g.league+':'+g.away_team_id)||!context.currentOK(current,at))continue;
  const prefix='bk_forecasts?league=eq.'+g.league+'&game_id=eq.'+encodeURIComponent(g.game_id)+'&model_version=eq.'+context.VERSION+'&result->context->>revision=eq.'+encodeURIComponent(current.body.model_revision)+'&as_of=lte.'+at.toISOString()+'&created_at=lte.'+at.toISOString();
  const latest=(await rest(prefix+'&order=as_of.desc,forecast_id.asc&limit=1&select=generation:result->context->>input_revision'))[0];
  if(!latest?.generation)continue;
  const rows=await all(rest,prefix+'&result->context->>input_revision=eq.'+encodeURIComponent(latest.generation)+'&order=forecast_id.asc&select=*');
  const forecasts=context.latest(rows,current);if(!forecasts.length)continue;
  report.checked++;
  const result=await publish(ctx,g,forecasts,quotes.filter(q=>q.league===g.league&&q.game_id===g.game_id),lineupKey(g,current,at)||'initial');
  const league=report.leagues[g.league]||={qualified:0,sent:0,selections_sent:0};
  for(const key of ['qualified','sent','selections_sent'])report[key]+=result[key];
  for(const key of ['qualified','sent','selections_sent'])league[key]+=result[key];
  if(result.held_reasons){league.held_reasons||={};for(const [reason,n]of Object.entries(result.held_reasons))league.held_reasons[reason]=(league.held_reasons[reason]||0)+n;}
 }
 return report;
}
module.exports={POLICY,KIND,FORMAT,LIMITS,passes,identity,destination,select,pages,publish,publishFresh};

