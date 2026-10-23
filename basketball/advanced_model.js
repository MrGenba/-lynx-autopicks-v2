'use strict';
const {MODELS,PROPS,playerForecast,teamForecast,normalDistribution}=require('./model');
const POLICY='bk-advanced-validation-1';
const VERSION='bk-advanced-opportunity-1';
const CONFIG={...MODELS.baseline,version:VERSION};
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const num=x=>typeof x==='number'&&Number.isFinite(x);
const close=(a,b,t=.002)=>num(a)&&num(b)&&Math.abs(a-b)<=t;
const context=g=>g.season_type===3?'Playoffs':'Regular Season';
function gate(row,g,now){
 const r=[];if(!row)return ['MISSING_DATASET'];
 if(row.league!==g.league||row.season!==g.season||row.season_type!==context(g)||row.per_mode!=='Totals')r.push('WRONG_CONTEXT');
 if(!row.player_id||row.mapping?.status!=='mapped')r.push('IDENTITY_UNVERIFIED');
 if(!['ok','partial'].includes(row.source_status))r.push('SOURCE_UNHEALTHY');
 for(const field of ['observed_at','source_published_at','latest_publication_at','source_checked_at']){
  const t=Date.parse(row[field]);if(!Number.isFinite(t)||t>now.getTime()||t>=Date.parse(g.starts_at))r.push('OBSERVATION_NOT_PREGAME');
  if(field==='latest_publication_at'&&now.getTime()-t>48*3600000)r.push('SOURCE_STALE');
  if(field==='source_checked_at'&&now.getTime()-t>2*3600000)r.push('COLLECTOR_STALE');
 }
 if(row.quality?.flags?.length)r.push(...row.quality.flags);
 if(row.quality?.boxscore_comparison?.games_match!==true)r.push('GAMES_NOT_RECONCILED');
 return [...new Set(r)];
}
function validatePlayer(rows,g,now){
 const matching=rows.filter(r=>r.league===g.league&&r.season===g.season&&r.season_type===context(g)&&r.per_mode==='Totals');
 const datasets=new Map();for(const r of matching){if(!datasets.has(r.dataset))datasets.set(r.dataset,[]);datasets.get(r.dataset).push(r);}
 const one=name=>datasets.get(name)?.length===1?datasets.get(name)[0]:null;
 const base=one('stats_base'),advanced=one('stats_advanced');
 const reasons=[...gate(base,g,now).map(s=>'BASE:'+s),...gate(advanced,g,now).map(s=>'ADVANCED:'+s)];
 const b=base?.stats||{},a=advanced?.stats||{};
 if(!Number.isInteger(b.gp)||b.gp<1||!num(b.min)||b.min<1||b.min>b.gp*90)reasons.push('EXPOSURE_INVALID');
 for(const k of ['pts','reb','ast','fgm','fga','fg3_m','fg3_a','ftm','fta','oreb','dreb','tov'])if(!Number.isInteger(b[k])||b[k]<0)reasons.push('BASE_COUNTS_INVALID');
 if(b.fgm>b.fga||b.fg3_m>b.fg3_a||b.fg3_a>b.fga||b.fg3_m>b.fgm||b.ftm>b.fta||b.oreb+b.dreb!==b.reb||2*b.fgm+b.fg3_m+b.ftm!==b.pts)reasons.push('BASE_ARITHMETIC');
 if(base?.quality?.boxscore_comparison?.points_match!==true)reasons.push('POINTS_NOT_RECONCILED');
 if(b.team_count!==1||a.team_count!==1)reasons.push('MULTI_TEAM_OR_UNKNOWN_SCOPE');
 if(base&&advanced&&(base.provider_player_id!==advanced.provider_player_id||base.provider_team_id!==advanced.provider_team_id||a.gp!==b.gp||a.fga!==b.fga||a.fgm!==b.fgm))reasons.push('DATASET_IDENTITY_OR_TOTALS_DIFFER');
 if(!close(a.min,b.min/b.gp,.16))reasons.push('ADVANCED_MINUTES_UNITS');
 if(b.fga>0&&!close(a.efg_pct,(b.fgm+.5*b.fg3_m)/b.fga))reasons.push('EFG_ARITHMETIC');
 if(b.fga+.44*b.fta>0&&!close(a.ts_pct,b.pts/(2*(b.fga+.44*b.fta)),.003))reasons.push('TS_ARITHMETIC');
 for(const k of ['usg_pct','ast_pct','reb_pct'])if(!num(a[k])||a[k]<0||a[k]>1)reasons.push('ADVANCED_RATE_INVALID');
 const tracking={},excluded={};
 for(const [name,field,baseField]of [['tracking_passing','ast','ast'],['tracking_rebounding','reb','reb']]){
  const row=one(name);if(!row){excluded[name]=['NOT_AVAILABLE'];continue;}
  const errors=gate(row,g,now),s=row.stats;
  if(row.provider_player_id!==base?.provider_player_id||row.provider_team_id!==base?.provider_team_id||s.gp!==b.gp||s[field]!==b[baseField]||!close(s.min,b.min,Math.max(1,b.gp*.1)))errors.push('TRACKING_TOTALS_OR_UNITS');
  const opportunities=name==='tracking_passing'?s.potential_ast:s.reb_chances;
  if(!Number.isInteger(opportunities)||opportunities<0||opportunities<s[field])errors.push('OPPORTUNITY_COUNTS');
  if(name==='tracking_passing'&&(!num(s.passes_made)||opportunities>s.passes_made))errors.push('PASSING_COUNTS');
  if(name==='tracking_rebounding'&&s.reb_contest+s.reb_uncontest!==s.reb)errors.push('REBOUND_COMPONENTS');
  if(errors.length)excluded[name]=[...new Set(errors)];else tracking[name]={row,opportunities,converted:s[field]};
 }
 const unique=[...new Set(reasons)],versionIds=matching.map(r=>r.version_id).sort();
 return {policy:POLICY,eligible:unique.length===0,reasons:unique,base,advanced,tracking,excluded,versionIds};
}
function priors(bundles){
 const totals={twoMade:0,twoAttempts:0,threeMade:0,threeAttempts:0,ftMade:0,ftAttempts:0,ast:0,potential:0,reb:0,chances:0};
 for(const v of bundles.filter(v=>v.eligible)){
  const s=v.base.stats;totals.twoMade+=s.fgm-s.fg3_m;totals.twoAttempts+=s.fga-s.fg3_a;totals.threeMade+=s.fg3_m;totals.threeAttempts+=s.fg3_a;totals.ftMade+=s.ftm;totals.ftAttempts+=s.fta;
  const p=v.tracking.tracking_passing,r=v.tracking.tracking_rebounding;if(p){totals.ast+=p.converted;totals.potential+=p.opportunities;}if(r){totals.reb+=r.converted;totals.chances+=r.opportunities;}
 }
 return {two:totals.twoAttempts>=100?totals.twoMade/totals.twoAttempts:null,three:totals.threeAttempts>=75?totals.threeMade/totals.threeAttempts:null,ft:totals.ftAttempts>=50?totals.ftMade/totals.ftAttempts:null,
  passing:totals.potential>=100?totals.ast/totals.potential:null,rebounding:totals.chances>=100?totals.reb/totals.chances:null,totals};
}
function enrichPlayer(f,bundle,leaguePrior,paceFactor){
 const result={...f,model_version:VERSION,props:Object.fromEntries(Object.entries(f.props).map(([k,v])=>[k,{...v}])),advanced:{policy:POLICY,status:'BASELINE_FALLBACK',reasons:bundle?.reasons||['NO_VALIDATED_STATS']}};
 if(!bundle?.eligible)return result;
 const s=bundle.base.stats,a=bundle.advanced.stats,w=Math.min(.25,s.gp/(s.gp+20),s.min/(s.min+600)),minutes=f.projected_minutes*paceFactor;
 const target={},weight={};
 if([leaguePrior.two,leaguePrior.three,leaguePrior.ft].every(num)){
  const p2=(s.fgm-s.fg3_m+100*leaguePrior.two)/(s.fga-s.fg3_a+100),p3=(s.fg3_m+75*leaguePrior.three)/(s.fg3_a+75),pft=(s.ftm+50*leaguePrior.ft)/(s.fta+50);
  target.points=(2*(s.fga-s.fg3_a)*p2+3*s.fg3_a*p3+s.fta*pft)/s.min*minutes;
  target.threes=s.fg3_a*p3/s.min*minutes;
  weight.points=w*clamp(a.usg_pct/.20,.5,1);weight.threes=w;
 }
 for(const [market,dataset,prior]of [['assists','tracking_passing',leaguePrior.passing],['rebounds','tracking_rebounding',leaguePrior.rebounding]]){
  const t=bundle.tracking[dataset];if(t&&num(prior)&&t.opportunities>=5){target[market]=t.opportunities/s.min*((t.converted+50*prior)/(t.opportunities+50))*minutes;weight[market]=w;}
 }
 // WNBA has no public tracking feed here. Its validated seasonal rates are a
 // limited prior; never synthesize potential assists or rebound opportunities.
 for(const [market,field]of [['assists','ast'],['rebounds','reb']])if(target[market]===undefined){target[market]=s[field]/s.min*minutes;weight[market]=w*.5;}
 const delta={};
 for(const [market,t]of Object.entries(target)){
  const old=f.props[market],bounded=clamp(t,old.mean*.7,old.mean*1.3),shift=weight[market]*(bounded-old.mean);
  result.props[market]={mean:old.mean+shift,variance:Math.max(old.variance,old.mean+shift)+weight[market]*(1-weight[market])*(bounded-old.mean)**2};delta[market]=shift;
 }
 for(const [key,parts]of Object.entries(PROPS))if(parts.length>1){const shift=parts.reduce((sum,k)=>sum+(delta[k]||0),0);result.props[key]={mean:f.props[key].mean+shift,variance:Math.max(f.props[key].variance,f.props[key].mean+shift)+shift*shift};}
 result.advanced={policy:POLICY,status:'APPLIED',games:s.gp,minutes:s.min,max_weight:w,usage:a.usg_pct,targets:target,weights:weight,
  validation_reasons:[],excluded_tracking:bundle.excluded,version_ids:[bundle.base.version_id,bundle.advanced.version_id,...Object.values(bundle.tracking).map(t=>t.row.version_id)],
  features:{fg2a:s.fga-s.fg3_a,fg2m:s.fgm-s.fg3_m,fg3a:s.fg3_a,fg3m:s.fg3_m,fta:s.fta,ftm:s.ftm,ts_pct:a.ts_pct,efg_pct:a.efg_pct,usg_pct:a.usg_pct,
   potential_assists:bundle.tracking.tracking_passing?.opportunities??null,rebound_chances:bundle.tracking.tracking_rebounding?.opportunities??null},
  source_observed_at:bundle.base.observed_at,source_published_at:bundle.base.latest_publication_at};
 return result;
}
function buildAdvanced(game,history,rosters,rows,now){
 const base=teamForecast(game,history,MODELS.baseline);if(base.status!=='OK')return {team:{...base,model_version:VERSION},players:[],validations:[]};
 const grouped=new Map();for(const r of rows){if(!r.player_id)continue;if(!grouped.has(r.player_id))grouped.set(r.player_id,[]);grouped.get(r.player_id).push(r);}
 const bundles=new Map([...grouped].map(([pid,rs])=>[pid,validatePlayer(rs,game,now)])),leaguePrior=priors([...bundles.values()]);
 const players=[],basePlayers=[];const seen=new Set();
 for(const ro of rosters)for(const p of ro.players){if(seen.has(p.player_id))continue;seen.add(p.player_id);const f=playerForecast(p.player_id,game,history,base,MODELS.baseline);if(f.status!=='OK'||f.team_id!==ro.team_id)continue;
  basePlayers.push(f);players.push(enrichPlayer(f,bundles.get(p.player_id),leaguePrior,clamp(base.pace/base.league_pace,.85,1.15)));
 }
 const needed=(game.league==='NBA'?48:40)*5,coverage={},adjustments={};
 for(const tid of [game.home_team_id,game.away_team_id]){const ps=players.filter(p=>p.team_id===tid&&p.advanced.status==='APPLIED');coverage[tid]=Math.min(1,ps.reduce((s,p)=>s+p.projected_minutes,0)/needed);
  const minuteScale=needed/Math.max(needed,players.filter(p=>p.team_id===tid).reduce((s,p)=>s+p.projected_minutes,0));
  adjustments[tid]=clamp(.5*minuteScale*ps.reduce((s,p)=>s+p.props.points.mean-basePlayers.find(b=>b.player_id===p.player_id).props.points.mean,0),-3,3);
 }
 const applied=Object.values(coverage).every(c=>c>=.65),homeDelta=applied?adjustments[game.home_team_id]:0,awayDelta=applied?adjustments[game.away_team_id]:0;
 const margin=base.margin+homeDelta-awayDelta,total=base.total+homeDelta+awayDelta,marginVariance=base.margin_variance+(homeDelta-awayDelta)**2,totalVariance=base.total_variance+(homeDelta+awayDelta)**2;
 const win=normalDistribution(margin,marginVariance,0,'over'),pHome=win.p_win/(1-win.p_push);
 const team={...base,model_version:VERSION,home_points:base.home_points+homeDelta,away_points:base.away_points+awayDelta,margin,total,margin_variance:marginVariance,total_variance:totalVariance,p_home:pHome,p_away:1-pHome,
  advanced:{policy:POLICY,status:applied?'APPLIED':'BASELINE_FALLBACK',coverage,home_delta:homeDelta,away_delta:awayDelta,league_priors:leaguePrior,
   player_inputs:players.filter(p=>p.advanced.status==='APPLIED').map(p=>({player_id:p.player_id,minutes:p.projected_minutes,version_ids:p.advanced.version_ids,points:p.props.points.mean})),reasons:applied?[]:['INSUFFICIENT_ROSTER_COVERAGE']}};
 const validations=[...bundles].filter(([,v])=>v.base||v.advanced).map(([pid,v])=>({validation_id:[POLICY,game.league,game.season,context(game),pid,v.base?.version_id||'none',v.advanced?.version_id||'none',...Object.values(v.tracking).map(t=>t.row.version_id).sort()].join(':'),
  league:game.league,player_id:pid,policy:POLICY,as_of:now.toISOString(),result:{eligible:v.eligible,reasons:v.reasons,excluded_tracking:v.excluded,version_ids:v.versionIds,season:game.season,season_type:context(game)}}));
 return {team,players,validations};
}
module.exports={POLICY,VERSION,CONFIG,gate,validatePlayer,priors,enrichPlayer,buildAdvanced};
