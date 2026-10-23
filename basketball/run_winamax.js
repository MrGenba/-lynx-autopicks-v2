'use strict';
// Public FR pages, direct VPS connection. Never rotate proxies or retry access denials.
const {chromium}=require('patchright');
const {HEADERS,teamNorm,eventIdentity,parsePairs}=require('./winamax');
const INDEX={NBA:'https://www.winamax.fr/paris-sportifs/sports/2/15/177',WNBA:'https://www.winamax.fr/paris-sportifs/sports/2/15/11419'};
async function checked(page,url){const r=await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});if([401,403,429,451].includes(r?.status()))throw Error('SOURCE_ACCESS_DENIED');await page.waitForTimeout(4500);await guard(page);}
async function guard(page){if(!page.url().startsWith('https://www.winamax.fr/'))throw Error('JURISDICTION_CHANGED');if(page.sourceAccessDenied||/access denied|you have been blocked|verify you are human|captcha/i.test(await page.locator('body').innerText()))throw Error('SOURCE_ACCESS_DENIED');}
async function groups(page,market,header){
 const h=page.getByText(header,{exact:true});if(await h.count()!==1)return [];
 const root=h.locator('xpath=ancestor::*[.//*[contains(concat(" ",normalize-space(@class)," ")," odd-button-wrapper ")]][1]');
 if(await root.count()!==1)return [];
 let expansion='not_required';const more=root.getByText('Plus de sélections',{exact:true});if(await more.count()===1){try{
  // This public expansion control sits inside a translated scrolling panel.
  // DOM activation avoids its clipped pointer coordinates; never activate odds.
  if(!await more.isVisible())throw Error('EXPANSION_HIDDEN');
  await more.evaluate(e=>{if(e.closest('.odd-button-wrapper'))throw Error('NOT_NAVIGATION');e.click();});
  await page.waitForTimeout(500);expansion=await more.count()?'visible_rows_only':'expanded';
 }catch(_){expansion='visible_rows_only';}}
 const blocks=await root.evaluate(el=>{const result=[],seen=new Set();for(const button of el.querySelectorAll('.odd-button-wrapper')){
  if(!/^Plus de /m.test(button.innerText))continue;let row=button.parentElement;while(row&&row!==el){const n=row.querySelectorAll('.odd-button-wrapper').length,first=row.innerText.split('\n').find(s=>s.trim())||'';if(n===2&&!/^(Plus|Moins) de /.test(first))break;if(n>2)break;row=row.parentElement;}
  if(!row||row===el||row.querySelectorAll('.odd-button-wrapper').length!==2||seen.has(row))continue;seen.add(row);
  const odds=[...row.querySelectorAll('.odd-button-wrapper')];result.push({text:row.innerText,outcome_ids:odds.map(x=>(x.getAttribute('data-testid')||'').replace(/^odd-button-/,'')),disabled:odds.some(x=>x.getAttribute('aria-disabled')==='true'||x.classList.contains('disabled'))});
 }return result;});
 const captured_at=new Date().toISOString();return parsePairs(header,blocks).map(m=>({...m,captured_at,coverage:expansion}));
}
async function run(league,input){
 if(!INDEX[league]||input.bookmaker?.toLowerCase()!=='winamax'||!Array.isArray(input.candidateNames)||input.candidateNames.length<2||input.candidateNames.length>6||input.candidateNames.length%2)throw Error('INPUT_INVALID');
 const result={league,bookmaker:'winamax.fr',jurisdiction:'FR',games:[],errors:[],access_denied:false};
 const browser=await chromium.launch({headless:true,channel:'chrome',args:['--no-proxy-server','--disable-dev-shm-usage','--no-sandbox']});
 try{const ctx=await browser.newContext({locale:'fr-FR',timezoneId:'UTC'});const p=await ctx.newPage();p.setDefaultTimeout(8000);
  p.on('response',r=>{if([401,403,429,451].includes(r.status())&&['document','xhr','fetch'].includes(r.request().resourceType())&&new URL(r.url()).hostname==='www.winamax.fr')p.sourceAccessDenied=true;});
  for(let i=0;i<input.candidateNames.length;i+=2){const names=input.candidateNames.slice(i,i+2);let stage='index';try{
   await checked(p,INDEX[league]);const cookie=p.getByRole('button',{name:'Tout refuser',exact:true});for(let j=0;j<await cookie.count();j++)if(await cookie.nth(j).isVisible()){await cookie.nth(j).click();break;}
   // Team name in the match header, never an outcome button.
   const label=p.getByText(names[0],{exact:true}).first();if(await label.count()!==1)throw Error('EVENT_NOT_LISTED');
   if(await label.evaluate(e=>Boolean(e.closest('.odd-button-wrapper'))))throw Error('EVENT_HEADER_NOT_FOUND');
   stage='match_navigation';if(!await label.isVisible())throw Error('EVENT_HEADER_NOT_VISIBLE');
   await label.evaluate(e=>{if(e.closest('.odd-button-wrapper'))throw Error('NOT_NAVIGATION');e.click();});await p.waitForTimeout(3500);await guard(p);
   if(!/^https:\/\/www\.winamax\.fr\/paris-sportifs\/match\/\d+$/.test(p.url()))throw Error('MATCH_URL_UNVERIFIED');
   const event={...eventIdentity(await p.title(),await p.locator('body').innerText(),league,names),source_event_url:p.url(),source_event_id:p.url().split('/').at(-1),markets:[],notes:[]};
   const done=new Set();const capture=async()=>{for(const [market,header]of Object.entries(HEADERS)){if(done.has(market))continue;await guard(p);try{const rows=await groups(p,market,header);if(rows.length){event.markets.push(...rows);done.add(market);}}catch(_){event.notes.push(market+':UI_READ_FAILED');}}await guard(p);};
   stage='player_markets';await capture();
   // Expanding a market scrolls the nested match panel. Reload the observed match
   // URL to restore its navigation before opening the additional player markets.
   await checked(p,event.source_event_url);const fresh=eventIdentity(await p.title(),await p.locator('body').innerText(),league,names);if(fresh.start_time_utc!==event.start_time_utc)throw Error('EVENT_TIME_CHANGED');
   const stats=p.getByText('Stats joueurs',{exact:true});if(await stats.count()===1){try{await stats.click({timeout:5000});await p.waitForTimeout(1000);}catch(_){event.notes.push('STATS_TAB_NOT_CLICKABLE');}await guard(p);await capture();}
   if(!event.markets.length)event.notes.push('NO_SUPPORTED_PLAYER_MARKETS_VISIBLE');result.games.push(event);
  }catch(e){const code=/^[A-Z_]+$/.test(e.message||'')?e.message:'SOURCE_PAGE_FAILED';result.errors.push({teams:names,code,stage,...(code==='SOURCE_PAGE_FAILED'?{detail:String(e.message).slice(0,1500)}:{})});if(code==='SOURCE_ACCESS_DENIED'||code==='JURISDICTION_CHANGED'){result.access_denied=true;break;}}}
  result.fetched_at=new Date().toISOString();return result;
 }finally{await browser.close();}
}
if(require.main===module){let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>{data+=x;});process.stdin.on('end',()=>run(process.argv[2],JSON.parse(data)).then(r=>console.log(JSON.stringify(r))).catch(()=>{console.error('WINAMAX_PROPS_FAILED');process.exitCode=1}));}
module.exports={run,groups};
