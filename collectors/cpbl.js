'use strict';
const VERSION='cpbl-official-1',SOURCE='stats.cpbl.com.tw';
const TEAMS={ACN011:'BR',ADD011:'UL',AJL011:'MO',AEO011:'FG',AAA011:'DR',AKP011:'EA'};
function canonical(x){if(Array.isArray(x))return x.map(canonical);if(x&&typeof x==='object')return Object.fromEntries(Object.entries(x).map(([k,v])=>[k.replace(/([a-z0-9])([A-Z])/g,'$1_$2').replace(/([A-Z])([A-Z][a-z])/g,'$1_$2').toLowerCase().replace(/_([a-z])/g,(_,c)=>c.toUpperCase()),canonical(v)]));return x;}
function count(n){if(!Number.isInteger(n)||n<0)throw Error('CPBL_INVALID_COUNT');return n;}
const sum=(a,k)=>a.reduce((n,x)=>n+x[k],0),nullable=x=>x==null||!Number.isFinite(Number(x))?null:Number(x);
function game(raw){const r=canonical(raw),id=r.gameId,m=/^(20\d{2})-([ACE])-(\d+)$/.exec(id);if(!m||m[2]!==r.kindCode||Number(m[3])!==r.gameSno)throw Error('CPBL_GAME_IDENTITY');
 const away=TEAMS[r.visiting?.team?.code],home=TEAMS[r.home?.team?.code];if(!away||!home||away===home)throw Error('CPBL_UNKNOWN_TEAM');
 const states={FINISHED:'final',SCHEDULED:'scheduled',POSTPONED:'postponed',CANCELLED:'cancelled',CANCELED:'cancelled',RESERVED:'suspended',OTHER:'unknown',START:'live'};const status=states[r.gameStatus];if(!status)throw Error('CPBL_UNKNOWN_STATUS:'+r.gameStatus);
 const time=r.preExeDate;if(!/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(time)||time.slice(0,4)!==m[1])throw Error('CPBL_INVALID_START');
 const starter=side=>{const p=r[side]?.pitchers?.filter(p=>p.roleType==='先發')||[];return p.length===1?{name:p[0].pitcherName,id:p[0].pitcherAcnt}:{};};const a=starter('visiting'),h=starter('home');
 return {game_id:id,game_pk:m[2]==='A'?m[1]+m[3].padStart(3,'0'):m[1]+'_'+m[2]+'_'+m[3].padStart(3,'0'),game_date:time.slice(0,10),season:Number(m[1]),game_kind:m[2],away_team:away,home_team:home,
  away_score:status==='final'?count(r.visiting.score):null,home_score:status==='final'?count(r.home.score):null,status,game_time_local:time.slice(11)==='00:00:00'?null:time.slice(11,16),game_time:time.slice(11)==='00:00:00'?null:new Date(time+'+08:00').toISOString(),venue_name:r.field?.abbe||null,
  away_starter:a.name||null,home_starter:h.name||null,away_starter_id:a.id||null,home_starter_id:h.id||null,scheduled_innings:9,source:SOURCE};
}
function boxscore(raw){const r=canonical(raw),g=game(r);if(g.status!=='final')throw Error('CPBL_FINAL_REQUIRED');
 const base={game_id:g.game_id,game_date:g.game_date,season:g.season,game_kind:g.game_kind,source:SOURCE};const pitchers=[],batters=[];
 for(const [side,abbr]of [['visiting',g.away_team],['home',g.home_team]]){
  const t=r[side];if(!t.pitchers?.length||t.hitters?.length<9)throw Error('CPBL_INCOMPLETE_BOXSCORE');
  t.pitchers.forEach((p,i)=>{const outs=count(p.inningPitchedCnt)*3+count(p.inningPitchedDiv3Cnt);if(p.inningPitchedDiv3Cnt>2)throw Error('CPBL_INVALID_INNINGS');pitchers.push({...base,team_abbr:abbr,player_id:p.pitcherAcnt,player_name:p.pitcherName,appearance_no:i+1,is_starter:p.roleType==='先發',outs,ip:outs/3,bf:count(p.plateAppearances),pitches:count(p.pitchCnt),h:count(p.hittingCnt),hr:count(p.homeRunCnt),so:count(p.strikeOutCnt),bb:count(p.basesOnBallsCnt),hbp:count(p.hitByPitchCnt),runs:count(p.runCnt),er:count(p.earnedRunCnt)});});
  t.hitters.forEach((b,i)=>batters.push({...base,team_abbr:abbr,player_id:b.hitterAcnt,player_name:b.hitterName,appearance_no:i+1,pa:count(b.plateAppearances),ab:count(b.hitCnt),h:count(b.hittingCnt),h2b:count(b.twoBaseHitCnt),h3b:count(b.threeBaseHitCnt),hr:count(b.homeRunCnt),so:count(b.strikeOutCnt),bb:count(b.basesOnBallsCnt),hbp:count(b.hitByPitchCnt),sac:count(b.sacrificeHitCnt),sf:count(b.sacrificeFlyCnt),runs:count(b.scoreCnt),rbi:count(b.runBattedInCnt),sb:count(b.stealBaseOkCnt)}));
 }
 for(const rows of [pitchers,batters]){const keys=new Set();for(const p of rows){const k=p.team_abbr+'|'+p.player_id;if(!/^\d+$/.test(p.player_id)||!p.player_name||keys.has(k))throw Error('CPBL_PLAYER_IDENTITY');keys.add(k);}}
 for(const [side,team,opp]of [['visiting',g.away_team,g.home_team],['home',g.home_team,g.away_team]]){
  const bs=batters.filter(b=>b.team_abbr===team),ps=pitchers.filter(p=>p.team_abbr===opp);
  if(ps.filter(p=>p.is_starter).length!==1||sum(bs,'runs')!==r[side].score||sum(bs,'h')!==r[side].hittingCnt)throw Error('CPBL_TEAM_TOTALS');
  for(const k of ['h','hr','so','bb','hbp','runs'])if(sum(bs,k)!==sum(ps,k))throw Error('CPBL_CROSS_TOTAL:'+k);
  if(sum(bs,'pa')!==sum(ps,'bf'))throw Error('CPBL_BATTERS_FACED');
 }
 if(pitchers.some(p=>p.er>p.runs||p.hr>p.h)||batters.some(b=>b.h>b.ab||b.h2b+b.h3b+b.hr>b.h||b.ab+b.bb+b.hbp+b.sac+b.sf>b.pa))throw Error('CPBL_INVALID_PLAYER_TOTALS');
 const pitches=[],seen=new Set();for(const p of r.liveLog||[]){
  // Exclude pickoffs, substitutions and administrative events. Keep physical pitches even without tracking.
  if(p.isChangePlayer==='1'||!['0','2'].includes(p.isSpecialEvent)||!p.pitcherAcnt||!p.pitchCnt)continue;
  const k=p.pitcherAcnt+'|'+p.pitchCnt;if(seen.has(k))continue;seen.add(k);if(!pitchers.some(x=>x.player_id===p.pitcherAcnt))throw Error('CPBL_TRACKING_PITCHER');
  const t=p.trackman,release=t?.pitch?.release,location=t?.pitch?.location,hit=t?.hit?.launch;
  pitches.push({pa:p.mainEventNo,n:p.pitchCnt,pitcher_id:p.pitcherAcnt,batter_id:p.hitterAcnt,kind:t?.play?.pitchTag?.taggedPitchType||t?.play?.pitchTag?.autoPitchType||null,
   velocity_kmh:release?.relSpeed>0?release.relSpeed:null,spin_rate:release?.spinRate>0?release.spinRate:null,release_side_m:nullable(release?.relSide),release_height_m:nullable(release?.relHeight),extension_m:nullable(release?.extension),
   plate_side_m:nullable(location?.plateLocSide),plate_height_m:nullable(location?.plateLocHeight),zone_speed_kmh:location?.zoneSpeed>0?location.zoneSpeed:null,zone_time_s:nullable(location?.zoneTime),
   trajectory:t?.pitch?.flight?.polyFit?.pitchTrajectory||null,pitch_call:t?.play?.pitchTag?.pitchCall||null,auto_pitch_type:t?.play?.pitchTag?.autoPitchType||null,
   exit_velocity_kmh:hit?.exitSpeed>0?hit.exitSpeed:null,launch_angle_deg:nullable(hit?.angle),hit_direction_deg:nullable(hit?.direction),hit_spin_rate:nullable(hit?.hitSpinRate),
   distance_m:nullable(t?.hit?.landingFlat?.distance),hang_time_s:nullable(t?.hit?.landingFlat?.hangTime),landing_bearing_deg:nullable(t?.hit?.landingFlat?.bearing),landing_confidence:t?.hit?.landingFlat?.confidence||null});
 }
 const complete=pitchers.every(p=>pitches.filter(x=>x.pitcher_id===p.player_id).length===p.pitches);
 return {game:g,pitchers,batters,pitches,receipt:{version:VERSION,pitcher_count:pitchers.length,batter_count:batters.length,pitch_count:pitches.length,expected_pitch_count:sum(pitchers,'pitches'),tracking_status:complete?'COMPLETE':'PARTIAL',
  velocity_count:pitches.filter(p=>p.velocity_kmh!=null).length,spin_count:pitches.filter(p=>p.spin_rate!=null).length,batted_ball_count:pitches.filter(p=>p.exit_velocity_kmh!=null).length,
  quality_flags:complete?[]:['PITCH_HISTORY_COUNT_MISMATCH'],source:SOURCE,source_url:'https://'+SOURCE+'/schedule/'+g.game_id}};
}
module.exports={VERSION,SOURCE,TEAMS,canonical,game,boxscore};
