'use strict';
const {PROPS,MODELS}=require('./model');
const context=require('./context');
const {VERSION:ADVANCED}=require('./advanced_model');
const labels={points:'puntos',rebounds:'rebotes',assists:'asistencias',threes:'triples',pra:'P+R+A',pr:'P+R',pa:'P+A',ra:'R+A'};
const norm=s=>String(s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
const price=n=>n.toFixed(3).replace(/0$/,'');
function valid(q,g,now=null){
 const captured=Date.parse(q.captured_at),start=Date.parse(g.starts_at);
 if(q.league!==g.league||q.game_id!==g.game_id||q.bookmaker!=='ps3838'||q.source!=='ps3838_public_delayed'||q.period!=='full_game'||
  q.detail?.reference_only!==true||q.detail?.delayed!==true||!q.detail?.bookmaker_event_id||
  ![q.odds,q.opposite_odds].every(x=>Number.isFinite(x)&&x>1&&x<=1000)||!Number.isFinite(captured)||captured>=start)return false;
 if(now&&(g.status!=='scheduled'||start<=now.getTime()||captured>now.getTime()||captured<now.getTime()-15*60000||!(Date.parse(q.expires_at)>now.getTime())))return false;
 if(q.player_id){if(!PROPS[q.market]||q.detail.identity_status!=='EXACT_NAME_IN_GAME_FORECAST'||!q.detail.player_name)return false;}
 else if(!['moneyline','total','spread'].includes(q.market)||q.detail.player_name)return false;
 if(q.market!=='moneyline'&&(!Number.isFinite(q.line)||q.line*2!==Math.round(q.line*2)||(q.market!=='spread'&&q.line<0)))return false;
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
function previews(g,forecasts,quotes,now){
 const entries=pairs(g,quotes,now);if(!entries.length)return [];
 const rank={[context.VERSION]:3,[ADVANCED]:2,[MODELS.baseline.version]:1};
 const rows=forecasts.filter(f=>f.league===g.league&&f.game_id===g.game_id&&rank[f.model_version]&&f.result?.status==='OK'&&
  Date.parse(f.as_of)<=now.getTime()&&Date.parse(f.created_at||f.as_of)<=now.getTime()).sort((a,b)=>rank[b.model_version]-rank[a.model_version]||Date.parse(b.as_of)-Date.parse(a.as_of));
 const players=entries.filter(e=>e.q.player_id).map(e=>({...e,f:rows.find(f=>f.player_id===e.q.player_id&&norm(f.result.player_name)===norm(e.q.detail.player_name))}));
 players.sort((a,b)=>(b.f?.result.projected_minutes||0)-(a.f?.result.projected_minutes||0)||Number(b.q.market==='points')-Number(a.q.market==='points'));
 const seen=new Set(),selected=players.filter(e=>!seen.has(e.q.player_id)&&seen.add(e.q.player_id)).slice(0,4);
 return [['team',teamPairs(entries)],['players',selected]].filter(([,items])=>items.length).map(([key,items])=>{
  const lines=[g.league+' · cuotas PS3838 · REFERENCIA RETRASADA',g.away_team+' @ '+g.home_team,
   'La web pública retrasa las cuotas; demora y reglas de prórroga sin verificar. No activa apuestas de valor.'];
  for(const e of items){lines.push('\n'+pairText(g,e));const projected=e.f?.result.props?.[e.q.market]?.mean;
   if(Number.isFinite(projected))lines.push('Proyección del modelo: '+projected.toFixed(1)+' · disponibilidad '+e.f.result.availability+'.');
   lines.push('Observada '+new Date(e.q.captured_at).toLocaleString('es-ES',{timeZone:'Europe/Madrid',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})+' (Madrid); hora real del precio desconocida.');}
  return {key,text:lines.join('\n'),expires_at:new Date(Math.min(Date.parse(g.starts_at),...items.flatMap(e=>[Date.parse(e.q.expires_at),Date.parse(e.pair.expires_at),Date.parse(e.q.captured_at)+15*60000]))).toISOString(),
   payload:{kind:'basketball_ps3838_reference',game_id:g.game_id,reference_only:true,reference_quotes:items.flatMap(e=>[e.q,e.pair])}};
 });
}
module.exports={valid,pairs,teamPairs,pairText,previews,price,norm};
