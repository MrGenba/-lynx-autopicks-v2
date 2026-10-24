'use strict';
const {PROPS}=require('./model');
const POLICY='bk-opponent-props-1',num=Number.isFinite,clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
function totals(rows){const v={games:0,two_a:0,two_m:0,three_a:0,three_m:0,misses:0,poss:0,ast:0,oreb:0,dreb:0};for(const r of rows){const s=r.stats||{},to=s.total_turnovers??s.turnovers;
 if(!['fga','fgm','fg3a','fg3m','fta','orb','drb','assists'].every(k=>num(s[k]))||!num(to)||s.fgm>s.fga||s.fg3m>s.fg3a||s.fga-s.fg3a<s.fgm-s.fg3m)continue;
 const poss=s.fga-s.orb+.44*s.fta+to;if(poss<40||poss>170)continue;
 v.games++;v.two_a+=s.fga-s.fg3a;v.two_m+=s.fgm-s.fg3m;v.three_a+=s.fg3a;v.three_m+=s.fg3m;v.misses+=s.fga-s.fgm;v.poss+=poss;v.ast+=s.assists;v.oreb+=s.orb;v.dreb+=s.drb;
 }return v;}
function opponent(g,h,teamId,now){
 const valid=(h?.teams||[]).filter(t=>t.game?.season>=g.season-1&&[2,3].includes(t.game.season_type)&&Date.parse(t.game.starts_at)+4*3600000<now.getTime()&&Date.parse(t.game.starts_at)<Date.parse(g.starts_at)).sort((a,b)=>Date.parse(a.game.starts_at)-Date.parse(b.game.starts_at));
 const season=valid.filter(t=>t.game.season===g.season),prior=totals(season.length>=100?season:valid),other=teamId===g.home_team_id?g.away_team_id:g.home_team_id;
 const allowed=totals(valid.filter(t=>t.opponent_id===other).slice(-20)),offense=totals(valid.filter(t=>t.team_id===other).slice(-20));
 if(prior.games<100||allowed.games<8||offense.games<8||prior.two_m<=0||prior.three_m<=0||prior.ast<=0||prior.misses<=0)return null;
 const ratio=(observed,n,p,strength)=>clamp(((observed+strength*p)/(n+strength))/p,.92,1.08);
 return {policy:POLICY,opponent_id:other,prior_scope:season.length>=100?'CURRENT_SEASON_REGULAR_AND_PLAYOFFS':'CURRENT_AND_PREVIOUS_SEASON',prior_games:prior.games,allowed_games:allowed.games,offense_games:offense.games,
  two_factor:ratio(allowed.two_m,allowed.two_a,prior.two_m/prior.two_a,400),three_factor:ratio(allowed.three_m,allowed.three_a,prior.three_m/prior.three_a,300),
  assists_factor:ratio(allowed.ast,allowed.poss,prior.ast/prior.poss,1000),own_miss_factor:ratio(allowed.misses,allowed.poss,prior.misses/prior.poss,1000),opponent_miss_factor:ratio(offense.misses,offense.poss,prior.misses/prior.poss,1000)};
}
function apply(f,g,h,now){
 const out=JSON.parse(JSON.stringify(f)),opp=opponent(g,h,f.team_id,now);
 const rows=(h?.players||[]).filter(p=>p.player_id===f.player_id&&p.team_id===f.team_id&&p.game?.season>=g.season-1&&[2,3].includes(p.game.season_type)&&!p.did_not_play&&p.minutes>0&&Date.parse(p.game.starts_at)+4*3600000<now.getTime()&&Date.parse(p.game.starts_at)<Date.parse(g.starts_at)).sort((a,b)=>Date.parse(a.game.starts_at)-Date.parse(b.game.starts_at)).slice(-30);
 const counts={two:0,three:0,ft:0,orb:0,drb:0,two_a:0,three_a:0,minutes:0};let n=0;
 for(const p of rows){const s=p.stats;if(!s||!['fgm','fga','fg3m','fg3a','ftm','orb','drb'].every(k=>num(s[k])))continue;n++;counts.two+=2*(s.fgm-s.fg3m);counts.three+=3*s.fg3m;counts.ft+=s.ftm;counts.orb+=s.orb;counts.drb+=s.drb;counts.two_a+=s.fga-s.fg3a;counts.three_a+=s.fg3a;counts.minutes+=p.minutes;}
 const points=counts.two+counts.three+counts.ft,rebounds=counts.orb+counts.drb;
 if(!opp||n<8||points<=0||rebounds<=0){out.defense={policy:POLICY,status:'HISTORY_FALLBACK',reason:'INSUFFICIENT_VALIDATED_OPPONENT_OR_PLAYER_HISTORY',player_games:n};return out;}
 const factors={points:(counts.two*opp.two_factor+counts.three*opp.three_factor+counts.ft)/points,threes:opp.three_factor,assists:opp.assists_factor,rebounds:(counts.orb*opp.own_miss_factor+counts.drb*opp.opponent_miss_factor)/rebounds},delta={};
 for(const [k,factor]of Object.entries(factors)){if(!f.props[k])continue;const s=f.props[k],mean=s.mean*factor;delta[k]=mean-s.mean;out.props[k]={mean,variance:Math.max(mean,s.variance*Math.max(1,factor*factor))+delta[k]**2};}
 for(const [k,parts]of Object.entries(PROPS))if(parts.length>1&&f.props[k]){const shift=parts.reduce((s,k)=>s+(delta[k]||0),0);out.props[k]={mean:f.props[k].mean+shift,variance:Math.max(f.props[k].variance,f.props[k].mean+shift)+shift*shift};}
 out.defense={policy:POLICY,status:'APPLIED',opponent:opp,factors,player_games:n,shot_mix:{two_point_share:counts.two/points,three_point_share:counts.three/points,free_throw_share:counts.ft/points,offensive_rebound_share:counts.orb/rebounds},expected_makes:{two:(counts.two/2)/counts.minutes*f.projected_minutes*opp.two_factor,three:(counts.three/3)/counts.minutes*f.projected_minutes*opp.three_factor,definition:'HISTORICAL_SHOT_RATE_ADJUSTED_FOR_MINUTES_AND_OPPONENT_NOT_OPTICAL_TRACKING'}};
 return out;
}
module.exports={POLICY,totals,opponent,apply};
