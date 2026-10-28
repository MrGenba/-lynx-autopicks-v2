'use strict';
const divider='━━━━━━━━━━━━━━';
const availability=code=>({AVAILABLE:'disponible',CONFIRMED:'confirmado',NOT_LISTED:'no figura en el parte',PROBABLE:'probable',QUESTIONABLE:'en duda',DOUBTFUL:'dudoso',OUT:'baja',SUSPENDED:'suspendido',INACTIVE:'inactivo',CONFLICT:'información contradictoria'}[code]||'sin confirmar');
const lineup=code=>({CONFIRMED:'confirmado',EXPECTED:'previsto',UNMAPPED:'pendiente de identificar'}[code]||'pendiente');
const role=code=>({STARTER:'titular',BENCH:'suplente'}[code]||'sin confirmar');
const book=name=>({'bet365':'Bet365','betano':'Betano','winamax.fr':'Winamax.fr','ps3838':'PS3838'}[name]||name);
function time(value,withDate=false){
 const date=new Date(value);if(!Number.isFinite(date.getTime()))return 'hora pendiente';
 return date.toLocaleString('es-ES',{timeZone:'Europe/Madrid',...(withDate?{day:'2-digit',month:'2-digit'}:{}),hour:'2-digit',minute:'2-digit'});
}
const heading=(game,title)=>['🏀 '+game.league+' · '+title,game.away_team+' @ '+game.home_team,'🗓 '+time(game.starts_at,true)+' (Madrid)'];
const signedPercent=n=>(n>0?'+':'')+(100*n).toFixed(1)+'%';
module.exports={divider,availability,lineup,role,book,time,heading,signedPercent};

