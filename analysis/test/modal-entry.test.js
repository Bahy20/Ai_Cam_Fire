import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {snapshotScheduler,MAX_SNAPSHOT_FAILURES,COMMIT_MARKER} from '../src/persistence.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const exists=path=>stat(path).then(()=>true,()=>false);
const turn=()=>new Promise(r=>setImmediate(r));
// Each snapshot call waits until the test settles it.
const manual=(options={})=>{const runs=[];
  return {runs,s:snapshotScheduler({snapshot:()=>{const d=deferred();runs.push(d);return d.promise;},exit:()=>assert.fail('unexpected exit'),log:()=>{},...options})};};

test('timer ticks skip a snapshot that is still running instead of queueing behind it',async()=>{
  const {runs,s}=manual();
  assert.equal(s.tick() instanceof Promise,true);assert.equal(s.tick(),null);assert.equal(s.tick(),null);assert.equal(runs.length,1);
  runs[0].resolve();await s.idle();assert.equal(runs.length,1,'skipped ticks are not replayed');
  s.tick();assert.equal(runs.length,2);runs[1].resolve();await s.idle();
});
test('four consecutive snapshot failures are logged without exiting; the fifth exits',async()=>{
  assert.equal(MAX_SNAPSHOT_FAILURES,5);const exits=[],logged=[];
  const s=snapshotScheduler({snapshot:async()=>{throw new Error('volume_unavailable');},exit:code=>exits.push(code),log:(...a)=>logged.push(a.join(' '))});
  for(let i=0;i<4;i++)await s.tick();
  assert.deepEqual(exits,[]);assert.equal(s.failures,4);assert.equal(logged.length,4);assert.match(logged[3],/4\/5.*volume_unavailable/);
  await s.tick();assert.deepEqual(exits,[1]);
});
test('a successful snapshot resets the consecutive failure count',async()=>{
  let fail=true;const exits=[];
  const s=snapshotScheduler({snapshot:async()=>{if(fail)throw new Error('volume_unavailable');},exit:code=>exits.push(code),log:()=>{}});
  for(let i=0;i<4;i++)await s.tick();
  fail=false;await s.tick();assert.equal(s.failures,0);
  fail=true;for(let i=0;i<4;i++)await s.tick();assert.deepEqual(exits,[],'eight failures around a success are not five in a row');
  await s.critical();assert.deepEqual(exits,[1],'critical saves count toward the same run of failures');
});
test('critical requests during an in-flight save trigger exactly one follow-up save, then the commit marker',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fire-persist-')),marker=join(dir,COMMIT_MARKER);const {runs,s}=manual({marker});
  try{
    s.tick();s.critical();s.tick();s.critical();s.critical();assert.equal(runs.length,1);
    runs[0].resolve();while(runs.length<2)await turn();
    assert.equal(await exists(marker),false,'the periodic save started before the change, so it requests no commit');
    runs[1].resolve();await s.idle();
    assert.equal(runs.length,2,'one follow-up covers every request made during the run');
    assert.equal(await exists(marker),true);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('the commit marker is written only after a critical save succeeds',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fire-marker-')),marker=join(dir,COMMIT_MARKER);let fail=false;
  const s=snapshotScheduler({snapshot:async()=>{if(fail)throw new Error('disk_full');},marker,exit:()=>{},log:()=>{}});
  try{
    await s.tick();assert.equal(await exists(marker),false,'periodic saves keep the periodic commit cadence');
    fail=true;await s.critical();assert.equal(await exists(marker),false,'a failed save requests no commit');
    const {runs,s:pending}=manual({marker});pending.critical();await turn();
    assert.equal(await exists(marker),false,'no commit request before the snapshot completes');
    runs[0].resolve();await pending.idle();assert.equal(await exists(marker),true);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('shutdown flush waits for the running save, holds the guard and reports its own failure',async()=>{
  const {runs,s}=manual();
  s.tick();const flushed=s.flush();await turn();assert.equal(runs.length,1,'no overlapping snapshot');
  runs[0].resolve();while(runs.length<2)await turn();
  assert.equal(s.tick(),null,'ticks skip the final save');assert.equal(runs.length,2);
  runs[1].reject(new Error('final_failed'));await assert.rejects(flushed,/final_failed/);
});
test('a failed critical save leaves the commit request pending until the next save succeeds, even a periodic one',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fire-pending-')),marker=join(dir,COMMIT_MARKER);let fail=true;
  const s=snapshotScheduler({snapshot:async()=>{if(fail)throw new Error('disk_full');},marker,exit:()=>{},log:()=>{}});
  try{
    await s.critical();await s.tick();assert.equal(await exists(marker),false,'no commit request while saves fail');
    fail=false;await s.tick();assert.equal(await exists(marker),true,'the first successful save carries the pending request');
    await rm(marker);await s.tick();assert.equal(await exists(marker),false,'one request per critical change');
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('a critical request during the shutdown save gets one follow-up save before flush resolves',async()=>{
  const {runs,s}=manual();let flushed=false;
  const done=s.flush().then(()=>{flushed=true;});await turn();assert.equal(runs.length,1);
  s.critical();assert.equal(runs.length,1,'no overlapping snapshot');
  runs[0].resolve();for(let i=0;i<20&&runs.length<2;i++)await turn();
  assert.equal(runs.length,2,'the request gets its own save');assert.equal(flushed,false,'flush waits for the follow-up');assert.equal(s.tick(),null,'ticks still skip');
  runs[1].resolve();await done;assert.equal(runs.length,2);
});
