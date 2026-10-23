import unittest
import pandas as pd
from basketball.advanced_stats import identity_index, normalize


class AdvancedStatisticsTests(unittest.TestCase):
    def setUp(self):
        self.cross = [{'season': 2027, 'espn_athlete_id': '100', 'espn_full_name': 'A.J. Green',
                       'team_abbreviation': 'MIL', 'nba_player_id': None}]
        self.row = dict(player_id=200, player_name='AJ Green', team_id=1, team_abbreviation='MIL',
                        season=2027, league_id='00', season_type='Regular Season', per_mode='Totals',
                        gp=1, potential_ast=3, ast=1, ts_pct=None, gp_rank=4)
        self.asset = {'updated_at': '2026-10-23T14:00:00Z', 'browser_download_url': 'https://github.com/example.parquet'}

    def parse(self, rows=None, cross=None, dataset='tracking_passing'):
        index = identity_index(cross or self.cross, 'NBA', 2027, {})
        return normalize(pd.DataFrame(rows or [self.row]), 'NBA', 2027, dataset, index, self.asset, '2026-10-23T15:00:00Z')

    def test_exact_name_requires_team_and_unique_id(self):
        parsed = self.parse()[0]
        self.assertEqual(parsed['player_id'], '100')
        wrong_team = {**self.row, 'team_abbreviation': 'ATL'}
        self.assertIsNone(self.parse([wrong_team])[0]['player_id'])
        ambiguous = self.cross + [{**self.cross[0], 'espn_athlete_id': '101'}]
        self.assertIsNone(self.parse(cross=ambiguous)[0]['player_id'])

    def test_no_invented_cutoff_or_zeroes(self):
        parsed = self.parse()[0]
        self.assertIsNone(parsed['stats']['ts_pct'])
        self.assertIsNone(parsed['data_through'])
        self.assertFalse(parsed['quality']['eligible_for_model'])
        self.assertNotIn('gp_rank', parsed['stats'])

    def test_separate_playoffs_and_units(self):
        rows = [self.row, {**self.row, 'season_type': 'Playoffs'}, {**self.row, 'per_mode': 'PerGame'}]
        self.assertEqual(len({r['entity_key'] for r in self.parse(rows)}), 3)
        with self.assertRaisesRegex(ValueError, 'DUPLICATE'):
            self.parse([self.row, self.row])

    def test_wrong_season_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'SEASON_OR_LEAGUE'):
            self.parse([{**self.row, 'season': 2026}])

    def test_conflicting_source_identity_is_quarantined_without_losing_others(self):
        rows = [self.row, {**self.row, 'player_name': 'Different Name'}, {**self.row, 'player_id': 201}]
        rejected = []
        parsed = normalize(pd.DataFrame(rows), 'NBA', 2027, 'stats_advanced', ({}, {}), self.asset, '2026-10-23T15:00:00Z', rejected)
        self.assertEqual(len(parsed), 1)
        self.assertEqual(len(rejected), 2)
        self.assertEqual(parsed[0]['provider_player_id'], '201')

    def test_missing_crosswalk_team_uses_current_season_box_identity(self):
        row = {**self.row, 'player_name': 'Aaron Gordon', 'team_abbreviation': 'DEN'}
        known = {'99': {'player_name': 'Aaron Gordon', 'team_id': '7', 'season': 2027}}
        parsed = normalize(pd.DataFrame([row]), 'NBA', 2027, 'stats_base', identity_index([], 'NBA', 2027, known), self.asset, '2026-10-23T15:00:00Z')
        self.assertEqual(parsed[0]['player_id'], '99')
        known['99']['season'] = 2026
        parsed = normalize(pd.DataFrame([row]), 'NBA', 2027, 'stats_base', identity_index([], 'NBA', 2027, known), self.asset, '2026-10-23T15:00:00Z')
        self.assertIsNone(parsed[0]['player_id'])

    def test_bad_rebound_components_are_flagged(self):
        rows = [{**self.row, 'reb': 6, 'reb_contest': 7, 'reb_uncontest': 2}]
        self.assertIn('REB_COMPONENT_MISMATCH', self.parse(rows, dataset='tracking_rebounding')[0]['quality']['flags'])

    def test_source_and_boxscore_differences_are_not_silently_trusted(self):
        index = identity_index(self.cross, 'NBA', 2027, {})
        totals = {('100', 'Regular Season'): {'gp': 2, 'pts': 12, 'last_game': '2026-10-23T01:30:00Z'}}
        parsed = normalize(pd.DataFrame([{**self.row, 'pts': 9}]), 'NBA', 2027, 'stats_base', index, self.asset, '2026-10-23T15:00:00Z', box_totals=totals)[0]
        self.assertIn('BOXSCORE_GAME_COUNT_DIFFERS', parsed['quality']['flags'])
        self.assertIn('BOXSCORE_POINTS_DIFFER', parsed['quality']['flags'])

    def test_changed_publication_does_not_change_content_hash(self):
        first = self.parse()[0]
        self.asset['updated_at'] = '2026-10-23T15:00:00Z'
        second = self.parse()[0]
        self.assertEqual(first['content_hash'], second['content_hash'])
        self.assertNotEqual(first['version_id'], second['version_id'])

    def test_published_crosswalk_is_validated_against_canonical_name(self):
        cross = [{**self.cross[0], 'nba_player_id': '200', 'match_confidence': 1}]
        index = identity_index(cross, 'NBA', 2027, {'100': {'player_name': 'Another Player'}})
        parsed = normalize(pd.DataFrame([self.row]), 'NBA', 2027, 'stats_advanced', index, self.asset, '2026-10-23T15:00:00Z')
        self.assertIsNone(parsed[0]['player_id'])


if __name__ == '__main__':
    unittest.main()
