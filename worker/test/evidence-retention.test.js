import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraDO } from '../src/camera-do.js';
import { testInferenceEnvironment } from './test-inference-budget.js';

// Header-only JPEG fixture: these tests exercise storage, not pixel decoding.
const jpeg = Buffer.from([255, 216, 255, 192, 0, 17, 8, 0, 80, 0, 100, 3,
  1, 17, 0, 2, 17, 0, 3, 17, 0, 255, 217]).toString('base64');
const model = '@cf/meta/llama-4-scout-17b-16e-instruct';
const post = (path, body) => new Request(`https://do/${path}`, {method: 'POST', body: JSON.stringify(body)});
function harness(env = {}, data = new Map()) {
  const events = [], operations = [], background = [];
  const state = {
    storage: {
      put: async (key, value) => { operations.push(['put', key]); data.set(key, value); },
      get: async key => { operations.push(['get', key]); return data.get(key); },
      delete: async key => { operations.push(['delete', key]); return data.delete(key); },
      list: async ({prefix = '', startAfter, limit = 1000} = {}) => new Map([...data]
        .filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter))
        .sort(([a], [b]) => a.localeCompare(b)).slice(0, limit)),
    },
    waitUntil(promise) { background.push(promise); },
    getWebSockets: () => [{send: text => events.push(JSON.parse(text))}],
  };
  const camera = new CameraDO(state, testInferenceEnvironment({
    VLM_PROVIDER: 'workers_ai', VLM_MODEL: model, AI: {run: async () => ({response: '{}'})},
    DB: {prepare: () => ({bind: () => ({run: async () => {}})})}, ...env,
  }));
  const snapshot = async ts => {
    const response = await camera.fetch(post('cam/snapshot', {ts_ms: ts, snap_b64: jpeg}));
    assert.equal(response.status, 200);
  };
  return {camera, state, data, operations, events, background, snapshot};
}

test('snapshot entry bounds persisted evidence to the numeric newest 24 across restart, without deleting unrelated keys', async () => {
  const h = harness();
  h.data.set('incident:other', 'keep');
  for (let ts = 0; ts < 80; ts++) {
    await h.snapshot(ts);
    assert.ok([...h.data.keys()].filter(key => key.startsWith('snap:')).length <= 24);
  }
  assert.deepEqual([...h.data.keys()].filter(key => key.startsWith('snap:')).sort((a,b) => +a.slice(5) - +b.slice(5)),
    Array.from({length: 24}, (_, i) => `snap:${56 + i}`));
  const restored = harness({}, h.data);
  await restored.snapshot(80);
  assert.equal(h.data.has('snap:56'), false);
  assert.equal(h.data.has('snap:80'), true);
  assert.equal(h.data.get('incident:other'), 'keep');
  assert.equal(h.data.size, 25);
});

test('actual confirmation registers enrichment with DurableObjectState.waitUntil', async () => {
  const h = harness();
  for (let ts = 1; ts <= 5; ts++) {
    await h.snapshot(ts);
    h.camera.ingest({ts_ms: ts, frame_wh: [100, 80], detections: [
      {cls: 'fire', conf: 0.8, bbox_xyxy: [0, 0, 10, 10]},
    ]}, 'cam');
  }
  assert.equal(h.camera.alert, 'confirmed');
  assert.equal(h.background.length, 1, 'runtime owns the enrichment promise');
  await Promise.all(h.background);
  const cause = h.events.flat().find(event => event.type === 'cause_update');
  assert.equal(cause.cause.source, 'workers_ai');
  assert.equal(cause.cause.model, model);
});

test('obsolete R2 bindings are never called or advertised as successful Pi archival', async () => {
  const h=harness({EVIDENCE_STORAGE:'pi', SNAPSHOTS:{put:async()=>assert.fail('no cloud image archive')}});
  for(let ts=1;ts<=5;ts++) {
    await h.snapshot(ts);
    h.camera.ingest({ts_ms:ts,frame_wh:[100,80],detections:[{cls:'fire',conf:.8,bbox_xyxy:[0,0,10,10]}]},'cam');
  }
  await Promise.all(h.background);
  const event=h.events.flat().find(e=>e.type==='cause_update');
  assert.equal(event.snapshot_key,undefined);
  assert.equal(event.snapshot_archive,undefined);
  assert.equal(event.evidence_location,'pi');
  assert.equal(event.edge_archive_verified,false);
});

test('snapshot storage errors never produce a stored-success response', async () => {
  const h=harness();
  h.state.storage.put=async()=>{throw new Error('storage unavailable');};
  await assert.rejects(h.camera.fetch(post('cam/snapshot',{ts_ms:1,snap_b64:jpeg})),/storage unavailable/);
  assert.equal(h.camera.snapshotKeys.size,0);
});

