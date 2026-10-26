import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraDO, SNAPSHOT_LIMITS } from '../src/camera-do.js';

const makeCamera = env => new CameraDO({storage: {}, getWebSockets: () => []}, {
  EVIDENCE_STORAGE: 'pi', DB: {prepare: () => ({bind: () => ({run: async () => {}})})}, ...env,
});
const frame = (ts, extra = {}) => ({ts_ms: ts, frame_wh: [100,80],
  visibility: 'adequate', camera_motion: false,
  detections: [{cls: 'fire', conf: 0.8, bbox_xyxy: [0,0,20,20]}], ...extra});

test('widely separated observations cannot accumulate confirmation support; a gap never clears an already confirmed incident', () => {
  const camera = makeCamera();
  for (let i = 0; i < 5; i++) camera.ingest(frame(i * 10000), 'cam');
  assert.notEqual(camera.alert, 'confirmed');
  assert.equal(camera.window.length, 1);
  for (let i = 1; i <= 4; i++) camera.ingest(frame(40000 + i * 1000), 'cam');
  assert.equal(camera.alert, 'confirmed');
  camera.ingest(frame(100000), 'cam');
  assert.equal(camera.alert, 'confirmed', 'missing time is not clearance or a negative observation');
  assert.equal(camera.window.length, 1);
});

test('after a source gap a confirmed incident needs eight actual consecutive negative observations to clear', () => {
  const camera = makeCamera();
  for (let i = 0; i < 5; i++) camera.ingest(frame(i * 1000), 'cam');
  assert.equal(camera.alert, 'confirmed');
  const incidentId = camera.incidentId;
  for (let i = 0; i < 7; i++) {
    const result = camera.ingest(frame(10000 + i * 1000, {detections: []}), 'cam');
    assert.equal(result.alert, 'confirmed', `${i + 1} observed negatives cannot clear an incident`);
    assert.equal(camera.incidentId, incidentId);
    assert.equal(result.published.includes('fire_cleared'), false);
  }
  const cleared = camera.ingest(frame(17000, {detections: []}), 'cam');
  assert.equal(cleared.alert, 'idle');
  assert.equal(cleared.published.filter(type => type === 'fire_cleared').length, 1);
  assert.equal(camera.incidentId, null);
  assert.equal(camera.closedIncidentId, incidentId);
});

test('a detection interrupts clearance support and ordinary clearing still needs eight consecutive negatives', () => {
  const camera = makeCamera();
  for (let i = 0; i < 5; i++) camera.ingest(frame(i * 1000), 'cam');
  for (let i = 5; i < 12; i++) camera.ingest(frame(i * 1000, {detections: []}), 'cam');
  assert.equal(camera.alert, 'confirmed');
  camera.ingest(frame(12000), 'cam');
  for (let i = 13; i < 20; i++) {
    camera.ingest(frame(i * 1000, {detections: []}), 'cam');
    assert.equal(camera.alert, 'confirmed');
  }
  assert.equal(camera.ingest(frame(20000, {detections: []}), 'cam').alert, 'idle');
});

test('a gap interrupts a negative run while duplicate and delayed source observations do not advance clearance', () => {
  const camera = makeCamera();
  for (let i = 0; i < 5; i++) camera.ingest(frame(i * 1000), 'cam');
  for (let i = 5; i < 12; i++) camera.ingest(frame(i * 1000, {detections: []}), 'cam');
  const duplicate = camera.ingest(frame(11000, {detections: []}), 'cam');
  const delayed = camera.ingest(frame(10500, {detections: []}), 'cam');
  assert.equal(duplicate.alert, 'confirmed');
  assert.deepEqual(duplicate.published, []);
  assert.equal(delayed.alert, 'confirmed');
  assert.deepEqual(delayed.published, []);
  for (let i = 0; i < 7; i++) {
    camera.ingest(frame(14001 + i * 1000, {detections: []}), 'cam');
    assert.equal(camera.alert, 'confirmed', 'a gap discards the preceding negative run');
  }
  assert.equal(camera.ingest(frame(21001, {detections: []}), 'cam').alert, 'idle');
});

test('observations exactly two seconds apart maintain clearance continuity', () => {
  const camera = makeCamera();
  for (let i = 0; i < 5; i++) camera.ingest(frame(i * 1000), 'cam');
  for (let i = 1; i <= 7; i++) {
    camera.ingest(frame(4000 + i * 2000, {detections: []}), 'cam');
    assert.equal(camera.alert, 'confirmed');
  }
  assert.equal(camera.ingest(frame(20000, {detections: []}), 'cam').alert, 'idle');
});

test('receipt freshness expires monitoring without rewriting event time or claiming extinction', t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const camera = makeCamera();
  camera.ingest(frame(100000, {detections: []}), 'cam');
  assert.equal(camera.snapshot().response_priority, 'monitor', 'source time is independent of server receipt time');
  now = 6001;
  const stale = camera.snapshot();
  assert.equal(stale.response_priority, 'inspect_urgently');
  assert.equal(stale.evidence_current, false);
  assert.equal(stale.visual_activity, 'unknown');
  assert.equal(stale.ts_ms, 100000);
  assert.equal(stale.alert, 'idle');
  assert.equal(stale.hazard_level, 'unknown');
});

test('one oversized inference image is rejected before transient buffer mutation', async () => {
  const camera = makeCamera();
  await assert.rejects(camera.storeSnapshot('snap:1', 'A'.repeat(512 * 1024 + 4)),
    error => error.status === 413 && error.message === 'snapshot_image_budget_exceeded');
  assert.equal(camera.transientSnapshots.size, 0);
});

test('aggregate inference image bytes remain bounded without evicting pinned evidence', async () => {
  const camera = makeCamera();
  const image = 'A'.repeat(SNAPSHOT_LIMITS.imageBase64Bytes); // Synthetic resource fixture, not image content.
  for (let i = 0; i < 20; i++) {
    await camera.storeSnapshot(`snap:${i}`, image);
    camera.snapshotKeys.add(`snap:${i}`);
    if (i < 2) camera.capturedSnapshotKeys.set(`snap:${i}`, 1);
    const bytes = [...camera.transientSnapshots.values()].reduce((sum, value) => sum + value.length, 0);
    assert.ok(bytes <= SNAPSHOT_LIMITS.totalBase64Bytes);
  }
  for (const key of ['snap:0', 'snap:1', 'snap:19']) assert.ok(camera.transientSnapshots.has(key));
  assert.equal(camera.transientSnapshots.has('snap:2'), false);
  assert.equal(camera.snapshotKeys.has('snap:2'), false);
});
