import io,unittest
from pathlib import Path
from datetime import datetime,timezone
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject,NameObject,DecodedStreamObject
from basketball.context_sources import injury_pdf,lineups,news
from basketball.context_capture import context_for,match_name
NOW=datetime(2026,10,23,17,10,tzinfo=timezone.utc)
URL='https://ak-static.cms.nba.com/referee/injury/Injury-Report_2026-10-23_01_00PM.pdf'
def pdf():
 w=PdfWriter()
 for tokens in [[(200,115,'Matchup'),(264,115,'Team'),(425,115,'Player'),(586,115,'Current'),(666,115,'Reason'),(24,136,'10/23/2026'),(201,136,'CHI@MIL'),(265,136,'Chicago Bulls'),(426,136,'Example, Player'),(587,136,'Out'),(667,136,'Suspension')],[(426,95,'Other, Player'),(587,95,'Questionable'),(667,95,'Injury')]]:
  p=w.add_blank_page(width=842,height=595);font=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})
  p[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):w._add_object(font)})})
  stream=DecodedStreamObject();stream.set_data(('1 0 0 -1 0 595 cm\n'+'\n'.join(f'q 1 0 0 1 {x} {y} cm BT /F1 -10 Tf 0 0 Td ({t}) Tj ET Q' for x,y,t in tokens)).encode());p[NameObject('/Contents')]=w._add_object(stream)
 out=io.BytesIO();w.write(out);return out.getvalue()
class ContextTests(unittest.TestCase):
 def test_live_wnba_fixture_accepts_shared_basketball_markup_but_not_nba_page(self):
  html=(Path(__file__).parent/'fixtures/basketball/wnba_lineups.html').read_text(encoding='utf8')
  rows=lineups(html,'WNBA',datetime(2026,10,24,8,tzinfo=timezone.utc))
  self.assertEqual(len(rows),2);self.assertEqual({r['team'] for r in rows},{'ATL','GSV'})
  self.assertTrue(all(not r['confirmed'] and len(r['players'])==5 for r in rows))
  self.assertEqual(rows[0]['starts_at'],'2026-10-24T17:00:00+00:00')
  self.assertEqual(lineups(html.replace('WNBA Daily Lineups','NBA Daily Lineups'),'WNBA',datetime(2026,10,24,8,tzinfo=timezone.utc)),[])
 def test_omitted_suffix_requires_unique_full_name_and_team_catalog(self):
  catalog=[{'player_id':'p','player_name':'Jaime Jaquez Jr.'}]
  self.assertEqual(match_name('Jaime Jaquez',catalog),'p')
  self.assertIsNone(match_name('Jaime Jaquez',catalog+[{'player_id':'other','player_name':'Jaime Jaquez Sr.'}]))
 def test_pdf_keeps_team_across_page_break_and_rejects_future(self):
  r=injury_pdf(pdf(),URL,NOW);self.assertEqual(len(r['records']),2);self.assertEqual(r['records'][1]['team'],'Chicago Bulls');self.assertEqual(r['records'][0]['player_name'],'Player Example')
  with self.assertRaises(ValueError):injury_pdf(pdf(),URL,datetime(2026,10,23,16,tzinfo=timezone.utc))
 def test_lineup_requires_five_unique_players_and_explicit_confirmation(self):
  rows=''.join(f'<li class="lineup__player"><a title="Player {i}" href="/basketball/player/test-{i}">P</a></li>' for i in range(5))
  html='<div class="page-title__secondary">Starting lineups for October 23, 2026</div><div class="lineup is-nba"><div class="lineup__time">4:00 PM ET</div><div class="lineup__teams"><div class="lineup__abbr">CHI</div><div class="lineup__abbr">MIL</div></div><ul class="lineup__list is-visit"><li class="lineup__status is-expected">Expected Lineup</li>'+rows+'</ul></div>'
  self.assertFalse(lineups(html,'NBA',NOW)[0]['confirmed']);self.assertTrue(lineups(html.replace('is-expected','is-confirmed'),'NBA',NOW)[0]['confirmed'])
  self.assertEqual(lineups(html.replace('Player 4','Player 3'),'NBA',NOW),[])
 def test_missing_report_is_not_assumed_healthy_and_news_remains_unresolved(self):
  g={'league':'NBA','game_id':'g','season':2027,'home_team_id':'15','away_team_id':'4','home_team':'Milwaukee Bucks','away_team':'Chicago Bulls','starts_at':'2026-10-23T20:00:00Z'}
  known=[{'league':'NBA','player_id':'p','player_name':'Player Example','team_id':'4','season':2027}]
  ns=[{'name':'Player Example','team':'CHI','availability_risk':True,'headline':'Limited at practice'}]
  c=context_for(g,known,[],{},[],ns,{'injuries':'AWAITING_REPORT'});self.assertEqual(c['players']['p']['availability'],'UNVERIFIED');self.assertTrue(c['players']['p']['news_unresolved']);self.assertFalse(c['teams']['4']['injury_report_submitted'])
if __name__=='__main__':unittest.main()
