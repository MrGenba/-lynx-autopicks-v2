'use strict';
const {chromium}=require('patchright');
const {teamNorm}=require('./winamax');
async function guard(page){
 if(page.sourceAccessDenied||/access denied|you have been blocked|verify you are human|captcha|restricted country|not available in your country/i.test(await page.locator('body').innerText()))throw Error('SOURCE_ACCESS_DENIED');
 if(new URL(page.url()).hostname!=='www.ps3838.com')throw Error('SOURCE_ORIGIN_CHANGED');
}
// Inspect only rendered public event tables. No session login, private API,
// outcome clicks or modifications to the site's anonymous request parameters.
async function readTables(page,league){
 return page.locator('table.events').evaluateAll((tables,league)=>tables.flatMap(table=>{
  const identity=table.querySelector('[data-league-name="'+league+'"][data-home-team]');if(!identity)return [];
  const get=name=>identity.getAttribute('data-'+name);
  const odds=[...table.querySelectorAll('td[data-period="0"] a.odds[id]')].map(a=>{
   const cell=a.closest('td'),lock=a.parentElement.querySelector('.style-lock'),style=getComputedStyle(a);
   return {id:a.id,period:cell.getAttribute('data-period'),parent_id:a.getAttribute('data-parent-id'),team_type:a.getAttribute('data-team-type'),odds_id:a.getAttribute('data-oddsid'),start_ms:a.getAttribute('data-date'),price:a.querySelector('span')?.innerText.trim(),status:[...cell.classList].find(c=>/^status_/.test(c)),visible:!!a.getClientRects().length&&style.visibility!=='hidden',disabled:a.getAttribute('aria-disabled')==='true'||a.classList.contains('disabled')||!!(lock&&!lock.classList.contains('lock-hidden')&&lock.getClientRects().length)};
  });
  return [{league:get('league-name'),home_team:get('home-team'),away_team:get('away-team'),live:get('live'),source_event_id:get('event'),odds}];
 }),league);
}
async function readPlayerRows(page,eventId){
 const more=page.locator('#more_'+eventId);if(await more.count()!==1)return [];
 await more.click({timeout:5000});await page.waitForTimeout(2000);await guard(page);
 return page.locator('#e'+eventId+'_more .more-player-outright .contestant-line').evaluateAll(rows=>rows.map(row=>{
  const section=row.closest('.special');return {title:row.querySelector('.special-name')?.innerText.trim(),period:section?.querySelector('.special-header .header-name')?.innerText.trim(),disabled:!!row.closest('.status_C,.status_H,.disabled'),outcomes:[...row.querySelectorAll('a.outright-odds')].map(a=>({id:a.id,label:a.querySelector('.prefix-outright')?.innerText,price:a.querySelector(':scope > span')?.innerText.trim(),visible:!!a.getClientRects().length&&getComputedStyle(a).visibility!=='hidden',disabled:a.getAttribute('aria-disabled')==='true'||!!a.closest('.disabled,.suspended')||!!a.parentElement.querySelector('.style-lock:not(.lock-hidden)')}))};
 }));
}
async function run(league,input){
 if(!['NBA','WNBA'].includes(league)||input.bookmaker?.toLowerCase()!=='ps3838'||!Array.isArray(input.candidateNames)||input.candidateNames.length<2||input.candidateNames.length>6||input.candidateNames.length%2)throw Error('INPUT_INVALID');
 const result={league,bookmaker:'ps3838',anonymous:true,delayed:true,games:[],errors:[],access_denied:false};
 const browser=await chromium.launch({channel:'chrome',headless:true,args:['--no-proxy-server','--disable-dev-shm-usage','--no-sandbox']});
 try{
  const ctx=await browser.newContext({locale:'fr-FR',timezoneId:'UTC'}),page=await ctx.newPage();page.setDefaultTimeout(8000);
  page.on('response',r=>{const u=new URL(r.url());if(u.hostname==='www.ps3838.com'&&[401,403,429,451].includes(r.status())&&(r.request().resourceType()==='document'||u.pathname.startsWith('/sports-service/')))page.sourceAccessDenied=true;});
  const response=await page.goto('https://www.ps3838.com/fr/sports/basketball',{waitUntil:'domcontentloaded',timeout:30000});
  if([401,403,429,451].includes(response?.status()))throw Error('SOURCE_ACCESS_DENIED');
  await page.waitForTimeout(6500);await guard(page);
  if(!/^https:\/\/www\.ps3838\.com\/[a-z]{2}\/sports\/basketball$/.test(page.url()))throw Error('BASKETBALL_PAGE_UNVERIFIED');
  const events=await readTables(page,league),captured_at=new Date().toISOString();
  for(let i=0;i<input.candidateNames.length;i+=2){
   const [home,away]=input.candidateNames.slice(i,i+2),found=events.filter(e=>teamNorm(e.home_team)===teamNorm(home)&&teamNorm(e.away_team)===teamNorm(away));
   if(found.length!==1){result.errors.push({teams:[home,away],code:'EVENT_NOT_LISTED'});continue;}
   const e=found[0],times=[...new Set(e.odds.map(o=>Number(o.start_ms)).filter(Number.isFinite))];
   if(times.length!==1){result.errors.push({teams:[home,away],code:'EVENT_TIME_UNVERIFIED'});continue;}
   const event={...e,start_time_utc:new Date(times[0]).toISOString(),source_event_url:page.url(),captured_at,player_rows:[],player_markets_status:'NOT_CAPTURED'};
   try{event.player_rows=await readPlayerRows(page,e.source_event_id);event.player_captured_at=new Date().toISOString();event.player_markets_status=event.player_rows.length?'VISIBLE_ROWS':'NONE_VISIBLE';}
   catch(error){if(['SOURCE_ACCESS_DENIED','SOURCE_ORIGIN_CHANGED'].includes(error.message))throw error;event.player_markets_status='READ_FAILED';result.errors.push({teams:[home,away],code:'PLAYER_MARKET_READ_FAILED'});}
   result.games.push(event);
  }
  await guard(page);
 }catch(e){const code=/^[A-Z_]+$/.test(e.message||'')?e.message:'SOURCE_PAGE_FAILED';result.errors.push({code});if(['SOURCE_ACCESS_DENIED','SOURCE_ORIGIN_CHANGED'].includes(code)){result.access_denied=true;result.games=[];}}
 finally{await browser.close();}
 result.fetched_at=new Date().toISOString();return result;
}
if(require.main===module){let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>{input+=s;});process.stdin.on('end',()=>run(process.argv[2],JSON.parse(input)).then(r=>console.log(JSON.stringify(r))).catch(()=>{console.error('PS3838_PUBLIC_READER_FAILED');process.exitCode=1;}));}
module.exports={run,readTables,readPlayerRows};
