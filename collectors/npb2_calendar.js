'use strict';
const TEAMS={1:'TY',2:'YG',3:'HT',4:'DB',5:'HR',6:'CD',7:'FS',8:'SW',9:'HF',10:'TM',11:'OB',12:'TR',13:'OIS',14:'HAY'};
const SOURCE='baseball-data-store.com';
function parseCalendar(html,season,month){
 if(!new RegExp('<h1[^>]*>\\s*'+season+'年'+month+'月').test(html))throw Error('NPB2_WRONG_MONTH');
 const start=html.indexOf('<h2 class="section-title">ファーム公式戦</h2>');if(start<0)throw Error('NPB2_FARM_SECTION_MISSING');
 const section=html.slice(start).split('</section>')[0],mobile=section.split('<div class="schedule-list-mobile">')[1]?.split('<table')[0];
 if(mobile==null)throw Error('NPB2_INVALID_CALENDAR');
 const rows=[],seen=new Set();for(const day of mobile.split('<div class="schedule-list__day">').slice(1)){
  const dm=day.match(/schedule-list__date[^>]*>\s*(\d+)\/(\d+)/);if(!dm||Number(dm[1])!==month)throw Error('NPB2_DAY_MISMATCH');
  const date=season+'-'+String(month).padStart(2,'0')+'-'+dm[2].padStart(2,'0');
  for(const part of day.split('<div class="schedule-list__game">').slice(1)){
   const teams=[...part.matchAll(/href="\/team\/(\d+)\?year=(\d+)"/g)].slice(0,2);if(teams.length!==2||teams.some(t=>Number(t[2])!==season)||!teams.every(t=>TEAMS[t[1]]))throw Error('NPB2_UNKNOWN_TEAM');
   const anyId=part.match(/href="\/game_detail\/(npb[a-z]+)\d/);
   if(['npbfen','npbfse'].includes(anyId?.[1]))continue; // Phoenix and spring educational games are separate competitions.
   if(anyId&&!['npbfil','npbfle','npbfln','npbflw','npbfnp'].includes(anyId[1]))throw Error('NPB2_UNKNOWN_COMPETITION');
   const link=part.match(/href="\/game_detail\/(npb(?:fil|fle|fln|flw|fnp)[a-z0-9]+)"[^>]*>(\d+)\s*-\s*(\d+)<\/a>/);
   const away=TEAMS[teams[0][1]],home=TEAMS[teams[1][1]];if(away===home)throw Error('NPB2_SAME_TEAM');
   const id=link?.[1]||date+'_'+away+'_'+home;if(seen.has(id))continue;seen.add(id);
   // The publisher's calendar lists away/home but prints HOME-AWAY scores.
   // Verified against its SportsEvent team results and official NPB championship results.
   const status=link?'final':/中止/.test(part)?'cancelled':/延期/.test(part)?'postponed':'scheduled';
   if(link&&!id.includes(date.replace(/-/g,'')))throw Error('NPB2_GAME_DATE_MISMATCH');
   rows.push({game_pk:'NPB2_BDS_'+id,game_id:link?.[1]||null,game_date:date,season,away_team:away,home_team:home,
    away_score:link?Number(link[3]):null,home_score:link?Number(link[2]):null,status,game_time_local:null,
    source:SOURCE,source_game_id:id,source_url:link?'https://'+SOURCE+'/game_detail/'+id:'https://'+SOURCE+'/season_schedule?year='+season+'&month='+month});
  }
 }
 return rows;
}
function reconcile(rows,prior){const out=[];for(const row of rows){const found=prior.filter(p=>p.game_date===row.game_date&&p.away_team===row.away_team&&p.home_team===row.home_team);
 let old=found.find(p=>p.source_game_id===row.source_game_id)||found.find(p=>row.game_id&&p.game_id===row.game_id);
 if(!old&&found.length===1)old=found[0];
 if(!old&&found.length>1){const exact=found.filter(p=>p.status==='final'&&row.status==='final'&&p.away_score===row.away_score&&p.home_score===row.home_score);if(exact.length===1)old=exact[0];}
 if(!old&&found.length>1)throw Error('NPB2_AMBIGUOUS_GAME');
 if(old?.status==='final'&&row.status==='final'&&(old.away_score!==row.away_score||old.home_score!==row.home_score))throw Error('NPB2_SOURCE_SCORE_CONFLICT:'+row.source_game_id);
 if(old?.status==='final'&&row.status!=='final')throw Error('NPB2_FINAL_REGRESSION');
 out.push({...row,...(old?{game_pk:old.game_pk,game_id:old.game_id||row.game_id,game_time_local:old.game_time_local,venue_name:old.venue_name}:{}),updated_at:new Date().toISOString()});
 if(old?.status==='final')for(const duplicate of found.filter(p=>p.game_pk!==old.game_pk&&!p.game_id&&p.status==='scheduled'&&p.game_time_local===old.game_time_local))out.push({...duplicate,status:'superseded',superseded_by:old.game_pk,source:'legacy_placeholder',updated_at:new Date().toISOString()});
 }return out;}
async function run({http,rest,now=new Date(),fullSeason=false}){
 const local=new Date(now.getTime()+9*3600000),season=local.getUTCFullYear(),month=local.getUTCMonth()+1,months=fullSeason?Array.from({length:Math.max(1,month-2)},(_,i)=>Math.min(month,i+3)):[month,...(month>1?[month-1]:[])];
 const prior=[];for(let offset=0;;offset+=1000){const a=await rest('npb2_games?season=eq.'+season+'&select=*&order=game_pk.asc&limit=1000&offset='+offset);if(!Array.isArray(a))throw Error('NPB2_DATABASE_READ');prior.push(...a);if(a.length<1000)break;}
 const all=[],sources=[];for(const m of months){const url='https://'+SOURCE+'/season_schedule?year='+season+'&month='+m;let html;
  for(let i=0;i<3;i++)try{const r=await http(url);if(r.status===401||r.status===403)throw Error('NPB2_ACCESS_DENIED');if(r.status===200){html=r.body;break;}}catch(e){if(e.message==='NPB2_ACCESS_DENIED')throw e;}
  if(typeof html!=='string')throw Error('NPB2_SOURCE_UNAVAILABLE');const rows=parseCalendar(html,season,m);all.push(...rows);sources.push({month:m,games:rows.length,source:SOURCE});
 }
 const rows=reconcile(all,prior),groups=new Map();
 // PostgREST requires identical keys within one bulk upsert. Preserve legacy
 // fields on superseded placeholders without clearing them on ordinary games.
 for(const row of rows){const key=Object.keys(row).filter(k=>row[k]!==undefined).sort().join('|');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
 for(const group of groups.values())for(let i=0;i<group.length;i+=100)await rest('npb2_games?on_conflict=game_pk','POST',group.slice(i,i+100));
 const report={status:'healthy',season,games:all.length,finals:all.filter(g=>g.status==='final').length,superseded:rows.filter(g=>g.status==='superseded').length,sources,lookback_complete:true,source:SOURCE};
 await rest('bb_capture_health?on_conflict=league,component','POST',[{league:'NPB2',component:'calendar',status:'healthy',season,checked_at:now.toISOString(),last_success_at:now.toISOString(),detail:report}]);return report;
}
module.exports={parseCalendar,reconcile,run,TEAMS};
