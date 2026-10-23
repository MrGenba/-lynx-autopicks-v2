'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {schedule,boxscore,outs,pitchProfiles}=require('../collectors/kbo');
const {enrichKbo}=require('../vendor/kbo_lookup');
const fixture=require('./fixtures/kbo_boxscore.json');
test('official boxscore reconciles both teams, exact innings and combined walks/HBP',()=>{
 const x=boxscore(schedule(fixture.schedule)[0],fixture.box);
 assert.equal(x.pitchers.length,14);assert.equal(x.batters.length,26);
 assert.equal(x.pitchers.filter(p=>p.team_abbr==='LG').reduce((n,p)=>n+p.outs,0),27);
 assert.equal(x.pitchers.find(p=>p.player_name==='카라스코').outs,4);
 assert(x.pitchers.every(p=>p.bb===null));assert.equal(x.batters.filter(b=>b.team_abbr==='KIA').reduce((n,b)=>n+b.hr,0),4);
 assert.equal(outs('0'),0);assert.equal(outs('2/3'),2);assert.equal(outs('5 1/3'),16);assert.equal(outs('5.2'),17);assert.throws(()=>outs('5.5'));
});
test('partial pitchers or altered totals cannot create a complete receipt',()=>{
 for(const change of [t=>t.rows.pop(),t=>t.rows[0].row[10].Text='99']){
  const raw=structuredClone(fixture.box),t=JSON.parse(raw.arrPitcher[0].table);change(t);raw.arrPitcher[0].table=JSON.stringify(t);
  assert.throws(()=>boxscore(schedule(fixture.schedule)[0],raw));
 }
});
test('doubleheaders keep separate game identities and cancelled games are not finals',()=>{
 const g=fixture.schedule.game[0],raw={code:'100',game:[{...g,G_ID:'20261020HTLG1',HEADER_NO:1},{...g,G_ID:'20261020HTLG2',HEADER_NO:2}]};
 const a=schedule(raw);assert.notEqual(a[0].game_pk,a[1].game_pk);
 const cancelled=schedule({code:'100',game:[{...g,CANCEL_SC_ID:'1'}]})[0];assert.equal(cancelled.status,'cancelled');assert.throws(()=>boxscore(cancelled,fixture.box));
});
test('pitch profiles retain units and limited coverage, rejecting swapped names',()=>{
 const raw={rows:[['A','','직구','슬라이더'],['구종 구사비율','60%','20%'],['평균구속','145km/h','130km/h'],['B','','직구','포크'],['구종 구사비율','50%','25%'],['평균구속','150km/h','135km/h']].map(a=>({row:a.map(Text=>({Text}))}))};
 const players=[{id:1,name:'A',team:'LG'},{id:2,name:'B',team:'KIA'}],rows=pitchProfiles(raw,players,2026);
 assert.equal(rows[0].velocity_kmh,145);assert.equal(rows[0].usage,.6);assert.equal(rows[0].source_as_of,null);assert.equal(rows[0].coverage,'up_to_four_pitch_types');assert.throws(()=>pitchProfiles(raw,players.reverse(),2026));
});
function packet(){
 const now=new Date('2026-10-23T08:00:00Z'),game={game_id:'20261023LGHT0',game_pk:'20261023_LG_KIA',game_date:'2026-10-23',season:2026,game_start:'2026-10-23T09:30:00Z',status:'scheduled',away_team:'LG',home_team:'KIA',away_starter:'Away',home_starter:'Home'};
 return {now,inputs:[{awayRaw:'KIA',homeRaw:'LG',away_ml:2.1,home_ml:1.8}],games:[game],pitchers:['LG','KIA'].map((team,i)=>({season:2026,team_abbr:team,player_name:i?'Home':'Away',outs:30,pa_or_ip:10,era:0,fip:3.2,k_9:9})),batters:[],logs:[],history:[],health:{pending_games:0,final_games:724},capture:{status:'OK',checked_at:now.toISOString()}};
}
test('lookup preserves real home/away when quotes arrive reversed and never invents a starter',()=>{
 const p=packet(),out=enrichKbo(p)[0];assert.equal(out.away_team_name,'LG');assert.equal(out.home_team_name,'KIA');assert.equal(out.away_ml,1.8);assert.equal(out.away_p_era,0);assert.equal(out.away_p_siera,null);
 p.games[0].away_starter=null;assert.match(enrichKbo(p)[0].error,/abridores/);
});
test('lookup blocks incomplete capture, ambiguous doubleheaders and already started games',()=>{
 for(const mutate of [p=>p.health.pending_games=1,p=>p.capture.checked_at='2026-10-01',p=>p.capture.checked_at='2026-10-24',p=>p.games.push({...p.games[0],game_id:'second'}),p=>p.games[0].game_start='2026-10-23T07:00:00Z',p=>p.games[0].game_start='invalid']){
  const p=packet();mutate(p);assert(enrichKbo(p)[0].error);
 }
});
test('starter workload uses actual recent starts and accepts a measured zero ERA',()=>{
 const engine=require('../vendor/quant_engine_kbo');
 const common={season:2026,away_p_stats_season:2026,away_p_ip_season:100};
 assert(Math.abs(engine.estimateStarterShare({...common,away_p_ip_l5:14,away_p_starts_l5:2},'away')-.63)<1e-12);
 assert(Math.abs(engine.estimateStarterShare({...common,away_p_ip_l5:35,away_p_starts_l5:5},'away')-.63)<1e-12);
 assert(Math.abs(engine.estimateStarterShare({...common,away_p_ip_l5:0,away_p_starts_l5:0},'away')-.59)<1e-12);
 assert(engine.estimateStarterRaPer9({...common,away_p_era:0},'away')<engine.estimateStarterRaPer9({...common,away_p_era:null},'away'));
 const p=packet();p.weather=[{game_pk:p.games[0].game_pk,wind_tailwind:25,wind_speed_10m:25,temperature_2m:20}];
 assert.equal(enrichKbo(p)[0].wind_tailwind,null);
});
test('generated n8n lookup executes its transport and blocks empty data',async()=>{
 const {lookup}=require('../collectors/kbo_workflows');
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 let calls=0;
 const helpers={httpRequest:async o=>{calls++;assert(o.url.startsWith('https://database.invalid/rest/v1/'));assert.equal(o.headers.apikey,'test');return [];}};
 const output=await new AsyncFunction('helpers','$input',lookup({url:'https://database.invalid/',key:'test'}))(helpers,{all:()=>[{json:{awayRaw:'KIA',homeRaw:'LG'}}]});
 assert.equal(calls,9);assert.match(output[0].json.error,/captura oficial/);
});
