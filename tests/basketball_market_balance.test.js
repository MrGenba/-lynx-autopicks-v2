'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const m=require('../basketball/market_balance');
const {VERSION}=require('../basketball/context');
const {teamMarketPreviews}=require('../basketball/market_preview');
const {validateQuote}=require('../basketball/pipeline');
const g={league:'NBA',game_id:'g',status:'final',starts_at:'2026-10-23T20:00:00Z',home_team:'Home',away_team:'Away',home_score:110,away_score:100,box_complete:true};
const time='2026-10-23T19:00:00Z';
const q={quote_id:'q',league:'NBA',game_id:'g',player_id:'p',market:'points',selection:'over',line:20.5,odds:1.8,opposite_odds:2,bookmaker:'winamax.fr',source:'winamax_fr_direct',period:'full_game',includes_overtime:true,captured_at:time,expires_at:'2026-10-23T19:15:00Z',source_url:'https://www.winamax.fr/paris-sportifs/match/1'};
const p={league:'NBA',game_id:'g',player_id:'p',player_name:'Example',minutes:25,stats:{points:21,rebounds:6,assists:4,fg3m:3}};
const fs=[{forecast_id:'f',league:'NBA',game_id:'g',player_id:'p',as_of:time,created_at:time,result:{player_name:'Example'}}];
const legacy={notification_id:'props-analysis-v1:NBA:g:winamax.fr:winamax_fr_direct',league:'NBA',sent_at:time,created_at:time,message_id:1,payload:{kind:'basketball_market_preview',text:'NBA · pronósticos y cuotas · winamax.fr\nAway @ Home\n\nExample · puntos 20.5 · lectura 21:00\nProyección: 22.0 · 30.0 min (avanzado).\nMás: cuota 1.80 · prob. 60.0% · EV 8.0%.\nMenos: cuota 2.00 · prob. 40.0% · EV -20.0%.\nPronóstico del modelo: más de 20.5.\nSIN APUESTA: filtros.\n\nResumen de jugadores.'}};
test('legacy balance uses the sent side and price, includes SIN APUESTA, and never selects from actual results',()=>{
 const rows=m.publishedSelections(g,[legacy],fs,[p]).informational;
 assert.equal(rows.length,1);assert.equal(rows[0].odds,1.8);assert.equal(rows[0].result,'WIN');assert.equal(rows[0].actual,21);
 assert.equal(m.publishedSelections(g,[legacy],fs,[{...p,stats:{points:5}}]).informational[0].result,'LOSS');
 const unknown={...fs[0],player_id:'another'};assert.equal(m.publishedSelections(g,[legacy],[...fs,unknown],[p]).informational.length,0);
 assert.equal(m.publishedSelections(g,[{...legacy,sent_at:g.starts_at}],fs,[p]).informational.length,0);
});
test('a later delivered structured revision replaces the old line once; no price is read from current quotes',()=>{
 const n={...legacy,notification_id:'props-lineup-v1:NBA:g:k:winamax.fr',created_at:'2026-10-23T19:01:00Z',sent_at:'2026-10-23T19:01:01Z',payload:{kind:'basketball_market_preview',game_id:'g',selections:[{player_name:'Example',forecast_id:'f',quote_snapshot:{...q,line:21,selection:'under',odds:1.9}}]}};
 const before=JSON.stringify([legacy,n]);const result=m.publishedSelections(g,[legacy,n],fs,[p]);
 assert.equal(result.informational.length,1);assert.equal(result.informational[0].result,'PUSH');assert.equal(result.informational[0].odds,1.9);assert.equal(JSON.stringify([legacy,n]),before);
 const after={...n,payload:{...n.payload,selections:[{quote_snapshot:{...q,captured_at:'2026-10-23T21:00:00Z'}}]}};
 assert.equal(m.publishedSelections(g,[after],fs,[p]).informational.length,0);
});
test('settlement handles every supported prop, spreads, pushes, missing statistics and DNP without zero-filling',()=>{
 for(const [market,actual]of Object.entries({points:21,rebounds:6,assists:4,threes:3,pra:31,pr:27,pa:25,ra:10})){const r=m.settle(g,{...q,market,line:actual},[p]);assert.equal(r.result,'PUSH');assert.equal(r.actual,actual);}
 assert.equal(m.settle(g,{...q,player_id:null,market:'spread',selection:'home',line:-10},[]).result,'PUSH');
 assert.equal(m.settle(g,{...q,player_id:null,market:'spread',selection:'away',line:9.5},[]).result,'LOSS');
 assert.equal(m.settle(g,q,[{...p,did_not_play:true,minutes:0,stats:null}]).result,'DNP');
 assert.equal(m.settle(g,q,[]).result,'MISSING');assert.equal(m.settle({...g,box_complete:false},q,[p]).result,'MISSING');
 assert.equal(m.settle(g,{...q,market:'pra'},[{...p,stats:{points:21}}]).result,'MISSING');
 const s=m.summary([m.settle(g,q,[p]),m.settle(g,q,[{...p,stats:{points:1}}]),m.settle(g,q,[])]);
 assert.equal(s.accuracy,.5);assert.equal(s.paper_staked,2);assert.ok(Math.abs(s.paper_units+.2)<1e-9);
});
const candidates=(model=VERSION,t=time,line=20.5)=>['over','under'].map((selection,i)=>({candidate_id:model+':'+selection+':'+t,league:'NBA',game_id:'g',player_id:'p',model_version:model,as_of:t,created_at:t,market:'points',selection,line,odds:i?2:1.8,p_win:i?.4:.6,ev:0,verdict:'CONTEXT_BLOCKED',forecast:{player_name:'Example',props:{points:{mean:22}},context:{revision:t}},quote_snapshot:{...q,quote_id:selection,selection,line,odds:i?2:1.8,opposite_odds:i?1.8:2,captured_at:t,expires_at:new Date(Date.parse(t)+15*60000).toISOString()}}));
test('evaluated cohort counts one paired direction and latest pregame context, excluding late, delayed and unpaired data',()=>{
 const old=candidates(),newer=candidates(VERSION,'2026-10-23T19:05:00Z',25.5),late=candidates(VERSION,'2026-10-23T20:01:00Z',1.5),base=candidates('bk-pace-minutes-1','2026-10-23T19:30:00Z',1.5);
 const r=m.evaluatedSelections(g,[...old,...newer,...late,...base],[p]);assert.equal(r.length,1);assert.equal(r[0].line,25.5);assert.equal(r[0].result,'LOSS');
 assert.equal(m.evaluatedSelections(g,[old[0]],[p]).length,0);
 assert.equal(m.evaluatedSelections(g,old.map(c=>({...c,created_at:g.starts_at})),[p]).length,0);
 assert.equal(m.evaluatedSelections(g,old.map(c=>({...c,quote_snapshot:{...c.quote_snapshot,detail:{delayed:true}}})),[p]).length,0);
});
test('team prices can be delivered after an initial forecast with no quotes, with sealed selections and no value bypass',()=>{
 const f={status:'OK',model_version:'bk-pace-minutes-1',p_home:.6,p_away:.4,total:210,total_variance:200,margin:10,margin_variance:100};
 const forecasts=[{league:'NBA',game_id:'g',kind:'team',player_id:null,model_version:f.model_version,forecast_id:'f',result:f}];
 const over={...q,player_id:null,market:'moneyline',selection:'home',line:null,bookmaker:'bet365'};
 const quotes=[over,{...over,quote_id:'other',selection:'away',odds:2,opposite_odds:1.8}];
 const result=teamMarketPreviews({...g,status:'scheduled'},forecasts,quotes,new Date(time),validateQuote);
 assert.equal(result.length,1);assert.match(result[0].text,/Home @1.80/);assert.match(result[0].text,/SIN APUESTA/);
 assert.equal(result[0].payload.selections[0].quote_snapshot.odds,1.8);assert.equal(result[0].payload.selections[0].forecast_id,'f');
});
test('Telegram balance contains exact line, odds, result and explicit simulated units and respects message limit',()=>{
 const b=m.build(g,fs,[p],candidates(),[legacy]);const text=m.messages(g,b).join('\n');
 assert.match(text,/más de 20.5/);assert.match(text,/@1.80/);assert.match(text,/real 21 · ACIERTO/);assert.match(text,/Simulación de 1 unidad/);assert.match(text,/Alertas de valor entregadas: 0/);
 b.published=Array.from({length:100},()=>b.published[0]);assert.ok(m.messages(g,b).length>1);assert.ok(m.messages(g,b).every(s=>s.length<4096));
});
