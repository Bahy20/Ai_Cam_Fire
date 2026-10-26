import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CameraDO } from '../src/camera-do.js';
import { deploymentConfigErrors } from '../src/index.js';
import { testInferenceEnvironment } from './test-inference-budget.js';

const config = name => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
  .replace(/("(?:\\.|[^"\\])*")|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, (match, quoted) => quoted ?? ''));

test('all deployment profiles archive on Pi without any R2 binding', () => {
  const cloud = config('wrangler.jsonc');
  for (const c of [cloud, cloud.env.production, config('wrangler.dev.jsonc'), config('wrangler.ai-dev.jsonc')]) {
    assert.equal(c.vars.EVIDENCE_STORAGE, 'pi');
    assert.equal(c.vars.CAMERA_CONTEXTS_JSON, '{}', 'reviewed context is explicit operator configuration, empty by default');
    assert.equal(c.r2_buckets, undefined, 'no billing-gated R2 provisioning needed');
    if (c.vars.APP_ENV === 'production') assert.deepEqual(deploymentConfigErrors(c), []);
  }
});

test('Pi profile uses only a bounded in-memory cloud image buffer, never durable cloud images', async () => {
  const jpeg = Buffer.from([255,216,255,192,0,17,8,0,80,0,100,3,1,17,0,2,17,0,3,17,0,255,217]).toString('base64');
  const forbidden = async () => assert.fail('Pi image archival must not write/read durable cloud image storage');
  const c = new CameraDO({storage: {put: forbidden, get: forbidden, list: forbidden, delete: forbidden},
    getWebSockets: () => []}, {EVIDENCE_STORAGE: 'pi'});
  for (let ts = 0; ts < 30; ts++) {
    const response = await c.fetch(new Request('https://do/cam/snapshot', {method: 'POST',
      body: JSON.stringify({ts_ms: ts, snap_b64: jpeg})}));
    assert.equal(response.status, 200);
  }
  assert.equal(c.transientSnapshots.size, 24);
  assert.equal(c.transientSnapshots.has('snap:0'), false);
  assert.equal(c.transientSnapshots.get('snap:29'), jpeg);
});

test('Pi archival profile still investigates and persists with null cloud key, never claiming verified local storage', async () => {
  const events = [], saved = [], deleted = [];
  let aiCalls = 0;
  const camera = new CameraDO({ storage: {
    get: async () => 'AQID', delete: async key => deleted.push(key),
  }, getWebSockets: () => [{send: text => events.push(JSON.parse(text))}] }, testInferenceEnvironment({
    EVIDENCE_STORAGE: 'pi', VLM_PROVIDER: 'workers_ai', VLM_MODEL: 'test-model',
    AI: {run: async () => { aiCalls++; return {response: '{}'}; }},
    SNAPSHOTS: {put: async () => assert.fail('a stale R2 binding must not be used')},
    DB: {prepare: sql => ({bind: (...args) => {
      const columns=sql.match(/INSERT INTO events \(([^)]+)\)/)[1].split(',').map(s=>s.trim());
      saved.push(Object.fromEntries(columns.map((key,i)=>[key,args[i]])));
      return {run: async () => {}};
    }})},
  }));
  camera.cameraId = 'cam';
  await camera.storeSnapshot('snap:1', 'AQID');
  await camera.storeSnapshot('snap:2', 'AQID');
  for(const ts of [1,2]) {
    camera.snapshotKeys.add(`snap:${ts}`);
    camera.ingest({ts_ms:ts,frame_wh:[100,80],detections:[]},'cam');
  }
  await camera.enrich(2);
  assert.equal(aiCalls, 1);
  const event = events.at(-1);
  assert.equal(event.cause.source, 'workers_ai');
  assert.equal(event.snapshot_key, undefined);
  assert.equal(event.snapshot_archive, undefined);
  assert.equal(event.evidence_location, 'pi');
  assert.equal(event.edge_archive_verified, false);
  assert.equal(saved[0].snapshot_key, null);
  assert.deepEqual(deleted, [], 'no durable cloud image writes/deletes');
  assert.equal(camera.transientSnapshots.size, 2);
});
