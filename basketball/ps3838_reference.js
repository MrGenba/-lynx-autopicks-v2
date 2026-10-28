'use strict';
const {PROPS,MODELS,probability}=require('./model');
const context=require('./context');
const {VERSION:ADVANCED}=require('./advanced_model');
const view=require('./pick_format');
const overtime=require('./overtime');
const {notifyReference:notify}=require('./notifications');
const labels={points:'puntos',rebounds:'rebotes',assists:'asistencias',threes:'triples',pra:'P+R+A',pr:'P+R',pa:'P+A',ra:'R+A'};
const norm=s=>String(s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
const price=n=>n.toFixed(3).replace(/0$/,'');
const BOOKS=['bet365','betano','winamax.fr','ps3838'];
const FRESH_MINUTES=5;
const FORMAT_VERSION='bookmaker-lines-3';
const MESSAGE_LIMIT=3900;
const percent=n=>(100*n).toFixed(1)+'%';
const points=n=>(n>0?'+':'')+(100*n).toFixed(1)+' pp';
function valid(q,g,now=null){
 const captured=Date.parse(q.captured_at),start=Date.parse(g.starts_at);
 if(q.league!==g.league||q.game_id!==g.game_id||q.bookmaker!=='ps3838'||q.source!=='ps3838_public_delayed'||q.period!=='full_game'||
  q.detail?.reference_only!==true||q.detail?.delayed!==true||!q.detail?.bookmaker_event_id||
  ![q.odds,q.opposite_odds].every(x=>Number.isFinite(x)&&x>1&&x<=1000)||!Number.isFinite(captured)||captured>=start)return false;
 if(now&&(g.status!=='scheduled'||start<=now.getTime()||captured>now.getTime()||captured<now.getTime()-15*60000||!(Date.parse(q.expires_at)>now.getTime())))return false;
 if(q.player_id){if(!PROPS[q.market]||q.detail.identity_status!=='EXACT_NAME_IN_GAME_FORECAST'||!q.detail.player_name)return false;}
 else if(!['moneyline','total','spread'].includes(q.market)||q.detail.player_name)return false;
 if(q.market!=='moneyline'&&(!Number.isFinite(q.line)||Math.abs(q.line)>1000||q.line*2!==Math.round(q.line*2)||(q.market!=='spread'&&q.line<0)))return false;
 return (q.player_id||q.market==='total'?['over','under']:['home','away']).includes(q.selection);
}
function pairs(g,quotes,now=null){
 const validQuotes=quotes.filter(q=>valid(q,g,now)),out=[];
 for(const q of validQuotes.filter(q=>['home','over'].includes(q.selection))){
  const opposite=q.selection==='home'?'away':'under';
  const candidates=validQuotes.filter(p=>p.player_id===q.player_id&&p.market===q.market&&p.selection===opposite&&
   (q.market==='spread'?p.line===-q.line:p.line===q.line)&&p.captured_at===q.captured_at&&p.detail.bookmaker_event_id===q.detail.bookmaker_event_id&&
   p.odds===q.opposite_odds&&p.opposite_odds===q.odds&&(!q.player_id||norm(q.detail.player_name)===norm(p.detail.player_name)));
  if(candidates.length!==1)continue;
  out.push({q,pair:candidates[0]});
 }
 // Pick by time and price balance only, never by an outcome or apparent EV.
 return out.sort((a,b)=>Date.parse(b.q.captured_at)-Date.parse(a.q.captured_at)||Math.abs(a.q.odds-a.pair.odds)-Math.abs(b.q.odds-b.pair.odds)||a.q.quote_id.localeCompare(b.q.quote_id));
}
function teamPairs(entries){const seen=new Set();return entries.filter(e=>!e.q.player_id&&!seen.has(e.q.market)&&seen.add(e.q.market));}
function lineText(g,q){return q.player_id?q.detail.player_name+' · '+labels[q.market]+' '+(q.selection==='over'?'más de ':'menos de ')+q.line:
 q.market==='total'?'Total '+(q.selection==='over'?'más de ':'menos de ')+q.line:(q.selection==='home'?g.home_team:g.away_team)+(q.market==='spread'?' '+(q.line>0?'+':'')+q.line:' gana');}
function pairText(g,{q,pair}){return lineText(g,q)+' @'+price(q.odds)+' / '+lineText(g,pair)+' @'+price(pair.odds);}
// Milestones are stored canonically as N - 0.5, never as an integer line with a push.
function normalizeQuote(q){
 if(!q)return null;
 const plus=typeof q.line==='string'&&/^[1-9]\d*\+$/.test(q.line)?Number(q.line.slice(0,-1)):null;
 if(plus){
  if(!q.player_id||q.selection!=='over'||!PROPS[q.market])return null;
  if(q.detail?.line_type&&q.detail.line_type!=='at_least')return null;
  if(q.detail?.threshold!==undefined&&q.detail.threshold!==plus)return null;
  q={...q,line:plus-.5,detail:{...q.detail,line_type:'at_least',threshold:plus}};
 }
 if(q.detail?.line_type==='at_least'){
  const n=q.detail.threshold;
  if(!q.player_id||q.selection!=='over'||!Number.isSafeInteger(n)||n<1||q.line!==n-.5)return null;
 }else if(q.detail?.line_type&&q.detail.line_type!=='over_under')return null;
 if(q.market==='moneyline')return q.line==null&&['home','away'].includes(q.selection)?q:null;
 if(!Number.isFinite(q.line)||Math.abs(q.line)>1000||q.line*2!==Math.round(q.line*2)||(q.market!=='spread'&&q.line<0))return null;
 return (q.player_id||q.market==='total'?['over','under']:['home','away']).includes(q.selection)?q:null;
}
function quoteProbability(q,f){
 if(f?.status!=='OK')return null;
 const values=q.player_id?[f.props?.[q.market]?.mean,f.props?.[q.market]?.variance]:q.market==='moneyline'?[f.p_home,f.p_away]:q.market==='total'?[f.total,f.total_variance]:[f.margin,f.margin_variance];
 if(!values.every(Number.isFinite)||(q.player_id&&values.some(n=>n<0))||(q.market!=='moneyline'&&values[1]<0))return null;
 try{
  const p=probability(q,f);
  if(![p.p_win,p.p_push,p.p_loss].every(n=>Number.isFinite(n)&&n>=0&&n<=1)||Math.abs(p.p_win+p.p_push+p.p_loss-1)>1e-6||1-p.p_push<1e-9)return null;
  return {...p,conditional:p.p_win/(1-p.p_push),...(f.overtime?.status==='APPLIED'?{scope:overtime.scope(q),p_overtime:f.overtime.p_any}:{})};
 }catch(_){return null;}
}
function publicBetanoReference(q){
 return q.bookmaker==='betano'&&q.source==='betano_public_ontario'&&q.detail?.reference_only===true&&
  q.detail?.jurisdiction==='Ontario'&&q.detail?.rules_status==='OVERTIME_UNVERIFIED'&&q.includes_overtime===false&&
  /^https:\/\/www\.betano\.ca\/game-odds\/[^/]+\/\d+\/$/.test(q.source_url||'');
}
function currentQuote(q,anchor,g,now){
 return BOOKS.includes(q.bookmaker)&&q.bookmaker!== 'ps3838'&&g.status==='scheduled'&&Date.parse(g.starts_at)>now.getTime()&&
  (q.player_id?!!PROPS[q.market]&&!!q.detail?.player_name:['moneyline','spread','total'].includes(q.market)&&!q.detail?.player_name)&&
  q.league===g.league&&q.game_id===g.game_id&&
  (q.player_id||null)===(anchor.player_id||null)&&q.market===anchor.market&&q.period==='full_game'&&(q.includes_overtime===true||publicBetanoReference(q))&&
  q.detail?.delayed!==true&&(q.detail?.reference_only!==true||publicBetanoReference(q))&&typeof q.source==='string'&&!!q.source&&
  typeof q.source_url==='string'&&/^https?:\/\//.test(q.source_url)&&Number.isFinite(q.odds)&&q.odds>1&&q.odds<=1000&&
  Date.parse(q.captured_at)<=now.getTime()&&Date.parse(q.captured_at)>=now.getTime()-FRESH_MINUTES*60000&&Date.parse(q.expires_at)>now.getTime()&&
  (!anchor.player_id||(q.detail?.identity_status==='EXACT_NAME_IN_GAME_FORECAST'&&norm(q.detail.player_name)===norm(anchor.detail.player_name)));
}
function latestPrices(quotes){
 const grouped=new Map();
 for(const q of quotes){const key=[q.line,q.selection,q.detail?.line_type||'over_under'].join(':');if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(q);}
 const result=[];
 for(const rows of grouped.values()){
  const newest=Math.max(...rows.map(q=>Date.parse(q.captured_at))),latest=rows.filter(q=>Date.parse(q.captured_at)===newest);
  const signatures=new Set(latest.map(q=>JSON.stringify([q.odds,q.opposite_odds,q.source,q.source_url,q.detail?.bookmaker_event_id,q.detail?.line_type,q.detail?.threshold])));
  if(signatures.size===1)result.push(latest.sort((a,b)=>String(a.quote_id).localeCompare(String(b.quote_id)))[0]);
 }
 return result.sort((a,b)=>(a.market==='spread'?(a.selection==='home'?a.line:-a.line)-(b.selection==='home'?b.line:-b.line):a.line-b.line)||Number(['under','away'].includes(a.selection))-Number(['under','away'].includes(b.selection)));
}
function counterpart(q,quotes){
 const opposite={over:'under',under:'over',home:'away',away:'home'}[q.selection];
 const matches=quotes.filter(p=>p.selection===opposite&&(q.market==='moneyline'||p.line===(q.market==='spread'?-q.line:q.line))&&
  p.source===q.source&&p.source_url===q.source_url&&(p.detail?.bookmaker_event_id||null)===(q.detail?.bookmaker_event_id||null)&&
  Math.abs(Date.parse(p.captured_at)-Date.parse(q.captured_at))<=1000&&p.odds===q.opposite_odds&&p.opposite_odds===q.odds);
 return matches.length===1?matches[0]:null;
}
function assess(q,f,quotes){
 const model=quoteProbability(q,f),pair=counterpart(q,quotes),market=pair?(1/q.odds)/(1/q.odds+1/pair.odds):null;
 const regulation_model=model?.scope==='ASSUMING_OVERTIME_INCLUDED'?quoteProbability({...q,includes_overtime:false,detail:{...q.detail,rules_status:'REGULATION_ONLY_VERIFIED'}},f):null;
 return {quote:q,model,break_even:1/q.odds,edge_price:model?model.conditional-1/q.odds:null,
  ...(regulation_model?{regulation_model,edge_regulation:regulation_model.conditional-1/q.odds}:{}),
  market_probability_no_vig:market,edge_no_vig:model&&market!==null?model.conditional-market:null,
  expected_return:model?model.p_win*(q.odds-1)-model.p_loss:null};
}
function comparisons(entry,g,quotes,now,referencePairs=pairs(g,quotes,now)){
 const anchor=entry.q;
 return {books:BOOKS.map(book=>{
  const candidates=book==='ps3838'?referencePairs.flatMap(e=>[e.q,e.pair]).filter(q=>(q.player_id||null)===(anchor.player_id||null)&&q.market===anchor.market&&(!q.player_id||norm(q.detail.player_name)===norm(anchor.detail.player_name))):
   quotes.filter(q=>q.bookmaker===book).map(normalizeQuote).filter(q=>q&&currentQuote(q,anchor,g,now));
  const prices=latestPrices(candidates);
  return {bookmaker:book,status:prices.length?'OBSERVED':'NO_CURRENT_CAPTURE',delayed:book==='ps3838',lines:prices.map(q=>assess(q,entry.f?.result,prices))};
 })};
}
function subjectHeading(entry){
 const {q,f}=entry,player=!!q.player_id,name=player?q.detail.player_name+' · '+labels[q.market]:{moneyline:'Ganador',spread:'Hándicap',total:'Total de puntos'}[q.market];
 const lines=['',view.divider,'📌 '+name],projected=f?.result?.props?.[q.market]?.mean;
 if(Number.isFinite(projected))lines.push('📊 Media prevista: '+projected.toFixed(1));
 if(f?.result?.overtime?.status==='APPLIED'){const ot=f.result.overtime;lines.push('⏱ Prórroga estimada: '+percent(ot.p_any)+(player&&ot.regulation.props?.[q.market]?' · media reglamentaria '+ot.regulation.props[q.market].mean.toFixed(1):''));}
 if(player)lines.push('👤 Disponibilidad: '+view.availability(f?.result?.availability));
 return lines;
}
function selectionLabel(q){
 if(q.detail?.line_type==='at_least')return q.detail.threshold+'+';
 if(q.player_id||q.market==='total')return (q.selection==='over'?'Más de ':'Menos de ')+q.line;
 return (q.selection==='home'?'Local':'Visitante')+(q.market==='spread'?' '+(q.line>0?'+':'')+q.line:' gana');
}
function rowText(row){
 const {quote:q,model}=row;
 return '• '+selectionLabel(q)+' @'+price(q.odds)+' · 🎯 '+(model?percent(model.conditional):'no calculable')+
  ' · Edge cuota: '+(row.edge_price===null?'no calculable':points(row.edge_price))+
  (model?.p_push>0?' · ↩ '+percent(model.p_push):'')+(row.regulation_model?' · Reg.: '+percent(row.regulation_model.conditional)+' / edge '+points(row.edge_regulation):'')+' · 🕒 '+view.time(q.captured_at,true);
}
function pagesFor(g,key,details){
 const hasDelayed=details.some(d=>d.comparison.books.some(b=>b.delayed&&b.status==='OBSERVED'));
 const header=[...view.heading(g,'CUOTAS · TODAS LAS LÍNEAS'),(hasDelayed?'⏳ REFERENCIA RETRASADA':'📋 COMPARATIVA')+' · '+(key==='players'?'JUGADORES':'PARTIDO'),'Solo referencia · no activa apuestas de valor.'];
 const footer=['',view.divider,'📐 Edge cuota = modelo − 1/cuota (pp); incluye el margen. Acierto estimado sin devolución'+(key==='players'?', condicionado a participar.':'.'),
  '↩ Probabilidad de devolución. '+(hasDelayed?'PS3838 ⏳: precio retrasado y prórrogas sin verificar. ':'')+'Horas de Madrid. Modelo experimental.'];
 if(details.some(d=>d.comparison.books.some(b=>b.bookmaker==='winamax.fr'&&b.status==='OBSERVED')))footer.push('Winamax.fr: equivalencia con España y reglas actuales sin verificar.');
 if(details.some(d=>d.comparison.books.some(b=>b.lines.some(r=>publicBetanoReference(r.quote)))))footer.push('Betano Ontario: prórrogas y reglas de participación sin verificar; solo referencia.');
 if(details.some(d=>d.comparison.books.some(b=>b.lines.some(r=>r.regulation_model))))footer.push('Probabilidad y edge principales suponen que cuenta prórroga; Reg. muestra la alternativa sin prórroga.');
 const pages=[];let page={body:[],units:[]},lastSubject=null,lastBook=null;
 const finish=()=>{if(page.units.length)pages.push(page);page={body:[],units:[]};lastSubject=null;lastBook=null;};
 for(const detail of details){
  for(const book of detail.comparison.books){
   for(const row of book.lines.length?book.lines:[null]){
    const unit={detail,book,row},subject=JSON.stringify([detail.entry.q.player_id||null,detail.entry.q.market]);
    const render=()=>[...(lastSubject!==subject?subjectHeading(detail.entry):[]),...(lastSubject!==subject||lastBook!==book.bookmaker?['🏦 '+view.book(book.bookmaker)+(book.delayed?' ⏳':'')]:[]),row?rowText(row):'   Sin cuota vigente capturada.'];
    let added=render();
    if([...header,...page.body,...added,...footer].join('\n').length+40>MESSAGE_LIMIT&&page.units.length){finish();added=render();}
    page.body.push(...added);page.units.push(unit);lastSubject=subject;lastBook=book.bookmaker;
   }
  }
 }
 finish();
 const observed=details.flatMap(d=>d.comparison.books.flatMap(b=>b.lines.map(l=>l.quote)));
 const expires=new Date(Math.min(Date.parse(g.starts_at),...observed.flatMap(q=>[Date.parse(q.expires_at),Date.parse(q.captured_at)+(q.bookmaker==='ps3838'?15:FRESH_MINUTES)*60000]))).toISOString();
 return pages.map((p,i)=>{
  const text=[...header,...(pages.length>1?['📄 '+(i+1)+'/'+pages.length]:[]),...p.body,...footer].join('\n');
  if(text.length>4096)throw Error('REFERENCE_MESSAGE_TOO_LONG');
  const comparisons=[];
  for(const detail of details){
   const units=p.units.filter(u=>u.detail===detail);if(!units.length)continue;
   const e=detail.entry;
   comparisons.push({player_id:e.q.player_id,market:e.q.market,forecast_id:e.f?.forecast_id||null,model_version:e.f?.model_version||null,
    books:detail.comparison.books.filter(b=>units.some(u=>u.book===b)).map(b=>({...b,lines:units.filter(u=>u.book===b&&u.row).map(u=>u.row)}))});
  }
  return {key:i?key+':'+(i+1):key,text,expires_at:expires,payload:{kind:'basketball_ps3838_reference',format_version:FORMAT_VERSION,game_id:g.game_id,reference_only:true,
   page:i+1,pages:pages.length,reference_quotes:p.units.filter(u=>u.row?.quote.bookmaker==='ps3838').map(u=>u.row.quote),bookmaker_comparisons:comparisons}};
 });
}
function previews(g,forecasts,quotes,now){
 if(g.status!=='scheduled'||!(Date.parse(g.starts_at)>now.getTime()))return [];
 const references=pairs(g,quotes,now);
 const rank={[context.VERSION]:3,[ADVANCED]:2,[MODELS.baseline.version]:1};
 const rows=forecasts.filter(f=>f.league===g.league&&f.game_id===g.game_id&&rank[f.model_version]&&f.result?.status==='OK'&&
  Date.parse(f.as_of)<=now.getTime()&&Date.parse(f.created_at||f.as_of)<=now.getTime()).sort((a,b)=>rank[b.model_version]-rank[a.model_version]||Date.parse(b.as_of)-Date.parse(a.as_of));
 const forecastFor=q=>rows.find(f=>(f.player_id||null)===(q.player_id||null)&&(!q.player_id||norm(f.result.player_name)===norm(q.detail.player_name)));
 const direct=quotes.map(normalizeQuote).filter(q=>q&&currentQuote(q,q,g,now)&&(!q.player_id||forecastFor(q))).map(q=>({q}));
 const subjects=new Map();
 for(const entry of [...references,...direct]){
  const key=JSON.stringify([entry.q.player_id||null,entry.q.market]);
  if(!subjects.has(key))subjects.set(key,{...entry,f:forecastFor(entry.q)});
 }
 const markets=Object.keys(PROPS),players=[...subjects.values()].filter(e=>e.q.player_id);
 players.sort((a,b)=>(b.f?.result.projected_minutes||0)-(a.f?.result.projected_minutes||0)||norm(a.q.detail.player_name).localeCompare(norm(b.q.detail.player_name))||markets.indexOf(a.q.market)-markets.indexOf(b.q.market));
 const teams=[...subjects.values()].filter(e=>!e.q.player_id);
 return [['team',teams],['players',players]].filter(([,items])=>items.length).flatMap(([key,items])=>
  pagesFor(g,key,items.map(entry=>({entry,comparison:comparisons(entry,g,quotes,now,references)}))));
}
// Freeze continuation pages with the first delivery. Later price updates must not
// append a different tail to an earlier message, or resend legacy comparisons.
async function publish(ctx,g,forecasts,quotes,now,prefix,options={}){
 const fresh=previews(g,forecasts,quotes,now).map(p=>({...p,text:options.title?p.text.replace('CUOTAS · TODAS LAS LÍNEAS',options.title):p.text,payload:{...p.payload,...options.payload}}));let sent=0;
 for(const group of ['team','players']){
  const id=prefix+':'+group,existing=(await ctx.rest('bk_notifications?notification_id=eq.'+encodeURIComponent(id)+'&select=payload,sent_at'))[0];
  let first,continuations;
  if(existing){
   if(existing.payload.format_version!==FORMAT_VERSION)continue;
   first={text:existing.payload.text,expires_at:existing.payload.expires_at,payload:existing.payload};
   continuations=existing.payload.continuation_pages||[];
   if(!existing.sent_at){
    if(Date.parse(first.expires_at)<=now.getTime()||!await notify(ctx,id,g.league,first.text,first.expires_at,first.payload))continue;
    sent++;
   }
  }else{
   const groupPages=fresh.filter(p=>p.key===group||p.key.startsWith(group+':'));if(!groupPages.length)continue;
   [first,...continuations]=groupPages;
   if(!await notify(ctx,id,g.league,first.text,first.expires_at,{...first.payload,continuation_pages:continuations}))continue;
   sent++;
  }
  for(const p of continuations){
   if(Date.parse(p.expires_at)<=now.getTime())continue;
   if(await notify(ctx,prefix+':'+p.key,g.league,p.text,p.expires_at,p.payload))sent++;
  }
 }
 return sent;
}
module.exports={valid,pairs,teamPairs,pairText,previews,publish,price,norm,BOOKS,FORMAT_VERSION,MESSAGE_LIMIT,normalizeQuote,quoteProbability,currentQuote,latestPrices,counterpart,assess,comparisons,selectionLabel};

