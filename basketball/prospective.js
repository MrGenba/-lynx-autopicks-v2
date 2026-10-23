'use strict';
const {VERSION}=require('./advanced_model');
const PROTOCOL='bk-advanced-prospective-1';
function compareAdvanced(games,forecasts,candidates,protocol,pairedCI){
 const result={protocol:PROTOCOL,model:VERSION,n:0,required:200,status:'AWAITING_REGISTERED_PROTOCOL',improvement:false};
 if(!protocol?.registered_at)return result;
 const start=Date.parse(protocol.registered_at),gm=new Map(games.filter(g=>g.status==='final'&&g.box_complete&&Date.parse(g.starts_at)>start).map(g=>[g.game_id,g])),byGame=new Map();
 for(const f of forecasts){const g=gm.get(f.game_id);if(!g||f.kind!=='team'||!['bk-pace-minutes-1',VERSION].includes(f.model_version)||![Date.parse(f.created_at),Date.parse(f.as_of),f.result.p_home,f.result.margin].every(Number.isFinite)||f.result.p_home<0||f.result.p_home>1||Date.parse(f.created_at)>=Date.parse(g.starts_at)||Date.parse(f.as_of)>=Date.parse(g.starts_at))continue;
  if(f.model_version===VERSION&&(Date.parse(f.created_at)<start||f.result.advanced?.status!=='APPLIED'))continue;
  if(!byGame.has(f.game_id))byGame.set(f.game_id,{});byGame.get(f.game_id)[f.model_version]=f;
 }
 const sorted=[...candidates].sort((a,b)=>Date.parse(a.as_of)-Date.parse(b.as_of)),quotes=new Map();
 for(const c of sorted){const g=gm.get(c.game_id),q=c.quote_snapshot;if(!g||quotes.has(c.game_id)||c.model_version!==VERSION||c.market!=='moneyline'||c.player_id||!q||q.bookmaker!=='bet365'||q.source!=='cuotasahora'||q.detail?.delayed||q.detail?.reference_only||q.period!=='full_game'||q.includes_overtime!==true||!Number.isFinite(q.odds)||!Number.isFinite(q.opposite_odds)||q.odds<=1||q.opposite_odds<=1||!Number.isFinite(Date.parse(c.as_of))||Date.parse(c.as_of)<start||Date.parse(c.as_of)>=Date.parse(g.starts_at)||!Number.isFinite(Date.parse(q.captured_at))||Date.parse(q.captured_at)>Date.parse(c.as_of)||Date.parse(q.captured_at)<Date.parse(c.as_of)-15*60000)continue;
  const total=1/q.odds+1/q.opposite_odds;if(total<1||total>1.12)continue;
  const selected=(1/q.odds)/total;quotes.set(c.game_id,q.selection==='home'?selected:1-selected);
 }
 const pairs=[...byGame.entries()].filter(([id,v])=>v[VERSION]&&v['bk-pace-minutes-1']&&quotes.has(id)).sort((a,b)=>Date.parse(gm.get(a[0]).starts_at)-Date.parse(gm.get(b[0]).starts_at)||a[0].localeCompare(b[0])).slice(0,200);
 const db=[],dm=[],margin=[];
 for(const [id,v]of pairs){const g=gm.get(id),y=g.home_score>g.away_score?1:0,a=v[VERSION].result,b=v['bk-pace-minutes-1'].result;
  db.push((a.p_home-y)**2-(b.p_home-y)**2);dm.push((a.p_home-y)**2-(quotes.get(id)-y)**2);margin.push((a.margin-(g.home_score-g.away_score))**2-(b.margin-(g.home_score-g.away_score))**2);
 }
 const avg=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null,ciBase=pairs.length===200?pairedCI(db):null,ciMarket=pairs.length===200?pairedCI(dm):null;
 return {...result,n:pairs.length,registered_at:protocol.registered_at,status:pairs.length<200?'ACCUMULATING':ciBase[1]<0&&ciMarket[1]<0?'IMPROVED_MONEYLINE_BRIER':'NO_DEMONSTRATED_IMPROVEMENT',
  improvement:!!ciBase&&ciBase[1]<0&&ciMarket[1]<0,brier_delta_baseline:avg(db),brier_delta_market:avg(dm),ci95_baseline:ciBase,ci95_market:ciMarket,margin_MSE_delta_descriptive:avg(margin),
  cohort_game_ids:pairs.map(([id])=>id),scope:'FIRST_200_PAIRED_GAMES_ALL_CANDIDATES_INCLUDING_DISCARDS',claim_scope:'Moneyline Brier only; not player props, ROI or closing-price superiority',no_reuse_for_new_hypotheses:true};
}
module.exports={PROTOCOL,compareAdvanced};
