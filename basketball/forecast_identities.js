'use strict';
const {all}=require('./capture');
// Quote matching only needs the player identity. Avoid transporting every model
// distribution and context revision with each browser poll.
async function load(rest,league,games){
 if(!games.length)return [];
 const rows=await all(rest,'bk_forecasts?league=eq.'+league+'&game_id=in.('+games.map(g=>g.game_id).join(',')+')&kind=eq.player&select=league,game_id,player_id,player_name:result->>player_name,team_id:result->>team_id&order=forecast_id.asc');
 const seen=new Set(),result=[];
 for(const row of rows){
  const player_name=row.player_name??row.result?.player_name,team_id=row.team_id??row.result?.team_id;
  if(!row.player_id||!player_name||!team_id)continue;
  const key=JSON.stringify([row.league,row.game_id,row.player_id,player_name,team_id]);
  if(seen.has(key))continue;seen.add(key);
  result.push({league:row.league,game_id:row.game_id,player_id:row.player_id,result:{player_name,team_id}});
 }
 return result;
}
module.exports={load};

