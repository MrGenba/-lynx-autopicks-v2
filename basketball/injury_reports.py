"""Bounded PDF reads: a publication delay must not permanently disable a feed."""
from datetime import timedelta
from basketball.context_sources import ET, injury_pdf, report_time


def fresh_report(report, league, now):
    folder = 'injury' if league == 'NBA' else 'wnba_injury'
    prefix = 'https://ak-static.cms.nba.com/referee/' + folder + '/'
    try:
        url = report['source_url']
        published = report_time(url)
        if not url.startswith(prefix) or not 0 <= (now-published).total_seconds() <= 6*3600:
            return {}
        if not report.get('records') or report.get('published_at') != published.isoformat():
            return {}
        return report
    except (KeyError, TypeError, ValueError):
        return {}


async def latest_report(league, now, get, previous=None):
    """Read one completed quarter-hour slot. Never retry an access denial blindly.

    The storage host also returns XML AccessDenied for unavailable objects. Only
    a successful read of a previously validated PDF on that same host can classify
    that particular response as a missing publication rather than a host block.
    """
    previous = previous or {}
    report = fresh_report(previous.get('report', {}), league, now)
    at = now.astimezone(ET).replace(second=0, microsecond=0)-timedelta(minutes=15)
    at -= timedelta(minutes=at.minute % 15)
    folder = 'injury' if league == 'NBA' else 'wnba_injury'
    url = 'https://ak-static.cms.nba.com/referee/' + folder + '/Injury-Report_' + at.strftime('%Y-%m-%d_%I_%M%p') + '.pdf'
    detail = {**previous, 'report': report}
    if previous.get('last_attempt_url') == url:
        status = previous.get('source_status', 'AWAITING_REPORT')
        if status == 'OK' and not report:
            status = 'AWAITING_REPORT'
        return report, {**detail, 'source_status': status}
    detail.update(last_attempt_url=url, last_attempt_at=now.isoformat(), blocked=False)
    try:
        response = await get(url)
        detail['http'] = response.status_code
        if response.status_code == 200:
            report = injury_pdf(response.content, url, now)
            detail.update(report=report, source_status='OK', publication='CURRENT')
        elif response.status_code == 404:
            detail.update(source_status='OK' if report else 'AWAITING_REPORT', publication='AWAITING_NEXT_REPORT')
        elif (response.status_code == 403 and report and report['source_url'] != url
              and '<Code>AccessDenied</Code>' in response.text
              and 'xml' in response.headers.get('content-type', '').lower()):
            # Same public connection, one known document, no proxy or authentication change.
            control = await get(report['source_url'])
            detail['control_http'] = control.status_code
            if control.status_code == 200:
                report = injury_pdf(control.content, report['source_url'], now)
                detail.update(report=report, source_status='OK', publication='AWAITING_NEXT_REPORT')
            else:
                detail.update(source_status='SOURCE_ACCESS_BLOCKED', blocked=True, publication='UNVERIFIED')
        elif response.status_code in [401, 403, 429, 451]:
            detail.update(source_status='SOURCE_ACCESS_BLOCKED', blocked=True, publication='UNVERIFIED')
        else:
            detail.update(source_status='SOURCE_HTTP_'+str(response.status_code), publication='UNVERIFIED')
    except ValueError:
        detail.update(source_status='REPORT_INVALID', publication='UNVERIFIED')
    except Exception:
        detail.update(source_status='SOURCE_FAILED', publication='UNVERIFIED')
    return report, detail
