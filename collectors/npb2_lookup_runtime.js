const SUPA_URL=settings.url,SUPA_KEY=settings.key;
const items=$input.all().map(i=>i.json); if(!items.length)return[];
function parseJson(x){return Array.isArray(x)?x:(typeof x==="string"?JSON.parse(x):(x||[]));}

const TEAMS={"YG":["yg","giants","yomiuri","巨人","読売"],"TY":["ty","swallows","yakult","ヤクルト"],"HT":["ht","tigers","hanshin","阪神"],"CD":["cd","dragons","chunichi","中日"],"DB":["db","baystars","bay stars","dena","yokohama","横浜"],"HR":["hr","carp","hiroshima","広島"],"SW":["sw","lions","seibu","西武"],"TM":["tm","marines","lotte","chiba","ロッテ"],"TR":["tr","eagles","rakuten","tohoku","楽天"],"HF":["hf","fighters","nippon ham","nipponham","hokkaido","日本ハム"],"OB":["ob","buffaloes","orix","オリックス"],"FS":["fs","hawks","softbank","ソフトバンク"]};const EN={"YG":"Giants","TY":"Swallows","HT":"Tigers","CD":"Dragons","DB":"Baystars","HR":"Carp","SW":"Lions","TM":"Marines","TR":"Eagles","HF":"Fighters","OB":"Buffaloes","FS":"Hawks"};
Object.assign(TEAMS,{OIS:["ois","oisix","niigata","オイシックス","新潟"],HAY:["hay","hayate","ハヤテ"]});Object.assign(EN,{OIS:"Oisix Niigata",HAY:"Hayate"});
function matchTeam(raw){
if(!raw||!raw.trim())return null;
  const n=(raw||"").toLowerCase().replace(/[^a-z0-9\u3000-\u9fff\u30a0-\u30ff]/g," ").replace(/\s+/g," ").trim();
  const ns=n.replace(/\s/g,"");
  for(const[abbr,aliases]of Object.entries(TEAMS)){
    if(abbr.toLowerCase()===n)return abbr;
    if(aliases.some(a=>{
      const as=a.replace(/\s/g,"");
      // Aliases ?2 chars: solo exact match (evitar "ht" dentro de "fighters")
      if(as.length<=2) return n===a||ns===as;
      return n.includes(a)||a.includes(n)||ns.includes(as)||as.includes(ns);
    }))return abbr;
  }
  return null;
}
const today=new Date(Date.now()+9*3600000).toISOString().slice(0,10);const seasonNow=Number(today.slice(0,4)); // JST UTC+9
let gamesRaw,pitchersRaw,pfRaw,wxRaw,histRaw;
try {
  [gamesRaw,pitchersRaw,pfRaw,wxRaw]=await Promise.all([
    helpers.httpRequest({method:"GET",url:SUPA_URL+"/rest/v1/npb2_games?game_date=eq."+today+"&status=eq.scheduled&select=*",headers:{apikey:SUPA_KEY,Authorization:"Bearer "+SUPA_KEY,Accept:"application/json"}}),
    helpers.httpRequest({method:"GET",url:SUPA_URL+"/rest/v1/npb2_player_stats?season=eq."+seasonNow+"&stats_type=eq.pitching&source=eq.farm-stats.com&order=pa_or_ip.desc.nullslast&limit=1000&select=*",headers:{apikey:SUPA_KEY,Authorization:"Bearer "+SUPA_KEY,Accept:"application/json"}}),
    helpers.httpRequest({method:"GET",url:SUPA_URL+"/rest/v1/npb2_park_factors?select=*",headers:{apikey:SUPA_KEY,Authorization:"Bearer "+SUPA_KEY,Accept:"application/json"}}),
    helpers.httpRequest({method:"GET",url:SUPA_URL+"/rest/v1/npb2_game_weather?game_date=eq."+today+"&select=*",headers:{apikey:SUPA_KEY,Authorization:"Bearer "+SUPA_KEY,Accept:"application/json"}}),
  ]);
  const health=parseJson(await helpers.httpRequest({url:SUPA_URL+'/rest/v1/bb_capture_health?league=eq.NPB2&select=*',headers:{apikey:SUPA_KEY,Authorization:'Bearer '+SUPA_KEY}}));
  const time=Date.now();if(!['calendar','stats'].every(component=>{const h=health.find(h=>h.component===component),checked=Date.parse(h?.checked_at),success=Date.parse(h?.last_success_at);return h?.status==='healthy'&&checked<=time&&success<=time&&time-checked<48*3600000&&time-success<48*3600000;}))throw Error('captura incompleta o desactualizada');
  histRaw=[];for(let offset=0;;offset+=1000){const rows=parseJson(await helpers.httpRequest({url:SUPA_URL+'/rest/v1/npb2_games?season=eq.'+seasonNow+'&status=eq.final&game_date=lt.'+today+'&select=game_pk,away_team,home_team,away_score,home_score,source_game_id&order=game_pk.asc&limit=1000&offset='+offset,headers:{apikey:SUPA_KEY,Authorization:'Bearer '+SUPA_KEY}}));histRaw.push(...rows.filter(g=>!String(g.source_game_id||'').startsWith('npbfnp')));if(rows.length<1000)break;}

} catch(e) {
  return items.map(inp=>({json:{error:"Buscar NPB2: fallo HTTP - "+e.message,chatId:inp.chatId}}));
}
const games=parseJson(gamesRaw);const pitchers=parseJson(pitchersRaw).filter(p=>Date.now()-Date.parse(p.source_observed_at)>=0&&Date.now()-Date.parse(p.source_observed_at)<48*3600000);const pfs=parseJson(pfRaw);const wxRows=parseJson(wxRaw);
const wxByGame={};for(const w of wxRows){if(w?.game_pk)wxByGame[w.game_pk]=w;}
const hist=parseJson(histRaw);const teamRuns={};
for(const g of hist){if(g.away_score==null||g.home_score==null)continue;for(const[team,score]of[[g.away_team,g.away_score],[g.home_team,g.home_score]]){if(!team)continue;if(!teamRuns[team])teamRuns[team]={sum:0,n:0};teamRuns[team].sum+=Number(score);teamRuns[team].n++;}}
function avgRuns(abbr){const d=teamRuns[abbr];if(!d||d.n<3)return null;return Math.round(d.sum/d.n*100)/100;}
const normalizePitcher=x=>String(x||'').replace(/[\s　]+/g,'').toLowerCase();
const bullpenByTeam={};for(const p of pitchers){if(p.is_reliever!==true||!(p.pa_or_ip>0)||p.er_raw==null)continue;const b=bullpenByTeam[p.team_abbr]||={ip:0,er:0};b.ip+=Number(p.pa_or_ip);b.er+=Number(p.er_raw);}
function findPitcher(name,abbr){const n=normalizePitcher(name);if(!n)return null;const team=pitchers.filter(p=>p.team_abbr===abbr);const exact=team.filter(p=>normalizePitcher(p.player_name)===n);if(exact.length===1)return exact[0];const abbreviated=team.filter(p=>normalizePitcher(p.player_name).startsWith(n));return abbreviated.length===1?abbreviated[0]:null;}
function bullpenEra(abbr){const b=bullpenByTeam[abbr];return b?.ip?9*b.er/b.ip:null;}
const pfByTeam={};for(const pf of pfs){if(pf.team_abbr)pfByTeam[pf.team_abbr]=pf;if(pf.venue_name)pfByTeam["v_"+pf.venue_name]=pf;}
function getPF(venue,homeTeam){return pfByTeam["v_"+venue]||pfByTeam[homeTeam]||null;}
const out=[];const usedPk=new Set();
for(const inp of items){
  if(inp.error||inp.__skip){out.push({json:inp});continue;}
  if(!Array.isArray(games)||!games.length){out.push({json:{error:"Sin juegos NPB2 hoy",chatId:inp.chatId}});continue;}
  const awayAbbr=matchTeam(inp.awayRaw||"");const homeAbbr=matchTeam(inp.homeRaw||"");
  const matches=games.filter(g=>!usedPk.has(g.game_pk)&&((g.away_team===awayAbbr&&g.home_team===homeAbbr)||(g.home_team===awayAbbr&&g.away_team===homeAbbr)));
  if(matches.length>1){out.push({json:{error:'NPB2: doble jornada sin identificar el partido exacto.',chatId:inp.chatId}});continue;}
  let best=null,swapped=false;
  for(const g of games){if(usedPk.has(g.game_pk))continue;if(g.away_team===awayAbbr&&g.home_team===homeAbbr){best=g;swapped=false;break;}if(g.away_team===homeAbbr&&g.home_team===awayAbbr){best=g;swapped=true;break;}}
  if(!best){for(const g of games){if(usedPk.has(g.game_pk))continue;const aOk=g.away_team===awayAbbr||g.home_team===awayAbbr;const hOk=g.away_team===homeAbbr||g.home_team===homeAbbr;if(aOk&&hOk){swapped=(g.home_team===awayAbbr);best=g;break;}}}
  if(!best){out.push({json:{error:"Partido NPB2 no encontrado: "+inp.awayRaw+" @ "+inp.homeRaw,chatId:inp.chatId}});continue;}
  usedPk.add(best.game_pk);
  const realAway=best.away_team;const realHome=best.home_team;
  const annAway=best.away_starter;const annHome=best.home_starter;
  const awayP=findPitcher(annAway,realAway);const homeP=findPitcher(annHome,realHome);
  if(!awayP||!homeP){out.push({json:{error:"NPB2: faltan abridores confirmados y estadísticas identificadas.",game_pk:best.game_pk,chatId:inp.chatId}});continue;}
  const gameStart=Date.parse(best.game_date+'T'+best.game_time_local+':00+09:00');if(!Number.isFinite(gameStart)||gameStart<=Date.now()){out.push({json:{error:"NPB2: no hay una hora futura confirmada.",chatId:inp.chatId}});continue;}
  const pf=getPF(best.venue_name,realHome);const wx=wxByGame[best.game_pk]||{};
  const normInp=swapped?{...inp,input_order_swapped:true,awayRaw:inp.homeRaw,homeRaw:inp.awayRaw,away_ml:inp.home_ml??null,home_ml:inp.away_ml??null,away_hc:inp.home_hc??null,home_hc:inp.away_hc??null,away_hc_line:inp.home_hc_line??(inp.hc_value!=null?-Math.abs(inp.hc_value):null),home_hc_line:inp.away_hc_line??(inp.hc_value!=null?Math.abs(inp.hc_value):null)}:{...inp,input_order_swapped:false};
  out.push({json:{...normInp,game_pk:best.game_pk,game_date:best.game_date,season:best.season,scheduled_innings:9,game_time_local:best.game_time_local||null,
    away_team_name:realAway+" "+(EN[realAway]||""),home_team_name:realHome+" "+(EN[realHome]||""),
    away_pitcher_name:awayP?.player_name||annAway||"TBD",home_pitcher_name:homeP?.player_name||annHome||"TBD",
    venue_name:best.venue_name||"N/A",park_factor:pf?.park_factor??null,altitude_m:pf?.altitude_m??null,
    away_team_avg_runs:avgRuns(realAway),away_team_games:teamRuns[realAway]?.n??0,
    home_team_avg_runs:avgRuns(realHome),home_team_games:teamRuns[realHome]?.n??0,
    away_p_era:awayP?.era??null,away_p_fip:awayP?.fip??null,away_p_siera:awayP?.siera??null,
    away_p_babip:awayP?.babip??null,away_p_k_9:awayP?.k_9??null,away_p_bb_9:awayP?.bb_9??null,away_p_ip_season:awayP?.pa_or_ip??null,
    home_p_era:homeP?.era??null,home_p_fip:homeP?.fip??null,home_p_siera:homeP?.siera??null,
    home_p_babip:homeP?.babip??null,home_p_k_9:homeP?.k_9??null,home_p_bb_9:homeP?.bb_9??null,home_p_ip_season:homeP?.pa_or_ip??null,
    away_bullpen_era:bullpenEra(realAway),home_bullpen_era:bullpenEra(realHome),
    temperature_2m:wx.temperature_2m??null,wind_speed_10m:wx.wind_speed_10m??null,wind_direction:wx.wind_direction??null,wind_tailwind:null,stats_source:'farm-stats.com',statcast_available:false,
  }});
}
return out;