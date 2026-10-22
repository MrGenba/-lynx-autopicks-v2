"use strict";
// Shared by n8n and maintenance: every row is a complete replacement for ONE
// league, season, role and competition phase. Missing values stay null.
const STATCAST_VERSION = "statcast-scoped-v1";
const STATCAST_MAP = {
  xwoba:"xwoba", xba:"xba", xslg:"xslg", woba:"woba", xobp:"xobp",
  ba:"ba", obp:"obp", slg:"slg", iso:"iso", babip:"babip",
  avg_exit_velocity:"launch_speed", launch_angle_avg:"launch_angle",
  hard_hit_pct:"hardhit_percent", barrel_pct:"barrels_per_bbe_percent",
  barrels_per_pa_pct:"barrels_per_pa_percent", barrels_total:"barrels_total",
  k_percent:"k_percent", bb_percent:"bb_percent", swing_miss_percent:"swing_miss_percent",
  pitches:"pitches", pa:"pa", bip:"bip", whiffs:"whiffs", swings:"swings", takes:"takes",
  spin_rate:"spin_rate", velocity:"velocity", effective_speed:"effective_speed",
  release_extension:"release_extension", sweet_spot_pct:"sweet_spot_pct", bbe:"bbe",
};
function statcastNumber(value) {
  if (value == null || String(value).trim() === "" || /^(null|n\/a|nan|--|-)$/i.test(String(value).trim())) return null;
  const n=Number(value); return Number.isFinite(n) ? n : null;
}
function statcastCsv(text, required=['player_id','player_name','pitches','pa','xwoba','hardhit_percent','k_percent','bb_percent']) {
  if (typeof text!=="string" || /^\s*</.test(text)) throw Error("Statcast returned HTML, not CSV");
  const rows=[];let row=[],cell="",quoted=false;
  text=text.replace(/^\uFEFF/,"");
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(c==='"') {if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
    else if(c===','&&!quoted){row.push(cell);cell="";}
    else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(x=>x.trim()))rows.push(row);row=[];cell="";}
    else cell+=c;
  }
  if(quoted)throw Error("Truncated Statcast CSV");
  if(cell||row.length){row.push(cell);rows.push(row);}
  const headers=rows.shift()?.map(x=>x.trim())||[];
  for(const key of required){
    if(!headers.includes(key))throw Error("Statcast schema missing "+key);
  }
  return {headers,rows:rows.map(r=>{
    if(r.length!==headers.length)throw Error("Statcast CSV column count changed");
    return Object.fromEntries(headers.map((h,i)=>[h,r[i].trim()]));
  })};
}
function statcastUrl(sportId,role,season,phase,through) {
  if(![1,11].includes(sportId)||!['pitcher','batter'].includes(role)||!['R','POST'].includes(phase))throw Error("Invalid Statcast scope");
  if(!Number.isInteger(season)||season<2020||!/^\d{4}-\d{2}-\d{2}$/.test(through)||!through.startsWith(String(season)))throw Error("Invalid Statcast season/cutoff");
  // Explicit AAA filter: minors=true alone also includes tracked lower levels.
  const params={all:'true',hfGT:phase==='R'?'R|':'F|D|L|W|',hfSea:season+'|',player_type:role,group_by:'name',
    min_pitches:'0',min_results:'0',min_pas:'0',sort_col:'pitches',sort_order:'desc',minors:String(sportId===11),wbc:'false',
    game_date_gt:season+'-01-01',game_date_lt:through,...(sportId===11?{hfLevel:'AAA|'}:{})};
  return 'https://baseballsavant.mlb.com/statcast-search-minors/csv?'+Object.entries(params).map(([k,v])=>k+'='+encodeURIComponent(v)).join('&');
}
function parseStatcast(text,scope) {
  const {headers,rows}=statcastCsv(text),seen=new Set(),mapped=[];
  for(const raw of rows){
    const id=statcastNumber(raw.player_id);
    if(!Number.isInteger(id)||id<=0)throw Error("Invalid Statcast player id");
    if(seen.has(id))throw Error("Duplicate player in Statcast scope");seen.add(id);
    const out={player_id:id,player_name:raw.player_name||null,team_name:null,source:'baseball_savant',raw_metrics:raw,quality_flags:[]};
    for(const [key,source]of Object.entries(STATCAST_MAP)){
      let n=statcastNumber(raw[source]);
      const pct=/(_pct|_percent)$/.test(key);
      if(n!==null&&((pct&&(n<0||n>100))||(/^(xwoba|woba|xba|ba|obp|xobp)$/.test(key)&&(n<0||n>2.5))||(/^(pitches|pa|bip|bbe|barrels_total|whiffs|swings|takes)$/.test(key)&&(n<0||!Number.isInteger(n))))){
        out.quality_flags.push('invalid_'+key);n=null;
      }
      out[key]=n;
    }
    // Do not infer a denominator for BBE or sweet-spot from another statistic.
    mapped.push(out);
  }
  return {rows:mapped,batch:{...scope,collector_version:STATCAST_VERSION,source_headers:headers,
    metric_coverage:Object.fromEntries(Object.keys(STATCAST_MAP).map(k=>[k,mapped.filter(r=>r[k]!==null).length])),
    quality_flags:[...new Set(mapped.flatMap(r=>r.quality_flags))]}};
}
async function collectStatcast({sportId,season,through,http,ingest,log}) {
  const reports=[];
  for(const role of ['pitcher','batter'])for(const phase of ['R','POST']){
    const sourceUrl=statcastUrl(sportId,role,season,phase,through);
    const response=await http({method:'GET',url:sourceUrl,headers:{'User-Agent':'Mozilla/5.0'},returnFullResponse:true,timeout:45000});
    const status=response.statusCode??response.status;
    if(!(status>=200&&status<300))throw Error('Statcast HTTP '+status);
    const parsed=parseStatcast(response.body,{sport_id:sportId,season,player_type:role,season_type:phase,
      requested_through:through,source_url:sourceUrl});
    // The RPC checks shrinkage against the last complete batch. Early-season
    // datasets can legitimately have fewer than 100 players (or no games yet).
    const receipt=await ingest(parsed.rows,parsed.batch);
    reports.push(receipt);
    log('Statcast '+sportId+' '+role+' '+phase+': '+parsed.rows.length+' rows; hard-hit '+parsed.batch.metric_coverage.hard_hit_pct);
  }
  return reports;
}
if(typeof module!=='undefined')module.exports={STATCAST_VERSION,STATCAST_MAP,statcastNumber,statcastCsv,statcastUrl,parseStatcast,collectStatcast};
