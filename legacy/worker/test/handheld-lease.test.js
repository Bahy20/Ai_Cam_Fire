import test from 'node:test';
import assert from 'node:assert/strict';
import {contextForCamera} from '../src/site-context.js';
import {advanceHandheldLease, createHandheldLease, isHandheldLeaseCurrent, restoreHandheldLease} from '../src/handheld-lease.js';

const policy = contextForCamera(JSON.stringify({cam: {reviewed:true, reviewed_by:'operator', reviewed_at_ms:1_000,
  review_expires_at_ms:100_000, expected_handheld_flame_use:true, occupied_area:false,
  known_hazards:[], critical_zones:[]}}), 'cam');
const candidate = (patch = {}) => ({version:1, camera_id:'cam', incident_id:'incident-1',
  session_id:'123e4567-e89b-42d3-a456-426614174000', generation:1, candidate_id:'lighter-track-1',
  model_sha256:'a'.repeat(64), source_ts_ms:2_000, frame_ids:['frame-1500','frame-2000'],
  tool_type:'lighter', flame_relation:'at_tool_tip', image_quality:'adequate', fire_region_count:1,
  smoke_evidence:'not_detected', secondary_burning_evidence:'not_detected', ...patch});

test('only a fresh two-frame local lighter candidate under trusted reviewed permission creates a lease', () => {
  const lease = createHandheldLease(candidate(), policy, 2_100);
  assert.ok(lease);
  assert.equal(lease.camera_id, 'cam');
  assert.equal(lease.incident_id, 'incident-1');
  assert.equal(lease.candidate_id, 'lighter-track-1');
  assert.equal(lease.expires_at_ms, 7_100);
  assert.equal(isHandheldLeaseCurrent(lease, {cameraId:'cam', incidentId:'incident-1',
    sessionId:candidate().session_id, sourceTsMs:2_000, nowMs:2_100}), true);
});

test('missing, expired, mismatched or forged review policy cannot issue a lease', () => {
  const noPermission = contextForCamera(JSON.stringify({cam:{reviewed:true,reviewed_by:'operator',reviewed_at_ms:1_000,
    expected_handheld_flame_use:false,occupied_area:false,known_hazards:[],critical_zones:[]}}),'cam');
  for (const context of [null, noPermission, {...policy}]) assert.equal(createHandheldLease(candidate(), context, 2_100), null);
  assert.equal(createHandheldLease(candidate(), policy, 100_001), null);
  assert.equal(createHandheldLease(candidate({camera_id:'other'}), policy, 2_100), null);
  assert.equal(createHandheldLease(candidate({incident_id:''}), policy, 2_100), null);
});

test('one frame, nonchronological or stale frame pair, model/session changes and uncertain evidence never qualify', () => {
  const bad = [
    {frame_ids:['frame-2000']},
    {frame_ids:['frame-2000','frame-1500'], source_ts_ms:1_500},
    {frame_ids:['frame-1500','frame-9000'], source_ts_ms:9_000},
    {frame_ids:['frame-1500','frame-2000'], source_ts_ms:9_000},
    {tool_type:'uncertain'}, {flame_relation:'separate'}, {image_quality:'unknown'},
    {fire_region_count:2}, {smoke_evidence:'detected'}, {secondary_burning_evidence:'detected'},
  ];
  for (const patch of bad) assert.equal(createHandheldLease(candidate(patch), policy, 9_100), null, JSON.stringify(patch));
});

test('lease renewal requires a newer same-session local track and cancels on gaps or contradictions', () => {
  const original = createHandheldLease(candidate(), policy, 2_100);
  const nextCandidate = candidate({source_ts_ms:3_000, frame_ids:['frame-2500','frame-3000']});
  const renewed = advanceHandheldLease(original, {observation_valid:true, ts_ms:3_000,
    handheld_candidate:nextCandidate}, 3_100);
  assert.equal(renewed.cancelled, false);
  assert.equal(renewed.lease.expires_at_ms, 8_100);
  assert.equal(isHandheldLeaseCurrent(renewed.lease, {cameraId:'cam', incidentId:'incident-1',
    sessionId:nextCandidate.session_id, sourceTsMs:3_000, nowMs:3_100}), true);

  for (const observation of [
    {observation_valid:false, ts_ms:3_000},
    {observation_valid:true, ts_ms:3_000},
    {observation_valid:true, ts_ms:3_000, smoke_evidence:'detected', handheld_candidate:nextCandidate},
    {observation_valid:true, ts_ms:3_000, secondary_burning_evidence:'detected', handheld_candidate:nextCandidate},
    {observation_valid:true, ts_ms:3_000, fire_region_count:2, handheld_candidate:nextCandidate},
    {observation_valid:true, ts_ms:3_000, handheld_candidate:candidate({session_id:'123e4567-e89b-42d3-a456-426614174001'})},
    {observation_valid:true, ts_ms:3_000, handheld_candidate:candidate({model_sha256:'b'.repeat(64),
      source_ts_ms:3_000, frame_ids:['frame-2500','frame-3000']})},
  ]) {
    const result = advanceHandheldLease(original, observation, 3_100);
    assert.equal(result.lease, null);
    assert.equal(result.cancelled, true);
    assert.ok(result.reason);
  }
});

test('lease binds camera, incident, session, candidate time and a five-second maximum', () => {
  const lease = createHandheldLease(candidate(), policy, 2_100);
  for (const binding of [
    {cameraId:'other'}, {incidentId:'other'}, {sessionId:'other'}, {sourceTsMs:7_001}, {nowMs:7_101},
  ]) {
    assert.equal(isHandheldLeaseCurrent(lease, {cameraId:'cam', incidentId:'incident-1',
      sessionId:candidate().session_id, sourceTsMs:2_000, nowMs:2_100, ...binding}), false);
  }
});

test('serialized leases are untrusted until restored against the current reviewed camera policy', () => {
  const lease = createHandheldLease(candidate(), policy, 2_100);
  const copy = structuredClone(lease);
  assert.equal(isHandheldLeaseCurrent(copy, {cameraId:'cam', incidentId:'incident-1',
    sessionId:candidate().session_id, sourceTsMs:2_000, nowMs:2_100}), false);
  const restored = restoreHandheldLease(copy, policy, 2_100);
  assert.ok(restored);
  assert.equal(isHandheldLeaseCurrent(restored, {cameraId:'cam', incidentId:'incident-1',
    sessionId:candidate().session_id, sourceTsMs:2_000, nowMs:2_100}), true);
  copy.expires_at_ms += 1;
  assert.equal(restoreHandheldLease(copy, policy, 2_100), null);
});
