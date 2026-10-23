'use strict';
const parser=require('./npb2_stats');
async function runStats({http,rest,now=new Date()}){
 const checkedAt=now.toISOString(),season=new Date(now.getTime()+9*3600000).getUTCFullYear();
 const groups=[];
 for(const type of ['pitching','batting']){let failure,rows;
  for(let i=0;i<3;i++)try{const r=await http('https://www.farm-stats.com/stats/'+(type==='pitching'?'pitcher':'hitter'));
   if([401,403].includes(r.status))throw Error('NPB2_ACCESS_DENIED');if(r.status!==200)throw Error('NPB2_STATS_HTTP_'+r.status);
   rows=parser.parse(r.body,type,season,checkedAt);break;
  }catch(e){failure=e;if(e.message==='NPB2_ACCESS_DENIED')break;}
  if(!rows)throw failure;groups.push(rows);
 }
 await rest('bb_capture_health?on_conflict=league,component','POST',{league:'NPB2',component:'stats',status:'running',season,checked_at:checkedAt,detail:{code:'REFRESH_IN_PROGRESS'}});
 for(const rows of groups)for(let i=0;i<rows.length;i+=100)await rest('npb2_player_stats?on_conflict=player_name,team_abbr,season,stats_type','POST',rows.slice(i,i+100));
 const detail={pitchers:groups[0].length,batters:groups[1].length,teams:14,excluded:groups.flatMap(g=>g.excluded),source:'farm-stats.com',source_kind:'independent_publisher',source_as_of:null};
 await rest('bb_capture_health?on_conflict=league,component','POST',{league:'NPB2',component:'stats',status:'healthy',season,checked_at:checkedAt,last_success_at:checkedAt,detail});
 return {league:'NPB2',status:'healthy',...detail,observed_at:checkedAt};
}
module.exports={runStats};
