'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {TASKS,plan,recovered,targetFor,runSupervisor}=require('../basketball/supervisor');
const now=new Date('2026-10-23T15:00:00Z');
const healthy=()=>Object.values(TASKS).flatMap(r=>['NBA','WNBA'].map(league=>({league,component:r.component,status:'healthy',checked_at:now.toISOString()})));
const games=[{league:'NBA',status:'scheduled',starts_at:'2026-10-23T20:00:00Z'}];
test('supervisor detects stale work without retrying absent markets or active leases',()=>{
 const s=healthy().map(s=>s.component==='props'?{...s,checked_at:'2026-10-23T14:00:00Z'}:s);
 const r=plan(s,games,[{name:'props',expires_at:'2026-10-23T15:10:00Z'}],now);
 assert.equal(r.issues.length,1);assert.equal(r.issues[0].task,'props');assert.equal(r.issues[0].locked,true);assert.equal(r.issues[0].affected.length,1);
});
test('supervisor respects API cooldown and resumes a previous day review afterwards',()=>{
 const s=healthy().map(s=>s.component==='research'?{...s,status:'attention',checked_at:'2026-10-22T15:00:00Z',detail:{review:'RATE_LIMITED'}}:s);
 const cooldown={league:'ALL',component:'ai_access',detail:{retry_at:'2026-10-23T16:00:00Z'}};
 assert.equal(plan([...s,cooldown],games,[],now).blocked[0].task,'research');
 assert.equal(plan(s,games,[],now).issues[0].task,'research');
});
test('webhook acceptance is not proof of recovery; a newer healthy checkpoint is needed',()=>{
 const action={requested_at:now.toISOString(),evidence:{affected:[{league:'NBA',component:'analysis'}]}};
 assert.equal(recovered(action,healthy()),false);
 assert.equal(recovered(action,[{league:'NBA',component:'analysis',status:'healthy',checked_at:'2026-10-23T15:01:00Z'}]),true);
 assert.equal(recovered(action,[{league:'NBA',component:'analysis',status:'error',checked_at:'2026-10-23T15:01:00Z'}]),false);
});
test('recovery tools cannot dispatch arbitrary targets',()=>{
 assert.throws(()=>targetFor('shell',{}));assert.throws(()=>targetFor('analysis',{analysis:{webhookPath:'https://other.test',webhookToken:'a'.repeat(64)}}));
 assert.ok(targetFor('analysis',{analysis:{webhookPath:'basketball-analysis-12345678-1234-1234-1234-123456789abc',webhookToken:'a'.repeat(64)}}));
});
test('explicit source access denial stops recovery dispatches',()=>{
 const s=healthy().map(s=>s.component==='props'?{...s,status:'source_error'}:s);
 s.push({league:'ALL',component:'props_access',status:'blocked'});
 const r=plan(s,games,[],now);assert.equal(r.issues.length,0);assert.deepEqual(r.blocked,[{task:'props',reason:'SOURCE_ACCESS_DENIED'}]);
});
test('persistent claim prevents duplicate recovery across process restarts',async()=>{
 let claimed=false,dispatches=0;const writes=[];
 const states=healthy().map(s=>s.component==='analysis'&&s.league==='NBA'?{...s,status:'error'}:s);
 const ctx={now,supervisorTargets:{analysis:{webhookPath:'basketball-analysis-12345678-1234-1234-1234-123456789abc',webhookToken:'a'.repeat(64)}},http:async()=>{dispatches++;return {status:200};},rest:async(p,m,b)=>{
  if(p==='bk_state?select=league,component,status,checked_at,detail')return states;
  if(p.startsWith('bk_games?'))return games;if(p.startsWith('bk_locks?')||p.startsWith('bk_agent_actions?')||p.startsWith('bk_state?league='))return [];
  if(p==='rpc/bk_agent_claim'){if(claimed)return null;claimed=true;return 'action';}
  if(p==='rpc/bk_claim_notification')return false;writes.push({p,b});return true;
 }};
 await runSupervisor(ctx);await runSupervisor({...ctx});assert.equal(dispatches,1);
 assert.ok(writes.some(w=>w.p==='rpc/bk_agent_finish'&&w.b.p_status==='requested'));
 assert.ok(!writes.some(w=>w.b?.p_status==='recovered'));
});
