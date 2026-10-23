'use strict';
// Server-only public-page reader. Exact bet365 rows; no regional substitutes.
const {chromium}=require('patchright');
const {parseBookmakerRows,pickBookmaker,parseAggregateLines,pickMainLine,marketHashFragment}=require('../vendor/parser_cuotasahora');
const norm=s=>String(s||'').replace(/ F$/,'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
const lines=async p=>(await p.innerText('body')).split('\n').map(x=>x.trim()).filter(Boolean);
function eventIdentity(texts,league){const events=[];for(const t of texts){try{const d=JSON.parse(t);for(const e of [d,...(d['@graph']||[])])if([e['@type']].flat().includes('SportsEvent')&&e.organizer?.name===league)events.push(e);}catch(_){}}
 if(events.length!==1)throw Error('EVENT_IDENTITY_UNVERIFIED');const e=events[0];
 if(!e.homeTeam?.name||!e.awayTeam?.name||!/(?:Z|[+-]\d\d:\d\d)$/.test(e.startDate)||!Number.isFinite(Date.parse(e.startDate)))throw Error('EVENT_IDENTITY_UNVERIFIED');
 if((e.eventStatus?.['@id']||e.eventStatus)!=='https://schema.org/EventScheduled')throw Error('EVENT_NOT_SCHEDULED');
 return {home_team:e.homeTeam.name,away_team:e.awayTeam.name,start_time_utc:new Date(e.startDate).toISOString()};
}
async function overtime(p){const e=p.getByText('Final del partido incluyendo prórroga',{exact:true});if(await e.count()!==1)return false;return e.evaluate(el=>el.tagName==='BUTTON'&&Number(getComputedStyle(el).fontWeight)>=600);}
async function table(p){const ls=await lines(p),start=ls.indexOf('Bookmakers');if(start<0)return null;return pickBookmaker(parseBookmakerRows(ls,start,ls.length),'bet365');}
async function drill(p,market){
 const labels=market==='total'?['Over/Under','Más/Menos de']:['Asian Handicap','Hándicap asiático'];let label;
 for(const s of labels)if(await p.getByText(s,{exact:true}).first().isVisible().catch(()=>false)){label=s;break;}
 if(!label)throw Error('MARKET_NOT_OFFERED');await p.getByText(label,{exact:true}).first().click({timeout:5000});
 const hash=marketHashFragment(new URL(p.url()).hash,market==='total'?'OU':'HC');if(!hash)throw Error('MARKET_SCOPE_UNVERIFIED');
 await p.evaluate(h=>{location.hash=h;},hash);
 await p.waitForFunction(m=>m==='total'?/Over\s+Under\s+Payout/.test(document.body.innerText):/Handicap\s+1\s+2\s+Payout/.test(document.body.innerText),market,{timeout:15000});
 let ls=await lines(p);const allowed=n=>Number.isFinite(n)&&Number.isInteger(n*2)&&(market==='total'?n>=80&&n<=320:Math.abs(n)<=40);
 const aggregate=parseAggregateLines(ls,label,0,ls.length).filter(r=>allowed(r.line));let expected=null;
 if(aggregate.length){const main=pickMainLine(aggregate);expected=main.line;await p.getByText(label+' '+(expected>0?'+':'')+expected,{exact:true}).first().click({timeout:5000});await p.getByText('Bookmakers',{exact:true}).first().waitFor({timeout:15000});}
 if(!await overtime(p))throw Error('OVERTIME_SCOPE_UNVERIFIED');const picked=await table(p);
 if(!picked)throw Error('BET365_MARKET_UNAVAILABLE');if(picked.line===null||!allowed(picked.line)||expected!==null&&expected!==picked.line)throw Error('MARKET_LINE_UNVERIFIED');
 return {line:picked.line,odds1:picked.odds1,odds2:picked.odds2,captured_at:new Date().toISOString(),price_updated_at:null};
}
async function run(league,input){
 if(!['NBA','WNBA'].includes(league)||input.bookmaker?.toLowerCase()!=='bet365'||!Array.isArray(input.candidateNames)||!input.candidateNames.length)throw Error('BASKETBALL_INPUT_INVALID');
 const browser=await chromium.launch({headless:true,channel:'chrome',proxy:process.env.PROXY_SERVER?{server:process.env.PROXY_SERVER}:undefined,args:['--disable-dev-shm-usage','--no-sandbox']});
 const result={league,bookmaker:'bet365',games:[],errors:[],player_props_status:'NO_VERIFIED_FEED'};
 try{const context=await browser.newContext({locale:'en-US',timezoneId:'UTC'});await context.route('**/*',r=>['image','font','media'].includes(r.request().resourceType())?r.abort():r.continue());const page=await context.newPage();
  const response=await page.goto('https://www.cuotasahora.com/basketball/usa/'+league.toLowerCase()+'/',{waitUntil:'domcontentloaded',timeout:45000});if([401,403,429].includes(response?.status()))throw Error('SOURCE_ACCESS_DENIED');
  await page.locator('a[href*="/basketball/h2h/"]').first().waitFor({timeout:15000});
  const names=input.candidateNames.map(norm),links=[...new Set(await page.locator('a[href*="/basketball/h2h/"]').evaluateAll(es=>es.map(e=>e.href)))].filter(u=>/^https:\/\/www\.cuotasahora\.com\/basketball\/h2h\/[^?#]+\/#[A-Za-z0-9]+$/.test(u)&&names.filter(n=>norm(u).includes(n)).length>=2).slice(0,6);
  for(const url of links){if(result.games.length>=3)break;try{
   const r=await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000});if([401,403,429].includes(r?.status()))throw Error('SOURCE_ACCESS_DENIED');
   const cookie=page.locator('#onetrust-accept-btn-handler');if(await cookie.isVisible().catch(()=>false))await cookie.click();
   await page.getByText('Bookmakers',{exact:true}).first().waitFor({timeout:15000});
   const identity=eventIdentity(await page.locator('script[type="application/ld+json"]').allTextContents(),league);
   if(!names.includes(norm(identity.home_team))||!names.includes(norm(identity.away_team)))continue;
   if(Date.parse(identity.start_time_utc)<=Date.now()||Date.parse(identity.start_time_utc)>Date.now()+24*3600000)continue;
   if(!await overtime(page))throw Error('OVERTIME_SCOPE_UNVERIFIED');
   const ml=await table(page),g={league,...identity,bookmaker:'bet365',source:'cuotasahora',source_event_url:url,period:'full_game',includes_overtime:true,markets:[],notes:[]};
   if(ml&&ml.line===null)g.markets.push({market:'moneyline',line:null,odds1:ml.odds1,odds2:ml.odds2,captured_at:new Date().toISOString(),price_updated_at:null});else g.notes.push('BET365_MONEYLINE_UNAVAILABLE');
   for(const market of ['total','spread'])try{g.markets.push({market,...await drill(page,market)});}catch(_){g.notes.push(market+'_UNAVAILABLE_OR_UNVERIFIED');}
   if(g.markets.length)result.games.push(g);else result.errors.push({code:'NO_BET365_MARKETS',url});
  }catch(e){result.errors.push({code:/^[A-Z_]+$/.test(e.message||'')?e.message:'SOURCE_PAGE_FAILED',url});if(e.message==='SOURCE_ACCESS_DENIED')break;}}
  result.fetched_at=new Date().toISOString();return result;
 }finally{await browser.close();}
}
if(require.main===module){let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>{input+=d;});process.stdin.on('end',()=>run(process.argv[2],JSON.parse(input)).then(r=>console.log(JSON.stringify(r))).catch(()=>{console.error('BASKETBALL_ODDS_FAILED');process.exitCode=1;}));}
module.exports={norm,eventIdentity,run};
