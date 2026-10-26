import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraDO } from '../src/camera-do.js';

async function workerHarness() {
  const { default: worker } = await import('../src/index.js');
  const h = harness();
  const dispatches = [];
  const env = { APP_ENV: 'development', DETECTOR_PROVIDER: 'edge', CAMERA_DO: { idFromName: name => name, get: name => ({ fetch: request => {
    dispatches.push({name, url: request.url});
    return h.camera.fetch(request);
  }}) }};
  return { ...h, dispatches, env, run: (path, body, headers) => worker.fetch(post(path, body, headers), env, {}) };
}

function harness() {
  const writes = [];
  const data = new Map();
  const camera = new CameraDO({
    storage: { put: async (key, value) => { writes.push(key); data.set(key, value); },
      get: async key => data.get(key), delete: async key => data.delete(key) },
    getWebSockets: () => [],
  }, {});
  return { camera, writes, data };
}
// Header fixture for bounded image validation; not a pixel-decode/model test.
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 80, 0, 100, 3,
  1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xd9]).toString('base64');

function observation(extra = {}) {
  return { camera_id: 'route', ts_ms: 1000, frame_wh: [100, 80], detections: [], ...extra };
}
function post(path, body, headers = {}) {
  return new Request(`https://do/${path}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers });
}

test('route identity is authoritative through Worker and DO and mismatches cannot mutate state', async () => {
  const h = await workerHarness();
  const mismatch = await h.run('ingest/camera/route', observation({camera_id: 'forged'}));
  assert.equal(mismatch.status, 400);
  assert.equal((await h.run('ingest/camera/route', {camera_id: 'forged'})).status, 400);
  assert.equal(h.camera.cameraId, null);
  assert.equal(h.camera.window.length, 0);
  const accepted = await h.run('ingest/camera/route', observation({camera_id: undefined,
    detections: [{cls: 'fire', conf: 0.9, bbox_xyxy: [-1, 0, 10, 10], area_px: 90000}]}));
  assert.equal(accepted.status, 200);
  assert.equal(h.camera.cameraId, 'route');
  assert.equal(h.camera.window[0].area, 100);
  assert.deepEqual(h.camera.window[0].dets[0].bbox_xyxy, [0, 0, 10, 10]);
  const other = await h.camera.fetch(post('other', observation({camera_id: 'other'})));
  assert.equal(other.status, 400);
  assert.equal(h.camera.cameraId, 'route');
  assert.equal(h.camera.window.length, 1);
});

test('actual DO handles malformed JSON and bounds streamed bytes without trusting Content-Length', async () => {
  const h = await workerHarness();
  for (const body of ['{bad', '', '{"ts_ms":NaN}']) {
    assert.equal((await h.run('ingest/camera/route', body)).status, 400);
  }
  let cancelled = false;
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024)); },
    cancel() { cancelled = true; } });
  const request = new Request('https://do/route', {method: 'POST', body: stream, duplex: 'half', headers: {'content-length': '1'}});
  assert.equal((await h.camera.fetch(request)).status, 413);
  assert.equal(cancelled, true);
  assert.equal(h.camera.window.length, 0);
  assert.deepEqual(h.writes, []);
});

test('observation resource limits apply before normalization and state changes', async () => {
  const h = await workerHarness();
  const box = {cls: 'fire', conf: 0.3, bbox_xyxy: [0, 0, 2, 2]};
  for (const input of [observation({detections: Array(257).fill(box)}), observation({frame_wh: [8193, 1]}),
    observation({frame_wh: [5000, 5000]})]) {
    assert.equal((await h.run('ingest/camera/route', input)).status, 413);
    assert.equal(h.camera.window.length, 0);
  }
});

test('snapshot DO entry validates bounded JSON, identity, timestamp and image before storage', async () => {
  const {camera, writes, data} = harness();
  for (const [input, status] of [['{bad', 400], [null, 400], [{ts_ms: -1, snap_b64: jpeg}, 422],
    [{ts_ms: 1000, snap_b64: 'AQID'}, 422], [{ts_ms: 1000, snap_b64: jpeg, camera_id: 'other'}, 400],
    [{ts_ms: 1000, snap_b64: ['a', 'b']}, 400], [' '.repeat(6 * 1024 * 1024 + 1), 413]]) {
    assert.equal((await camera.fetch(post('route/snapshot', input))).status, status);
    assert.deepEqual(writes, []);
  }
  assert.equal((await camera.fetch(post('route/snapshot', {ts_ms: 1000, snap_b64: jpeg}))).status, 200);
  assert.equal(data.get('snap:1000'), jpeg);
  await camera.fetch(post('route', observation()));
  assert.equal((await camera.fetch(post('other/snapshot', {ts_ms: 1001, snap_b64: jpeg}))).status, 400);
  assert.deepEqual(writes, ['snap:1000']);
});

test('persistence-compatible camera/time bounds reject before state or image mutation', async () => {
  const {camera,writes}=harness();
  const oversized='a'.repeat(129);
  assert.equal((await camera.fetch(post(oversized,observation({camera_id:oversized})))).status,400);
  assert.equal((await camera.fetch(post('route',observation({ts_ms:8640000000000001})))).status,422);
  assert.equal((await camera.fetch(post('route/snapshot',{ts_ms:8640000000000001,snap_b64:jpeg}))).status,422);
  assert.equal(camera.cameraId,null);
  assert.equal(camera.window.length,0);
  assert.deepEqual(writes,[]);
  const id='_'.repeat(128);
  assert.equal((await camera.fetch(post(id,observation({camera_id:id})))).status,200);
  assert.equal(camera.cameraId,id,'a valid existing Pi identity must not be normalized');
});

test('actual DO rejects invalid observations atomically with normalizer HTTP statuses', async () => {
  const { camera, writes } = harness();
  for (const [input, status] of [[null, 400], [[], 400], [observation({frame_wh: undefined}), 422],
    [observation({error: 'jpeg_decode_failed'}), 422],
    [observation({detections: [{cls: 'fire', conf: 2, bbox_xyxy: [0, 0, 10, 10]}]}), 422]]) {
    const response = await camera.fetch(post('route', input));
    assert.equal(response.status, status);
    assert.equal(camera.window.length, 0);
    assert.equal(camera.cameraId, null);
    assert.equal(camera.alert, 'idle');
    assert.deepEqual(writes, []);
  }
});
