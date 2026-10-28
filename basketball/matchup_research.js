'use strict';
const {VERSION,POLICY}=require('./matchup_model');
const {PROPS,probability}=require('./model');
const {usableQuote}=require('./market_balance');
function compare(games,forecasts,players,candidates,protocol,pairedCI){
 const out={protocol:POLICY,model:VERSION,n:0,required:200,improvement:false,status:'AWAITING_REGISTERED_PROTOCOL',scope:'PLAYER_PROP_BRIER_PER_GAME_FIRST_200_FUTURE_PAIRED_GAMES',no_automatic_promotion:true};
 if(!protocol?.registered_at)return out;
 const start=Date.parse(protocol.registered_at),gm=new Map(games.filter(g=>g.status==='final'&&g.box_complete&&Date.parse(g.starts_at)>start).map(g=>[g.game_id,g]));
 const fm=new Map(forecasts.map(f=>[f.forecast_id,f])),pm=new Map(players.map(p=>[p.game_id+':'+p.player_id,p])),seen=new Set(),groups=new Map();
 const pairKey=c=>[c.game_id,c.player_id,c.market,c.quote_snapshot?.line,c.quote_snapshot?.bookmaker,c.quote_snapshot?.source,c.quote_snapshot?.captured_at].join('|');
 const unders=new Map(candidates.filter(c=>c.model_version===VERSION&&c.selection==='under').map(c=>[pairKey(c),c]));
 for(const c of [...candidates].sort((a,b)=>Date.parse(a.as_of)-Date.parse(b.as_of)||a.candidate_id?.localeCompare(b.candidate_id||'')||0)){
  const g=gm.get(c.game_id),q=c.quote_snapshot,base=fm.get(c.matchup?.base_forecast_id),actual=pm.get(c.game_id+':'+c.player_id),key=[c.game_id,c.player_id,c.market].join(':');
  if(c.model_version!==VERSION||!g||!q||!c.player_id||c.selection!=='over'||!PROPS[c.market]||Number.isInteger(Number(q.line))||seen.has(key)||c.matchup?.status!=='APPLIED'||!base||base.game_id!==c.game_id||base.player_id!==c.player_id||
   ![c.created_at,c.as_of,base.created_at,base.as_of].every(t=>Number.isFinite(Date.parse(t)))||Date.parse(c.created_at)<start||Date.parse(c.as_of)<start||Date.parse(c.created_at)>=Date.parse(g.starts_at)||Date.parse(base.created_at)>=Date.parse(g.starts_at)||Date.parse(base.as_of)>Date.parse(c.as_of)||!usableQuote(q,g,c.as_of))continue;
  const other=unders.get(pairKey(c));if(!other||!usableQuote(other.quote_snapshot,g,other.as_of)||!Number.isFinite(Date.parse(other.created_at))||Date.parse(other.created_at)>=Date.parse(g.starts_at)||other.quote_snapshot.odds!==q.opposite_odds||other.quote_snapshot.opposite_odds!==q.odds)continue;
  if(!actual||actual.did_not_play||!(actual.minutes>0)||!PROPS[c.market].every(k=>Number.isFinite(actual.stats?.[k])))continue;
  const overround=1/q.odds+1/q.opposite_odds;if(!(overround>=1&&overround<=1.12))continue;
  const p=c.p_win,b=probability(q,base.result).p_win,m=(1/q.odds)/overround;if(![p,b,m].every(x=>Number.isFinite(x)&&x>=0&&x<=1))continue;
  const y=PROPS[c.market].reduce((s,k)=>s+actual.stats[k],0)>q.line?1:0;
  if(!groups.has(g.game_id))groups.set(g.game_id,[]);groups.get(g.game_id).push({base:(p-y)**2-(b-y)**2,market:(p-y)**2-(m-y)**2});seen.add(key);
 }
 const cohort=[...groups].sort((a,b)=>Date.parse(gm.get(a[0]).starts_at)-Date.parse(gm.get(b[0]).starts_at)||a[0].localeCompare(b[0])).slice(0,200),avg=a=>a.reduce((s,x)=>s+x,0)/a.length;
 const db=cohort.map(([,rs])=>avg(rs.map(r=>r.base))),dm=cohort.map(([,rs])=>avg(rs.map(r=>r.market))),ciBase=cohort.length===200?pairedCI(db):null,ciMarket=cohort.length===200?pairedCI(dm):null;
 return {...out,n:cohort.length,markets:cohort.reduce((s,[,r])=>s+r.length,0),registered_at:protocol.registered_at,cohort_game_ids:cohort.map(([id])=>id),
  brier_delta_current:db.length?avg(db):null,brier_delta_market:dm.length?avg(dm):null,ci95_current:ciBase,ci95_market:ciMarket,
  improvement:!!ciBase&&ciBase[1]<0&&ciMarket[1]<0,status:cohort.length<200?'ACCUMULATING':ciBase[1]<0&&ciMarket[1]<0?'IMPROVED_PROP_BRIER':'NO_DEMONSTRATED_IMPROVEMENT'};
}
module.exports={compare};

