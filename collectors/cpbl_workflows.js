'use strict';
// Builds n8n Code-node bodies. Caller supplies private settings; never commit generated output.
const fs=require('node:fs'),path=require('node:path');
function bundle(files){return `const factories={${files.map(([key,file])=>JSON.stringify(key)+':function(module,exports,require){\n'+fs.readFileSync(path.join(__dirname,'..',file),'utf8')+'\n}').join(',')}};const loaded={};function localRequire(k){if(!loaded[k]){const m={exports:{}};loaded[k]=m;factories[k](m,m.exports,localRequire);}return loaded[k].exports;}\n`;}
function transport(settings){return `const settings=${JSON.stringify(settings)};
async function rest(p,method='GET',body,opts={}){return helpers.httpRequest({url:(settings.url.endsWith('/')?settings.url.slice(0,-1):settings.url)+'/rest/v1/'+p,method,headers:{apikey:settings.key,Authorization:'Bearer '+settings.key,'Content-Type':'application/json',...(opts.prefer?{Prefer:opts.prefer}:{})},json:true,timeout:30000,...(body===undefined?{}:{body})});}
async function http(url,opts){const r=await helpers.httpRequest({url,method:opts.method,headers:opts.headers,...(opts.body===undefined?{}:{body:opts.body}),json:false,returnFullResponse:true,ignoreHttpStatusErrors:true,timeout:opts.timeout});return {status:r.statusCode,body:r.body};}
async function alert(message){return helpers.httpRequest({url:'https://api.telegram.org/bot'+settings.bot+'/sendMessage',method:'POST',json:true,body:{chat_id:settings.chat,text:message},timeout:15000});}
`;}
function collector(mode,settings){return bundle([['./cpbl','collectors/cpbl.js'],['./cpbl_runner','collectors/cpbl_runner.js']])+transport(settings)+`
const state=$getWorkflowStaticData('global');let result;
try{result=await localRequire('./cpbl_runner').runCpbl({http,rest,mode:${JSON.stringify(mode)},fullSeason:${mode==='postgame'?'new Date().getUTCDay()===0':'false'}});}
catch(_){try{await rest('cpbl_capture_state?on_conflict=scope','POST',{scope:${JSON.stringify(mode)},checked_at:new Date().toISOString(),status:'ATTENTION',report:{code:'CAPTURE_FAILED'}},{prefer:'resolution=merge-duplicates,return=minimal'});await rest('bb_capture_health?on_conflict=league,component','POST',{league:'CPBL',component:${JSON.stringify(mode==='postgame'?'stats':'calendar')},checked_at:new Date().toISOString(),status:'error',detail:{code:'CAPTURE_FAILED'}},{prefer:'resolution=merge-duplicates,return=minimal'});}catch(_){}await alert('⚠️ CPBL: fallo en la captura '+${JSON.stringify(mode)}+'. Revisar el workflow; no se confirma una actualización completa.');throw Error('CPBL_CAPTURE_FAILED');}
const issues=[...result.errors,...(result.warnings||[])],fingerprint=JSON.stringify(issues);
if(issues.length&&state.alert_fingerprint!==fingerprint){await alert('⚠️ CPBL '+result.mode+': '+issues.length+' incidencias. '+issues.slice(0,3).map(e=>e.code+(e.game_id?' '+e.game_id:'')+(e.games?' ('+e.games+' partidos)':'')).join('; '));}
state.alert_fingerprint=fingerprint;
return [{json:result}];`;}
function lookup(settings){return bundle([['./cpbl_lookup','vendor/cpbl_lookup.js']])+transport(settings)+`
const now=new Date(),today=new Date(now.getTime()+8*3600000).toISOString().slice(0,10),year=Number(today.slice(0,4));
async function all(p){const rows=[];for(let offset=0;;offset+=1000){const batch=await rest(p+'&limit=1000&offset='+offset);if(!Array.isArray(batch))throw Error('CPBL_LOOKUP_FAILED');rows.push(...batch);if(batch.length<1000)return rows;}}
const [games,pitchers,batters,logs,history,parks,weather,health,capture]=await Promise.all([
all('cpbl_source_games?game_date=eq.'+today+'&select=*&order=game_id.asc'),
all('cpbl_pitcher_season_current?season=eq.'+year+'&select=*&order=team_abbr.asc,player_name.asc'),
all('cpbl_batter_season_current?season=eq.'+year+'&select=*&order=team_abbr.asc,player_name.asc'),
all('cpbl_pitcher_gamelogs?season=eq.'+year+'&game_id=not.is.null&select=game_id,game_date,season,game_kind,team_abbr,player_id,player_name,is_starter,outs,er,pitches&order=game_id.asc,team_abbr.asc,appearance_no.asc'),
all('cpbl_source_games?season=eq.'+year+'&status=eq.final&select=game_date,game_kind,status,away_team,home_team,away_score,home_score&order=game_id.asc'),
rest('cpbl_park_factors?select=*'),Promise.resolve([]),rest('cpbl_capture_health?season=eq.'+year),rest('cpbl_capture_state?scope=eq.postgame')]);
return localRequire('./cpbl_lookup').enrichCpbl({inputs:$input.all().map(i=>i.json),games,pitchers,batters,logs,history,parks,weather,health:health[0],capture:capture[0],now}).map(json=>({json}));`;
}

module.exports={lookup,collector};
