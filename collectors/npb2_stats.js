'use strict';
const TEAMS={1:'TR',2:'OIS',3:'TY',4:'TM',5:'HF',6:'SW',7:'YG',8:'DB',9:'HAY',10:'CD',11:'OB',12:'HT',13:'HR',14:'FS'};
function payload(html,type,season){
 const title=html.match(/<h1[^>]*>([^<]*)<\/h1>/)?.[1];if(!title?.includes(String(season)+'年')||!title.includes(type==='pitching'?'投手':'打撃'))throw Error('Wrong statistics season/type');
 // Decode the public Next.js serialization as JSON data. Never execute scripts.
 const chunks=[...html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)].map(m=>JSON.parse(m[1])).join('');
 const found=[];function walk(x){if(!x||typeof x!=='object')return;if(!Array.isArray(x)&&Array.isArray(x.data)&&'isDummy'in x)found.push(x);Object.values(x).forEach(walk);}
 for(const line of chunks.split('\n')){const raw=line.slice(line.indexOf(':')+1);let value;try{value=JSON.parse(raw);}catch{continue;}walk(value);}
 if(found.length!==1||found[0].isDummy!==false)throw Error('Missing/ambiguous/placeholder data');const rows=found[0].data;
 if(rows.length<100||rows.length>2000||new Set(rows.map(p=>p.teamId)).size!==14)throw Error('Incomplete team/player coverage');return rows;
}
function parse(html,type,season,observedAt){const raw=payload(html,type,season),seen=new Set(),excluded=[];const rows=raw.map(p=>{
 const team=TEAMS[p.teamId],name=String(p.playerName||'').replace(/[\s　]+/g,'');if(!team||!name||!Number.isInteger(p.playerId))throw Error('Unknown player/team');const key=name+'|'+team;if(seen.has(key))throw Error('Duplicate player');seen.add(key);
 const base={player_name:name,team_abbr:team,season,stats_type:type,games:p.games,source:'farm-stats.com',source_url:'https://www.farm-stats.com/stats/'+(type==='pitching'?'pitcher':'hitter'),source_player_id:String(p.playerId),source_observed_at:observedAt,source_as_of:null,raw_metrics:p,updated_at:observedAt};
 const fields=type==='pitching'?['games','gs','hitsAllowed','hrAllowed','bb','hbp','so','er']:['games','pa','ab','hits','hr','bb','so'];if(!fields.every(k=>Number.isInteger(p[k])&&p[k]>=0))throw Error('Invalid counting statistic');
 if(type==='pitching'){
  if(!(p.ip>0)||Math.abs(p.ip*3-Math.round(p.ip*3))>1e-6||!Number.isFinite(p.era)||Math.abs(p.er*9/p.ip-p.era)>.011)throw Error('Invalid innings/ERA identity');
  return {...base,starts:p.gs,pa_or_ip:p.ip,era:p.era,fip:null,siera:null,whip:(p.hitsAllowed+p.bb)/p.ip,k_pct:null,bb_pct:null,hr9:p.hrAllowed*9/p.ip,babip:null,k_9:p.so*9/p.ip,bb_9:p.bb*9/p.ip,h_raw:p.hitsAllowed,hr_raw:p.hrAllowed,bb_raw:p.bb,k_raw:p.so,er_raw:p.er,is_reliever:p.gs===0,_hbp:p.hbp};
 }
 if(!['avg','obp','slg','ops'].every(k=>Number.isFinite(p[k])&&p[k]>=0)||p.avg>1||p.obp>1||p.hits>p.ab||p.ab>p.pa||Math.abs(p.obp+p.slg-p.ops)>.003){excluded.push({player_id:p.playerId,team_abbr:team,reason:'INCONSISTENT_BATTING_COUNTS_OR_RATES'});return null;}
 return {...base,pa_or_ip:p.pa,avg:p.avg,obp:p.obp,slg:p.slg,ops:p.ops,woba:null,hr:p.hr,h_raw:p.hits,hr_raw:p.hr,bb_raw:p.bb,k_raw:p.so};
 }).filter(Boolean);
 if(excluded.length>raw.length*.01)throw Error('Too many inconsistent statistics rows');
 if(type==='pitching'){const totals=rows.reduce((a,p)=>({ip:a.ip+p.pa_or_ip,er:a.er+p.er_raw,hr:a.hr+p.hr_raw,bb:a.bb+p.bb_raw+p._hbp,k:a.k+p.k_raw}),{ip:0,er:0,hr:0,bb:0,k:0});const C=(totals.er*9-13*totals.hr-3*totals.bb+2*totals.k)/totals.ip;for(const p of rows){p.fip=Math.round((((13*p.hr_raw+3*(p.bb_raw+p._hbp)-2*p.k_raw)/p.pa_or_ip)+C)*1000)/1000;delete p._hbp;}}
 rows.excluded=excluded;return rows;
}
module.exports={parse,payload,TEAMS};
