import json,unittest
from pathlib import Path
from datetime import datetime,timezone
from basketball.cbs_results import parse,url_for
P=Path(__file__).parent/'fixtures'/'basketball'
PAGE=(P/'cbs_nyk_bos.html').read_text(encoding='utf8')
CATALOG=json.loads((P/'cbs_catalog.json').read_text(encoding='utf8'))
GAME={'league':'NBA','game_id':'g','season':2027,'season_type':2,'home_team_id':'2','away_team_id':'18','home_team':'Boston Celtics','away_team':'New York Knicks','starts_at':'2026-10-23T23:00:00Z','status':'scheduled'}
NOW=datetime(2026,10,24,6,tzinfo=timezone.utc)
class Tests(unittest.TestCase):
 def test_final_box_reconciles_all_players_and_scores(self):
  p=parse(PAGE,GAME,CATALOG,NOW);self.assertTrue(p['receipt']['complete']);self.assertEqual([p['game']['away_score'],p['game']['home_score']],[103,107])
  for t in p['teams']:self.assertEqual(sum(p['stats']['points'] for p in p['players'] if p['team_id']==t['team_id'] and not p['did_not_play']),t['stats']['points'])
  self.assertEqual(p['receipt']['minutes_precision'],'rounded_whole_minutes')
  self.assertIn('NBA_20261023_NY%40BOS/',url_for(GAME))
 def test_wrong_team_time_live_and_future_fail(self):
  for change in [{'home_team':'Chicago Bulls'},{'starts_at':'2026-10-24T23:00:00Z'},{'starts_at':'2026-10-23T20:00:00Z'}]:
   with self.assertRaises(ValueError):parse(PAGE,{**GAME,**change},CATALOG,NOW)
  with self.assertRaises(ValueError):parse(PAGE.replace('FINAL','LIVE'),GAME,CATALOG,NOW)
 def test_missing_active_identity_preserves_only_validated_final_score(self):
  p=parse(PAGE,GAME,[x for x in CATALOG if x['player_name']!='Jayson Tatum'],NOW)
  self.assertFalse(p['receipt']['complete']);self.assertEqual(p['players'],[]);self.assertEqual(p['game']['status'],'final');self.assertIn('UNMAPPED',p['receipt']['reason'])
 def test_player_scoring_corruption_cannot_be_a_complete_box(self):
  damaged=PAGE.replace('>36</td>','>37</td>')
  p=parse(damaged,GAME,CATALOG,NOW);self.assertFalse(p['receipt']['complete'])
if __name__=='__main__':unittest.main()
