'use strict';
const POSTGAME_VERSION = 'postgame-complete-v1';
function buildPostgameIngest(g, box, sportId) {
  if (![1,11,23].includes(sportId) || g.status?.abstractGameState !== 'Final' ||
      !['Final','Game Over','Completed Early'].includes(g.status?.detailedState)) throw Error('Only official final games are eligible');
  if (!Number.isInteger(g.gamePk) || !Number.isFinite(Date.parse(g.gameDate))) throw Error('Missing event identity');
  const rows=[], expected=[], seen=new Set(), totals={};
  for (const side of ['away','home']) {
    const team=box.teams?.[side], scheduled=g.teams?.[side];
    if (!team || team.team?.id !== scheduled?.team?.id || !Number.isInteger(scheduled.score)) throw Error('Team/score mismatch');
    if (!Array.isArray(team.pitchers) || !team.pitchers.length) throw Error('Missing pitchers');
    let outsTotal=0;
    for (const [index,id] of team.pitchers.entries()) {
      const p=team.players?.['ID'+id], st=p?.stats?.pitching;
      if (!st || st.inningsPitched == null) throw Error('Incomplete pitcher '+id);
      const m=/^(\d+)\.([012])$/.exec(String(st.inningsPitched));
      if (!m || seen.has(id)) throw Error('Invalid innings/duplicate pitcher');
      const outs=Number(m[1])*3+Number(m[2]);
      if (st.outs != null && Number(st.outs)!==outs) throw Error('Inconsistent outs');
      seen.add(id);expected.push(id);outsTotal+=outs;
      const stats={};
      for(const [to,from] of Object.entries({earned_runs:'earnedRuns',strikeouts:'strikeOuts',walks:'baseOnBalls',hits:'hits',home_runs:'homeRuns',batters_faced:'battersFaced',pitches:'numberOfPitches',strikes:'strikes'})) {
        const v=st[from];if(v!=null&&(!Number.isInteger(Number(v))||Number(v)<0))throw Error('Invalid '+from);
        stats[to]=v==null?null:Number(v);
      }
      rows.push({game_pk:g.gamePk,game_id:g.gamePk,game_date:g.officialDate||g.gameDate.slice(0,10),season:Number(g.season||g.gameDate.slice(0,4)),player_id:id,
        player_name:p.person?.fullName||null,team_id:team.team.id,team_name:team.team.name,is_home:side==='home',is_starter:index===0,
        innings_pitched:outs/3,...stats,base_on_balls:stats.walks});
    }
    const t=String(team.teamStats?.pitching?.inningsPitched||'');const m=/^(\d+)\.([012])$/.exec(t);
    if (!m || Number(m[1])*3+Number(m[2])!==outsTotal) throw Error('Team innings do not reconcile');
    totals[side]=outsTotal;
  }
  return {sport_id:sportId,collector_version:POSTGAME_VERSION,source_url:'https://statsapi.mlb.com/api/v1/game/'+g.gamePk+'/boxscore',
    game:{game_id:g.gamePk,game_date:g.gameDate,official_date:g.officialDate||g.gameDate.slice(0,10),season:Number(g.season||g.gameDate.slice(0,4)),
      status:g.status.detailedState,game_type:g.gameType,scheduled_innings:g.scheduledInnings,venue_id:g.venue?.id,venue_name:g.venue?.name,
      away_team_id:g.teams.away.team.id,away_team_name:g.teams.away.team.name,home_team_id:g.teams.home.team.id,home_team_name:g.teams.home.team.name,
      away_score:g.teams.away.score,home_score:g.teams.home.score},
    rows,expected_pitcher_ids:expected,team_outs:totals,known_pregame:false};
}
module.exports={buildPostgameIngest,POSTGAME_VERSION};
