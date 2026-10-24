'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {marketPreviews}=require('../basketball/market_preview');
const {validateQuote,runAnalysis}=require('../basketball/pipeline');
const {VERSION}=require('../basketball/advanced_model');
const {MODELS,probability}=require('../basketball/model');
const {retryNotifications}=require('../basketball/notifications');
const now=new Date('2026-10-23T17:00:00Z');
function fixture(league='NBA'){
 const game={league,game_id:'g',status:'scheduled',starts_at:'2026-10-23T20:00:00Z',home_team:'Home',away_team:'Away',home_team_id:'h',away_team_id:'a'};
 const f={status:'OK',player_id:'p',player_name:'Player Example',team_id:'h',projected_minutes:30,sample:30,minutes_sd:3,last_played_at:'2026-10-22T20:00:00Z',availability:'UNVERIFIED',props:{points:{mean:24,variance:36},rebounds:{mean:5,variance:10},assists:{mean:4,variance:8}}};
 const forecasts=[MODELS.baseline.version,MODELS.challenger.version,VERSION].flatMap(model_version=>[
  {league,game_id:'g',player_id:'p',model_version,kind:'player',result:{...f,model_version,advanced:{status:'APPLIED'}}},
  {league,game_id:'g',player_id:null,model_version,kind:'team',result:{status:'OK',model_version,advanced:{status:'APPLIED'},home_points:110,away_points:100,total:210,p_home:.65,p_away:.35}}
 ]);
 const q={quote_id:'q',league,game_id:'g',player_id:'p',market:'points',line:20.5,selection:'over',odds:1.7,opposite_odds:1.74,bookmaker:'winamax.fr',source:'winamax_fr_direct',source_url:'https://www.winamax.fr/paris-sportifs/match/1',period:'full_game',includes_overtime:true,captured_at:now.toISOString(),expires_at:'2026-10-23T17:15:00Z'};
 return {game,forecasts,quotes:[q,{...q,quote_id:'u',selection:'under',odds:q.opposite_odds,opposite_odds:q.odds}]};
}
test('NBA and WNBA player messages include the actual projection, probabilities, EV and rejection',()=>{
 for(const league of ['NBA','WNBA']){
  const {game,forecasts,quotes}=fixture(league),[preview]=marketPreviews(game,forecasts,quotes,now,validateQuote);
  const p=probability(quotes[0],forecasts.find(f=>f.model_version===VERSION&&f.player_id)?.result);
  assert.match(preview.text,/Proyección: 24.0/);assert.match(preview.text,/Pronóstico del modelo: más de 20.5/);
  assert.ok(preview.text.includes('prob. '+(100*p.p_win).toFixed(1)+'%'));
  assert.ok(preview.text.includes('EV '+(100*(p.p_win*quotes[0].odds-(1-p.p_push))).toFixed(1)+'%'));
  assert.match(preview.text,/SIN APUESTA: margen de la bookie/);assert.doesNotMatch(preview.text,/Supera los filtros/);
  assert.match(preview.text,/EV ≥10%/);assert.match(preview.text,/Winamax.fr: equivalencia con España/);
  assert.equal(preview.expires_at,'2026-10-23T17:05:00.000Z');assert.ok(preview.text.length<4096);
 }
});
test('informational forecasts do not bypass the existing value policy',()=>{
 const {game,forecasts,quotes}=fixture();quotes.forEach(q=>{q.odds=1.9;q.opposite_odds=1.9;});
 assert.match(marketPreviews(game,forecasts,quotes,now,validateQuote)[0].text,/SIN APUESTA: falta información reciente de disponibilidad/);
 const fallback=forecasts.filter(f=>f.model_version!==VERSION);
 const text=marketPreviews(game,fallback,quotes,now,validateQuote)[0].text;
 assert.match(text,/modelo base/);assert.match(text,/SIN APUESTA: estadísticas avanzadas insuficientes/);
});
test('stale, unpaired, delayed and unmapped quotes never produce model-and-price messages',()=>{
 for(const change of [x=>x.quotes.pop(),x=>x.quotes.forEach(q=>q.captured_at='2026-10-23T16:54:00Z'),x=>x.quotes.forEach(q=>q.detail={delayed:true}),x=>x.quotes.forEach(q=>q.player_id=null),x=>x.forecasts.forEach(f=>f.game_id='other'),x=>x.quotes[1].opposite_odds=2]){
  const x=fixture();change(x);assert.deepEqual(marketPreviews(x.game,x.forecasts,x.quotes,now,validateQuote),[]);
 }
});
test('integer player lines show pushes without mislabelling unconditional win probabilities',()=>{
 const x=fixture();x.quotes.forEach(q=>q.line=24);
 const text=marketPreviews(x.game,x.forecasts,x.quotes,now,validateQuote)[0].text;
 assert.match(text,/Devolución: [1-9]/);
});
test('superseded price-only messages are not retried',async()=>{
 let sends=0;const ctx={rest:async()=>[{notification_id:'props:winamax.fr:NBA:g',league:'NBA',payload:{text:'old price-only message'}}],send:async()=>{sends++;}};
 assert.equal(await retryNotifications(ctx,now),0);assert.equal(sends,0);
});
test('analysis sends a single combined preview per game/book and leaves failed-value alerts blocked',async()=>{
 const x=fixture(),sent=[],claimed=new Set();
 const ctx={now,owner:'test',send:async(league,text)=>{sent.push({league,text});return {ok:true,result:{message_id:sent.length}};},rest:async(p,m='GET',b)=>{
  if(m==='POST'){
   if(p==='rpc/bk_claim_notification'){if(claimed.has(b.p_id))return false;claimed.add(b.p_id);return true;}
   if(p==='rpc/bk_finish_notification')return true;
   if(p==='rpc/bk_seal_value_alert')throw Error('Rejected high-margin market cannot be sealed');
   if(p.startsWith('bk_state?')||['rpc/bk_settle_candidates','rpc/bk_seal_candidates'].includes(p))return 0;
   throw Error('Unexpected write '+p);
  }
  if(p.startsWith('bk_notifications?')||p.startsWith('bk_value_alerts?'))return [];
  if(p.startsWith('bk_context_current?'))return [];
  if(p.startsWith('bk_model_protocols?'))return [];
  if(p.startsWith('bk_games?'))return p.includes('league=eq.NBA')&&p.includes('status=eq.scheduled')?[x.game]:[];
  if(p.startsWith('bk_forecasts?'))return x.forecasts;
  if(p.startsWith('bk_quotes?'))return x.quotes;
  throw Error('Unexpected read '+p);
 }};
 await runAnalysis(ctx);await runAnalysis(ctx);
 assert.equal(sent.filter(s=>s.text.includes('pronósticos y cuotas')).length,1);
 assert.equal(sent.filter(s=>s.text.includes('· cuotas de jugadores ·')).length,0);
 assert.ok([...claimed].some(id=>id.startsWith('props-analysis-v1:NBA:g:')));
});
