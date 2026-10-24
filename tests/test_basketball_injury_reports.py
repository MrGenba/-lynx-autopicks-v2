import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch
import httpx
from basketball.injury_reports import latest_report, fresh_report

NOW = datetime(2026, 10, 24, 7, 49, tzinfo=timezone.utc)
OLD = 'https://ak-static.cms.nba.com/referee/wnba_injury/Injury-Report_2026-10-24_03_00AM.pdf'
NEW = 'https://ak-static.cms.nba.com/referee/wnba_injury/Injury-Report_2026-10-24_03_30AM.pdf'
REPORT = {'source_url': OLD, 'published_at': '2026-10-24T07:00:00+00:00', 'records': [{'status': 'OUT'}]}


class InjuryReportTests(unittest.IsolatedAsyncioTestCase):
    async def test_delay_and_cache_avoid_polling_an_unpublished_slot_every_tick(self):
        get = AsyncMock(return_value=httpx.Response(200, content=b'pdf'))
        parsed = {**REPORT, 'source_url': NEW, 'published_at': '2026-10-24T07:30:00+00:00'}
        with patch('basketball.injury_reports.injury_pdf', return_value=parsed):
            report, detail = await latest_report('WNBA', NOW, get)
            self.assertEqual(get.call_args.args, (NEW,))
            again, _ = await latest_report('WNBA', NOW+timedelta(seconds=30), get, detail)
        self.assertEqual(get.await_count, 1)
        self.assertEqual(report, again)
        self.assertEqual(detail['source_status'], 'OK')

    async def test_xml_missing_object_needs_successful_known_public_document(self):
        get = AsyncMock(side_effect=[httpx.Response(403, text='<Error><Code>AccessDenied</Code></Error>', headers={'content-type': 'application/xml'}), httpx.Response(200, content=b'pdf')])
        with patch('basketball.injury_reports.injury_pdf', return_value=REPORT):
            report, detail = await latest_report('WNBA', NOW, get, {'report': REPORT})
        self.assertEqual([c.args[0] for c in get.call_args_list], [NEW, OLD])
        self.assertFalse(detail['blocked'])
        self.assertEqual(detail['publication'], 'AWAITING_NEXT_REPORT')
        self.assertEqual(report['published_at'], REPORT['published_at'])

    async def test_real_access_denial_stops_without_fallback_or_rotation(self):
        for code in [401, 403, 429, 451]:
            get = AsyncMock(return_value=httpx.Response(code, text='Access denied'))
            _, detail = await latest_report('WNBA', NOW, get, {'report': REPORT})
            self.assertTrue(detail['blocked'])
            self.assertEqual(detail['source_status'], 'SOURCE_ACCESS_BLOCKED')
            self.assertEqual(get.await_count, 1)
        get = AsyncMock(side_effect=[httpx.Response(403, text='<Code>AccessDenied</Code>', headers={'content-type': 'application/xml'}), httpx.Response(403)])
        _, detail = await latest_report('WNBA', NOW, get, {'report': REPORT})
        self.assertTrue(detail['blocked'])

    async def test_expired_report_cannot_be_refreshed_by_a_missing_publication(self):
        get = AsyncMock(return_value=httpx.Response(404))
        report, detail = await latest_report('WNBA', NOW+timedelta(hours=6), get, {'report': REPORT})
        self.assertEqual(report, {})
        self.assertEqual(detail['source_status'], 'AWAITING_REPORT')
        self.assertEqual(fresh_report(REPORT, 'NBA', NOW), {})

    async def test_malformed_pdf_does_not_replace_valid_history_or_say_source_ok(self):
        get = AsyncMock(return_value=httpx.Response(200, content=b'bad'))
        with patch('basketball.injury_reports.injury_pdf', side_effect=ValueError('EMPTY_REPORT')):
            report, detail = await latest_report('WNBA', NOW, get, {'report': REPORT})
        self.assertEqual(report, REPORT)
        self.assertEqual(detail['source_status'], 'REPORT_INVALID')

if __name__ == '__main__':
    unittest.main()
