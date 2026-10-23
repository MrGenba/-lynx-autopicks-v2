"""Authenticated, bounded context refresh in a separate worker on the VPS."""
import asyncio,json
from aiohttp import web
from app.basketball_stats import authorized
from app.node_bridge import _kill_process_tree
lock=asyncio.Lock()
async def refresh(request):
    if not authorized(request):return web.json_response({'error':'unauthorized'},status=401)
    if lock.locked():return web.json_response({'status':'already_running'})
    async with lock:
        proc=None
        try:
            proc=await asyncio.create_subprocess_exec('python','-m','basketball.context_capture',stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE,start_new_session=True)
            out,_=await asyncio.wait_for(proc.communicate(),timeout=110)
            result=json.loads(out.decode())
            return web.json_response(result,status=200 if proc.returncode==0 else 502)
        except Exception:
            if proc and proc.returncode is None:_kill_process_tree(proc);await proc.wait()
            return web.json_response({'status':'error','error':'CONTEXT_CAPTURE_FAILED'},status=502)
def register(app):app.router.add_post('/basketball-context/refresh',refresh)
