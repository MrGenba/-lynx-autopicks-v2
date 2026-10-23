'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const cpbl=require('../collectors/cpbl'),npb2=require('../collectors/npb2_calendar'),{enrichCpbl,team}=require('../vendor/cpbl_lookup');
const raw=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/cpbl_c4.json'))).Data.Game;
const html=fs.readFileSync(path.join(__dirname,'fixtures/npb2_oct.html'),'utf8');
test('CPBL official game reconciles opponents, outs, pitch events and Trackman units',()=>{
 const p=cpbl.boxscore(raw);assert.equal(p.game.game_id,'2026-C-4');assert.equal(p.game.game_time,'2026-10-21T10:35:00.000Z');
 assert.equal(p.pitchers.length,11);assert.equal(p.batters.length,21);assert.equal(p.receipt.expected_pitch_count,352);assert.equal(p.pitches.length,352);
 assert.equal(p.receipt.tracking_status,'COMPLETE');assert.equal(p.receipt.velocity_count,349);assert.equal(p.receipt.spin_count,349);
 assert(p.pitches.some(p=>p.pitch_call==='StrikeCalled'&&p.n===44));
 assert(p.pitches.some(p=>p.velocity_kmh>140&&p.spin_rate>2000&&p.exit_velocity_kmh>130&&p.distance_m>90&&p.release_height_m<3));
 assert.equal(p.pitchers.reduce((n,p)=>n+p.bf,0),p.batters.reduce((n,b)=>n+b.pa,0));
});
test('CPBL inconsistent totals fail; absent tracking never becomes zero speed',()=>{
 const broken=structuredClone(raw);broken.Home.Score++;assert.throws(()=>cpbl.boxscore(broken),/TOTAL/);
 const absent=structuredClone(raw);absent.LiveLog=[];const p=cpbl.boxscore(absent);assert.equal(p.receipt.tracking_status,'PARTIAL');assert.equal(p.receipt.velocity_count,0);assert.equal(p.pitchers.length,11);
});
test('CPBL source team codes, calendar and freshness are enforced',()=>{
 assert.equal(team('Wei Chuan Dragons'),'DR');assert.equal(team('Uni-Lions'),'UL');assert.equal(team(''),null);
 const wrong=structuredClone(raw);wrong.Home.Team.Code='UNKNOWN';assert.throws(()=>cpbl.game(wrong),/UNKNOWN_TEAM/);
 const suspended=structuredClone(raw);suspended.GameStatus='RESERVED';suspended.PreExeDate='2026-09-12T00:00:00';const s=cpbl.game(suspended);assert.equal(s.status,'suspended');assert.equal(s.game_time,null);
 const result=enrichCpbl({inputs:[{awayRaw:'Brothers',homeRaw:'Monkeys'}],games:[],pitchers:[],batters:[],logs:[],history:[],now:new Date('2026-10-23T00:00:00Z')});assert.match(result[0].error,/captura incompleta/);
});
test('NPB2 away/home score reversal is correct and Phoenix games are excluded',()=>{
 const rows=npb2.parseCalendar(html,2026,10);assert.equal(rows.length,3);
 assert.deepEqual(rows.map(g=>[g.game_date,g.away_team,g.home_team,g.away_score,g.home_score]),[['2026-10-03','FS','HF',6,7],['2026-10-03','YG','DB',3,1],['2026-10-04','YG','HF',2,5]]);
 assert(rows.every(g=>g.game_time_local===null));assert.throws(()=>npb2.parseCalendar(html,2025,10),/WRONG_MONTH/);
});
test('NPB2 keeps the original identity and supersedes only a matching placeholder',()=>{
 const [row]=npb2.parseCalendar(html,2026,10),old={...row,game_pk:'official',game_id:'2026_1003_FS_HF',game_time_local:'11:00'},placeholder={...old,game_pk:'duplicate',game_id:null,status:'scheduled'};
 const r=npb2.reconcile([row],[old,placeholder]);assert.equal(r[0].game_pk,'official');assert.equal(r[0].game_time_local,'11:00');assert.equal(r[1].status,'superseded');assert.equal(r[1].superseded_by,'official');
 assert.throws(()=>npb2.reconcile([row],[{...old,home_score:1}]),/SCORE_CONFLICT/);
 assert.throws(()=>npb2.reconcile([{...row,status:'scheduled'}],[old]),/FINAL_REGRESSION/);
});
test('NPB2 no-games calendar is healthy only after validating the page',async()=>{
 const writes=[],r=await npb2.run({now:new Date('2026-01-10T00:00:00Z'),fullSeason:true,http:async()=>({status:200,body:'<h1>2026年1月</h1><h2 class="section-title">ファーム公式戦</h2><div class="schedule-list-mobile"></div></section>'}),rest:async(p,m,b)=>m==='POST'?writes.push({p,b}):[]});
 assert.equal(r.games,0);assert.equal(r.status,'healthy');assert.equal(writes.length,1);
 await assert.rejects(npb2.run({http:async()=>({status:200,body:'maintenance'}),rest:async()=>[]}),/WRONG_MONTH/);
});
test('CPBL lookup uses exact starter IDs, regular-season history and actual recent starts',()=>{
 const now=new Date('2026-10-24T08:00:00Z'),p={now,inputs:[{awayRaw:'Dragons',homeRaw:'Brothers',away_ml:2,home_ml:1.8}],
 games:[{game_id:'2026-C-5',game_pk:'2026_C_005',game_date:'2026-10-24',status:'scheduled',game_time:'2026-10-24T09:05:00Z',away_team:'BR',home_team:'DR',away_starter:'A',home_starter:'B',away_starter_id:'1',home_starter_id:'2'}],
 pitchers:[['BR','1'],['DR','2']].map(([team_abbr,player_id])=>({season:2026,team_abbr,player_id,player_name:'same',outs:300,pa_or_ip:100,era:0,fip:3,k_9:9,bb_9:2})),batters:[],logs:[],history:[{game_date:'2026-09-01',status:'final',game_kind:'A',away_team:'BR',home_team:'DR',away_score:5,home_score:3},{game_date:'2026-10-20',status:'final',game_kind:'C',away_team:'BR',home_team:'DR',away_score:20,home_score:0}],
 health:{pending_games:0,final_games:368},capture:{status:'OK',checked_at:now.toISOString()}};
 const out=enrichCpbl(p)[0];assert.equal(out.error,undefined);assert.equal(out.away_ml,1.8);assert.equal(out.away_p_era,0);assert.equal(out.away_team_avg_runs,5);assert.equal(out.away_team_games,1);assert.equal(out.away_p_siera,null);
 p.games[0].away_starter_id='unknown';assert.match(enrichCpbl(p)[0].error,/estadísticas verificadas/);
 const engine=require('../vendor/quant_engine_cpbl');assert(Math.abs(engine.estimateStarterShare({away_p_ip_season:100,away_p_ip_l5:14,away_p_starts_l5:2},'away')-.63)<1e-12);
});
test('MiLB health rejects partial daily writes and treats a validated empty calendar as normal',()=>{
 const {dailyHealth}=require('../collectors/milb_workflow_patch');const log=['schedule_MiLB 2026-10-23: 0 (HTTP 0)','schedule_MiLB 2026-10-24: 0 (HTTP 0)','advanced_MiLB: team 30 (200) | bullpen 30 (200)','siera_MiLB: 855 pitchers xFIP/SIERA (HTTP 200)','player_stats_MiLB: 1239 pitchers (HTTP 200)','fip_constant_MiLB: 3.79 (lgERA=4.99, HTTP 200)','statcast_scoped_v1: 4 scopes; team_map 927'];
 assert.deepEqual(dailyHealth(log),{calendar:'healthy',stats:'healthy'});assert.equal(dailyHealth(log.map(l=>l.startsWith('player_stats')?l.replace('200','500'):l)).stats,'error');assert.equal(dailyHealth(log.filter(l=>!l.startsWith('statcast'))).stats,'error');
});
test('NPB2 runtime blocks stale health and reads history beyond 500 rows',async()=>{
 const {lookup}=require('../collectors/npb2_workflows'),AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;let pages=0;
 const helpers={httpRequest:async o=>{
  if(o.url.includes('bb_capture_health'))return ['calendar','stats'].map(component=>({component,status:'healthy',checked_at:new Date().toISOString(),last_success_at:new Date().toISOString()}));
  if(o.url.includes('status=eq.final')){pages++;return pages===1?Array.from({length:1000},()=>({away_team:'FS',home_team:'HF',away_score:1,home_score:2})):[];}return [];
 }};
 const r=await new AsyncFunction('helpers','$input',lookup({url:'https://database.invalid',key:'test'}))(helpers,{all:()=>[{json:{awayRaw:'FS',homeRaw:'HF'}}]});assert.equal(pages,2);assert.match(r[0].json.error,/Sin juegos NPB2/);
 helpers.httpRequest=async()=>[];const blocked=await new AsyncFunction('helpers','$input',lookup({url:'https://database.invalid',key:'test'}))(helpers,{all:()=>[{json:{awayRaw:'FS',homeRaw:'HF'}}]});assert.match(blocked[0].json.error,/captura incompleta/);
});
