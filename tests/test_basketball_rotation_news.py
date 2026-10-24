import unittest
from datetime import datetime,timezone
from basketball.rotation_news import signals
from basketball.context_sources import news

class RotationTests(unittest.TestCase):
 def test_staff_numeric_cap_requires_named_subject_future_target_and_attribution(self):
  text='Coach Smith said Jones will be limited to 20-24 minutes Saturday.'
  s=signals('Example Jones','Minutes restriction',text,'2026-10-24')
  self.assertEqual(s['minutes_cap'],24);self.assertEqual(s['target_date'],'2026-10-24')
  for bad in ['Coach Smith said Davis will be limited to 20 minutes Saturday.','Jones will be limited to 20 minutes Saturday.','Coach Smith said Jones will be limited to 20 minutes.','Coach Smith said Jones will not be limited to 20 minutes Saturday.']:
   self.assertNotIn('minutes_cap',signals('Example Jones','Update',bad,'2026-10-24'))
 def test_boxscore_minutes_are_not_announced_limits_or_return_clearance(self):
  s=signals('Example Jones','Solid off bench','Jones scored 12 points across 20 minutes off the bench Friday.','2026-10-23')
  self.assertNotIn('minutes_cap',s);self.assertFalse(s['returning']);self.assertFalse(s['rotation_risk'])
 def test_no_restriction_is_evidence_not_a_number_or_medical_clearance(self):
  s=signals('Example Jones','Set to return','Coach Smith said Jones will return tonight and will not have a minutes restriction.','2026-10-24')
  self.assertTrue(s['returning']);self.assertTrue(s['unrestricted_reported']);self.assertNotIn('minutes_cap',s)
 def test_public_summary_is_read_and_subscription_analysis_is_excluded(self):
  html='<div class="news-update"><a class="news-update__player-link" href="/wnba/player/example-1">Example Jones</a><div class="news-update__headline">Set to return</div><div class="news-update__timestamp">October 24, 2026</div><img class="news-update__logo" alt="ATL"><div class="news-update__news">Coach Smith said Jones will be limited to 18 minutes tonight.</div><div class="news-update__analysis">Paywalled prediction: 35 minutes</div></div>'
  n=news(html,'WNBA',datetime(2026,10,24,12,tzinfo=timezone.utc))[0]
  self.assertEqual(n['rotation']['minutes_cap'],18);self.assertNotIn('35',n['summary']);self.assertNotIn('Paywalled',str(n))
if __name__=='__main__':unittest.main()
