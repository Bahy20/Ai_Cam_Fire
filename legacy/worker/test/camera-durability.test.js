import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraDO } from '../src/camera-do.js';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { qualifyModelInvestigation } from '../src/investigation.js';
import { createConfirmationRecord } from '../src/incident-store.js';
import worker from '../src/index.js';
import { testInferenceEnvironment } from './test-inference-budget.js';
import { canonicalObservationBatchHash } from '../src/observation-batch.js';

// Re-instantiating CameraDO keeps the actual SQLite checkpoint and D1 databases,
// not its in-memory windows, promises, pins or images.
function backend() {
  const db = new DatabaseSync(':memory:'), eventDb = new DatabaseSync(':memory:');
  for (const name of ['0001_init.sql', '0002_analysis.sql', '0003_event_keys.sql'])
    eventDb.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  let alarmAt = null;
  const storage = {setAlarm: async when => {alarmAt = when;}, deleteAlarm: async () => {alarmAt = null;},
    getAlarm: async () => alarmAt, sql: {exec: (query, ...args) => {
    const stmt = db.prepare(query), rows = stmt.columns().length ? stmt.all(...args) : (stmt.run(...args), []);
    return {toArray: () => rows};
  }}, transactionSync: callback => {
    db.exec('BEGIN IMMEDIATE');
    try {const value = callback(); db.exec('COMMIT'); return value;}
    catch (error) {db.exec('ROLLBACK'); throw error;}
  }, sync: async () => {}};
  const create = (env = {}) => {
    const jobs = [], events = [];
    const state = {storage, blockConcurrencyWhile: fn => Promise.resolve().then(fn),
      waitUntil: promise => jobs.push(promise),
      getWebSockets: () => [{send: raw => events.push(...[JSON.parse(raw)].flat())}]};
    const runtimeEnv = {EVIDENCE_STORAGE: 'pi',
      DB: {prepare: sql => ({bind: (...params) => ({run: async () => eventDb.prepare(sql).run(...params)})})}, ...env};
    const camera = new CameraDO(state, env.AI && env.APP_ENV !== 'production' ?
      testInferenceEnvironment(runtimeEnv) : runtimeEnv);
    const read = async () => {
      const response = await camera.fetch(new Request('https://do/cam'));
      assert.equal(response.status,200); return response.json();
    };
    const feed = async (ts, positive = true) => {
      const response = await camera.fetch(new Request('https://do/cam', {method: 'POST',
        body: JSON.stringify({camera_id: 'cam', ts_ms: ts, frame_wh: [100,80], visibility: 'adequate', camera_motion: false,
          detections: positive ? [{cls: positive==='smoke' ? 'smoke' : 'fire',conf:0.8,bbox_xyxy:[0,0,20,20]}] : []})}));
      return {response, body: await response.json()};
    };
    const settle = async () => {for (let i = 0; i < jobs.length; i++) await jobs[i];};
    return {camera, read, feed, settle, jobs, events};
  };
  return {db, eventDb, storage, create, close: () => {db.close(); eventDb.close();}};
}

test('public ingestion preserves valid Pi camera identities through confirmation, retry and cold restore', async () => {
  for(const cameraId of ['_cam','a'.repeat(81),'_'.repeat(128)]) {
    const store=backend();let active=store.create();
    const env={APP_ENV:'development',DETECTOR_PROVIDER:'edge',CAMERA_DO:{
      idFromName:id=>id,get:id=>{assert.equal(id,cameraId);return {fetch:req=>active.camera.fetch(req)};}}};
    const feed=ts=>worker.fetch(new Request(`https://worker/ingest/camera/${cameraId}`,{method:'POST',
      body:JSON.stringify({camera_id:cameraId,ts_ms:ts,frame_wh:[100,80],visibility:'adequate',camera_motion:false,
        detections:[{cls:'fire',conf:.8,bbox_xyxy:[0,0,20,20]}]})}),env,{});
    try {
      for(let i=0;i<5;i++)assert.equal((await feed(i*1000)).status,200);
      await active.settle();
      assert.equal(active.camera.alert,'confirmed');
      assert.equal((await feed(4000)).status,200);
      const incidentId=active.camera.incidentId;
      active=store.create();
      const response=await worker.fetch(new Request(`https://worker/state/camera/${cameraId}`),env,{});
      assert.equal(response.status,200);
      const state=await response.json();
      assert.equal(state.camera_id,cameraId);assert.equal(state.incident_id,incidentId);assert.equal(state.alert,'confirmed');
      assert.equal(state.ts_ms,4000);assert.equal(state.hits,5);
      assert.equal((await feed(4000)).status,200);
      assert.equal(active.camera.window.length,5);
      const rows=store.eventDb.prepare("SELECT * FROM events WHERE event_kind='confirmation'").all();
      assert.equal(rows.length,1);assert.equal(rows[0].camera_id,cameraId);assert.equal(rows[0].incident_id,incidentId);
      await active.settle();
    } finally {await active.settle();store.close();}
  }
});

test('actual coordinator restores watch and source watermark before serving a new instance', async () => {
  const store = backend(), first = store.create();
  assert.equal((await first.feed(0)).response.status,200);
  assert.equal((await first.feed(1000)).response.status,200);
  assert.equal((await first.read()).alert,'watch');
  const restored = store.create();
  const state = await restored.read();
  assert.equal(state.alert,'watch');
  assert.equal(state.hits,2);
  assert.equal(state.ts_ms,1000);
  assert.equal((await restored.feed(1000)).body.hits,2,'a retried source frame is not new confirmation support after restart');
  assert.equal((await restored.feed(0)).body.hits,2,'older source frames remain stale across restart');
  const persisted = store.db.prepare('SELECT checkpoint_json FROM fire_coordinator_checkpoint').get();
  assert.ok(persisted);
  const serialized = persisted.checkpoint_json;
  for (const forbidden of ['image_b64','jpeg_b64','snap_b64','reviewed_by','INGEST_API_KEY']) assert.equal(serialized.includes(forbidden),false);
  assert.equal(restored.camera.transientSnapshots.size,0);
  store.close();
});

test('a follow-up awaiting Pi evidence survives a coordinator restart', async () => {
  const store = backend();
  try {
    const first = store.create();
    for (let i = 0; i < 5; i++) assert.equal((await first.feed(i * 1000)).response.status, 200);
    await first.settle();
    const session = 'b54ea751-2bb9-41a0-a0cc-3b9b4c5dc7d4';
    first.camera.edgeSessionId = session;
    first.camera.edgeGeneration = 1;
    first.camera.edgeAttemptSequence = 5;
    first.camera.edgeAttemptTs = 4000;
    const prior = first.camera.evidenceState.history.at(-1);
    assert.ok(prior);
    const frame = {...prior, local_ref: {session_id: session, generation: 1, attempt_sequence: 5,
      jpeg_sha256: 'a'.repeat(64)}};
    first.camera.evidenceState.snapshots = [frame];
    await first.camera.enrich(4000, null, 'later_measured_peak');
    assert.equal(first.camera.pendingEvidenceRequest?.status, 'awaiting_images');
    const expectedJob = first.camera.analysisJob;
    const restored = store.create();
    assert.equal(restored.camera.analysisJob, expectedJob);
    assert.equal(restored.camera.pendingEvidenceRequest?.analysis_job_id, expectedJob);
    assert.equal((await restored.read()).analysis_status.pending_evidence, true);
  } finally {store.close();}
});

test('smoke after restart qualification watermark persists the urgent incident and clears the watermark', async () => {
  const store=backend();
  let active=store.create({HANDHELD_PRIORITY_ENABLED:'false'});
  try {
    for(let i=0;i<5;i++) assert.equal((await active.feed(i*1000)).response.status,200);
    await active.settle();
    assert.equal(active.camera.alert,'confirmed');
    active.camera.handheldQualificationRequiredAfterTs=active.camera.lastObservationTs;

    const smoke=await active.feed(5000,'smoke');
    assert.equal(smoke.response.status,200);
    await active.settle();
    assert.equal(active.camera.handheldQualificationRequiredAfterTs,null);
    assert.equal(active.camera.handheldHazardLatchIncidentId,active.camera.incidentId);
    assert.equal((await active.read()).response_priority,'inspect_urgently');

    active=store.create({HANDHELD_PRIORITY_ENABLED:'false'});
    const restored=await active.read();
    assert.equal(restored.alert,'confirmed');
    assert.equal(restored.response_priority,'inspect_urgently');
    assert.equal(active.camera.handheldHazardLatchIncidentId,active.camera.incidentId);
    assert.equal(active.camera.handheldQualificationRequiredAfterTs,null);
  } finally {
    await active.settle();
    store.close();
  }
});

test('a rejected checkpoint cannot broadcast acceptance or retain an uncommitted watermark after restart', async () => {
  const store = backend(), first = store.create();
  try {
    assert.equal((await first.feed(0)).response.status,200);
    const transaction = store.storage.transactionSync;
    let fail = true;
    store.storage.transactionSync = callback => {
      if (fail) {fail=false; throw new Error('injected storage failure');}
      return transaction(callback);
    };
    const rejected = await first.feed(1000);
    assert.equal(rejected.response.status,503);
    assert.equal(first.events.some(event=>event.type==='fire_watch'),false,'no alert is broadcast before its checkpoint commits');
    const restored = store.create();
    assert.equal((await restored.read()).ts_ms,0);
    const retry = await restored.feed(1000);
    assert.equal(retry.response.status,200);
    assert.equal(retry.body.hits,2);
    assert.equal((await restored.read()).alert,'watch');
  } finally {store.close();}
});

test('V2 batch checkpoint, event intent and ACK commit atomically across lost acknowledgements', async () => {
  const store=backend();
  let active=store.create();
  const session='2cf1a098-15d8-45bc-96f1-87f776ec3611';
  const env={APP_ENV:'development',DETECTOR_PROVIDER:'edge',CAMERA_DO:{idFromName:id=>id,get:()=>({fetch:req=>active.camera.fetch(req)})}};
  const call=(path,body)=>worker.fetch(new Request(`http://127.0.0.1/${path}`,{method:'POST',body:JSON.stringify(body)}),env,{});
  try {
    const start=await call('v2/sessions/camera/cam',{protocol_version:2,session_id:session,expected_generation:0});
    assert.equal(start.status,200);
    assert.equal((await start.json()).generation,1);
    const now=Date.now();
    const samples=Array.from({length:5},(_,index)=>({attempt_sequence:index+1,ts_ms:now-1800+index*100,status:'ok',
      frame_wh:[100,80],detections:[{cls:'fire',conf:.8,bbox_xyxy:[10,10,30,30]}],jpeg_sha256:'a'.repeat(64),
      local_image_available:true,visibility:'adequate',camera_motion:false,
      quality:{stability:'stable',blur_score:.1,occlusion:'none'},reason:null}));
    const batch={protocol_version:2,session_id:session,generation:1,batch_sequence:1,clock_mode:'live',payload_hash:'0'.repeat(64),samples};
    batch.payload_hash=await canonicalObservationBatchHash(batch);
    const transaction=store.storage.transactionSync;
    let fail=true;
    store.storage.transactionSync=callback=>{if(fail){fail=false;throw new Error('injected_atomic_batch_failure');}return transaction(callback);};
    const failed=await call('v2/observations/camera/cam',batch);
    assert.equal(failed.status,503);
    assert.equal(active.events.some(event=>event.type==='fire_confirmed'),false);
    assert.equal(store.eventDb.prepare("SELECT COUNT(*) AS count FROM events WHERE event_kind='confirmation'").get().count,0);

    active=store.create();
    const retry=await call('v2/observations/camera/cam',batch);
    assert.equal(retry.status,200);
    const ack=await retry.json();
    assert.equal(ack.final_state.alert,'confirmed');
    assert.equal(active.camera.observationBatchLedger.length,1);
    const saved=JSON.parse(store.db.prepare('SELECT checkpoint_json FROM fire_coordinator_checkpoint').get().checkpoint_json);
    assert.equal(saved.observationBatchLedger[0].payload_hash,batch.payload_hash);
    assert.equal(saved.edgeAttemptSequence,5);
    await active.settle();
    assert.equal(store.eventDb.prepare("SELECT COUNT(*) AS count FROM events WHERE event_kind='confirmation'").get().count,1);

    const duplicate=await call('v2/observations/camera/cam',batch);
    assert.equal(duplicate.status,200);
    assert.equal((await duplicate.json()).idempotent,true);
    assert.equal(store.eventDb.prepare("SELECT COUNT(*) AS count FROM events WHERE event_kind='confirmation'").get().count,1);
  } finally {await active.settle();store.close();}
});

test('a failed transition cannot prune evidence bytes before the metadata commit', async () => {
  const store = backend(), instance=store.create(), deleted=[];
  try {
    for(let i=0;i<24;i++) {
      await instance.camera.storeSnapshot(`snap:${i*1000}`,'AQID');
      instance.camera.snapshotKeys.add(`snap:${i*1000}`);
      assert.equal((await instance.feed(i*1000,false)).response.status,200);
    }
    const remove=instance.camera.deleteSnapshot.bind(instance.camera);
    instance.camera.deleteSnapshot=async key=>{deleted.push(key);return remove(key);};
    await instance.camera.storeSnapshot('snap:24000','AQID');instance.camera.snapshotKeys.add('snap:24000');
    store.storage.transactionSync=()=>{throw new Error('injected checkpoint failure');};
    assert.equal((await instance.feed(24000,false)).response.status,503);
    assert.deepEqual(deleted,[],'cleanup is a post-commit effect, never part of a rejected transition');
  } finally {await instance.settle();store.close();}
});

test('delivery backlog rejects before source mutation while alarms can drain it without resetting the coordinator', async t => {
  t.mock.method(console,'error',()=>{});
  const store=backend();let unavailable=true;
  const instance=store.create({DB:{prepare:sql=>({bind:(...args)=>({run:async()=>{
    if(unavailable)throw new Error('injected D1 outage');
    return store.eventDb.prepare(sql).run(...args);
  }})})}});
  try {
    assert.equal((await instance.feed(0,false)).response.status,200);
    instance.camera.saveCoordinator(Array.from({length:62},(_,i)=>createConfirmationRecord({
      cameraId:'cam',incidentId:`cam:${i}:1`,ts:i,priority:'inspect_urgently'})));
    const rejected=await instance.feed(1000,false);
    assert.equal(rejected.response.status,503);
    assert.equal(rejected.body.error,'incident_event_backlog');
    assert.equal(instance.camera.lastObservationTs,0);
    assert.equal(instance.camera.persistenceFailure,false,'capacity is not corrupt storage and must not disable recovery');
    unavailable=false;
    await instance.settle();
    await instance.camera.alarm();
    assert.equal(instance.camera.journal.pending().length,0);
    assert.equal((await instance.feed(1000,false)).response.status,200);
    assert.equal(instance.camera.lastObservationTs,1000);
  } finally {await instance.settle();store.close();}
});

test('a committed D1 write with lost acknowledgement survives restart and retries from an alarm without another observation', async t => {
  t.mock.method(console,'error',()=>{});
  const store = backend();
  let fail = true, modelCalls = 0;
  const instance = store.create({DB: {prepare: sql => ({bind: (...args) => ({run: async () => {
    store.eventDb.prepare(sql).run(...args);
    if (fail) throw new Error('injected acknowledgement lost');
  }})})}});
  instance.camera.analyzeCause = async () => {modelCalls++; return qualifyModelInvestigation({},[]);};
  try {
    for(let i=0;i<5;i++) assert.equal((await instance.feed(i*1000)).response.status,200);
    await instance.settle();
    const before = store.eventDb.prepare('SELECT * FROM events').all();
    assert.equal(before.length,1);
    assert.equal(modelCalls,0,'AI does not start until the durable confirmation is delivered');
    assert.ok(await store.storage.getAlarm(),'retry must already be durably armed');
    const restored = store.create();
    assert.equal(restored.camera.snapshot().durability_status.analysis_interrupted,true);
    fail=false;
    // The alarm path receives no new frames or client request to rescue delivery.
    await restored.camera.alarm();
    const after = store.eventDb.prepare('SELECT * FROM events').all();
    assert.deepEqual(after,before,'same key and immutable payload must leave exactly one D1 row');
    assert.equal(restored.camera.journal.pending().length,0);
    assert.equal(restored.camera.incidentId,before[0].incident_id);
    assert.equal(restored.camera.alert,'confirmed');
    assert.equal(restored.camera.transientSnapshots.size,0);
    await restored.settle();
  } finally {store.close();}
});

test('cold restore reports an unresolved native inference without replaying images or authorizing another call', async () => {
  const store = backend();
  let release, calls=0;
  const gate = new Promise(resolve => {release=resolve;});
  const env = {VLM_MODEL:'test-model',AI:{run: async () => {calls++; return gate;}}};
  const first = store.create(env);
  const image = Buffer.from([255,216,255,192,0,17,8,0,80,0,100,3,1,17,0,2,17,0,3,17,0,255,217]).toString('base64');
  try {
    for(let i=0;i<5;i++) {
      await first.camera.storeSnapshot(`snap:${i*1000}`,image);
      first.camera.snapshotKeys.add(`snap:${i*1000}`);
      assert.equal((await first.feed(i*1000)).response.status,200);
    }
    for(let attempt=0;attempt<20 && calls===0;attempt++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls,1);
    const restored = store.create(env), state = await restored.read();
    assert.equal(state.durability_status.native_inference_interrupted,true);
    assert.equal(state.analysis_status.native_inference_pending,true);
    assert.equal(restored.camera.transientSnapshots.size,0);
    assert.equal(restored.camera.capturedSnapshotKeys.size,0);
    const result = await restored.camera.analyzeCause({frames:[{frame_id:'frame-4000',ts_ms:4000,
      roles:['recent'],pre_ignition_verified:false,peak_scope:null,frame_wh:[100,80],image_b64:image}]});
    assert.equal(result.vlm_error,'vlm_previous_lifetime_unresolved');
    assert.equal(calls,1,'unknown previous execution is not proof of backend cancellation');
    restored.camera.followupUsed=true; // This durability case exercises the interrupted first inference only.
    assert.equal((await restored.feed(5000)).response.status,200);
    release({response:'{}'});
    await first.settle();
    assert.equal((await restored.read()).ts_ms,5000,'a fenced old finalizer cannot replace the new lifetime checkpoint');
    assert.equal(first.events.filter(e=>e.type==='cause_update').length,0);
    assert.equal(store.eventDb.prepare("SELECT COUNT(*) AS n FROM events WHERE event_kind='analysis'").get().n,0);
    await restored.settle();
  } finally {release({response:'{}'}); await first.settle(); store.close();}
});

test('image-backed recovery fallback checkpoints and persists without poisoning later ingestion', async () => {
  const store=backend();let release,calls=0;
  const gate=new Promise(resolve=>{release=resolve;});
  const env={VLM_MODEL:'test-model',AI:{run:async()=>{calls++;return gate;}}};
  const first=store.create(env);
  const image=Buffer.from([255,216,255,192,0,17,8,0,80,0,100,3,1,17,0,2,17,0,3,17,0,255,217]).toString('base64');
  try {
    for(let i=0;i<5;i++) {
      await first.camera.storeSnapshot(`snap:${i*1000}`,image);first.camera.snapshotKeys.add(`snap:${i*1000}`);
      assert.equal((await first.feed(i*1000)).response.status,200);
    }
    for(let i=0;calls===0&&i<100;i++)await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls,1);
    const restored=store.create(env);
    await restored.camera.storeSnapshot('snap:5000',image);restored.camera.snapshotKeys.add('snap:5000');
    restored.camera.followupUsed=true; // Keep this case focused on interrupted-call fallback recovery.
    assert.equal((await restored.feed(5000)).response.status,200);
    await restored.camera.enrich(5000);
    assert.equal(restored.camera.cause.vlm_error,'vlm_previous_lifetime_unresolved');
    assert.equal(restored.camera.persistenceFailure,false);
    assert.equal((await restored.feed(6000)).response.status,200);
    await restored.settle();
    const third=store.create(env), state=await third.read();
    assert.equal(state.ts_ms,6000);
    assert.equal(state.cause.vlm_error,'vlm_previous_lifetime_unresolved');
    assert.equal(state.durability_status.native_inference_interrupted,true);
    assert.equal(calls,1,'safe fallback must not dispatch another unresolved native operation');
    const row=store.eventDb.prepare("SELECT * FROM events WHERE event_kind='analysis'").get();
    assert.equal(JSON.parse(row.analysis_json).cause.vlm_error,state.cause.vlm_error);
    assert.equal(row.cause,'unknown');
    await third.settle();
  } finally {release({response:'{}'});await first.settle();store.close();}
});

test('smoke and source freshness survive confirmed/cleared restarts without fabricated clearance or duplicate incidents', async () => {
  const store = backend(), first = store.create();
  try {
    for(let i=0;i<5;i++) assert.equal((await first.feed(i*1000)).response.status,200);
    await first.settle();
    const id = first.camera.incidentId;
    assert.equal((await first.feed(5000,'smoke')).response.status,200);
    for(let i=6;i<13;i++) assert.equal((await first.feed(i*1000,false)).response.status,200);
    assert.equal(first.camera.alert,'confirmed','smoke among the last eight is not an empty observation');
    const receipt = first.camera.lastReceiptAtMs;
    const second = store.create(), restored = await second.read();
    assert.equal(restored.alert,'confirmed');
    assert.equal(restored.incident_id,id);
    assert.equal(second.camera.lastReceiptAtMs,receipt,'restore is not a fresh camera receipt');
    assert.equal(restored.analysis_status.active,false);
    assert.equal((await second.feed(13000,false)).response.status,200);
    assert.equal(second.camera.alert,'idle');
    await second.settle();
    const third = store.create();
    assert.equal((await third.read()).alert,'idle');
    assert.equal(third.camera.closedIncidentId,id);
    assert.equal((await third.feed(4000)).body.hits,0);
    assert.equal(third.camera.incidentId,null);
    assert.equal(store.eventDb.prepare("SELECT COUNT(*) AS n FROM events WHERE event_kind='confirmation'").get().n,1);
    await third.settle();
  } finally {store.close();}
});

test('confirmation is durable in actual D1 before investigation starts, even while its promise stalls', async () => {
  const store = backend(), instance = store.create();
  let release, started = false, confirmationBeforeAI = false;
  const gate = new Promise(resolve => {release = resolve;});
  instance.camera.analyzeCause = async () => {
    started = true;
    confirmationBeforeAI = !!store.eventDb.prepare("SELECT * FROM events WHERE event_kind = 'confirmation'").get();
    await gate;
    return qualifyModelInvestigation({}, []);
  };
  try {
    for (let i=0; i<5; i++) assert.equal((await instance.feed(i*1000)).response.status,200);
    // Allow the asynchronous D1 flush/model task to progress without completing AI.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(started,true);
    assert.equal(confirmationBeforeAI,true,'confirmation must not depend on expensive AI finishing or even starting');
    const row = store.eventDb.prepare("SELECT * FROM events WHERE event_kind = 'confirmation'").get();
    assert.equal(row.incident_id,instance.camera.incidentId);
    assert.equal(JSON.parse(row.analysis_json).analysis_status,'pending');
    assert.equal(row.cause,'unknown');
    const checkpoint = JSON.parse(store.db.prepare('SELECT checkpoint_json FROM fire_coordinator_checkpoint').get().checkpoint_json);
    assert.equal(checkpoint.alert,'confirmed');
    assert.equal(checkpoint.incidentId,row.incident_id);
  } finally {release(); await instance.settle(); store.close();}
});

test('restarting a confirmed DO requires a fresh handheld pair beyond the restored observation', async () => {
  const store=backend();
  try {
    const first=store.create();
    for(let i=0;i<5;i++) assert.equal((await first.feed(i*1000)).response.status,200);
    await first.settle();
    assert.equal(first.camera.alert,'confirmed');
    assert.equal(first.camera.handheldQualificationRequiredAfterTs,null);

    const restored=store.create();
    assert.equal(restored.camera.handheldQualificationRequiredAfterTs,4000,
      'a candidate may not reuse frames from before this coordinator lifetime');
    const checkpoint=JSON.parse(store.db.prepare('SELECT checkpoint_json FROM fire_coordinator_checkpoint').get().checkpoint_json);
    assert.equal(checkpoint.handheldQualificationRequiredAfterTs,4000,
      'the restart watermark is immediately durable');
    await restored.settle();
  } finally {store.close();}
});
