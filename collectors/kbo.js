'use strict';
// Official KBO GameCenter. Transport and persistence are injected.
const VERSION='kbo-official-1';
const TEAM={HT:'KIA',SK:'SSG',KIA:'KIA',SSG:'SSG',LG:'LG',OB:'OB',SS:'SS',HH:'HH',NC:'NC',KT:'KT',LT:'LT',WO:'WO'};
const SERIES=[0,3,4,5,6,7];
function text(v){return String(v??'').replace(/<br\s*\/?\s*>/gi,' / ').replace(/<[^>]*>/g,'').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').trim();}
function integer(v){const s=text(v);if(!/^\d+$/.test(s))throw Error('INVALID_COUNT:'+s);return Number(s);}
function outs(v){const s=text(v);let m;if((m=s.match(/^(\d+)(?:\s+([12])\/3)?$/)))return Number(m[1])*3+Number(m[2]||0);if((m=s.match(/^([12])\/3$/)))return Number(m[1]);if((m=s.match(/^(\d+)\.([012])$/)))return Number(m[1])*3+Number(m[2]);throw Error('INVALID_INNINGS:'+s);}
const cells=r=>r.row.map(c=>text(c.Text));
function schedule(payload){
 if(payload?.code!=='100'||!Array.isArray(payload.game))throw Error('INVALID_KBO_SCHEDULE');
 return payload.game.filter(g=>g.LE_ID===1&&SERIES.includes(g.SR_ID)).map(g=>{
  const away=TEAM[g.AWAY_ID],home=TEAM[g.HOME_ID];
  if(!away||!home||away===home||!/^\d{8}[A-Z]{4}[012]$/.test(g.G_ID)||g.G_ID.slice(0,8)!==g.G_DT)throw Error('INVALID_KBO_GAME_ID');
  const date=g.G_DT.replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3');
  const state=String(g.CANCEL_SC_ID)!=='0'?'cancelled':String(g.GAME_STATE_SC)==='3'?'final':String(g.GAME_STATE_SC)==='2'?'live':'scheduled';
  const time=/^\d{2}:\d{2}$/.test(g.G_TM)?g.G_TM:null;
  return {game_id:g.G_ID,game_pk:g.G_DT+'_'+away+'_'+home+(Number(g.HEADER_NO)?'_'+g.HEADER_NO:''),game_date:date,season:g.SEASON_ID,series_id:g.SR_ID,
   away_team:away,home_team:home,venue_name:g.S_NM,game_time_kst:time,game_start:time?new Date(date+'T'+time+':00+09:00').toISOString():null,
   status:state,away_score:state==='final'?integer(g.T_SCORE_CN):null,home_score:state==='final'?integer(g.B_SCORE_CN):null,
   away_starter:text(g.T_PIT_P_NM)||null,home_starter:text(g.B_PIT_P_NM)||null,away_starter_id:Number(g.T_PIT_P_ID)||null,home_starter_id:Number(g.B_PIT_P_ID)||null,
   source:'kbo_gamecenter',raw_schedule:g};
 });
}
function battingEvents(values){
 const events=values.flatMap(v=>text(v).split(/\s*\/\s*/)).filter(Boolean);
 const c={pa:events.length,bb:0,ibb:0,hbp:0,so:0,h1b:0,h2b:0,h3b:0,hr:0,sac:0,sf:0,ci:0};
 for(const e of events){
  if(e==='4구')c.bb++;else if(e==='고4'){c.bb++;c.ibb++;}else if(e==='사구')c.hbp++;
  else if(e==='삼진'||e==='스낫')c.so++;
  else if(/홈$/.test(e))c.hr++;else if(/안$/.test(e))c.h1b++;else if(/[좌중우유투123]2$/.test(e))c.h2b++;else if(/[좌중우유투123]3$/.test(e))c.h3b++;
  else if(/희비$/.test(e))c.sf++;else if(/희(?:번|실|선)$/.test(e))c.sac++;
  else if(e==='타방')c.ci++;
  else if(!/(?:땅|비|파|직|병|실|번|삼중)$/.test(e)&&e!=='야선')throw Error('UNKNOWN_BATTING_EVENT:'+e);
 }
 return {...c,events,ab:c.pa-c.bb-c.hbp-c.sac-c.sf-c.ci,h:c.h1b+c.h2b+c.h3b+c.hr};
}
function boxscore(game,raw){
 if(game.status!=='final'||raw?.arrPitcher?.length!==2||raw?.arrHitter?.length!==2)throw Error('FINAL_COMPLETE_BOXSCORE_REQUIRED');
 const pitchers=[],batters=[],totals=[];
 for(let side=0;side<2;side++){
  const team=side?game.home_team:game.away_team,table=JSON.parse(raw.arrPitcher[side].table);
  const headers=table.headers?.[0]?.row.map(c=>text(c.Text));
  for(const h of ['선수명','등판','이닝','타자','투구수','타수','피안타','홈런','4사구','삼진','실점','자책'])if(!headers?.includes(h))throw Error('PITCHER_HEADER_MISSING:'+h);
  const ps=table.rows.map((r,i)=>{
   const a=cells(r);if(a.length!==headers.length)throw Error('PITCHER_COLUMN_MISMATCH');const v=Object.fromEntries(headers.map((h,j)=>[h,a[j]]));
   const started=v['등판']==='선발',name=v['선수명'];if(!name||/^\d+$/.test(name))throw Error('PITCHER_NAME_MISSING');
   const out=outs(v['이닝']);return {game_id:game.game_id,game_date:game.game_date,season:game.season,series_id:game.series_id,team_abbr:team,
    appearance_no:i,player_name:name,player_id:started?(side?game.home_starter_id:game.away_starter_id):null,is_starter:started,
    outs:out,ip:out/3,bf:integer(v['타자']),pitches:integer(v['투구수']),ab:integer(v['타수']),h:integer(v['피안타']),hr:integer(v['홈런']),
    bb:null,bb_hbp:integer(v['4사구']),so:integer(v['삼진']),runs:integer(v['실점']),er:integer(v['자책']),result:v['결과']||null,
    era_game:out?integer(v['자책'])*27/out:null,source:'kbo_gamecenter',raw_cells:a};
  });
  if(!ps.length||ps.filter(p=>p.is_starter).length!==1||ps.some(p=>p.er>p.runs||p.hr>p.h||p.so>p.bf))throw Error('INVALID_PITCHING_ROWS');
  const foot=cells(table.tfoot[0]).slice(-11);
  const fields=['outs','bf','pitches','ab','h','hr','bb_hbp','so','runs','er'];
  // Team unearned runs may be earned against a reliever (inherited error context).
  // Preserve both official values; never redistribute individual earned runs.
  fields.forEach((k,i)=>{const expected=i===0?outs(foot[i]):integer(foot[i]),sum=ps.reduce((n,p)=>n+p[k],0);if(k==='er'?expected>sum:sum!==expected)throw Error('PITCHING_TOTAL_MISMATCH:'+k);});
  const bt=raw.arrHitter[side],a=JSON.parse(bt.table1),b=JSON.parse(bt.table2),c=JSON.parse(bt.table3);
  if(a.rows.length!==b.rows.length||a.rows.length!==c.rows.length||a.rows.length<9)throw Error('BATTING_ROWS_MISSING');
  const bs=a.rows.map((r,i)=>{const identity=cells(r),stats=cells(c.rows[i]),ev=battingEvents(b.rows[i].row.map(x=>x.Text));
   if(identity.length!==3||stats.length!==5||ev.ab!==integer(stats[0])||ev.h!==integer(stats[1]))throw Error('BATTING_EVENT_TOTAL_MISMATCH:'+game.game_id+':'+identity[2]);
   return {game_id:game.game_id,game_date:game.game_date,season:game.season,series_id:game.series_id,team_abbr:team,appearance_no:i,player_name:identity[2],
    batting_order:identity[0]?integer(identity[0]):null,position:identity[1],...ev,rbi:integer(stats[2]),runs:integer(stats[3]),source:'kbo_gamecenter'};
  });
  const bf=cells(c.tfoot[0]);['ab','h','rbi','runs'].forEach((key,i)=>{if(bs.reduce((n,r)=>n+r[key],0)!==integer(bf[i]))throw Error('BATTING_FOOT_MISMATCH:'+key);});
  pitchers.push(...ps);batters.push(...bs);totals.push({team_earned_runs:integer(foot[9]),pitching:Object.fromEntries(fields.map(k=>[k,ps.reduce((n,r)=>n+r[k],0)])),batting:Object.fromEntries(['pa','ab','h','hr','bb','hbp','so','runs'].map(k=>[k,bs.reduce((n,r)=>n+r[k],0)]))});
 }
 for(let i=0;i<2;i++){
  const p=totals[i].pitching,b=totals[1-i].batting;
  for(const k of ['ab','h','hr','so','runs'])if(p[k]!==b[k])throw Error('OPPONENT_TOTAL_MISMATCH:'+k);
  if(p.bf!==b.pa||p.bb_hbp!==b.bb+b.hbp||totals[i].batting.runs!==(i?game.home_score:game.away_score))throw Error('SCORE_OR_PA_MISMATCH');
 }
 return {game,pitchers,batters,receipt:{collector_version:VERSION,pitcher_count:pitchers.length,batter_count:batters.length,totals,source_url:'https://www.koreabaseball.com/Schedule/GameCenter/Main.aspx?gameDate='+game.game_id.slice(0,8)+'&gameId='+game.game_id}};
}
function pitchProfiles(raw,players,season){
 if(!Array.isArray(raw?.rows)||raw.rows.length!==6)throw Error('PITCH_PROFILE_INCOMPLETE');
 const out=[];
 for(let side=0;side<2;side++){
  const [header,mix,speed]=raw.rows.slice(side*3,side*3+3).map(cells),player=players[side];
  if(text(header[0])!==text(player.name)||mix[0]!=='구종 구사비율'||speed[0]!=='평균구속')throw Error('PITCH_PROFILE_IDENTITY_MISMATCH');
  for(let j=1;j<mix.length;j++){
   if(mix[j]==='-'||speed[j]==='-')continue;
   if(!/^\d+(\.\d+)?%$/.test(mix[j])||!/^\d+(\.\d+)?km\/h$/.test(speed[j]))throw Error('PITCH_PROFILE_INVALID_UNIT');
   const usage=Number(mix[j].slice(0,-1))/100,velocity=Number(speed[j].replace('km/h',''));
   if(!(usage>0&&usage<=1&&velocity>=60&&velocity<=180))throw Error('PITCH_PROFILE_INVALID_RANGE');
   out.push({season,player_id:player.id,player_name:player.name,team_abbr:player.team,pitch_type:header[j+1],usage,velocity_kmh:velocity,source:'kbo_gamecenter_pitch_analysis',source_as_of:null,coverage:'up_to_four_pitch_types',source_url:'https://www.koreabaseball.com/Schedule/GameCenter/Preview/StartPitcher.aspx'});
  }
 }
 return out;
}
module.exports={VERSION,TEAM,SERIES,text,integer,outs,schedule,boxscore,pitchProfiles,battingEvents};
