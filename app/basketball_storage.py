"""Private VPS database health and bounded daily backups on a persistent mount."""
import asyncio,hashlib,json,os,re,shutil,time
from datetime import datetime,timezone
from pathlib import Path
from urllib.parse import urlsplit,unquote
import asyncpg
from aiohttp import web
from app.basketball_stats import authorized

ROOT=Path('/app/basketball-data')
lock=asyncio.Lock()

async def maintain(request):
    if not authorized(request):return web.json_response({'error':'unauthorized'},status=401)
    if not os.environ.get('BASKETBALL_DATABASE_URL'):return web.json_response({'status':'not_configured'},status=503)
    if not os.path.ismount(ROOT):return web.json_response({'status':'error','error':'PERSISTENT_VOLUME_REQUIRED'},status=503)
    if lock.locked():return web.json_response({'status':'running'})
    async with lock:
        try:
            disk=shutil.disk_usage(ROOT)
            if disk.free<2*1024**3:return web.json_response({'status':'critical','error':'LOW_DISK_SPACE','disk_free_bytes':disk.free},status=503)
            backup=ROOT/'backups';backup.mkdir(exist_ok=True)
            date=datetime.now(timezone.utc).strftime('%Y-%m-%d');target=backup/f'basketball-{date}.dump';receipt=target.with_suffix('.json')
            made=False
            if not target.exists() or not receipt.exists():
                parsed=urlsplit(os.environ['BASKETBALL_DATABASE_URL']);env={**os.environ,'PGHOST':parsed.hostname,'PGPORT':str(parsed.port or 5432),'PGUSER':unquote(parsed.username),'PGPASSWORD':unquote(parsed.password),'PGDATABASE':parsed.path.lstrip('/')}
                if env['PGDATABASE']!='basketball':raise RuntimeError('WRONG_DATABASE')
                temporary=target.with_suffix('.partial');proc=await asyncio.create_subprocess_exec('pg_dump','--format=custom','--compress=6','--file',str(temporary),env=env,stdout=asyncio.subprocess.DEVNULL,stderr=asyncio.subprocess.PIPE)
                try:await asyncio.wait_for(proc.communicate(),180)
                except asyncio.TimeoutError:proc.kill();await proc.wait();raise RuntimeError('BACKUP_TIMEOUT')
                if proc.returncode or not temporary.exists() or temporary.stat().st_size<1024:raise RuntimeError('BACKUP_FAILED')
                check=await asyncio.create_subprocess_exec('pg_restore','--list',str(temporary),stdout=asyncio.subprocess.DEVNULL,stderr=asyncio.subprocess.DEVNULL)
                if await check.wait():raise RuntimeError('BACKUP_CONTENTS_INVALID')
                temporary.replace(target);sha=hashlib.sha256(target.read_bytes()).hexdigest()
                receipt.write_text(json.dumps({'created_at':datetime.now(timezone.utc).isoformat(),'bytes':target.stat().st_size,'sha256':sha,'database':'basketball'}));made=True
                # Only our known backup names, only after this day's backup is verified.
                for old in backup.iterdir():
                    if re.fullmatch(r'basketball-\d{4}-\d{2}-\d{2}\.(dump|json)',old.name) and old!=target and old!=receipt and time.time()-old.stat().st_mtime>7*86400:old.unlink()
            connection=await asyncpg.connect(os.environ['BASKETBALL_DATABASE_URL'],timeout=10)
            try:db_bytes=await connection.fetchval('select pg_database_size(current_database())')
            finally:await connection.close()
            data=json.loads(receipt.read_text());used=(disk.total-disk.free)/disk.total
            return web.json_response({'status':'attention' if used>=.8 or db_bytes>=10*1024**3 else 'healthy','storage':'VPS_POSTGRES_BASKETBALL','database_bytes':db_bytes,'disk_total_bytes':disk.total,'disk_free_bytes':disk.free,'disk_used_fraction':used,'backup':data,'backup_created':made,'backup_retention_days':7,'backup_location':'PERSISTENT_VPS_VOLUME','offsite_backup':False})
        except Exception as error:
            code=str(error) if re.fullmatch('[A-Z_]+',str(error)) else 'STORAGE_CHECK_FAILED'
            return web.json_response({'status':'error','error':code},status=503)

def register(app):app.router.add_post('/basketball-storage/maintain',maintain)
