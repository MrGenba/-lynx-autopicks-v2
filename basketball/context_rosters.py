"""Current roster identities for players with no historical boxscore.

This supplements identity only: it supplies no playing time, availability or
statistics. Missing/ambiguous names still remain publication blockers.
"""
import asyncio
import re
from datetime import datetime

VERSION = 'context-roster-1'


def roster_url(league, team_id, season):
    if league not in ('NBA', 'WNBA') or not re.fullmatch(r'[0-9]+', str(team_id)) or not isinstance(season, int):
        raise ValueError('ROSTER_SCOPE_INVALID')
    return f'https://site.api.espn.com/apis/site/v2/sports/basketball/{league.lower()}/teams/{team_id}/roster?season={season}'


def parse_roster(body, league, team_id, season, now):
    url = roster_url(league, team_id, season)
    if str(body.get('team', {}).get('id')) != str(team_id) or body.get('season', {}).get('year') != season:
        raise ValueError('ROSTER_SCOPE_MISMATCH')
    athletes = body.get('athletes')
    if not isinstance(athletes, list) or not 5 <= len(athletes) <= 40:
        raise ValueError('ROSTER_INCOMPLETE')
    rows, seen = [], set()
    for athlete in athletes:
        pid, name = str(athlete.get('id', '')), athlete.get('fullName')
        if not re.fullmatch(r'[0-9]+', pid) or pid in seen or not isinstance(name, str) or not name.strip():
            raise ValueError('ROSTER_IDENTITY_INVALID')
        seen.add(pid)
        rows.append({'league': league, 'team_id': str(team_id), 'season': season,
                     'player_id': pid, 'player_name': name.strip(),
                     'identity': {'method': 'espn_team_roster', 'source_url': url, 'observed_at': now.isoformat()}})
    return rows


async def refresh_rosters(league, targets, now, get, previous=None):
    previous = previous or {}
    cache = previous.get('teams', {}) if previous.get('version') == VERSION else {}
    semaphore = asyncio.Semaphore(4)

    async def fetch(target):
        season, tid = target
        key = f'{season}:{tid}'
        prior = cache.get(key, {})
        try:
            age = (now-datetime.fromisoformat(prior['checked_at'])).total_seconds()
        except (KeyError, TypeError, ValueError):
            age = float('inf')
        if 0 <= age < (3600 if prior.get('status') == 'OK' else 300):
            return key, prior
        async with semaphore:
            try:
                response = await asyncio.wait_for(get(roster_url(league, tid, season)), timeout=8)
                if response.status_code != 200:
                    raise ValueError('ROSTER_HTTP_' + str(response.status_code))
                rows = parse_roster(response.json(), league, tid, season, now)
                return key, {'status': 'OK', 'checked_at': now.isoformat(), 'players': rows}
            except (Exception, asyncio.CancelledError) as error:
                code = str(error) if isinstance(error, ValueError) and str(error).startswith('ROSTER_') else 'ROSTER_UNAVAILABLE'
                return key, {'status': code, 'checked_at': now.isoformat(), 'players': []}

    tasks = [asyncio.create_task(fetch(t)) for t in sorted(set(targets))]
    if tasks:
        _, pending = await asyncio.wait(tasks, timeout=20)
        for task in pending:
            task.cancel()
        results = await asyncio.gather(*tasks, return_exceptions=True)
    else:
        results = []
    teams = dict(r for r in results if isinstance(r, tuple))
    rows = [p for entry in teams.values() if entry['status'] == 'OK' for p in entry['players']]
    # A player simultaneously claimed by two current team lists is unresolved.
    memberships = {}
    for row in rows:
        memberships.setdefault(row['player_id'], set()).add(row['team_id'])
    rows = [r for r in rows if len(memberships[r['player_id']]) == 1]
    return rows, {'version': VERSION, 'teams': teams}


def supplement(known, rows):
    # Do not rewrite historical identities or silently move a player between teams.
    existing = {(p['league'], p['player_id']) for p in known}
    return [*known, *(p for p in rows if (p['league'], p['player_id']) not in existing)]
