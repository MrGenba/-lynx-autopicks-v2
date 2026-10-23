'use strict';
const {TEAM:KBO_TEAMS,text}=require('./kbo');
const {TEAMS:NPB_TEAMS}=require('./npb');
const {canonical,game:cpblGame}=require('./cpbl');
const VERSION='asian-lineups-1';
const POS={1:'P',2:'C',3:'1B',4:'2B',5:'3B',6:'SS',7:'LF',8:'CF',9:'RF',10:'DH'};
const KPOS={'투수':'P','포수':'C','1루수':'1B','2루수':'2B','3루수':'3B','유격수':'SS','좌익수':'LF','중견수':'CF','우익수':'RF','지명타자':'DH'};
function validNine(players){
 if(!players.length)return null;
 const sorted=[...players].sort((a,b)=>a.order-b.order);
 if(sorted.length!==9||sorted.some((p,i)=>p.order!==i+1||!p.name||p.name.length>100||!Object.values(POS).includes(p.position))||
  new Set(sorted.map(p=>p.id||p.name)).size!==9||new Set(sorted.map(p=>p.position)).size!==9)throw Error('INVALID_CONFIRMED_NINE');
 return sorted;
}
function inWindow(g,now){const start=Date.parse(g.game_start||g.game_time);return ['scheduled','live'].includes(g.status)&&Number.isFinite(start)&&start>=now.getTime()-30*60000&&start<=now.getTime()+5*3600000;}
function sameGame(expected,actual){if(!actual||String(actual.game_id)!==String(expected.game_id)||actual.game_date!==expected.game_date||actual.home_team!==expected.home_team||actual.away_team!==expected.away_team)throw Error('LINEUP_GAME_MISMATCH');}
function event(league,g,side,players,source,now,pitcher){
 const nine=validNine(players);if(!nine)return null;
 return {league,game_id:String(g.game_id),game_pk:g.game_pk,game_date:g.game_date,side,team:g[side+'_team'],away_team:g.away_team,home_team:g.home_team,
  starts_at:g.game_start||g.game_time,players:nine,pitcher:pitcher||null,source,observed_at:now.toISOString(),version:VERSION};
}
function kboLineups(g,raw,now=new Date()){
 if(!Array.isArray(raw)||!Array.isArray(raw[0])||typeof raw[0][0]?.LINEUP_CK!=='boolean')throw Error('INVALID_KBO_LINEUP_RESPONSE');
 // KBO explicitly serves the PREVIOUS game's nine until this flag becomes true.
 if(raw[0][0].LINEUP_CK!==true)return [];
 const events=[];
 for(const [side,meta,table]of [['away',2,4],['home',1,3]]){
  const m=raw[meta]?.[0];if(!m||m.G_ID!==g.game_id||KBO_TEAMS[m.T_ID]!==g[side+'_team']||Number(m.SEASON_ID)!==g.season||Number(m.SR_ID)!==g.series_id)throw Error('KBO_LINEUP_IDENTITY');
  const rows=JSON.parse(raw[table]?.[0]).rows;if(!Array.isArray(rows))throw Error('KBO_LINEUP_TABLE');
  const players=rows.map(r=>{const c=r.row.map(x=>text(x.Text));return {order:Number(c[0]),name:c[2],id:null,position:KPOS[c[1]]};});
  const e=event('KBO',g,side,players,'https://www.koreabaseball.com/Schedule/GameCenter/Main.aspx?gameDate='+g.game_date.replace(/-/g,'')+'&gameId='+g.game_id,now,g[side+'_starter']);if(e)events.push(e);
 }return events;
}
function npbLineups(g,raw,now=new Date()){
 if(!Array.isArray(raw))throw Error('INVALID_NPB_LINEUP_RESPONSE');
 if(raw.some(p=>String(p.gameId)!==g.game_id||![g.home_team,g.away_team].includes(NPB_TEAMS[p.teamId])))throw Error('NPB_LINEUP_IDENTITY');
 const events=[];
 for(const side of ['away','home']){
  const team=raw.filter(p=>NPB_TEAMS[p.teamId]===g[side+'_team']);
  // startBatNo=11/startPosition=11 is the bench, not a confirmed batting slot.
  const players=team.filter(p=>Number(p.startBatNo)>=1&&Number(p.startBatNo)<=9).map(p=>({order:Number(p.startBatNo),id:String(p.playerId||''),name:text(p.playerName),position:POS[p.startPosition]}));
  if(players.length&&players.length<9)continue; // publication can arrive in two parts
  if(players.some(p=>!/^\d+$/.test(p.id)))throw Error('NPB_LINEUP_PLAYER_ID');
  const pitchers=team.filter(p=>Number(p.startPosition)===1&&Number(p.startBatNo)<=10);
  const e=event('NPB',g,side,players,'https://spaia.jp/baseball/npb/game/'+g.game_id,now,pitchers.length===1?text(pitchers[0].playerName):null);if(e)events.push(e);
 }return events;
}
function cpblLineups(expected,payload,now=new Date()){
 const r=canonical(payload?.Data?.Game||payload?.data?.game||payload),g=cpblGame(r);sameGame(expected,g);
 if(!inWindow(g,now))return {game:g,events:[]};
 const events=[];
 for(const [side,key]of [['away','visiting'],['home','home']]){
  // Initial defenders have a bare position; substitutions use (PR), (C), etc.
  const players=(r[key].hitters||[]).filter(p=>/^(P|C|1B|2B|3B|SS|LF|CF|RF|DH)$/.test(p.defendStation||'')).map(p=>({order:p.lineup,id:p.hitterAcnt,name:text(p.hitterName),position:p.defendStation}));
  if(players.length&&players.length<9)continue;
  if(players.some(p=>!/^\d+$/.test(p.id)))throw Error('CPBL_LINEUP_PLAYER_ID');
  const e=event('CPBL',g,side,players,'https://stats.cpbl.com.tw/api/proxy/v1/games/'+g.game_id,now,g[side+'_starter']);if(e)events.push(e);
 }return {game:g,events};
}
function message(e){
 const when=new Date(e.starts_at).toLocaleString('es-ES',{timeZone:'Europe/Madrid',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
 return '📋 LINEUP CONFIRMADO — '+e.league+'\n'+e.away_team+' @ '+e.home_team+'\n🕒 '+when+' (Madrid)\n\n'+e.team+' · '+(e.side==='home'?'Local':'Visitante')+'\n'+
  e.players.map(p=>p.order+'. '+p.name+' ('+p.position+')').join('\n')+(e.pitcher?'\n⚾ Abridor: '+e.pitcher:'')+'\n\nFuente: '+e.source;
}
module.exports={VERSION,validNine,inWindow,sameGame,kboLineups,npbLineups,cpblLineups,message};
