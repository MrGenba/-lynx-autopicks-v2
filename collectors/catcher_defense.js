"use strict";
const {statcastCsv,statcastNumber}=require('./statcast');
const CATCHER_VERSION='catcher-defense-v1';
const CATCHER_SOURCES={
 framing:{path:'catcher-framing',id:'id',name:'name',phase:'R',fields:{
  framing_pitches:'pitches',framing_runs:'rv_tot',shadow_strike_pct:'pct_tot'}},
 blocking:{path:'catcher-blocking',id:'player_id',name:'player_name',phase:'R',fields:{
  blocking_opportunities:'pitches',blocking_runs:'catcher_blocking_runs',blocks_above_average:'blocks_above_average',
  passed_balls_wild_pitches:'n_pbwp',expected_passed_balls_wild_pitches:'x_pbwp',blocks_above_average_per_40:'blocks_above_average_per_game'}},
 poptime:{path:'poptime',id:'entity_id',name:'entity_name',phase:'SOURCE_DEFAULT',fields:{
  arm_strength_mph:'maxeff_arm_2b_3b_sba',exchange_seconds:'exchange_2b_3b_sba',throws_2b:'pop_2b_sba_count',
  pop_2b_seconds:'pop_2b_sba',pop_2b_cs_seconds:'pop_2b_cs',pop_2b_sb_seconds:'pop_2b_sb',
  throws_3b:'pop_3b_sba_count',pop_3b_seconds:'pop_3b_sba',pop_3b_cs_seconds:'pop_3b_cs',pop_3b_sb_seconds:'pop_3b_sb'}},
};
function catcherUrl(group,season){
 const config=CATCHER_SOURCES[group];
 if(!config||!Number.isInteger(season)||season<2020)throw Error('Invalid catcher scope');
 const params=group==='poptime'?{year:season,team:'',min2b:0,min3b:0}:group==='blocking'?
  {season_start:season,season_end:season,game_type:'Regular',type:'Cat',n:1,split:0,team:'',with_team_only:0}:
  {seasonStart:season,seasonEnd:season,gameType:'Regular',type:'catcher',minPitches:0,splitYears:'false'};
 return 'https://baseballsavant.mlb.com/leaderboard/'+config.path+'?'+Object.entries({...params,csv:'true'}).map(([k,v])=>k+'='+encodeURIComponent(v)).join('&');
}
function parseCatcher(text,group,season){
 const config=CATCHER_SOURCES[group];if(!config)throw Error('Invalid catcher group');
 const {headers,rows}=statcastCsv(text,[config.id,config.name,...Object.values(config.fields)]),seen=new Set();
 const mapped=rows.map(raw=>{
  const id=statcastNumber(raw[config.id]);
  if(!Number.isInteger(id)||id<=0||seen.has(id))throw Error('Invalid/duplicate catcher id');seen.add(id);
  if(group==='blocking'&&(Number(raw.start_year)!==season||(raw.end_year&&Number(raw.end_year)!==season)))throw Error('Catcher season mismatch');
  const metrics={},quality_flags=[];
  for(const [key,field]of Object.entries(config.fields)){
   let n=statcastNumber(raw[field]);
   if(key==='shadow_strike_pct'&&n!==null)n*=100; // Savant framing export uses fractions.
   const count=/(pitches|opportunities)$|^throws_/.test(key)&&!key.startsWith('expected_');
   if(n!==null&&((count&&(!Number.isInteger(n)||n<0))||
     (key.endsWith('_seconds')&&(n<=0||n>10))||(key.endsWith('_mph')&&(n<=0||n>130))||
     (key.endsWith('_pct')&&(n<0||n>100)))){quality_flags.push('invalid_'+key);n=null;}
   metrics[key]=n;
  }
  return {player_id:id,player_name:raw[config.name],metrics,raw_metrics:raw,quality_flags};
 });
 return {rows:mapped,batch:{sport_id:1,season,metric_group:group,season_type:config.phase,source_url:catcherUrl(group,season),
  collector_version:CATCHER_VERSION,source_headers:headers,quality_flags:[...new Set(mapped.flatMap(r=>r.quality_flags))],
  metric_coverage:Object.fromEntries(Object.keys(config.fields).map(k=>[k,mapped.filter(r=>r.metrics[k]!==null).length]))}};
}
async function collectCatchers({season,http,ingest,log}){
 const reports=[];
 for(const group of Object.keys(CATCHER_SOURCES)){
  const url=catcherUrl(group,season),r=await http({method:'GET',url,headers:{'User-Agent':'Mozilla/5.0'},returnFullResponse:true,timeout:45000});
  if(!((r.statusCode??r.status)>=200&&(r.statusCode??r.status)<300))throw Error('Catcher HTTP '+(r.statusCode??r.status));
  const parsed=parseCatcher(r.body,group,season);reports.push(await ingest(parsed.rows,parsed.batch));
  log('Catcher '+group+': '+parsed.rows.length+' rows');
 }
 return reports;
}
// This measures actual public fields, not the presence of an empty pitchData object.
function inspectLmbTracking(data){
 if(data.gameData?.teams?.home?.sport?.id!==23||data.gameData?.teams?.away?.sport?.id!==23)throw Error('Not an LMB game');
 if(data.gameData?.status?.abstractGameState!=='Final')throw Error('Tracking probe requires final game');
 const events=(data.liveData?.plays?.allPlays||[]).flatMap(p=>p.playEvents||[]),pitches=events.filter(e=>e.isPitch);
 const positive=v=>typeof v==='number'&&Number.isFinite(v)&&v>0;
 const batted=events.filter(e=>e.details?.isInPlay);
 return {game_pk:data.gamePk,game_date:data.gameData?.datetime?.originalDate,venue_id:data.gameData?.venue?.id,
  pitches:pitches.length,batted_balls:batted.length,
  pitch_velocity:pitches.filter(e=>positive(e.pitchData?.startSpeed)).length,
  spin_rate:pitches.filter(e=>positive(e.pitchData?.breaks?.spinRate)).length,
  exit_velocity:batted.filter(e=>positive(e.hitData?.launchSpeed)).length,
  launch_angle:batted.filter(e=>typeof e.hitData?.launchAngle==='number'&&Number.isFinite(e.hitData.launchAngle)).length,
  source_url:'https://statsapi.mlb.com/api/v1.1/game/'+data.gamePk+'/feed/live'};
}
if(typeof module!=='undefined')module.exports={CATCHER_SOURCES,catcherUrl,parseCatcher,collectCatchers,inspectLmbTracking};
