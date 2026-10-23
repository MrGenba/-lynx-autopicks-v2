'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validatePlayer,priors,enrichPlayer,VERSION}=require('../basketball/advanced_model');
const {validateQuote}=require('../basketball/pipeline');
const {assess,message,canRetryValue}=require('../basketball/value');
const {retryNotifications}=require('../basketball/notifications');
const {compareAdvanced}=require('../basketball/prospective');
const {pairedCI}=require('../basketball/research');
const now=new Date('2026-10-23T15:00:00Z'),game={league:'NBA',game_id:'g',season:2027,season_type:2,status:'scheduled',starts_at:'2026-10-23T20:00:00Z',home_team:'Home',away_team:'Away'};
function rows(){
 const common={league:'NBA',season:2027,season_type:'Regular Season',per_mode:'Totals',player_id:'p',provider_player_id:'n',provider_team_id:'t',mapping:{status:'mapped'},source_status:'partial',observed_at:'2026-10-23T14:00:00Z',source_published_at:'2026-10-23T13:00:00Z',latest_publication_at:'2026-10-23T13:00:00Z',source_checked_at:'2026-10-23T14:55:00Z',quality:{flags:[],boxscore_comparison:{games_match:true,points_match:true}}};
 return [{...common,dataset:'stats_base',version_id:'base',stats:{team_count:1,gp:10,min:300,pts:132,reb:50,ast:40,fgm:50,fga:100,fg3_m:16,fg3_a:40,ftm:16,fta:20,oreb:10,dreb:40,tov:10}},
 {...common,dataset:'stats_advanced',version_id:'advanced',stats:{team_count:1,gp:10,min:30,fga:100,fgm:50,efg_pct:.58,ts_pct:132/(2*108.8),usg_pct:.25,ast_pct:.2,reb_pct:.1}},
 {...common,dataset:'tracking_passing',version_id:'passing',stats:{gp:10,min:300,ast:40,potential_ast:80,passes_made:400}},
 {...common,dataset:'tracking_rebounding',version_id:'rebounds',stats:{gp:10,min:300,reb:50,reb_chances:90,reb_contest:20,reb_uncontest:30}}];
}
test('advanced statistics need coherent counts, units and pregame observation',()=>{
 assert.equal(validatePlayer(rows(),game,now).eligible,true);
 for(const change of [r=>r[0].stats.pts++,r=>r[1].stats.ts_pct=.8,r=>r[1].stats.min=300,r=>r[0].observed_at='2026-10-23T16:00:00Z',r=>r[0].latest_publication_at='2026-10-20T10:00:00Z',r=>r[0].quality.flags=['BOXSCORE_POINTS_DIFFER']]){const r=rows();change(r);assert.equal(validatePlayer(r,game,now).eligible,false);}
});
test('regular season, playoffs and WNBA tracking are never silently interchanged',()=>{
 assert.equal(validatePlayer(rows(),{...game,season_type:3},now).eligible,false);
 const r=rows().slice(0,2).map(r=>({...r,league:'WNBA',season:2026})),v=validatePlayer(r,{...game,league:'WNBA',season:2026},now);
 assert.equal(v.eligible,true);assert.equal(v.tracking.tracking_passing,undefined);assert.ok(v.excluded.tracking_rebounding);
});
test('tracking disagreement excludes that input while preserving valid core stats',()=>{const r=rows();r[2].stats.ast=39;const v=validatePlayer(r,game,now);assert.equal(v.eligible,true);assert.equal(v.tracking.tracking_passing,undefined);});
test('bounded season adjustment retains uncertainty and combination covariance',()=>{
 const v=validatePlayer(rows(),game,now),props={points:{mean:16,variance:50},rebounds:{mean:5,variance:12},assists:{mean:4,variance:8},threes:{mean:2,variance:3},pra:{mean:25,variance:90},pr:{mean:21,variance:70},pa:{mean:20,variance:65},ra:{mean:9,variance:28}},f={status:'OK',props,projected_minutes:30};
 const p={two:.52,three:.36,ft:.78,passing:.5,rebounding:.55};const enriched=enrichPlayer(f,v,p,1);
 assert.equal(enriched.model_version,VERSION);assert.ok(enriched.advanced.max_weight<=.25);assert.equal(f.props.points.mean,16);
 for(const [k,a]of Object.entries(enriched.props)){assert.ok(a.variance>=props[k].variance);assert.ok(Math.abs(a.mean-props[k].mean)<=props[k].mean*.075+1e-8);}
 assert.ok(Math.abs(enriched.props.pra.mean-enriched.props.points.mean-enriched.props.rebounds.mean-enriched.props.assists.mean)<1e-8);
});
function market(){const q={quote_id:'q',league:'NBA',game_id:'g',player_id:null,market:'moneyline',line:null,selection:'home',odds:1.9,opposite_odds:1.9,bookmaker:'bet365',source:'cuotasahora',source_url:'https://example.test',period:'full_game',includes_overtime:true,captured_at:now.toISOString(),expires_at:'2026-10-23T15:15:00Z'};return [q,{...q,quote_id:'p',selection:'away'}];}
const forecast={status:'OK',model_version:VERSION,advanced:{status:'APPLIED'},margin:6,margin_variance:100,p_home:.73,p_away:.27};
test('estimated value uses a paired margin-free market and an adverse scenario',()=>{const qs=market(),r=assess(qs[0],game,forecast,forecast,qs,now,validateQuote);assert.equal(r.qualifies,true);assert.equal(r.market_probability,.5);assert.ok(r.stress_ev<r.ev);assert.ok(message(game,qs[0],forecast,r).includes('rentabilidad no demostrada'));});
test('NBA and WNBA value alerts require at least 10 percent estimated EV',()=>{
 for(const league of ['NBA','WNBA'])for(const [p,qualifies]of [[.549,false],[.55,true],[.56,true]]){
  const qs=market().map(q=>({...q,league,odds:2,opposite_odds:2})),f={...forecast,p_home:p,p_away:1-p};
  const r=assess(qs[0],{...game,league},f,f,qs,now,validateQuote);
  assert.equal(r.qualifies,qualifies,league+' probability '+p);
  assert.equal(r.reasons.includes('EV_BELOW_THRESHOLD'),!qualifies);
 }
});
test('delayed prices, missing pairs, fallback models and stale quotes cannot alert',()=>{
 for(const change of [qs=>qs[0].detail={delayed:true},qs=>qs.pop(),qs=>qs[0].opposite_odds=2,qs=>qs[0].captured_at='2026-10-23T14:54:00Z']){const qs=market();change(qs);assert.equal(assess(qs[0],game,forecast,forecast,qs,now,validateQuote).qualifies,false);}
 const qs=market();assert.equal(assess(qs[0],game,{...forecast,advanced:{status:'BASELINE_FALLBACK'}},forecast,qs,now,validateQuote).qualifies,false);
});
test('a positive headline EV that fails stress testing produces no alert',()=>{const qs=market(),f={...forecast,margin:1,p_home:.55,p_away:.45};const r=assess(qs[0],game,f,f,qs,now,validateQuote);assert.ok(r.ev>0);assert.ok(r.reasons.includes('STRESS_TEST_FAILED'));});
test('value notification retries require fresh revalidation',async()=>{
 let sends=0;const pending={notification_id:'n',league:'NBA',payload:{kind:'basketball_value',alert_id:'a',text:'test',expires_at:'2026-10-23T15:05:00Z'}};
 const ctx={rest:async()=>[pending],send:async()=>{sends++;return {ok:true,result:{message_id:1}}}};
 assert.equal(await retryNotifications(ctx,now),0);assert.equal(sends,0);ctx.canRetryValue=async()=>false;assert.equal(await retryNotifications(ctx,now),0);assert.equal(sends,0);
});
test('pending alerts from the old policy must meet the current EV threshold',async()=>{
 for(const [ev,allowed]of [[.09,false],[.10,true],[.12,true],[null,false],[undefined,false]]){
  const q=market()[0],a={league:'NBA',game_id:'g',policy:'bk-value-estimate-1',expires_at:'2026-10-23T15:05:00Z',quote_snapshot:q,decision:{ev}};
  const ctx={rest:async path=>path.startsWith('bk_value_alerts?')?[a]:path.startsWith('bk_quotes?')?[q]:[game]};
  assert.equal(await canRetryValue(ctx,{alert_id:'old'},now),allowed,'EV '+ev);
 }
});
test('advanced performance claim needs a preregistered 200-game future cohort and both benchmarks',()=>{
 const games=[],fs=[],cs=[],protocol={registered_at:'2026-10-23T15:00:00Z'};
 for(let i=0;i<200;i++){const g={game_id:String(i),status:'final',box_complete:true,starts_at:new Date(Date.parse('2026-10-24T20:00:00Z')+i*86400000).toISOString(),home_score:100,away_score:90};games.push(g);
  for(const version of ['bk-pace-minutes-1',VERSION])fs.push({game_id:g.game_id,kind:'team',model_version:version,created_at:'2026-10-23T16:00:00Z',as_of:'2026-10-23T16:00:00Z',result:{p_home:version===VERSION?.7:.5,margin:version===VERSION?7:0,advanced:{status:'APPLIED'}}});
  cs.push({game_id:g.game_id,model_version:VERSION,player_id:null,market:'moneyline',as_of:'2026-10-23T16:00:00Z',verdict:'NO_EDGE',quote_snapshot:{bookmaker:'bet365',source:'cuotasahora',period:'full_game',includes_overtime:true,odds:1.9,opposite_odds:1.9,selection:'home',captured_at:'2026-10-23T16:00:00Z'}});
 }
 assert.equal(compareAdvanced(games.slice(0,199),fs,cs,protocol,pairedCI).improvement,false);
 assert.equal(compareAdvanced(games,fs,cs,null,pairedCI).improvement,false);
 assert.equal(compareAdvanced(games,fs,cs,protocol,pairedCI).improvement,true);
 assert.equal(compareAdvanced(games,fs.map(f=>({...f,created_at:'2030-01-01'})),cs,protocol,pairedCI).n,0);
 assert.equal(compareAdvanced(games,fs,cs.map(c=>({...c,quote_snapshot:{...c.quote_snapshot,detail:{delayed:true}}})),protocol,pairedCI).n,0);
 const betterMarket=cs.map(c=>({...c,quote_snapshot:{...c.quote_snapshot,odds:1.2,opposite_odds:5}}));
 assert.equal(compareAdvanced(games,fs,betterMarket,protocol,pairedCI).improvement,false);
});
