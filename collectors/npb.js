'use strict';
const VERSION='npb-spaia-1',SOURCE='spaia.jp';
const TEAMS={1:'YG',2:'TY',3:'DB',4:'CD',5:'HT',6:'HR',7:'SW',8:'HF',9:'TM',11:'OB',12:'FS',376:'TR'};
const KINDS=[1,2,3,26,35,36,37,38];
const name=s=>String(s||'').replace(/[\s　]+/g,'');
function count(v){if(!/^\d+$/.test(String(v)))throw Error('INVALID_COUNT:'+v);return Number(v);}
function nullable(v){return v==null||v===''||!Number.isFinite(Number(v))||Number(v)<0?null:Number(v);}
const sum=(a,k)=>a.reduce((n,r)=>n+Number(r[k]||0),0);
function game(raw,overview){
 const ov=overview?.[0],kind=Number(raw.gameTypeId??ov?.gameKindId);if(!KINDS.includes(kind))return null;
 const id=String(raw.gameId),date=String(raw.gameDate||ov?.gameDate||raw.requested_date);
 if(!/^\d{10}$/.test(id)||!/^20\d{6}$/.test(date)||ov&&String(ov.gameId)!==id)throw Error('GAME_IDENTITY_MISMATCH');
 const home=TEAMS[raw.homeTeamId??ov?.homeTeamId],away=TEAMS[raw.visitorTeamId??ov?.visitorTeamId];
 if(!home||!away||home===away)throw Error('UNKNOWN_TEAM');
 const day=date.slice(0,4)+'-'+date.slice(4,6)+'-'+date.slice(6),tm=String(raw.startTime||ov?.startTime||'');
 const local=/^([01]\d|2[0-3])[0-5]\d$/.test(tm)?tm.slice(0,2)+':'+tm.slice(2):null;
 const state=Number(raw.gameStateId),status=state===4?'final':/中止|ノーゲーム/.test(raw.gameStateName||'')?'cancelled':state===2||state===3?'live':'scheduled';
 return {game_id:id,game_pk:date.slice(0,4)+'_'+id,game_date:day,season:Number(date.slice(0,4)),game_kind:kind,
  home_team:home,away_team:away,home_score:status==='final'?count(raw.homeTeamTotalRuns):null,away_score:status==='final'?count(raw.visitorTeamTotalRuns):null,
  status,game_time_local:local,game_time:local?new Date(day+'T'+local+':00+09:00').toISOString():null,venue_name:ov?.stadiumName||null,
  home_starter:name(ov?.homePrePitcherName)||null,away_starter:name(ov?.visitorPrePitcherName)||null,
  home_starter_id:ov?.homePrePitcherId||null,away_starter_id:ov?.visitorPrePitcherId||null,source:SOURCE};
}
function boxscore(g,{score,pitchers,batters,history=[]}){
 if(g.status!=='final'||score?.length!==1||String(score[0].gameId)!==g.game_id||!Array.isArray(pitchers)||pitchers.length<2||!Array.isArray(batters)||batters.length<18)throw Error('COMPLETE_FINAL_REQUIRED');
 const s=score[0];if(count(s.totalRunHome)!==g.home_score||count(s.totalRunVisitor)!==g.away_score)throw Error('SCORE_MISMATCH');
 const base={game_id:g.game_id,game_date:g.game_date,season:g.season,game_kind:g.game_kind,source:SOURCE};
 const ps=pitchers.map(p=>{const out=count(p.ip)*3+(p.ip3==null?0:count(p.ip3));if(p.ip3!=null&&count(p.ip3)>2)throw Error('INVALID_INNINGS');
  return {...base,player_id:String(p.playerId),player_name:name(p.playerName),team_abbr:TEAMS[p.teamId],appearance_no:count(p.no),is_starter:count(p.no)===1,
   outs:out,ip:out/3,bf:count(p.bf),pitches:count(p.nopg),h:count(p.h),hr:count(p.hr),so:count(p.so),bb:count(p.bb),hbp:count(p.hbp),runs:count(p.r),er:count(p.er)};});
 const bs=batters.map(b=>({...base,player_id:String(b.playerId),player_name:name(b.playerName),team_abbr:TEAMS[b.teamId],appearance_no:count(b.rowno),
  pa:count(b.pa),ab:count(b.ab),h:count(b.h),h2b:count(b.h2b),h3b:count(b.h3b),hr:count(b.hr),so:count(b.so),bb:count(b.bb),hbp:count(b.hp),sac:count(b.sh),sf:count(b.sf),runs:count(b.r),rbi:count(b.rbi),sb:count(b.sb)}));
 for(const rows of [ps,bs]){const keys=new Set();for(const r of rows){const key=r.team_abbr+'|'+r.player_id;if(![g.home_team,g.away_team].includes(r.team_abbr)||!r.player_name||!/^\d+$/.test(r.player_id)||keys.has(key))throw Error('PLAYER_IDENTITY_MISMATCH');keys.add(key);}}
 if(ps.some(p=>p.er>p.runs||p.hr>p.h||p.so>p.bf)||bs.some(b=>b.h>b.ab||b.hr+b.h2b+b.h3b>b.h||b.ab+b.bb+b.hbp+b.sac+b.sf>b.pa))throw Error('INVALID_PLAYER_TOTALS');
 const quality=[];
 for(const [t,o,side] of [[g.home_team,g.away_team,'Home'],[g.away_team,g.home_team,'Visitor']]){
  const p=ps.filter(r=>r.team_abbr===o),b=bs.filter(r=>r.team_abbr===t);
  if(p.filter(r=>r.is_starter).length!==1||b.length<9)throw Error('MISSING_STARTER_OR_LINEUP');
  if(sum(b,'runs')!==count(s['totalRun'+side]))throw Error('BATTING_SCORE_MISMATCH');
  // The live scoreboard may retain a hit/error ruling later changed in BOTH
  // player tables. Preserve the discrepancy; player batting/pitching must agree.
  if(sum(b,'h')!==count(s['totalHit'+side]))quality.push({code:'SCOREBOARD_HITS_DIFFER',team:t,scoreboard_hits:count(s['totalHit'+side]),player_hits:sum(b,'h')});
  for(const k of ['h','hr','so','bb','hbp','runs'])if(sum(p,k)!==sum(b,k))throw Error('OPPONENT_TOTAL_MISMATCH:'+k);
  if(sum(p,'bf')!==sum(b,'pa'))throw Error('BATTERS_FACED_MISMATCH');
 }
 // Retain available pitch observations. Plot coordinates are source units, not feet/metres.
 const pitchRows=[],seen=new Set();for(const h of history){if(String(h.gameId)!==g.game_id)throw Error('PITCH_GAME_MISMATCH');if(Number(h.atBatBallCount)<=0)continue;
  const key=h.fiveDigitSerialNumber+'|'+h.atBatBallCount;if(seen.has(key))throw Error('DUPLICATE_PITCH');seen.add(key);
  if(!ps.some(p=>p.player_id===String(h.pitId)))throw Error('PITCHER_NOT_IN_BOXSCORE');
  pitchRows.push({pa:String(h.fiveDigitSerialNumber),n:count(h.atBatBallCount),pitcher_id:String(h.pitId),batter_id:String(h.batId),kind:nullable(h.ballKind),velocity_kmh:Number(h.ballSpeed)>0?nullable(h.ballSpeed):null,x:nullable(h.x),y:nullable(h.y),pitch_result:h.presult,batting_result:h.bresult,batted_x:nullable(h.battedX),batted_y:nullable(h.battedY)});
 }
 const trackingComplete=ps.every(p=>pitchRows.filter(r=>r.pitcher_id===p.player_id).length===p.pitches);
 const amended={...g};for(const side of ['away','home']){const starter=ps.find(p=>p.team_abbr===g[side+'_team']&&p.is_starter);amended[side+'_starter']=starter.player_name;amended[side+'_starter_id']=starter.player_id;}
 return {game:amended,pitchers:ps,batters:bs,pitches:pitchRows,receipt:{version:VERSION,pitcher_count:ps.length,batter_count:bs.length,pitch_count:pitchRows.length,expected_pitch_count:sum(ps,'pitches'),tracking_status:trackingComplete?'COMPLETE':'PARTIAL',quality_flags:quality,source:SOURCE,source_url:'https://spaia.jp/baseball/npb/game/'+g.game_id}};
}
module.exports={VERSION,SOURCE,TEAMS,KINDS,name,count,game,boxscore};
