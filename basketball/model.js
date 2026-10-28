'use strict';
// Separate, experimental basketball baselines. No baseball run distributions.
const MODELS={baseline:{version:'bk-pace-minutes-1',window:30,decay:0.97,priorGames:12},challenger:{version:'bk-pace-minutes-2',window:15,decay:0.94,priorGames:20}};
const PROPS={points:['points'],rebounds:['rebounds'],assists:['assists'],threes:['fg3m'],pra:['points','rebounds','assists'],pr:['points','rebounds'],pa:['points','assists'],ra:['rebounds','assists']};
const mean=a=>a.reduce((s,v)=>s+v,0)/a.length;
function weighted(rows,fn,decay){let w=0,s=0,s2=0;rows.forEach((r,i)=>{const k=Math.pow(decay,rows.length-1-i),v=fn(r);w+=k;s+=k*v;s2+=k*v*v;});const m=s/w;return {mean:m,variance:Math.max(0,s2/w-m*m),weight:w};}
function normalCdf(x){const sign=x<0?-1:1,z=Math.abs(x)/Math.SQRT2,t=1/(1+0.3275911*z),erf=1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-z*z);return (1+sign*erf)/2;}
function normalDistribution(mu,variance,threshold,side='over'){
 const sd=Math.sqrt(Math.max(variance,0.01)),integer=Number.isInteger(threshold),lower=integer?threshold-0.5:Math.floor(threshold)+0.5,upper=integer?threshold+0.5:lower;
 const below=normalCdf((lower-mu)/sd),above=1-normalCdf((upper-mu)/sd),push=integer?1-below-above:0;
 return {p_win:side==='over'?above:below,p_push:Math.max(0,push),p_loss:side==='over'?below:above};
}
function countDistribution(mu,variance,line,side){
 if(!Number.isFinite(mu)||mu<0||!Number.isFinite(line)||line<0||!['over','under'].includes(side))throw Error('INVALID_COUNT_DISTRIBUTION');
 const cap=Math.floor(line),v=Math.max(mu,variance),r=v>mu+0.0001?mu*mu/(v-mu):null,p=r?r/(r+mu):null;
 let prob=mu===0?1:r?Math.exp(r*Math.log(p)):Math.exp(-mu),below=0,equal=0;
 for(let k=0;k<=cap;k++){if(Number.isInteger(line)&&k===cap)equal=prob;else below+=prob;prob*=r?((k+r)/(k+1))*(1-p):mu/(k+1);}
 const above=Math.max(0,1-below-equal);return {p_win:side==='over'?above:below,p_push:equal,p_loss:side==='over'?below:above};
}
function prepareHistory(games,teams,players,asOf,league){
 const cutoff=Date.parse(asOf),valid=games.filter(g=>g.league===league&&g.status==='final'&&g.box_complete===true&&Date.parse(g.starts_at)+4*3600000<cutoff),map=new Map(valid.map(g=>[g.game_id,g]));
 const attach=r=>({...r,game:map.get(r.game_id)}),byTime=(a,b)=>Date.parse(a.game.starts_at)-Date.parse(b.game.starts_at);
 return {games:valid,teams:teams.filter(t=>t.league===league&&map.has(t.game_id)).map(attach).sort(byTime),players:players.filter(p=>p.league===league&&map.has(p.game_id)).map(attach).sort(byTime)};
}
function possession(t){const s=t.stats;return s.fga-s.orb+(s.total_turnovers??s.turnovers)+0.44*s.fta;}
function teamForecast(game,history,config=MODELS.baseline){
 const data=history.teams.filter(t=>t.game.season>=game.season-1),byGame=new Map();for(const t of data){if(!byGame.has(t.game_id))byGame.set(t.game_id,[]);byGame.get(t.game_id).push(t);}
 const obs=data.map(t=>{const other=byGame.get(t.game_id)?.find(o=>o.team_id!==t.team_id);if(!other)return null;const poss=(possession(t)+possession(other))/2;if(!(poss>40&&poss<170))return null;
  const regulation=game.league==='NBA'?48:40,duration=regulation+Math.max(0,(t.game.periods||4)-4)*5;
  return {team:t.team_id,game:t.game,pace:poss*regulation/duration,off:100*t.stats.points/poss,def:100*other.stats.points/poss};}).filter(Boolean);
 if(obs.length<100)return {status:'INSUFFICIENT_TEAM_HISTORY',sample:obs.length};
 const leaguePace=mean(obs.map(r=>r.pace)),leagueEff=mean(obs.map(r=>r.off));
 const estimate=id=>{const rows=obs.filter(t=>t.team===id).slice(-config.window);if(rows.length<8)return null;const n=rows.length,prior=config.priorGames;
  const val=k=>(weighted(rows,r=>r[k],config.decay).mean*n+(k==='pace'?leaguePace:leagueEff)*prior)/(n+prior);return {games:n,pace:val('pace'),off:val('off'),def:val('def')};};
 const home=estimate(game.home_team_id),away=estimate(game.away_team_id);if(!home||!away)return {status:'INSUFFICIENT_TEAM_HISTORY'};
 const finalGames=history.games.filter(g=>g.season>=game.season-1),homeMargins=finalGames.filter(g=>!g.neutral_site).map(g=>g.home_score-g.away_score);
 const homeAdv=game.neutral_site||!homeMargins.length?0:mean(homeMargins)*homeMargins.length/(homeMargins.length+100);
 const pace=(home.pace+away.pace)/2,homePts=pace*(home.off+away.def-leagueEff)/100+homeAdv/2,awayPts=pace*(away.off+home.def-leagueEff)/100-homeAdv/2;
 const margins=finalGames.map(g=>g.home_score-g.away_score),totals=finalGames.map(g=>g.home_score+g.away_score),variance=a=>{const average=mean(a);return mean(a.map(x=>(x-average)**2));};
 const margin=homePts-awayPts,total=homePts+awayPts,marginVar=Math.max(64,variance(margins)),totalVar=Math.max(100,variance(totals));
 // Full-game basketball has no draw after overtime; condition the discretized margin on no tie.
 const win=normalDistribution(margin,marginVar,0,'over'),pHome=win.p_win/(1-win.p_push);
 return {status:'OK',model_version:config.version,home_points:homePts,away_points:awayPts,margin,total,margin_variance:marginVar,total_variance:totalVar,p_home:pHome,p_away:1-pHome,
  pace,league_pace:leaguePace,home_games:home.games,away_games:away.games,training_games:finalGames.length,uncertainty:'EXPERIMENTAL_UNCALIBRATED'};
}
function playerForecast(playerId,game,history,team,config=MODELS.baseline){
 const rows=history.players.filter(p=>p.player_id===playerId&&p.game.season>=game.season-1&&!p.did_not_play&&p.minutes>0&&p.stats).slice(-config.window);
 if(rows.length<10||team.status!=='OK')return {status:'INSUFFICIENT_PLAYER_HISTORY',sample:rows.length};
 const last=rows.at(-1),teamId=last.team_id;if(![game.home_team_id,game.away_team_id].includes(teamId))return {status:'PLAYER_TEAM_UNVERIFIED'};
 const sameTeam=rows.filter(p=>p.team_id===teamId);if(sameTeam.length<5)return {status:'RECENT_TEAM_CHANGE',sample:sameTeam.length};
 const recent=rows.slice(-10),minutes=weighted(recent,p=>p.minutes,config.decay),regulation=game.league==='NBA'?48:40,projectedMinutes=Math.min(regulation,minutes.mean);
 const paceFactor=Math.max(0.85,Math.min(1.15,team.pace/team.league_pace)),props={};
 for(const [key,fields]of Object.entries(PROPS)){
  // Each historical combination is summed within a game, preserving covariance.
  const values=weighted(rows,p=>fields.reduce((s,k)=>s+p.stats[k],0)/p.minutes*projectedMinutes*paceFactor,config.decay);
  const variance=Math.max(values.mean,values.variance+values.mean**2*minutes.variance/Math.max(1,projectedMinutes**2));
  props[key]={mean:values.mean,variance};
 }
 return {status:'OK',model_version:config.version,player_id:playerId,player_name:last.player_name,team_id:teamId,projected_minutes:projectedMinutes,minutes_sd:Math.sqrt(minutes.variance),props,
  sample:rows.length,last_played_at:last.game.starts_at,availability:'UNVERIFIED',uncertainty:'EXPERIMENTAL_UNCALIBRATED'};
}
function baseProbability(quote,forecast){
 if(forecast.status!=='OK')throw Error('FORECAST_NOT_READY');
 if(quote.player_id){const p=forecast.props[quote.market];if(!p)throw Error('UNSUPPORTED_PROP');return countDistribution(p.mean,p.variance,Number(quote.line),quote.selection);}
 if(quote.market==='moneyline')return {p_win:quote.selection==='home'?forecast.p_home:forecast.p_away,p_push:0,p_loss:quote.selection==='home'?forecast.p_away:forecast.p_home};
 if(quote.market==='total')return normalDistribution(forecast.total,forecast.total_variance,Number(quote.line),quote.selection);
 if(quote.market==='spread'){const mu=quote.selection==='home'?forecast.margin:-forecast.margin;return normalDistribution(mu,forecast.margin_variance,-Number(quote.line),'over');}
 throw Error('UNSUPPORTED_MARKET');
}
function probability(quote,forecast){return forecast?.overtime?.status==='APPLIED'?require('./overtime').probability(quote,forecast,baseProbability):baseProbability(quote,forecast);}
module.exports={MODELS,PROPS,weighted,normalCdf,normalDistribution,countDistribution,prepareHistory,teamForecast,playerForecast,baseProbability,probability};

