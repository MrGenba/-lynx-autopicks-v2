"""Public injury reports and public lineup/news pages. Never infer availability from silence."""
import hashlib, io, json, re, unicodedata
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from bs4 import BeautifulSoup
from pypdf import PdfReader

ET = ZoneInfo('America/New_York')
def norm(s):
    return re.sub('[^a-z0-9]', '', unicodedata.normalize('NFKD', str(s)).encode('ascii','ignore').decode().lower())
def digest(x):
    return hashlib.sha256(json.dumps(x, sort_keys=True, separators=(',',':')).encode()).hexdigest()
def status(s):
    s = s.strip().upper()
    return {'OUT FOR SEASON':'OUT','GTD':'QUESTIONABLE','GAME TIME DECISION':'QUESTIONABLE','PROB':'PROBABLE','QUES':'QUESTIONABLE','DOUBT':'DOUBTFUL'}.get(s, s if s in ['OUT','DOUBTFUL','QUESTIONABLE','PROBABLE','AVAILABLE','SUSPENDED','INACTIVE'] else 'UNVERIFIED')
def report_time(url):
    m = re.search(r'Injury-Report_(\d{4}-\d{2}-\d{2})_(\d{2})_(\d{2})(AM|PM)\.pdf$', url)
    if not m: raise ValueError('REPORT_URL_INVALID')
    return datetime.strptime(' '.join(m.groups()), '%Y-%m-%d %I %M %p').replace(tzinfo=ET).astimezone(timezone.utc)
def injury_pdf(content, url, now):
    published = report_time(url)
    if published > now or (now-published).total_seconds()>6*3600: raise ValueError('REPORT_DATE_INVALID')
    reader=PdfReader(io.BytesIO(content));records=[];date=match=team=None;cols=None
    if not 1<=len(reader.pages)<=40: raise ValueError('REPORT_PAGES_INVALID')
    for page in reader.pages:
        words=[];height=float(page.mediabox.height)
        def visit(text,cm,tm,font,size):
            if text.strip():words.append((tm[4]*cm[0]+tm[5]*cm[2]+cm[4],height-(tm[4]*cm[1]+tm[5]*cm[3]+cm[5]),text.strip()))
        page.extract_text(visitor_text=visit)
        lines=[]
        for x,y,t in sorted(words,key=lambda w:(w[1],w[0])):
            if not lines or abs(lines[-1][0]-y)>2:lines.append((y,[]))
            lines[-1][1].append((x,t))
        header=next(((y,w) for y,w in lines if {'Matchup','Team','Player','Current','Reason'}.issubset({t for _,t in w})),None)
        if not header and cols is None:raise ValueError('REPORT_HEADER_INVALID')
        if header:cols=[next(x for x,t in header[1] if t==label) for label in ['Matchup','Team','Player','Current','Reason']]
        if cols!=sorted(cols):raise ValueError('REPORT_COLUMNS_INVALID')
        for y,w in lines:
            if y<=(header[0] if header else 75) or y>height-65:continue
            cells=['']*6
            for x,t in sorted(w):
                col=sum(x>=bound-2 for bound in cols);cells[col]+=(' ' if cells[col] else '')+t
            before,ma,te,player,st,reason=cells
            dm=re.search(r'\d{2}/\d{2}/\d{4}',before)
            if dm:date=datetime.strptime(dm[0],'%m/%d/%Y').date().isoformat()
            if ma:
                if not re.fullmatch('[A-Z]{2,4}@[A-Z]{2,4}',ma):raise ValueError('REPORT_MATCHUP_INVALID')
                match=ma;team=None
            if te:team=te
            if not date or not match or not team:raise ValueError('REPORT_CONTEXT_MISSING')
            if 'NOT YET SUBMITTED' in ' '.join(cells):
                records.append({'date':date,'matchup':match,'team':team,'submitted':False,'player_name':None,'status':'UNVERIFIED','reason':'NOT_YET_SUBMITTED'});continue
            if player and st:
                value=status(st)
                if value=='UNVERIFIED' or ',' not in player:raise ValueError('REPORT_PLAYER_INVALID')
                last,first=player.split(',',1)
                records.append({'date':date,'matchup':match,'team':team,'submitted':True,'player_name':first.strip()+' '+last.strip(),'status':value,'reason':reason[:180]})
    if not records:raise ValueError('EMPTY_REPORT')
    return {'published_at':published.isoformat(),'source_url':url,'records':records}

def lineups(html,league,now):
    soup=BeautifulSoup(html,'html.parser');title=soup.select_one('.page-title__secondary')
    m=re.search(r'Starting lineups for (\w+ \d{1,2}, \d{4})',title.get_text(' ',strip=True) if title else '')
    if not m:raise ValueError('LINEUP_DATE_MISSING')
    date=datetime.strptime(m[1],'%B %d, %Y').date()
    if abs((date-now.astimezone(ET).date()).days)>1:raise ValueError('LINEUP_DATE_STALE')
    rows=[]
    selector='.lineup.is-'+league.lower()
    # RotoWire renders its WNBA page with the shared basketball ``is-nba``
    # class. Require explicit WNBA page identity before accepting that markup.
    page_title=soup.title.get_text(' ',strip=True) if soup.title else ''
    if league=='WNBA' and re.search(r'\bWNBA\b',page_title,re.I):
        selector+=', .lineup.is-nba'
    for block in soup.select(selector):
        teams=block.select('.lineup__teams .lineup__abbr');clock=block.select_one('.lineup__time')
        if len(teams)!=2 or not clock:continue
        try:start=datetime.strptime(date.isoformat()+' '+clock.get_text(' ',strip=True).replace(' ET',''),'%Y-%m-%d %I:%M %p').replace(tzinfo=ET).astimezone(timezone.utc)
        except ValueError:continue
        for side,index in [('visit',0),('home',1)]:
            ul=block.select_one('.lineup__list.is-'+side)
            if not ul:continue
            tag=ul.select_one('.lineup__status');confirmed=bool(tag and 'is-confirmed' in tag.get('class',[]))
            players=[]
            for li in ul.select('.lineup__player')[:5]:
                a=li.find('a',href=re.compile('/player/'));inj=li.select_one('.lineup__inj')
                if a:players.append({'name':a.get('title') or a.get_text(' ',strip=True),'provider_id':a['href'].rsplit('-',1)[-1], 'status':status(inj.get_text(' ',strip=True)) if inj else 'UNVERIFIED'})
            if len(players)==5 and len({norm(p['name']) for p in players})==5:
                rows.append({'date':date.isoformat(),'starts_at':start.isoformat(),'away':teams[0].get_text(strip=True),'home':teams[1].get_text(strip=True),'side':side,'team':teams[index].get_text(strip=True),'confirmed':confirmed,'players':players})
    return rows

def news(html,league,now):
    soup=BeautifulSoup(html,'html.parser');rows=[]
    for item in soup.select('.news-update'):
        player=item.select_one('.news-update__player-link');head=item.select_one('.news-update__headline');date=item.select_one('.news-update__timestamp');logo=item.select_one('.news-update__logo');inj=item.select_one('.news-update__inj')
        if not all([player,head,date,logo]):continue
        try:day=datetime.strptime(date.get_text(strip=True),'%B %d, %Y').date()
        except ValueError:continue
        if not 0<=(now.astimezone(ET).date()-day).days<=2:continue
        title=head.get_text(' ',strip=True)[:180];url=head.get('href') or player.get('href')
        if not url or not url.startswith(('/basketball/','/wnba/')):continue
        rows.append({'name':player.get_text(' ',strip=True),'team':logo.get('alt'),'headline':title,'date':day.isoformat(),'date_precision':'day','source_url':'https://www.rotowire.com'+url,'status':status(inj.get_text(' ',strip=True)) if inj else 'UNVERIFIED',
                     'availability_risk':bool(inj or re.search(r'\b(out|doubtful|questionable|suspend|injur|limited|restriction|scratch|waiv|starting|bench|resting)',title,re.I))})
    return rows
