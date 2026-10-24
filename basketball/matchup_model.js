'use strict';
// Fixed prospective challenger. These coefficients are hypotheses, not fitted
// to the already inspected 12-game results and never replace the active model.
const {PROPS}=require('./model');
const advanced=require('./advanced_model');
const VERSION='bk-shot-matchup-1',POLICY='bk-shot-matchup-prospective-1';
const num=Number.isFinite,clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
function optional(rows,name,bundle,g,now){
 const matches=rows.filter(r=>r.dataset===name&&r.season_type===bundle.base?.season_type&&r.per_mode==='Totals');if(matches.length!==1)return null;
 const r=matches[0],s=r.stats,b=bundle.base;
 if(advanced.gate(r,g,now).length||r.provider_player_id!==b.provider_player_id||r.provider_team_id!==b.provider_team_id||s.gp!==b.stats.gp)return null;
 const minutes=name==='stats_scoring'?b.stats.min/b.stats.gp:b.stats.min;
 if(!num(s.min)||Math.abs(s.min-minutes)>Math.max(1,b.stats.gp*.1))return null;
 return r;
}
function opponentHistory(game,history,teamId){
 const teams=history.teams.filter(t=>t.game.season>=game.season-1&&t.game.season_type===game.season_type&&Date.parse(t.game.starts_at)<Date.parse(game.starts_at));
 const sums=rows=>{const out={n:0,fg2a:0,fg2m:0,fg3a:0,fg3m:0,misses:0,poss:0,ast:0,oreb:0,dreb:0};
  for(const t of rows){const s=t.stats;if(!['fga','fgm','fg3a','fg3m','fta','orb','drb','assists'].every(k=>num(s[k])))continue;
   const poss=s.fga-s.orb+.44*s.fta+(s.total_turnovers??s.turnovers);if(!(poss>40&&poss<170))continue;
   out.n++;out.fg2a+=s.fga-s.fg3a;out.fg2m+=s.fgm-s.fg3m;out.fg3a+=s.fg3a;out.fg3m+=s.fg3m;out.misses+=s.fga-s.fgm;out.poss+=poss;out.ast+=s.assists;out.oreb+=s.orb;out.dreb+=s.drb;}
  return out;};
 const league=sums(teams),opponentId=teamId===game.home_team_id?game.away_team_id:game.home_team_id;
 const allowed=sums(teams.filter(t=>t.opponent_id===opponentId).slice(-30)),opponent=sums(teams.filter(t=>t.team_id===opponentId).slice(-30));
 if(league.n<50||allowed.n<8||opponent.n<8||!league.fg2a||!league.fg3a||!league.misses)return null;
 const l2=league.fg2m/league.fg2a,l3=league.fg3m/league.fg3a,lmiss=league.misses/league.poss;
 return {opponent_id:opponentId,games:allowed.n,two_factor:clamp(((allowed.fg2m+400*l2)/(allowed.fg2a+400))/l2,.9,1.1),
  three_factor:clamp(((allowed.fg3m+300*l3)/(allowed.fg3a+300))/l3,.9,1.1),
  own_miss_factor:clamp(((allowed.misses+800*lmiss)/(allowed.poss+800))/lmiss,.9,1.1),
  opponent_miss_factor:clamp(((opponent.misses+800*lmiss)/(opponent.poss+800))/lmiss,.9,1.1),
  assisted_basket_factor:clamp(((allowed.ast+400*league.ast/league.poss)/(allowed.poss+400))/(league.ast/league.poss),.9,1.1)};
}
function defenderContext(game,forecasts,bundles,rowsById,now,teamId){
 const opponentId=teamId===game.home_team_id?game.away_team_id:game.home_team_id,valid=[];
 for(const f of forecasts.filter(f=>f.team_id===opponentId&&f.status==='OK'&&!['OUT','INACTIVE','SUSPENDED','DOUBTFUL'].includes(f.availability))){
  const b=bundles.get(f.player_id);if(!b?.eligible)continue;
  const row=optional(rowsById.get(f.player_id)||[],'stats_defense',b,game,now),s=row?.stats;
  if(!s||s.stl!==b.base.stats.stl||s.blk!==b.base.stats.blk||s.dreb!==b.base.stats.dreb||!num(s.def_rating)||s.def_rating<60||s.def_rating>160)continue;
  valid.push({id:f.player_id,minutes:f.projected_minutes,rating:s.def_rating,games:s.gp,version_id:row.version_id});
 }
 const minutes=valid.reduce((s,r)=>s+r.minutes,0),required=(game.league==='NBA'?48:40)*5;
 if(minutes<required*.65)return {status:'INSUFFICIENT_ROSTER_COVERAGE',factor:1,players:valid};
 const rating=valid.reduce((s,r)=>s+r.rating*r.minutes,0)/minutes,weightedGames=valid.reduce((s,r)=>s+r.games*r.minutes,0)/minutes;
 // On-court team defense is contextual, not an isolated defender skill or a
 // guessed man-to-man assignment. Very limited effect, shrinking early seasons.
 const all=[...bundles.values()].filter(b=>b.eligible&&num(b.advanced.stats.def_rating)),reference=all.reduce((s,b)=>s+b.advanced.stats.def_rating*b.base.stats.min,0)/all.reduce((s,b)=>s+b.base.stats.min,0);
 if(!num(reference)||reference<=0)return {status:'NO_DEFENSE_PRIOR',factor:1,players:valid};
 return {status:'ROSTER_CONTEXT',factor:1+Math.min(.2,weightedGames/(weightedGames+30))*clamp(rating/reference-1,-.1,.1),rating,reference,players:valid};
}
function enrich(f,bundle,rows,prior,opponent,defense,game,now){
 const result=JSON.parse(JSON.stringify(f));result.model_version=VERSION;result.matchup={policy:POLICY,status:'FALLBACK',research_only:true,reasons:[]};
 if(!bundle?.eligible||!opponent||![prior.two,prior.three,prior.ft].every(num)){result.matchup.reasons.push('VALIDATED_INPUTS_OR_OPPONENT_HISTORY_MISSING');return result;}
 const b=bundle.base.stats,a=bundle.advanced.stats,weight=Math.min(.25,b.gp/(b.gp+20),b.min/(b.min+600));
 const exposure=f.projected_minutes*(f.matchup_pace_factor||1)/b.min;
 // Disjoint shot categories: catch-and-shoot, pull-up, and residual shots.
 const categories=[],versions=[bundle.base.version_id,bundle.advanced.version_id],excluded=[];
 let remaining={a2:b.fga-b.fg3_a,m2:b.fgm-b.fg3_m,a3:b.fg3_a,m3:b.fg3_m};
 for(const [dataset,prefix]of [['tracking_catchshoot','catch_shoot'],['tracking_pullupshot','pull_up']]){
  const row=optional(rows,dataset,bundle,game,now),s=row?.stats;
  if(!s){excluded.push(dataset);continue;}
  const v={name:dataset,a2:s[prefix+'_fga']-s[prefix+'_fg3_a'],m2:s[prefix+'_fgm']-s[prefix+'_fg3_m'],a3:s[prefix+'_fg3_a'],m3:s[prefix+'_fg3_m']};
  if(!['a2','m2','a3','m3'].every(k=>Number.isInteger(v[k])&&v[k]>=0&&v[k]<=remaining[k])||v.m2>v.a2||v.m3>v.a3||remaining.m2-v.m2>remaining.a2-v.a2||remaining.m3-v.m3>remaining.a3-v.a3){excluded.push(dataset+':COUNTS_INVALID_OR_OVERLAP');continue;}
  categories.push(v);for(const k of ['a2','m2','a3','m3'])remaining[k]-=v[k];versions.push(row.version_id);
 }
 categories.push({name:'remaining',...remaining});
 let expected2=0,expected3=0;
 const shotProfile=categories.map(c=>{const p2=clamp((c.m2+100*prior.two)/(c.a2+100)*opponent.two_factor*defense.factor,0,1),p3=clamp((c.m3+75*prior.three)/(c.a3+75)*opponent.three_factor*defense.factor,0,1);
  const x2=c.a2*exposure*p2,x3=c.a3*exposure*p3;expected2+=x2;expected3+=x3;return {...c,expected_attempts_2:c.a2*exposure,expected_attempts_3:c.a3*exposure,expected_made_2:x2,expected_made_3:x3};});
 const expectedFT=b.fta*exposure*(b.ftm+50*prior.ft)/(b.fta+50),target={points:2*expected2+3*expected3+expectedFT,threes:expected3};
 const passing=bundle.tracking.tracking_passing,rebounding=bundle.tracking.tracking_rebounding;
 if(passing&&num(prior.passing))target.assists=passing.opportunities*exposure*(passing.converted+50*prior.passing)/(passing.opportunities+50)*opponent.assisted_basket_factor;
 else target.assists=b.ast*exposure*opponent.assisted_basket_factor;
 const reboundFactor=b.reb?b.oreb/b.reb*opponent.own_miss_factor+b.dreb/b.reb*opponent.opponent_miss_factor:1;
 target.rebounds=(rebounding&&num(prior.rebounding)?rebounding.opportunities*exposure*(rebounding.converted+50*prior.rebounding)/(rebounding.opportunities+50):b.reb*exposure)*reboundFactor;
 for(const t of Object.values(bundle.tracking))versions.push(t.row.version_id);
 versions.push(...defense.players.map(p=>p.version_id));
 const delta={};for(const [market,expected]of Object.entries(target)){const old=f.props[market],bounded=clamp(expected,old.mean*.75,old.mean*1.25),shift=weight*(bounded-old.mean);delta[market]=shift;
  result.props[market]={mean:old.mean+shift,variance:Math.max(old.variance,old.mean+shift)+weight*(1-weight)*(bounded-old.mean)**2};}
 for(const [key,parts]of Object.entries(PROPS))if(parts.length>1){const shift=parts.reduce((s,k)=>s+(delta[k]||0),0);result.props[key]={mean:f.props[key].mean+shift,variance:Math.max(f.props[key].variance,f.props[key].mean+shift)+shift*shift};}
 result.matchup={policy:POLICY,status:'APPLIED',research_only:true,weight,version_ids:[...new Set(versions)].sort(),opponent,defense,
  features:{shots:shotProfile,expected_field_goals:expected2+expected3,expected_points:target.points,expected_free_throws:expectedFT,usage:a.usg_pct,offensive_rating:a.off_rating,defensive_rating:a.def_rating,
   offensive_rebounds:b.oreb,defensive_rebounds:b.dreb,steals:b.stl,blocks:b.blk,fouls:b.pf,turnovers:b.tov,potential_assists:passing?.opportunities??null,rebound_chances:rebounding?.opportunities??null},targets:target,excluded,
  expected_baskets_definition:'MODEL_ESTIMATE_FROM_SHOT_TYPE_VOLUME_AND_SHRUNK_CONVERSION_NOT_OPTICAL_XFG',availability:f.availability,minutes:f.projected_minutes};
 delete result.matchup_pace_factor;return result;
}
function build(game,history,forecasts,rows,now){
 const grouped=new Map();for(const row of rows){if(!row.player_id)continue;if(!grouped.has(row.player_id))grouped.set(row.player_id,[]);grouped.get(row.player_id).push(row);}
 const bundles=new Map([...grouped].map(([pid,rs])=>[pid,advanced.validatePlayer(rs,game,now)])),prior=advanced.priors([...bundles.values()]);
 const players=forecasts.filter(f=>f.player_id&&f.status==='OK'),opponents={},defenses={};
 for(const tid of [game.home_team_id,game.away_team_id]){opponents[tid]=opponentHistory(game,history,tid);defenses[tid]=defenderContext(game,players,bundles,grouped,now,tid);}
 const team=forecasts.find(f=>!f.player_id&&f.status==='OK'),paceFactor=team?.league_pace>0?clamp(team.pace/team.league_pace,.85,1.15):1;
 return players.map(f=>enrich({...f,matchup_pace_factor:paceFactor},bundles.get(f.player_id),grouped.get(f.player_id)||[],prior,opponents[f.team_id],defenses[f.team_id],game,now));
}
module.exports={VERSION,POLICY,optional,opponentHistory,defenderContext,enrich,build};
