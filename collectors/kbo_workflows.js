'use strict';
// Builds n8n Code-node bodies. Caller supplies private settings; never commit generated output.
const fs=require('node:fs'),path=require('node:path');
function bundle(files){return `const factories={${files.map(([key,file])=>JSON.stringify(key)+':function(module,exports,require){\n'+fs.readFileSync(path.join(__dirname,'..',file),'utf8')+'\n}').join(',')}};const loaded={};function localRequire(k){if(!loaded[k]){const m={exports:{}};loaded[k]=m;factories[k](m,m.exports,localRequire);}return loaded[k].exports;}\n`;}
function transport(settings){return `const settings=${JSON.stringify(settings)};
async function rest(p,method='GET',body,opts={}){return helpers.httpRequest({url:(settings.url.endsWith('/')?settings.url.slice(0,-1):settings.url)+'/rest/v1/'+p,method,headers:{apikey:settings.key,Authorization:'Bearer '+settings.key,'Content-Type':'application/json',...(opts.prefer?{Prefer:opts.prefer}:{})},json:true,timeout:30000,...(body===undefined?{}:{body})});}
async function http(url,opts){const r=await helpers.httpRequest({url,method:opts.method,headers:opts.headers,...(opts.body===undefined?{}:{body:opts.body}),json:false,returnFullResponse:true,timeout:opts.timeout});return {status:r.statusCode,body:r.body};}
async function alert(message){return helpers.httpRequest({url:'https://api.telegram.org/bot'+settings.bot+'/sendMessage',method:'POST',json:true,body:{chat_id:settings.chat,text:message},timeout:15000});}
`;}
function collector(mode,settings){return bundle([['./kbo','collectors/kbo.js'],['./kbo_runner','collectors/kbo_runner.js']])+transport(settings)+`
const state=$getWorkflowStaticData('global');let result;
try{result=await localRequire('./kbo_runner').runKbo({http,rest,mode:${JSON.stringify(mode)},fullSeason:${mode==='postgame'?'new Date().getUTCDay()===0':'false'}});}
catch(_){await alert('⚠️ KBO: fallo en la captura '+${JSON.stringify(mode)}+'. Revisar el workflow; no se confirma una actualización completa.');throw Error('KBO_CAPTURE_FAILED');}
if(result.errors.length){const day=new Date().toISOString().slice(0,10);if(state.alert_day!==day){await alert('⚠️ KBO '+result.mode+': '+result.errors.length+' incidencias. '+result.errors.slice(0,3).map(e=>e.code+(e.game_id?' '+e.game_id:'')).join('; '));state.alert_day=day;}}
return [{json:result}];`;}
function lookup(settings){return bundle([['./kbo_lookup','vendor/kbo_lookup.js']])+transport(settings)+`
const now=new Date(),today=new Date(now.getTime()+9*3600000).toISOString().slice(0,10),year=Number(today.slice(0,4));
async function all(p){const rows=[];for(let offset=0;;offset+=1000){const batch=await rest(p+'&limit=1000&offset='+offset);if(!Array.isArray(batch))throw Error('KBO_LOOKUP_FAILED');rows.push(...batch);if(batch.length<1000)return rows;}}
const [games,pitchers,batters,logs,history,parks,weather,health,capture]=await Promise.all([
all('kbo_official_games?game_date=eq.'+today+'&select=*&order=game_id.asc'),
all('kbo_pitcher_season_current?season=eq.'+year+'&select=*&order=team_abbr.asc,player_name.asc'),
all('kbo_batter_season_current?season=eq.'+year+'&select=*&order=team_abbr.asc,player_name.asc'),
all('kbo_pitcher_gamelogs?season=eq.'+year+'&game_id=not.is.null&select=game_id,game_date,season,series_id,team_abbr,player_name,is_starter,outs,er,pitches&order=game_id.asc,id.asc'),
all('kbo_official_games?season=eq.'+year+'&status=eq.final&select=game_date,series_id,status,away_team,home_team,away_score,home_score&order=game_id.asc'),
rest('vw_kbo_park_factors?select=*'),rest('kbo_game_weather?game_date=eq.'+today+'&select=*'),rest('kbo_capture_health?season=eq.'+year),rest('kbo_capture_state?scope=eq.postgame')]);
return localRequire('./kbo_lookup').enrichKbo({inputs:$input.all().map(i=>i.json),games,pitchers,batters,logs,history,parks,weather,health:health[0],capture:capture[0],now}).map(json=>({json}));`;
}

module.exports={lookup,collector};
