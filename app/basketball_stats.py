"""Isolated authenticated start/status API for basketball public snapshot imports."""
import asyncio,json,secrets,time,uuid
from aiohttp import web
from app.node_bridge import _kill_process_tree

jobs={}
def authorized(request):
    expected=request.app['cfg'].scrape_endpoint_token
    return bool(expected) and secrets.compare_digest(request.headers.get('Authorization',''),'Bearer '+expected)

async def collect(job_id):
    proc=None
    try:
        proc=await asyncio.create_subprocess_exec('python','-m','basketball.capture_snapshot',stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE,start_new_session=True)
        out,_=await asyncio.wait_for(proc.communicate(),timeout=600)
        result=json.loads(out.decode())
        jobs[job_id].update(status='done' if proc.returncode==0 else 'error',result=result)
    except Exception:
        if proc and proc.returncode is None:_kill_process_tree(proc);await proc.wait()
        jobs[job_id].update(status='error',error='SNAPSHOT_JOB_FAILED')

async def start(request):
    if not authorized(request):return web.json_response({'error':'unauthorized'},status=401)
    for jid,job in list(jobs.items()):
        if job['status']=='running':return web.json_response({'job_id':jid,'status':'running'})
        if time.time()-job['created_at']>7200:jobs.pop(jid,None)
    jid=str(uuid.uuid4());jobs[jid]={'status':'running','created_at':time.time()};asyncio.create_task(collect(jid))
    return web.json_response({'job_id':jid,'status':'running'})

async def status(request):
    if not authorized(request):return web.json_response({'error':'unauthorized'},status=401)
    job=jobs.get(request.match_info['job_id'])
    if not job:return web.json_response({'error':'job_not_found'},status=404)
    return web.json_response(job)

def register(app):
    app.router.add_post('/basketball-stats/start',start)
    app.router.add_get('/basketball-stats/status/{job_id}',status)
