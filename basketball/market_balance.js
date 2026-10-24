'use strict';
const {PROPS,MODELS}=require('./model');
const {VERSION:CONTEXT}=require('./context');
const {VERSION:ADVANCED}=require('./advanced_model');
const POLICY='bk-market-balance-1';
const labels={points:'puntos',rebounds:'rebotes',assists:'asistencias',threes:'triples',pra:'P+R+A',pr:'P+R',pa:'P+A',ra:'R+A',moneyline:'ganador',total:'total',spread:'hándicap'};
const fixed=x=>Number.isFinite(x)?x.toFixed(2):'—';
const before=(t,g)=>Number.isFinite(Date.parse(t))&&Date.parse(t)<Date.parse(g.starts_at);
const norm=s=>String(s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
const subject=r=>[r.bookmaker,r.player_id||'team',r.market].join(':');
function usableQuote(q,g,at){
 return q?.league===g.league&&q.game_id===g.game_id&&q.period==='full_game'&&q.includes_overtime===true&&q.odds>1&&Number.isFinite(q.odds)&&
  q.source!=='ps3838_public_delayed'&&!q.detail?.delayed&&!q.detail?.reference_only&&before(q.captured_at,g)&&
  Date.parse(q.captured_at)<=Date.parse(at)+1000&&Date.parse(q.captured_at)>=Date.parse(at)-15*60000&&Date.parse(q.expires_at)>Date.parse(at)&&
  (q.player_id?!!PROPS[q.market]:['moneyline','spread','total'].includes(q.market));
}
function settle(g,row,players){
 let actual=null,result='PENDING';
 if(g.status==='cancelled')result='VOID';
 else if(g.status==='final'){
  if(row.player_id){
   const p=players.find(p=>p.league===g.league&&p.game_id===g.game_id&&p.player_id===row.player_id),fields=PROPS[row.market];
   if(!g.box_complete||!p)result='MISSING';
   else if(p.did_not_play||p.minutes===0)result='DNP';
   else if(!fields||!fields.every(k=>Number.isFinite(p.stats?.[k])))result='MISSING';
   else actual=fields.reduce((s,k)=>s+p.stats[k],0);
  }else if([g.home_score,g.away_score].every(Number.isFinite))actual=row.market==='total'?g.home_score+g.away_score:g.home_score-g.away_score;
  if(actual!==null){
   const diff=row.player_id||row.market==='total'?(row.selection==='over'?actual-row.line:row.line-actual):
    (row.selection==='home'?actual:-actual)+(row.market==='spread'?row.line:0);
   result=diff>0?'WIN':diff<0?'LOSS':'PUSH';
  }
 }
 return {...row,actual,result,paper_units:result==='WIN'?row.odds-1:result==='LOSS'?-1:['PUSH','DNP','VOID'].includes(result)?0:null};
}
function summary(rows){
 const counts={WIN:0,LOSS:0,PUSH:0,DNP:0,VOID:0,MISSING:0,PENDING:0};for(const r of rows)counts[r.result]++;
 const n=counts.WIN+counts.LOSS,staked=n+counts.PUSH,units=rows.reduce((s,r)=>s+(r.paper_units??0),0);
 return {...counts,total:rows.length,accuracy:n?counts.WIN/n:null,paper_staked:staked,paper_units:units,paper_roi:staked?units/staked:null};
}
// Read the exact historical text for older deliveries that did not seal structured selections.
// Prices, side and line come from that message, never from mutable current quotes.
function legacySelections(n,g,forecasts){
 if(n.payload?.kind!=='basketball_market_preview')return [];
 const parts=n.notification_id.split(':');if(parts[1]!==g.league||parts[2]!==g.game_id)return [];
 const text=n.payload.text||'',bookmaker=text.split('\n')[0].split(' · ').at(-1),result=[];
 const re=/^(.+?) · (puntos|rebotes|asistencias|triples|P\+R\+A|P\+R|P\+A|R\+A) (-?\d+(?:\.\d+)?) · lectura[^\n]*\n([\s\S]*?)(?=\n\n|(?![\s\S]))/gm;
 for(const m of text.matchAll(re)){
  const market=Object.keys(labels).find(k=>labels[k]===m[2]),line=Number(m[3]),block=m[4];
  const side=/Pronóstico del modelo: (más|menos) de (-?\d+(?:\.\d+)?)\./.exec(block);
  const prices=/Más: cuota (\d+(?:\.\d+)?) · prob\. ([\d.]+)%[\s\S]*?Menos: cuota (\d+(?:\.\d+)?) · prob\. ([\d.]+)%/.exec(block);
  if(!side||!prices||Number(side[2])!==line)continue;
  const ids=[...new Set(forecasts.filter(f=>f.league===g.league&&f.game_id===g.game_id&&f.player_id&&before(f.as_of,g)&&before(f.created_at,g)&&norm(f.result?.player_name)===norm(m[1])).map(f=>f.player_id))];
  if(ids.length!==1)continue;
  const over=side[1]==='más',projection=/Proyección: ([\d.]+)/.exec(block);
  result.push({league:g.league,game_id:g.game_id,player_id:ids[0],player_name:m[1],market,line,selection:over?'over':'under',odds:Number(prices[over?1:3]),p_win:Number(prices[over?2:4])/100,
   projected:projection?Number(projection[1]):null,bookmaker,notification_id:n.notification_id,message_id:n.message_id,as_of:n.created_at,sent_at:n.sent_at,origin:'LEGACY_DELIVERED_TEXT',informational:true});
 }
 return result;
}
function publishedSelections(g,notifications,forecasts,players,alerts=[]){
 const rows=[];
 for(const n of notifications){
  if(n.league!==g.league||!before(n.sent_at,g)||!before(n.created_at,g))continue;
  if(n.payload?.game_id===g.game_id&&Array.isArray(n.payload.selections)){
   for(const r of n.payload.selections){const q=r.quote_snapshot;
    if(!usableQuote(q,g,n.created_at))continue;
    rows.push({...r,...q,notification_id:n.notification_id,message_id:n.message_id,as_of:n.created_at,sent_at:n.sent_at,origin:'SEALED_DELIVERY',informational:true});
   }
  }else rows.push(...legacySelections(n,g,forecasts));
 }
 // One last delivered forecast per bookmaker/player/market. Revisions are not extra bets.
 rows.sort((a,b)=>Date.parse(a.sent_at)-Date.parse(b.sent_at)||a.notification_id.localeCompare(b.notification_id));
 const latest=new Map();for(const r of rows)latest.set(subject(r),r);
 const value=[];
 for(const a of alerts){const n=notifications.find(n=>n.notification_id===a.alert_id);
  if(a.league!==g.league||a.game_id!==g.game_id||!n||!before(n.sent_at,g)||!before(n.created_at,g)||!before(a.as_of,g)||!usableQuote(a.quote_snapshot,g,a.as_of))continue;
  value.push(settle(g,{...a.quote_snapshot,player_name:a.decision?.forecast?.player_name,notification_id:n.notification_id,message_id:n.message_id,as_of:a.as_of,origin:'VALUE_ALERT',informational:false},players));
 }
 return {informational:[...latest.values()].map(r=>settle(g,r,players)),value};
}
function evaluatedSelections(g,candidates,players){
 // Fixed descriptive policy: context > advanced > baseline; last paired pregame revision,
 // one line and the more probable side per book/subject/market. Outcomes are not consulted.
 const grouped=new Map(),rank={[CONTEXT]:3,[ADVANCED]:2,[MODELS.baseline.version]:1};
 for(const c of candidates){
  if(c.league!==g.league||c.game_id!==g.game_id||!rank[c.model_version]||!before(c.as_of,g)||!before(c.created_at,g)||!usableQuote(c.quote_snapshot,g,c.as_of))continue;
  const key=[subject({...c,bookmaker:c.quote_snapshot.bookmaker}),c.quote_snapshot.source,c.model_version,c.forecast?.context?.revision||'',c.market==='spread'?Math.abs(c.line):c.line,c.quote_snapshot.captured_at].join('|');
  if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(c);
 }
 const paired=[];
 for(const rows of grouped.values()){
  const a=rows.find(c=>['over','home'].includes(c.selection)),b=rows.find(c=>['under','away'].includes(c.selection));
  if(!a||!b||a.quote_snapshot.opposite_odds!==b.odds||b.quote_snapshot.opposite_odds!==a.odds||![a.p_win,b.p_win].every(Number.isFinite))continue;
  const c=a.p_win>=b.p_win?a:b,q=c.quote_snapshot;
  paired.push({...q,candidate_id:c.candidate_id,model_version:c.model_version,player_name:c.forecast?.player_name,projected:c.player_id?c.forecast.props?.[c.market]?.mean:c.market==='total'?c.forecast.total:c.forecast.margin,
   p_win:c.p_win,ev:c.ev,verdict:c.verdict,as_of:c.as_of,created_at:c.created_at,origin:'EVALUATED_NOT_NECESSARILY_PUBLISHED',informational:true});
 }
 paired.sort((a,b)=>rank[a.model_version]-rank[b.model_version]||Date.parse(a.as_of)-Date.parse(b.as_of)||Date.parse(a.created_at)-Date.parse(b.created_at)||a.candidate_id.localeCompare(b.candidate_id));
 const latest=new Map();for(const r of paired)latest.set(subject(r),r);
 return [...latest.values()].map(r=>settle(g,r,players));
}
function build(g,forecasts,players,candidates,notifications,alerts=[]){
 const published=publishedSelections(g,notifications,forecasts,players,alerts),evaluated=evaluatedSelections(g,candidates,players);
 return {policy:POLICY,game_id:g.game_id,league:g.league,published:published.informational,value:published.value,evaluated,
  summaries:{published:summary(published.informational),value:summary(published.value),evaluated:summary(evaluated),player_published:summary(published.informational.filter(r=>r.player_id)),player_evaluated:summary(evaluated.filter(r=>r.player_id))}};
}
function selectionText(g,r){return r.player_id?r.player_name+' · '+labels[r.market]+' '+(r.selection==='over'?'más de ':'menos de ')+r.line:
 r.market==='total'?'Total '+(r.selection==='over'?'más de ':'menos de ')+r.line:(r.selection==='home'?g.home_team:g.away_team)+(r.market==='spread'?' '+(r.line>0?'+':'')+r.line:' gana');}
function rowText(g,r){
 const outcomes={WIN:'ACIERTO',LOSS:'FALLO',PUSH:'DEVOLUCIÓN',DNP:'SIN PARTICIPACIÓN',VOID:'ANULADO',MISSING:'SIN DATO VALIDADO',PENDING:'PENDIENTE'};
 return selectionText(g,r)+'\n'+r.bookmaker+' @'+fixed(r.odds)+(Number.isFinite(r.projected)&&r.player_id?' · proy. '+r.projected.toFixed(1):'')+' · real '+actualText(g,r)+' · '+outcomes[r.result]+'.';
}
function actualText(g,r){return r.actual===null||r.actual===undefined?'—':!r.player_id&&r.market==='moneyline'?g.away_score+'–'+g.home_score:!r.player_id&&r.market==='spread'?'margen '+(r.selection==='home'?r.actual:-r.actual):String(r.actual);}
function summaryText(s){return s.WIN+' aciertos / '+s.LOSS+' fallos'+(s.PUSH?' / '+s.PUSH+' devoluciones':'')+(s.DNP?' / '+s.DNP+' sin participación':'')+(s.MISSING?' / '+s.MISSING+' sin dato':'')+'; '+(s.accuracy===null?'sin resueltos':(100*s.accuracy).toFixed(1)+'% de acierto')+'.';}
function messages(g,b){
 const header=g.league+' · balance de cuotas y actuaciones\n'+g.away_team+' '+g.away_score+' — '+g.home_team+' '+g.home_score;
 const sections=['Pronósticos informativos enviados por Telegram (última revisión por jugador/mercado/casa):',...b.published.map(r=>rowText(g,r))];
 if(!b.published.length)sections.push('No consta un pronóstico con línea y cuota enviado antes del inicio.');
 const team=b.evaluated.filter(r=>!r.player_id&&r.bookmaker==='bet365');
 if(team.length)sections.push('Partido · cuotas históricas Bet365 evaluadas (no acreditan una apuesta publicada):',...team.map(r=>rowText(g,r)));
 sections.push('Actuaciones enviadas: '+summaryText(b.summaries.player_published));
 if(b.summaries.player_published.paper_staked)sections.push('Simulación de 1 unidad por actuación enviada: '+(b.summaries.player_published.paper_units>=0?'+':'')+fixed(b.summaries.player_published.paper_units)+' u; ROI '+fixed(100*b.summaries.player_published.paper_roi)+'%. No es dinero apostado.');
 sections.push('Todos los mercados de jugadores evaluados, incluidos descartes: '+summaryText(b.summaries.player_evaluated));
 if(b.value.length)sections.push('Alertas de valor entregadas:',...b.value.map(r=>rowText(g,r)));
 sections.push('Alertas de valor entregadas: '+b.value.length+'. Los pronósticos «sin apuesta» siguen siendo informativos. DNP excluidos del acierto; las reglas vigentes de la casa pueden afectar la liquidación real.');
 const pages=[];let text=header;for(const section of sections){if(text.length+section.length+2>3600){pages.push(text);text=header+' · continuación';}text+='\n\n'+section;}pages.push(text);
 return pages;
}
module.exports={POLICY,labels,usableQuote,settle,summary,legacySelections,publishedSelections,evaluatedSelections,build,selectionText,actualText,messages};
