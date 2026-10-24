"""Public SportsDataverse league stats: season aggregates, never live optical data.

Keep provider IDs and units, fail closed on ambiguous identities, and preserve each
changed observation. A file publication time is NOT its underlying game cutoff.
"""
import asyncio
import hashlib
import io
import json
import os
import re
import unicodedata
from collections import defaultdict
from datetime import datetime, timezone

import httpx
import pandas as pd
from basketball.storage import rest_config

RELEASES = 'https://api.github.com/repos/sportsdataverse/sportsdataverse-data/releases/tags/'
BASIC = ['advanced', 'base', 'defense', 'misc', 'scoring', 'usage']
TRACKING = ['catchshoot', 'defense', 'drives', 'efficiency', 'elbowtouch', 'painttouch',
            'passing', 'possessions', 'posttouch', 'pullupshot', 'rebounding', 'speeddistance']
IDENTITY = {'player_id', 'player_name', 'nickname', 'team_id', 'team_abbreviation',
            'season', 'league_id', 'season_type', 'per_mode'}
COLLECTOR_VERSION = 'advanced-v3'
NBA_TEAMS = dict(zip(map(str, range(1, 31)), ['ATL','BOS','NOP','CHI','CLE','DAL','DEN','DET','GSW','HOU',
    'IND','LAC','LAL','MIA','MIL','MIN','BKN','NYK','ORL','PHI','PHX','POR','SAC','SAS','OKC','UTA','WAS','TOR','MEM','CHA']))


def team_abbreviation(value):
    return {'GS': 'GSW', 'UTAH': 'UTA', 'WSH': 'WAS', 'NO': 'NOP', 'NY': 'NYK', 'SA': 'SAS'}.get(value, value)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def norm(value):
    return re.sub(r'[^a-z0-9]', '', unicodedata.normalize('NFKD', str(value or '')).encode('ascii', 'ignore').decode().lower())


def ident(value):
    if value is None or pd.isna(value):
        return None
    return str(int(value)) if isinstance(value, (int, float)) else str(value)


def records(frame):
    # Pandas JSON handles nullable scalars and NaN without inventing zeroes.
    return json.loads(frame.to_json(orient='records'))


def identity_index(crosswalk, league, season, known):
    by_id, by_name_team = defaultdict(list), defaultdict(list)
    provider_key = league.lower() + '_player_id'
    for row in crosswalk:
        eid = ident(row.get('espn_athlete_id'))
        if row.get('season') != season or not eid or not row.get('espn_full_name'):
            continue
        canonical = known.get(eid)
        if canonical and norm(canonical['player_name']) != norm(row['espn_full_name']):
            continue
        pid = ident(row.get(provider_key))
        if pid and row.get('match_confidence') == 1:
            by_id[pid].append(row)
        by_name_team[(norm(row['espn_full_name']), team_abbreviation(row.get('team_abbreviation')))].append(row)
    # The current NBA crosswalk can omit entire teams. Existing current-season
    # ESPN box identities provide an independent exact-name + exact-team fallback.
    if league == 'NBA':
        for eid, row in known.items():
            if row.get('season') == season and row.get('team_id') in NBA_TEAMS:
                by_name_team[(norm(row['player_name']), NBA_TEAMS[row['team_id']])].append(
                    {'espn_athlete_id': eid, 'espn_full_name': row['player_name'], 'identity_source': 'current_season_box'})
    return by_id, by_name_team


def map_player(row, index):
    by_id, by_name_team = index
    pid, name = ident(row['player_id']), norm(row['player_name'])
    candidates = by_id.get(pid, [])
    method = 'published_crosswalk'
    if not candidates:
        candidates = by_name_team.get((name, team_abbreviation(row.get('team_abbreviation'))), [])
        method = 'unique_exact_name_and_team'
    candidates = [r for r in candidates if norm(r.get('espn_full_name')) == name]
    ids = {ident(r['espn_athlete_id']) for r in candidates}
    if len(ids) != 1:
        return None, {'status': 'unmapped', 'reason': 'AMBIGUOUS_OR_MISSING_ID'}
    eid = ids.pop()
    # One ESPN ID must not be assigned to multiple provider IDs in the crosswalk.
    provider_ids = {p for p, rs in by_id.items() if any(ident(r['espn_athlete_id']) == eid for r in rs)}
    if provider_ids and provider_ids != {pid}:
        return None, {'status': 'unmapped', 'reason': 'PROVIDER_ID_CONFLICT'}
    return eid, {'status': 'mapped', 'method': method}


def quality_flags(dataset, stats):
    flags = []
    if dataset == 'tracking_rebounding':
        for prefix in ('oreb', 'dreb', 'reb'):
            count, contested, uncontested = (stats.get(prefix + suffix) for suffix in ('', '_contest', '_uncontest'))
            if all(isinstance(v, (int, float)) for v in (count, contested, uncontested)) and abs(count-contested-uncontested) > .11:
                flags.append(prefix.upper() + '_COMPONENT_MISMATCH')
    if stats.get('gp') == 0:
        flags.append('NO_GAMES')
    return flags


def normalize(frame, league, season, dataset, index, asset, observed_at, quarantined=None, box_totals=None):
    required = IDENTITY - {'nickname'}
    if not required.issubset(frame.columns):
        raise ValueError('SOURCE_SCHEMA_CHANGED')
    result, seen = [], set()
    context = ['player_id', 'team_id', 'season', 'season_type', 'per_mode']
    duplicates = frame.duplicated(context, keep=False)
    if duplicates.any():
        if quarantined is None:
            raise ValueError('SOURCE_DUPLICATE_CONTEXT')
        quarantined.extend({'reason': 'SOURCE_DUPLICATE_CONTEXT', 'row': r} for r in records(frame[duplicates]))
        frame = frame[~duplicates]
    for row in records(frame):
        if row['season'] != season or row['league_id'] != ('00' if league == 'NBA' else '10'):
            raise ValueError('SOURCE_SEASON_OR_LEAGUE_MISMATCH')
        if row['season_type'] not in ('Regular Season', 'Playoffs', 'Pre Season') or row['per_mode'] not in ('Totals', 'PerGame', 'Per36', 'Per100Possessions'):
            raise ValueError('SOURCE_CONTEXT_UNKNOWN')
        if not row['player_id'] or not row['player_name']:
            raise ValueError('SOURCE_PLAYER_REQUIRED')
        entity = [league, season, dataset, row['season_type'], row['per_mode'], ident(row['player_id']), ident(row['team_id'])]
        key = digest(entity)
        if key in seen:
            raise ValueError('SOURCE_DUPLICATE_CONTEXT')
        seen.add(key)
        eid, mapping = map_player(row, index)
        stats = {k: v for k, v in row.items() if k not in IDENTITY and not k.endswith('_rank')}
        flags = quality_flags(dataset, stats)
        quality = {'flags': flags, 'data_cutoff': 'not_provided', 'scope': 'season_aggregate',
                   'units': 'provider_native', 'eligible_for_model': False}
        comparison = (box_totals or {}).get((eid, row['season_type']))
        if comparison:
            quality['boxscore_comparison'] = {'games': comparison['gp'], 'latest_completed_box_start': comparison['last_game'],
                'games_match': stats.get('gp') == comparison['gp']}
            if stats.get('gp') != comparison['gp']:
                flags.append('BOXSCORE_GAME_COUNT_DIFFERS')
            if dataset == 'stats_base' and row['per_mode'] == 'Totals':
                match = stats.get('pts') == comparison['pts']
                quality['boxscore_comparison']['points_match'] = match
                if not match:
                    flags.append('BOXSCORE_POINTS_DIFFER')
        else:
            quality['boxscore_comparison'] = {'status': 'unavailable'}
        item = dict(entity_key=key, league=league, season=season, dataset=dataset,
                    season_type=row['season_type'], per_mode=row['per_mode'],
                    provider_player_id=ident(row['player_id']), provider_team_id=ident(row['team_id']),
                    player_id=eid, player_name=row['player_name'], team_abbreviation=row['team_abbreviation'],
                    stats=stats, mapping=mapping, quality=quality, data_through=None)
        item['content_hash'] = digest(item)
        item.update(source_url=asset['browser_download_url'], source_published_at=asset['updated_at'], observed_at=observed_at)
        item['version_id'] = digest([key, item['content_hash'], item['source_published_at']])
        result.append(item)
    # Refuse a many-to-one identity across players within this dataset.
    mapped = defaultdict(set)
    for item in result:
        if item['player_id']:
            mapped[item['player_id']].add(item['provider_player_id'])
    for item in result:
        if len(mapped[item['player_id']]) > 1:
            item['player_id'] = None
            item['mapping'] = {'status': 'unmapped', 'reason': 'MULTIPLE_PROVIDER_PLAYERS'}
            item['content_hash'] = digest([item['content_hash'], item['mapping']])
            item['version_id'] = digest([item['entity_key'], item['content_hash'], item['source_published_at']])
    return result


async def run():
    now = datetime.now(timezone.utc)
    observed = now.isoformat()
    base, headers = rest_config()
    reports = []
    async with httpx.AsyncClient(timeout=50, follow_redirects=True, trust_env=False) as client:
        async def rest(path, body=None, prefer=None):
            response = await client.request('GET' if body is None else 'POST', base+path,
                headers={**headers, **({'Prefer': prefer} if prefer else {})}, **({'json': body} if body is not None else {}))
            if response.status_code >= 300:
                raise RuntimeError('DATABASE_HTTP_' + str(response.status_code))
            return response.json() if response.content else None

        async def assets(tag):
            response = await client.get(RELEASES+tag, headers={'Accept': 'application/vnd.github+json'})
            if response.status_code != 200:
                raise RuntimeError('RELEASE_HTTP_' + str(response.status_code))
            return {a['name']: a for a in response.json()['assets']}

        async def parquet(asset):
            response = await client.get(asset['browser_download_url'])
            if response.status_code != 200:
                raise RuntimeError('ASSET_HTTP_' + str(response.status_code))
            if len(response.content) > 20_000_000:
                raise ValueError('ASSET_TOO_LARGE')
            return pd.read_parquet(io.BytesIO(response.content)), hashlib.sha256(response.content).hexdigest()

        catalog = await rest('rpc/bk_player_identity_catalog', {})
        for league, season in [('NBA', now.year+(now.month >= 9)), ('WNBA', now.year)]:
            report = {'league': league, 'season': season, 'datasets': [], 'tracking': 'available' if league == 'NBA' else 'not_public_in_source'}
            try:
                stats_assets = await assets(league.lower()+'_stats_leaguedash')
                cross_assets = await assets(league.lower()+'_crosswalk')
                cross_asset = cross_assets.get(f'{league.lower()}_player_crosswalk_{season}.parquet')
                if not cross_asset:
                    raise ValueError('CROSSWALK_MISSING')
                cross, _ = await parquet(cross_asset)
                known = {r['player_id']: r for r in catalog if r['league'] == league}
                index = identity_index(records(cross), league, season, known)
                totals = await rest('rpc/bk_player_season_box_totals', {'p_league': league, 'p_season': season})
                box_totals = {(r['player_id'], r['season_type']): r for r in totals}
                previous = {r['dataset']: r for r in await rest(f'bk_stat_sources?league=eq.{league}&season=eq.{season}&select=*')}
                datasets = ['stats_'+s for s in BASIC] + (['tracking_'+s for s in TRACKING] if league == 'NBA' else [])
                for dataset in datasets:
                    source = {'league': league, 'season': season, 'dataset': dataset, 'checked_at': observed}
                    try:
                        asset = stats_assets.get(f'player_{dataset}_{season}.parquet')
                        if not asset:
                            raise ValueError('DATASET_MISSING')
                        published = datetime.fromisoformat(asset['updated_at'].replace('Z', '+00:00'))
                        source.update(source_url=asset['browser_download_url'], source_published_at=asset['updated_at'])
                        old = previous.get(dataset, {})
                        mapping_revision = digest([COLLECTOR_VERSION, cross_asset['id'], cross_asset['updated_at'], known, totals])
                        unchanged = old.get('detail', {}).get('asset_id') == asset['id'] and old.get('detail', {}).get('asset_updated_at') == asset['updated_at'] and old.get('detail', {}).get('mapping_revision') == mapping_revision and old.get('status') in ('ok', 'partial', 'stale')
                        status = 'stale' if (now-published).total_seconds() > 48*3600 else 'ok'
                        if unchanged:
                            source.update(detail=old['detail'], content_sha256=old['content_sha256'], last_success_at=old['last_success_at'], status=status)
                        else:
                            frame, sha = await parquet(asset)
                            quarantined = []
                            rows = normalize(frame, league, season, dataset, index, asset, observed, quarantined, box_totals)
                            if not rows:
                                raise ValueError('DATASET_EMPTY')
                            for start in range(0, len(rows), 200):
                                await rest('rpc/bk_store_advanced_stats', {'p_rows': rows[start:start+200]})
                            source.update(content_sha256=sha, last_success_at=observed, status=status,
                                detail={'rows': len(rows), 'mapped': sum(r['player_id'] is not None for r in rows),
                                    'flagged': sum(bool(r['quality']['flags']) for r in rows), 'asset_id': asset['id'], 'asset_updated_at': asset['updated_at'],
                                    'quarantined': quarantined, 'collector_version': COLLECTOR_VERSION,
                                    'mapping_revision': mapping_revision, 'crosswalk_url': cross_asset['browser_download_url'],
                                    'crosswalk_published_at': cross_asset['updated_at'], 'data_through': None,
                                    'data_cutoff': 'not_provided', 'source': 'sportsdataverse_league_stats',
                                    'season_types': sorted({r['season_type'] for r in rows})})
                        if source['status'] == 'ok' and (source['detail'].get('quarantined') or source['detail'].get('flagged') or source['detail']['mapped'] < source['detail']['rows']):
                            source['status'] = 'partial'
                    except Exception as error:
                        code = str(error)
                        source.update(status='error', detail={'error': code if re.fullmatch('[A-Z_0-9]+', code) else 'DATASET_IMPORT_FAILED'})
                    await rest('bk_stat_sources?on_conflict=league,season,dataset', source, 'resolution=merge-duplicates,return=minimal')
                    report['datasets'].append({'dataset': dataset, 'status': source['status'], 'published_at': source.get('source_published_at'), **source['detail']})
                report['status'] = 'error' if any(d['status'] == 'error' for d in report['datasets']) else 'stale' if any(d['status'] == 'stale' for d in report['datasets']) else 'daily_snapshot_partial' if any(d['status'] == 'partial' for d in report['datasets']) else 'daily_snapshot_ok'
            except Exception as error:
                code = str(error)
                report.update(status='error', error=code if re.fullmatch('[A-Z_0-9]+', code) else 'ADVANCED_IMPORT_FAILED')
            await rest('bk_state?on_conflict=league,component', {'league': league, 'component': 'advanced_stats', 'checked_at': observed,
                'status': report['status'], 'detail': report}, 'resolution=merge-duplicates,return=minimal')
            reports.append(report)
    return {'at': observed, 'reports': reports}


if __name__ == '__main__':
    try:
        print(json.dumps(asyncio.run(run()), allow_nan=False))
    except Exception:
        print(json.dumps({'status': 'error', 'error': 'ADVANCED_JOB_FAILED'}))
        raise SystemExit(1)
