'use strict';
const day=t=>new Date(t).toLocaleDateString('en-CA',{timeZone:'America/New_York'});
const unique=a=>[...new Set(a)],escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function roleNews(p,g,now){
 const name=p.name||'',surname=name.replace(/\s+(?:Jr\.?|Sr\.?|II|III|IV)$/i,'').split(' ').at(-1);
 if(!name||!surname)return [];
 const subject=new RegExp('(?:^|\\b)(?:'+escape(name)+'|'+escape(surname)+')\\s*(?:\\([^)]*\\)\\s*)?(?:(?:is\\s+)?expected to|will|is set to|is likely to|should|is)\\s+([^.!?]+)','ig');
 const found=[];
 for(const n of p.news||[]){
  if(!/^https:\/\/www\.rotowire\.com\/(basketball|wnba)\//.test(n.source_url||'')||!/^\d{4}-\d{2}-\d{2}$/.test(n.date||'')||n.date>day(now)||n.date>day(g.starts_at)||Date.parse(day(g.starts_at))-Date.parse(n.date)>2*86400000||n.rotation?.target_date!==day(g.starts_at))continue;
  const text=String(n.summary||'').replace(/’/g,"'");subject.lastIndex=0;
  for(const match of text.matchAll(subject)){
   const clause=match[1].split(/\b(?:while|whereas|but|with)\b/i)[0];
   if(/\b(?:not|never|unlikely|won't|might|could|may)\b/i.test(clause))continue;
   let role=null;
   if(/^(?:come|play|operate)\s+off (?:the )?bench\b|^(?:return|move) to (?:the )?bench\b|^remain (?:on|off) (?:the )?bench\b/i.test(clause))role='BENCH';
   else if(/^start(?:ing)?(?:\s|$)|^(?:remain|move|return|be) in (?:the )?(?:starting lineup|starting five)\b/i.test(clause))role='STARTER';
   if(role)found.push({role,source_url:n.source_url,published_date:n.date,target_date:n.rotation.target_date,headline:n.headline,date_precision:n.date_precision||'day'});
  }
 }
 if(!found.length)return [];
 const latest=found.map(n=>n.published_date).sort().at(-1);
 return found.filter(n=>n.published_date===latest);
}

function resolve(g,p,team,now){
 const reasons=[],news=roleNews(p||{},g,now),roles=unique(news.map(n=>n.role));
 const valid=team&&['EXPECTED','CONFIRMED'].includes(team.lineup)&&team.starters?.length===5&&new Set(team.starters).size===5;
 const lineup=valid?(team.starters.includes(p?.player_id)?'STARTER':'BENCH'):'UNKNOWN';
 if(roles.length>1)reasons.push('ROLE_NEWS_CONFLICT');
 if(roles.length===1&&lineup!=='UNKNOWN'&&roles[0]!==lineup)reasons.push('ROLE_NEWS_LINEUP_CONFLICT');
 const role=roles.length===1?roles[0]:lineup;
 if(role==='UNKNOWN')reasons.push('EXPECTED_ROLE_UNKNOWN');
 return {role,source:roles.length===1?'CURRENT_GAME_NEWS':valid?'PROJECTED_LINEUP':null,news,reasons};
}
module.exports={resolve,roleNews};
