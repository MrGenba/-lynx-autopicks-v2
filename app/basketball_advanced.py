"""Authenticated background imports of public advanced basketball statistics."""
import asyncio
import json
import time
import uuid
from aiohttp import web
from app.basketball_stats import authorized
from app.node_bridge import _kill_process_tree

jobs = {}


async def collect(job_id):
    proc = None
    try:
        proc = await asyncio.create_subprocess_exec('python', '-m', 'basketball.advanced_stats',
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, start_new_session=True)
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=900)
        result = json.loads(out.decode())
        failed = proc.returncode != 0 or result.get('status') == 'error' or any(r['status'] == 'error' for r in result.get('reports', []))
        jobs[job_id].update(status='error' if failed else 'done', result=result)
    except Exception:
        if proc and proc.returncode is None:
            _kill_process_tree(proc)
            await proc.wait()
        jobs[job_id].update(status='error', error='ADVANCED_JOB_FAILED')


async def start(request):
    if not authorized(request):
        return web.json_response({'error': 'unauthorized'}, status=401)
    for jid, job in list(jobs.items()):
        if job['status'] == 'running':
            return web.json_response({'job_id': jid, 'status': 'running'})
        if time.time()-job['created_at'] > 7200:
            jobs.pop(jid, None)
    jid = str(uuid.uuid4())
    jobs[jid] = {'status': 'running', 'created_at': time.time()}
    asyncio.create_task(collect(jid))
    return web.json_response({'job_id': jid, 'status': 'running'})


async def status(request):
    if not authorized(request):
        return web.json_response({'error': 'unauthorized'}, status=401)
    job = jobs.get(request.match_info['job_id'])
    return web.json_response(job if job else {'error': 'job_not_found'}, status=200 if job else 404)


def register(app):
    app.router.add_post('/basketball-advanced/start', start)
    app.router.add_get('/basketball-advanced/status/{job_id}', status)
