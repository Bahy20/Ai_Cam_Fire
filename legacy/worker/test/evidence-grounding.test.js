import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraDO } from '../src/camera-do.js';
import { SCOUT_TEST_MODEL, testInferenceEnvironment } from './test-inference-budget.js';

const jpeg = Buffer.from([255,216,255,192,0,17,8,0,80,0,100,3,1,17,0,2,17,0,3,17,0,255,217]).toString('base64');
function harness(overrides = {}) {
  const events = [], saved = [], background = [], calls = [];
  const camera = new CameraDO({storage: {}, waitUntil: p => background.push(p),
    getWebSockets: () => [{send: text => events.push(...[JSON.parse(text)].flat())}]}, testInferenceEnvironment({
    EVIDENCE_STORAGE: 'pi', VLM_MODEL: SCOUT_TEST_MODEL,
    AI: {run: async (model, input) => {calls.push({model, input}); return {response: '{}'};}},
    DB: {prepare: sql => ({bind: (...args) => {
      const columns=sql.match(/INSERT INTO events \(([^)]+)\)/)[1].split(',').map(s=>s.trim());
      saved.push(Object.fromEntries(columns.map((key,i)=>[key,args[i]])));
      return {run: async () => {}};
    }})},
    ...overrides,
  }));
  async function feed(ts, size = 0, extra = {}) {
    const response = await camera.fetch(new Request('https://do/cam/snapshot', {method: 'POST',
      body: JSON.stringify({ts_ms: ts, snap_b64: jpeg})}));
    assert.equal(response.status, 200);
    return camera.ingest({ts_ms: ts, frame_wh: [100,80], detections: size ? [
      {cls: 'fire', conf: .8, bbox_xyxy: [0,0,size,size]},
    ] : [], ...extra}, 'cam');
  }
  async function confirm() {
    for (const [ts, size] of [[0,0],[1,0],[2,0],[3,10],[4,12],[5,25],[6,14],[7,15]]) await feed(ts, size);
  }
  async function settle() { for (let i=0; i<background.length; i++) await background[i]; }
  return {camera, events, saved, background, calls, feed, confirm, settle};
}

test('actual confirmation sends and saves unique chronological context/onset/measured peak/recent manifest', async () => {
  const h = harness();
  await h.confirm();
  await h.settle();
  const event = h.events.find(e => e.type === 'cause_update');
  assert.ok(event.evidence_manifest, 'cause_update publishes the actual evidence manifest');
  assert.deepEqual(event.evidence_manifest.map(f => f.ts_ms), [0,2,3,4,5,7]);
  assert.deepEqual(event.evidence_manifest.map(f => f.roles), [
    ['early'], ['context_before_onset'], ['onset'], ['context_after_onset'], ['peak'], ['recent'],
  ]);
  assert.equal(event.evidence_manifest[4].peak_scope, 'observed_so_far');
  assert.ok(event.evidence_manifest.every(f => f.pre_ignition_verified === false));
  assert.equal(h.calls[0].input.messages[0].content.filter(p => p.type === 'image_url').length, 6);
  assert.deepEqual(JSON.parse(h.saved[0].analysis_json).evidence_manifest, event.evidence_manifest);
  assert.ok(event.incident_id);
  assert.equal(h.saved[0].incident_id, event.incident_id);
  assert.equal(/snapshot_key|image_b64|local_path/.test(JSON.stringify(event.evidence_manifest)), false);
  assert.equal(h.saved[0].snapshot_key, null);
});

test('all ingress timestamps are idempotent; retired references are pruned without dropping onset anchors', async () => {
  const h = harness();
  await h.confirm(); await h.settle();
  const before = h.camera.window.length;
  await h.feed(7, 30); await h.feed(6, 30);
  assert.equal(h.camera.window.length, before);
  for (let ts=8; ts<180; ts++) await h.feed(ts, 10);
  await h.settle();
  assert.ok(h.camera.transientSnapshots.size <= 24);
  assert.ok(h.camera.snapshotKeys.size <= 24);
  assert.ok(h.camera.evidenceState.snapshots.length <= 24);
  assert.ok(h.camera.evidenceState.history.length <= 120);
  for (const ts of [0,2,3,4,5]) assert.ok(h.camera.transientSnapshots.has(`snap:${ts}`), `anchor ${ts} remains`);
  assert.deepEqual(new Set(h.camera.evidenceState.snapshots.map(f => f.snapshot_key)), h.camera.snapshotKeys);
});


test('rearm clears cause/evidence and a delayed prior job cannot publish into a new incident', async () => {
  let release;
  const pending = new Promise(resolve => {release = resolve;});
  let count = 0;
  const h = harness({AI: {run: async () => ++count === 1 ? pending : {response: '{}'}}});
  await h.confirm();
  const firstId = h.camera.incidentId;
  for (let ts=8; ts<16; ts++) await h.feed(ts, 0);
  assert.equal(h.camera.alert, 'idle');
  assert.equal(h.camera.cause, null);
  assert.deepEqual(h.camera.evidenceManifest, []);
  for (let ts=16; ts<21; ts++) await h.feed(ts, 10);
  assert.equal(h.camera.alert, 'confirmed');
  assert.notEqual(h.camera.incidentId, firstId);
  assert.ok(h.camera.evidenceState.snapshots.every(f => f.ts_ms >= 15));
  release({response: '{"ignition_source":"human"}'});
  await h.settle();
  const causes = h.events.filter(e => e.type === 'cause_update');
  assert.equal(causes.length, 1);
  assert.equal(causes[0].incident_id, h.camera.incidentId);
  assert.ok(causes[0].evidence_manifest.every(f => f.ts_ms >= 15));
});


test('one bounded follow-up waits for a fresh post-confirmation sequence, independent of another peak', async () => {
  let release;
  const pending = new Promise(resolve=>{release=resolve;});
  let calls=0;
  const h=harness({AI:{run:async()=>++calls===1 ? pending : {response:'{}'}}});
  await h.confirm();
  await h.feed(1008,20); await h.feed(2008,20);
  await h.feed(3008,20);
  await h.feed(4008,20);
  assert.equal(h.camera.followupRequested,4008);
  assert.equal(h.camera.followupUsed,false);
  release({response:'{}'});
  await h.settle();
  const events=h.events.filter(e=>e.type==='cause_update');
  assert.equal(events.length,2);
  assert.equal(events[0].ts_ms,7);
  assert.equal(events[0].evidence_manifest.find(f=>f.roles.includes('peak')).ts_ms,5);
  assert.ok(events[1].evidence_manifest.every(f=>f.ts_ms>5 && f.roles.includes('followup_context')));
  assert.ok(events[1].evidence_manifest.at(-1).ts_ms-events[1].evidence_manifest[0].ts_ms>=2000);
  assert.equal(events[1].analysis_reason,'later_scene_evidence');
  await h.feed(5008,40); await h.settle();
  assert.equal(h.events.filter(e=>e.type==='cause_update').length,2,'at most one peak follow-up per incident');
});

test('a finished edge clip does not request a second Scout investigation without a fresh camera receipt', async () => {
  let release;
  const pending = new Promise(resolve => {release = resolve;});
  let calls = 0;
  const h = harness({AI: {run: async () => ++calls === 1 ? pending : {response: '{}'}}});
  await h.confirm();
  await h.feed(1008, 30); await h.feed(2008, 35); await h.feed(3008, 35);
  assert.equal(h.camera.followupRequested,3008);
  h.camera.lastReceiptAtMs = Date.now() - 6_000;
  release({response: '{}'});
  await h.settle();
  assert.equal(calls, 1);
  assert.equal(h.events.filter(event => event.type === 'cause_update').length, 1);
  assert.equal(h.camera.followupRequested, null);
});


test('missing selected images are omitted from AI and saved metadata together, never substituted', async () => {
  const h=harness();
  const read=h.camera.readSnapshot.bind(h.camera);
  h.camera.readSnapshot=async key=>key==='snap:3'||key==='snap:5' ? undefined : read(key);
  await h.confirm(); await h.settle();
  const event=h.events.find(e=>e.type==='cause_update');
  assert.deepEqual(event.evidence_manifest.map(f=>f.ts_ms),[0,2,4,7]);
  assert.ok(event.evidence_manifest.every(f=>!f.roles.includes('onset')&&!f.roles.includes('peak')));
  assert.equal(h.calls[0].input.messages[0].content.filter(p=>p.type==='image_url').length,4);
  const prompt=h.calls[0].input.messages[0].content[0].text;
  assert.ok(!prompt.includes('"frame-3"')&&!prompt.includes('"frame-5"'));
  assert.deepEqual(JSON.parse(h.saved[0].analysis_json).evidence_manifest,event.evidence_manifest);
});

test('a slow image read keeps the frozen confirmation pack protected through 100 later uploads', async () => {
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const h=harness();
  const read=h.camera.readSnapshot.bind(h.camera);
  h.camera.readSnapshot=async key=>{if(key==='snap:3') await pending; return read(key);};
  await h.confirm();
  for(let ts=8;ts<108;ts++) {
    await h.feed(ts,10);
    assert.ok(h.camera.transientSnapshots.size<=24);
    for(const anchor of [0,2,3,4,5,7]) assert.ok(h.camera.transientSnapshots.has(`snap:${anchor}`));
  }
  release(); await h.settle();
  assert.deepEqual(h.events.find(e=>e.type==='cause_update').evidence_manifest.map(f=>f.ts_ms),[0,2,3,4,5,7]);
  assert.equal(h.camera.capturedSnapshotKeys.size,0);
  assert.equal(h.camera.evidenceState.protected_selection,null);
});


test('retried snapshot timestamp cannot overwrite in-flight evidence bytes', async () => {
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const h=harness();
  const read=h.camera.readSnapshot.bind(h.camera);
  h.camera.readSnapshot=async key=>{if(key==='snap:3') await pending; return read(key);};
  await h.confirm();
  const changed=Buffer.from(jpeg,'base64'); changed[12]=2;
  const response=await h.camera.fetch(new Request('https://do/cam/snapshot',{method:'POST',
    body:JSON.stringify({ts_ms:3,snap_b64:changed.toString('base64')})}));
  assert.equal(response.status,200);
  release(); await h.settle();
  assert.ok(h.calls[0].input.messages[0].content.filter(p=>p.type==='image_url')
    .every(p=>p.image_url.url===`data:image/jpeg;base64,${jpeg}`));
});


test('late packets after rearm cannot restart an old evidence lifetime or count as fresh detections', async () => {
  const h=harness(); await h.confirm(); await h.settle();
  for(let ts=8;ts<16;ts++) await h.feed(ts,0);
  assert.equal(h.camera.alert,'idle');
  const window=h.camera.window.length;
  const evidence=structuredClone(h.camera.evidenceState);
  for(const ts of [15,14,7]) {
    const result=await h.feed(ts,40);
    assert.deepEqual(result.published,[]);
    assert.equal(h.camera.window.length,window);
    assert.deepEqual(h.camera.evidenceState,evidence);
  }
});


test('inference completion can release metadata protection without falsely acknowledging an archive', async () => {
  const {createEvidenceState,protectEvidence,releaseEvidence}=await import('../src/evidence.js');
  const protectedState=protectEvidence(createEvidenceState()).state;
  const result=releaseEvidence(protectedState,{completed:true});
  assert.equal(result.state.protected_selection,null);
  assert.deepEqual(result.retired_keys,[]);
  assert.throws(()=>releaseEvidence(protectedState,{completed:false}));
});


test('watch rearm begins a fresh evidence lifetime rather than attributing a later incident to an old candidate', async () => {
  const h=harness();
  await h.feed(0,10); await h.feed(1,10);
  assert.equal(h.camera.alert,'watch');
  for(let ts=2;ts<28;ts++) await h.feed(ts,0);
  assert.equal(h.camera.alert,'idle');
  for(let ts=28;ts<33;ts++) await h.feed(ts,10);
  await h.settle();
  const cause=h.events.find(e=>e.type==='cause_update');
  assert.equal(cause.evidence_manifest.find(f=>f.roles.includes('onset')).ts_ms,28);
  assert.ok(cause.evidence_manifest.every(f=>f.ts_ms>=25));
});


test('repeated incidents while AI is slow keep one running and one latest queued evidence pack', async () => {
  let release, calls=0;
  const pending=new Promise(resolve=>{release=resolve;});
  const h=harness({AI:{run:async()=>++calls===1 ? pending : {response:'{}'}}});
  await h.confirm();
  for(let i=0;calls===0&&i<100;i++) await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,1,'confirmation starts one native investigation');
  let ts=8;
  try {
    for(let incident=0;incident<6;incident++) {
      for(let i=0;i<8;i++) await h.feed(ts++,0);
      for(let i=0;i<5;i++) await h.feed(ts++,10);
      assert.equal(h.camera.alert,'confirmed');
      assert.ok(h.camera.transientSnapshots.size<=24);
      assert.ok(h.camera.capturedSnapshotKeys.size<=12);
      assert.equal(calls,1,'no overlapping native inference requests');
    }
  } finally {release({response:'{}'}); await h.settle();}
  assert.equal(calls,2);
  const causes=h.events.filter(e=>e.type==='cause_update');
  assert.equal(causes.length,1,'discard obsolete jobs, not just their model cause text');
  assert.equal(causes[0].incident_id,h.camera.incidentId);
  assert.equal(h.camera.capturedSnapshotKeys.size,0);
  assert.equal(h.camera.pendingAnalysis,null);
});

test('investigation finishing after fire is no longer detected remains scoped to its closed incident', async () => {
  let release;
  const pending = new Promise(resolve => {release = resolve;});
  const h = harness({AI: {run: async () => pending}});
  await h.confirm();
  const incidentId = h.camera.incidentId;
  for (let ts = 8; ts < 16; ts++) await h.feed(ts, 0);
  assert.equal(h.camera.alert, 'idle');
  release({response: '{}'});
  await h.settle();
  const causes = h.events.filter(event => event.type === 'cause_update');
  assert.equal(causes.length, 1, 'a short incident must not lose its investigation while AI runs');
  assert.equal(causes[0].incident_id, incidentId);
  assert.equal(causes[0].incident_closed, true);
  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0].incident_id, incidentId);
  assert.equal(h.camera.cause, null, 'archived results must not reactivate a detection or become the current cause');
  assert.equal(h.camera.incidentId, null);
});

