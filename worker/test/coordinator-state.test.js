import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeCoordinatorState, decodeCoordinatorState } from '../src/coordinator-state.js';
import { CameraDO } from '../src/camera-do.js';
import { protectEvidence } from '../src/evidence.js';
import { qualifyModelInvestigation } from '../src/investigation.js';
import { contextForCamera } from '../src/site-context.js';
import { createSceneLease } from '../src/scene-lease.js';

function investigated(legacy = false) {
  const camera = withSnapshots();
  camera.evidenceManifest = camera.evidenceState.protected_selection.map(({snapshot_key, ...frame}) => frame);
  const id = camera.evidenceManifest[0].frame_id;
  camera.cause = {...qualifyModelInvestigation(legacy ? {ignition_source: 'human', fuel_type: 'wood_paper',
    ignition_tool: 'lighter', evidence_status: 'observed', confidence: 'high', evidence_refs: [id]} : {
    observations: [{frame_ids: [id], kind: 'person_present', description: 'A person is nearby.'}],
    hypothesis: {ignition_source: 'human', ignition_tool: 'unknown', fuel_type: 'unknown', confidence: 'low',
      action_frame_ids: [], ignition_frame_id: null}}, camera.evidenceManifest), source: 'workers_ai', model: '@cf/example'};
  return camera;
}

function withSnapshots(count = 10) {
  const camera = fresh();
  for (let i = 0; i < count; i++) {
    const ts_ms = 50.25 + i * 100;
    camera.snapshotKeys.add(`snap:${ts_ms}`);
    if (camera.alert === 'confirmed') camera.followupUsed = true;
    camera.ingest({ts_ms, frame_wh: [640, 480], detections: i < 2 ? [] : [detection()]}, 'cam-1');
    if (camera.alert === 'confirmed') camera.followupUsed = true;
  }
  camera.evidenceState = protectEvidence(camera.evidenceState).state;
  return camera;
}

const fresh = () => {
  const camera = new CameraDO({ storage: {}, getWebSockets: () => [] }, {EVIDENCE_STORAGE: 'pi'});
  camera.startEnrichment = () => {};
  return camera;
};
const detection = (cls = 'fire', conf = 0.8) => ({cls, conf, bbox_xyxy: [1, 2, 31, 42]});
function observed(count = 6, detectionCount = 1, mixed = false) {
  const camera = fresh();
  for (let i = 0; i < count; i++) camera.ingest({ts_ms: 100.125 + i * 250.125,
    frame_wh: [640, 480], detections: Array.from({length: detectionCount}, () =>
      mixed && i === 0 ? detection('smoke') : mixed && i === 1 ? detection('fire', 0.05) : detection())}, 'cam-1');
  return camera;
}

test('confirmed high-detection state compacts window without inventing boxes and preserves fractional watermark', () => {
  const camera = observed(24, 256, true);
  const checkpoint = encodeCoordinatorState(camera);
  assert.deepEqual(Object.keys(checkpoint.window[0]), ['ts', 'area', 'strong', 'any', 'detected']);
  assert.deepEqual(checkpoint.window[0], {ts: 100.125, area: null, strong: false, any: false, detected: true});
  assert.equal(checkpoint.window[1].any, false);
  assert.equal(checkpoint.window[2].strong, true);
  const restored = decodeCoordinatorState(JSON.parse(JSON.stringify(checkpoint)));
  assert.equal(restored.lastObservationTs, camera.lastObservationTs);
  assert.deepEqual(restored.fire, camera.fire);
  assert.equal(restored.incidentId, camera.incidentId);
  assert.equal(restored.analysisJob, camera.analysisJob);
  assert.deepEqual(restored.currentObservation, camera.currentObservation);
  assert.deepEqual(restored.measurement, camera.measurement);
  assert.deepEqual(restored.trendWindow, camera.trendWindow.map(sample => ({...sample, reset: sample.reset ?? null})));
  assert.equal('dets' in restored.window[2], false);
  assert.ok(new TextEncoder().encode(JSON.stringify(checkpoint)).length < 256 * 1024);
  assert.deepEqual(encodeCoordinatorState(restored), checkpoint);
});

test('undefined alone means fresh storage; fresh camera state round-trips without authority or runtime objects', () => {
  assert.equal(decodeCoordinatorState(undefined), null);
  const camera = fresh();
  camera.siteContext = { trusted: true, auth: 'secret' };
  camera.transientSnapshots.set('snap:1', 'NEVER_SERIALIZE_IMAGE');
  const checkpoint = encodeCoordinatorState(camera);
  assert.equal(checkpoint.version, 7);
  const restored = decodeCoordinatorState(JSON.parse(JSON.stringify(checkpoint)));
  for (const key of ['cameraId', 'lastObservationTs', 'lastReceiptAtMs', 'currentObservation', 'fire', 'cause', 'incidentId', 'closedIncidentId']) {
    assert.equal(restored[key], null, key);
  }
  assert.equal(restored.alert, 'idle');
  assert.equal(restored.analysisInterrupted, false);
  assert.equal(restored.nativeInferenceInterrupted, false);
  assert.equal(restored.analysisActive, false);
  assert.equal(restored.pendingAnalysis, null);
  assert.equal(restored.nativeInference, null);
  assert.equal('siteContext' in restored, false);
  assert.equal('transientSnapshots' in restored, false);
  assert.equal(JSON.stringify(checkpoint).includes('NEVER_SERIALIZE_IMAGE'), false);
  for (const value of [null, false, 0, '', {}, [], {version: 2}]) assert.throws(() => decodeCoordinatorState(value));
});

test('coordinator event sequence survives restart and upgrades version-one checkpoints conservatively', () => {
  const camera = observed();
  camera.eventSequence = 17;
  const checkpoint = encodeCoordinatorState(camera);
  assert.equal(checkpoint.eventSequence, 17);
  assert.equal(decodeCoordinatorState(checkpoint).eventSequence, 17);

  const legacyV3 = structuredClone(checkpoint);
  legacyV3.version = 3;
  for (const key of ['edgeSessionId','edgeGeneration','edgeAttemptSequence','edgeAttemptTs','edgeBatchSequence','observationBatchLedger','pendingEvidenceRequest','completedEvidenceRequests','handheldHazardLatchIncidentId','handheldQualificationRequiredAfterTs']) delete legacyV3[key];
  assert.equal(decodeCoordinatorState(legacyV3).eventSequence, 17);
  const legacyV2 = structuredClone(legacyV3);
  legacyV2.version = 2;
  delete legacyV2.sceneLease;
  delete legacyV2.sceneLeaseGeneration;
  delete legacyV2.sceneHazardLatchIncidentId;
  assert.equal(decodeCoordinatorState(legacyV2).eventSequence, 17);
  const legacyV1 = structuredClone(legacyV2);
  legacyV1.version = 1;
  delete legacyV1.eventSequence;
  const restored = decodeCoordinatorState(legacyV1);
  assert.equal(restored.eventSequence, 0, 'legacy checkpoints begin the new event stream without inventing prior events');
  assert.equal(encodeCoordinatorState(restored).version, 7);
});

test('handheld hazard latches persist for only the active incident while renewable leases expire across restart', () => {
  const camera=observed();
  assert.ok(camera.incidentId);
  camera.handheldHazardLatchIncidentId=camera.incidentId;
  camera.handheldLease={ephemeral:'must not restore'};
  const checkpoint=encodeCoordinatorState(camera);
  const restored=decodeCoordinatorState(JSON.parse(JSON.stringify(checkpoint)));
  assert.equal(restored.handheldHazardLatchIncidentId,camera.incidentId);
  assert.equal(Object.hasOwn(restored,'handheldLease'),false,
    'short-lived branded proof is discarded on restart and therefore cannot keep a downgraded priority');
  const invalid=structuredClone(checkpoint);
  const [cameraId,incidentTs,sequence]=camera.incidentId.split(':');
  invalid.handheldHazardLatchIncidentId=`${cameraId}:${Number(incidentTs)-1}:${sequence}`;
  assert.throws(()=>decodeCoordinatorState(invalid),/handheld hazard latch/);
  const legacy=structuredClone(checkpoint);
  legacy.version=5;
  delete legacy.handheldHazardLatchIncidentId;
  delete legacy.handheldQualificationRequiredAfterTs;
  assert.equal(decodeCoordinatorState(legacy).handheldHazardLatchIncidentId,null);
});

test('handheld uncertainty requires post-result frames even after a Durable Object restart', () => {
  const camera=observed();
  camera.handheldQualificationRequiredAfterTs=camera.lastObservationTs;
  const checkpoint=encodeCoordinatorState(camera);
  const restored=decodeCoordinatorState(JSON.parse(JSON.stringify(checkpoint)));
  assert.equal(restored.handheldQualificationRequiredAfterTs,camera.lastObservationTs,
    'the two-frame requalification watermark must not be lost on restart');
  const future=structuredClone(checkpoint);
  future.handheldQualificationRequiredAfterTs=camera.lastObservationTs+1;
  assert.throws(()=>decodeCoordinatorState(future),/handheld qualification watermark/);
});

test('handheld hazard transition clears the uncertainty watermark before checkpointing', () => {
  const camera=observed();
  camera.handheldQualificationRequiredAfterTs=camera.lastObservationTs;
  assert.equal(camera.latchHandheldHazard(),true);
  assert.equal(camera.handheldQualificationRequiredAfterTs,null);
  assert.equal(camera.handheldHazardLatchIncidentId,camera.incidentId);
  assert.doesNotThrow(()=>encodeCoordinatorState(camera));
});

test('broadcasts assign a gap-detectable monotonic event sequence and expose the final watermark', () => {
  const camera = fresh();
  const sent = [];
  camera.state.getWebSockets = () => [{send: value => sent.push(JSON.parse(value))}];
  camera.broadcast([{type: 'fire_confirmed'}]);
  camera.broadcast([{type: 'fire_update'}, {type: 'fire_cleared'}]);
  assert.deepEqual(sent.flatMap(value => Array.isArray(value) ? value : [value]).map(event => event.event_sequence), [1, 2, 3]);
  assert.equal(camera.snapshot().event_sequence, 3);
});

test('malformed scalar, identity, counter, window and trend state rejects atomically instead of resetting', () => {
  const valid = encodeCoordinatorState(observed());
  const mutations = [
    s => { delete s.lastObservationTs; },
    s => { s.version = 99; }, s => { s.cameraId = 'other'; },
    s => { s.lastObservationTs = null; }, s => { s.lastReceiptAtMs = Infinity; },
    s => { s.alert = 'safe'; }, s => { s.fire.startedAt = s.lastObservationTs + 1; },
    s => { s.incidentId = 'other:1100.625:1'; }, s => { s.closedIncidentId = s.incidentId; },
    s => { s.incidentSequence = 0; }, s => { s.analysisJob = -1; },
    s => { s.followupUsed = 'false'; }, s => { s.persistCount = 25; },
    s => { s.followupRequested = s.lastObservationTs + 1; },
    s => { s.window = Array(2); }, s => { s.window.push(s.window.at(-1)); },
    s => { s.window[0].strong = 1; }, s => { s.window[0].any = false; },
    s => { s.window[0].area = -1; }, s => { s.window[0].ts = NaN; },
    s => { s.window = Array.from({length: 25}, () => s.window[0]); },
    s => { s.trendWindow[0].reliable = 'yes'; },
    s => { s.trendWindow[0].frame_wh = [8193, 480]; },
    s => { s.trendWindow[0].area_ratio = 2; },
    s => { s.trendWindow[0].visibility = 'clear'; },
    s => { s.trendWindow[0].reset = 'all_safe'; },
    s => { s.trendWindow.at(-1).ts = s.lastObservationTs + 1; },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(valid);
    mutate(candidate);
    assert.throws(() => decodeCoordinatorState(candidate), undefined, mutate.toString());
  }
  assert.deepEqual(decodeCoordinatorState(valid).window, valid.window);
});

test('evidence metadata is bounded, internally coherent and restored with immutable frozen selection', () => {
  const camera = withSnapshots(140);
  const checkpoint = encodeCoordinatorState(camera);
  const restored = decodeCoordinatorState(checkpoint);
  assert.equal(restored.evidenceState.history.length, 120);
  assert.equal(restored.evidenceState.snapshots.length, 24);
  assert.deepEqual(restored.evidenceState, camera.evidenceState);
  assert.ok(Object.isFrozen(restored.evidenceState.protected_selection));
  assert.ok(Object.isFrozen(restored.evidenceState.protected_selection[0]));
  assert.ok(Object.isFrozen(restored.evidenceState.protected_selection[0].roles));
  assert.ok(Object.isFrozen(restored.evidenceState.protected_selection[0].frame_wh));
  for (const mutate of [
    s => { s.evidenceState.version = 2; },
    s => { s.evidenceState.history = Array(2); },
    s => { s.evidenceState.history.push(s.evidenceState.latest); },
    s => { s.evidenceState.snapshots.push(s.evidenceState.snapshots[0]); },
    s => { s.evidenceState.latest.ts_ms = 0; },
    s => { s.evidenceState.onset.fire_evidence = 'not_detected'; },
    s => { s.evidenceState.peak.area_fraction = 1.1; },
    s => { s.evidenceState.peak.area_fraction = 0.9; },
    s => { s.evidenceState.pre_onset[0].ts_ms = s.lastObservationTs; },
    s => { s.evidenceState.onset_successor.ts_ms = 0; },
    s => { s.evidenceState.protected_selection[0].pre_ignition_verified = true; },
    s => { s.evidenceState.protected_selection[0].roles = ['ignition_verified']; },
    s => { s.evidenceState.protected_selection[0].snapshot_key = 'foreign'; },
  ]) {
    const candidate = structuredClone(checkpoint); mutate(candidate);
    assert.throws(() => decodeCoordinatorState(candidate), undefined, mutate.toString());
  }
});

test('qualified causes and actual-image manifests survive without promoting unreviewed claims', () => {
  for (const legacy of [false, true]) {
    const camera = investigated(legacy);
    const checkpoint = encodeCoordinatorState(camera);
    const restored = decodeCoordinatorState(checkpoint);
    assert.deepEqual(restored.cause, camera.cause);
    assert.deepEqual(restored.evidenceManifest, camera.evidenceManifest);
    for (const mutate of [
      s => { s.cause.accepted_cause = 'human'; },
      s => { s.cause.ignition_source = 'human'; },
      s => { s.cause.ignition_tool = 'lighter'; },
      s => { s.cause.probable_cause = 'human'; },
      s => { s.cause.requires_human_review = false; },
      s => { s.cause.hazard_absence_verified = true; },
      s => { s.cause.electrical_hazard = 'absent'; },
      s => { s.cause.recommended_agent = 'water_or_soil_sand'; },
      s => { s.cause.hypothesis.ignition_source = 'arson'; },
      s => { s.cause.model_claims.provenance = 'reviewed'; },
      s => { s.evidenceManifest[0].frame_id = 'other'; },
      s => { s.evidenceManifest[0].pre_ignition_verified = true; },
      s => { s.evidenceManifest[0].ts_ms = s.lastObservationTs + 1; },
    ]) {
      const candidate = structuredClone(checkpoint); mutate(candidate);
      assert.throws(() => decodeCoordinatorState(candidate), undefined, mutate.toString());
    }
  }
});

test('in-flight work becomes persistent interruption metadata, never resurrected promises, queues or pins', () => {
  for (const kind of ['active', 'pending', 'native', 'recovered_analysis', 'recovered_native']) {
    const camera = withSnapshots();
    camera.analysisJob = 2;
    camera.followupUsed = false;
    camera.followupRequested = camera.lastObservationTs;
    if (kind === 'active') camera.analysisActive = true;
    if (kind === 'pending') camera.pendingAnalysis = {image_b64: 'DO_NOT_STORE', keys: ['snap:1'], arbitrary: true};
    if (kind === 'native') camera.nativeInference = new Promise(() => {});
    if (kind === 'recovered_analysis') camera.analysisInterrupted = true;
    if (kind === 'recovered_native') camera.nativeInferenceInterrupted = true;
    const checkpoint = encodeCoordinatorState(camera);
    assert.equal(JSON.stringify(checkpoint).includes('DO_NOT_STORE'), false);
    assert.deepEqual(checkpoint.evidenceState.protected_selection, camera.evidenceState.protected_selection);
    const restored = decodeCoordinatorState(checkpoint);
    assert.equal(restored.analysisInterrupted, true, kind);
    assert.equal(restored.nativeInferenceInterrupted, ['native', 'recovered_native'].includes(kind));
    assert.equal(restored.analysisActive, false);
    assert.equal(restored.pendingAnalysis, null);
    assert.equal(restored.nativeInference, null);
    assert.equal(restored.evidenceState.protected_selection, null);
    assert.equal(restored.followupRequested, null);
    assert.equal(restored.analysisJob, 2);
    assert.equal(restored.incidentId, camera.incidentId);
    const twice = decodeCoordinatorState(encodeCoordinatorState(restored));
    assert.equal(twice.analysisInterrupted, true);
    assert.equal(twice.nativeInferenceInterrupted, restored.nativeInferenceInterrupted);
    assert.equal(camera.followupRequested, camera.lastObservationTs);
    assert.notEqual(camera.evidenceState.protected_selection, null);
  }
});

test('encoder strips unknown metadata fields and decoder rejects injected authority, bytes and non-JSON containers', () => {
  const camera = investigated();
  const marker = 'NEVER_COPY_ME';
  camera.auth = marker;
  camera.siteContext = {reviewed: true, secret: marker};
  for (const item of [camera.currentObservation, camera.currentObservation.detections[0], camera.measurement,
    camera.trendWindow[0], camera.evidenceState, camera.evidenceState.history[0], camera.cause,
    camera.cause.hypothesis, camera.cause.model_claims, camera.evidenceManifest[0]]) {
    item.image_b64 = marker;
    item.context = {authority: true};
  }
  const checkpoint = encodeCoordinatorState(camera);
  assert.equal(JSON.stringify(checkpoint).includes(marker), false);
  assert.equal(JSON.stringify(checkpoint).includes('authority'), false);
  for (const mutate of [
    s => { s.auth = 'secret'; }, s => { s.siteContext = {reviewed: true}; },
    s => { s.currentObservation.snap_b64 = 'bytes'; },
    s => { s.cause.model_claims.image_b64 = 'bytes'; },
    s => { s.evidenceState.history[0].image = 'bytes'; },
    s => { s.evidenceManifest[0].context = {authority: true}; },
    s => { s.evidenceState = new Map(); },
    s => { s.measurement = Promise.resolve({}); },
    s => { s.window[0].ts = undefined; },
  ]) {
    const candidate = structuredClone(checkpoint); mutate(candidate);
    assert.throws(() => decodeCoordinatorState(candidate), undefined, mutate.toString());
  }
  const clone = structuredClone(checkpoint);
  const restored = decodeCoordinatorState(checkpoint);
  restored.window[0].area = 7;
  restored.currentObservation.detections[0].bbox_xyxy[0] = 9;
  restored.evidenceState.history[0].frame_wh[0] = 1;
  restored.cause.model_claims.observations[0].description = 'changed';
  assert.deepEqual(checkpoint, clone);
});

test('checkpoint byte guard rejects oversized metadata explicitly before restoration', () => {
  const checkpoint = encodeCoordinatorState(fresh());
  checkpoint.oversized = 'x'.repeat(256 * 1024);
  assert.throws(() => decodeCoordinatorState(checkpoint), /coordinator_state_too_large/);
});

test('encoder enforces the UTF-8 aggregate ceiling on otherwise bounded metadata', () => {
  const camera = withSnapshots(140);
  for (let i = 0; i < 140; i++) camera.ingest({ts_ms: camera.lastObservationTs + 100.123456789,
    frame_wh: [8192, 2048], detections: Array.from({length: 256}, () => ({
      cls: 'fire', conf: 0.8123456789012345,
      bbox_xyxy: [0.123456789012345, 0.234567890123456, 7012.345678901234, 1234.567890123456]}))}, 'cam-1');
  camera.evidenceState = protectEvidence(camera.evidenceState).state;
  camera.evidenceManifest = camera.evidenceState.protected_selection.map(({snapshot_key, ...frame}) => frame);
  const frame_id = camera.evidenceManifest[0].frame_id;
  const description = '\u{10ffff}'.repeat(300);
  const observations = Array.from({length: 16}, () => ({frame_ids: [frame_id], kind: 'unknown', description}));
  camera.cause = {...qualifyModelInvestigation({observations, hypothesis: {ignition_source: 'unknown',
    ignition_tool: 'unknown', fuel_type: 'unknown', confidence: 'low', action_frame_ids: [], ignition_frame_id: null}},
    camera.evidenceManifest), source: 'workers_ai'};
  for (const key of ['reasons', 'evidence', 'validation_errors']) camera.cause[key] = Array(8).fill(description);
  camera.cause.cause_limitations = Array(16).fill(description);
  camera.cause.hypothesis.limitations = Array(16).fill(description);
  camera.cause.visual_observations = Array.from({length: 16}, () => ({frame_id, kind: 'unknown', description}));
  const checkpoint = encodeCoordinatorState(camera);
  const json = JSON.stringify(checkpoint);
  assert.ok(new TextEncoder().encode(json).length > json.length);
  assert.ok(new TextEncoder().encode(json).length <= 256 * 1024);
  assert.equal(decodeCoordinatorState(checkpoint).cause.accepted_cause, 'unknown');
});

test('historical/current metadata cannot contradict confirmation, trend or incident counters', () => {
  const checkpoint = encodeCoordinatorState(observed());
  for (const mutate of [
    s => { s.window[0].strong = false; },
    s => { s.window[0].area = 2; },
    s => { s.trendWindow.at(-1).area_ratio = 0.25; },
    s => { s.trendWindow.at(-1).frame_wh = [1, 1]; },
    s => { s.fire.peakArea = 1; },
    s => { s.incidentSequence = 2; },
    s => { s.analysisActive = true; },
  ]) {
    const candidate = structuredClone(checkpoint); mutate(candidate);
    assert.throws(() => decodeCoordinatorState(candidate), undefined, mutate.toString());
  }
  const camera = observed();
  camera.window[0].dets = Array(1);
  assert.throws(() => encodeCoordinatorState(camera));
});

test('watch and closed incidents preserve source ordering and identifiers after metadata round-trip', () => {
  const watching = observed(2);
  assert.equal(decodeCoordinatorState(encodeCoordinatorState(watching)).alert, 'watch');
  const camera = observed();
  const incidentId = camera.incidentId;
  for (let i = 0; i < 8; i++) camera.ingest({ts_ms: 2000.125 + i * 250,
    frame_wh: [640, 480], detections: []}, 'cam-1');
  const restored = decodeCoordinatorState(encodeCoordinatorState(camera));
  assert.equal(restored.closedIncidentId, incidentId);
  assert.equal(restored.incidentId, null);
  assert.equal(restored.alert, 'idle');
  assert.equal(restored.lastObservationTs, camera.lastObservationTs);
  assert.equal(restored.incidentSequence, 1);
  assert.deepEqual(restored.window, []);
});

test('actual no-image and malformed-model caller fallbacks remain qualified checkpoint metadata', async () => {
  const camera = withSnapshots();
  camera.cause = await camera.analyzeCause();
  assert.deepEqual(decodeCoordinatorState(encodeCoordinatorState(camera)).cause, camera.cause);
  camera.evidenceManifest = camera.evidenceState.protected_selection.map(({snapshot_key, ...frame}) => frame);
  camera.env.AI = {run: async () => ({response: 'not json'})};
  camera.env.VLM_MODEL = '@cf/example';
  camera.cause = await camera.analyzeCause({frames: camera.evidenceManifest.map(frame => ({...frame, image_b64: 'dGVzdA=='}))});
  assert.deepEqual(decodeCoordinatorState(encodeCoordinatorState(camera)).cause, camera.cause);
});

test('normalizer reconstructs only genuine validated observations and rejects contradictory geometry and summaries', () => {
  const valid = encodeCoordinatorState(observed());
  for (const mutate of [
    s => { s.currentObservation.detections[0].bbox_xyxy = [3, 2, 1, 4]; },
    s => { s.currentObservation.detections[0].bbox_xyxy[0] = -1; },
    s => { s.currentObservation.detections = Array(1); },
    s => { s.currentObservation.detections = Array(257).fill(detection()); },
    s => { s.currentObservation.fire.area_px = 999; },
    s => { s.currentObservation.observation_valid = false; },
    s => { s.currentObservation.ts_ms = 0; },
    s => { s.measurement.area_reliable = false; },
    s => { s.measurement.area_fraction = 0.5; },
  ]) {
    const candidate = structuredClone(valid); mutate(candidate);
    assert.throws(() => decodeCoordinatorState(candidate), undefined, mutate.toString());
  }
});


test('contained scene survives strict coordinator restart and old causes restore as uncertain',()=>{
 const camera=investigated();const ids=camera.evidenceManifest.slice(0,2).map(f=>f.frame_id);
 camera.cause=qualifyModelInvestigation({observations:[{kind:'flame_contained',frame_ids:ids,description:'Flame visibly contained at candle.'}],hypothesis:{ignition_source:'unknown',ignition_tool:'unknown',fuel_type:'unknown',confidence:'low',action_frame_ids:[],ignition_frame_id:null},scene_assessment:{category:'contained_flame',confidence:'medium',frame_ids:ids,limitations:[]}},camera.evidenceManifest);
 const checkpoint=encodeCoordinatorState(camera);const restored=decodeCoordinatorState(checkpoint);
 assert.equal(restored.cause.scene_assessment.support,'frame_linked_unverified');
 assert.deepEqual(restored.cause.scene_assessment.evidence_interval,{start_ts_ms:camera.evidenceManifest[0].ts_ms,end_ts_ms:camera.evidenceManifest[1].ts_ms});
 for(const mutate of [s=>s.cause.scene_assessment.provenance='verified',s=>s.cause.scene_assessment.evidence_interval.end_ts_ms++,s=>s.cause.observations[0].kind='tool_visible']){const c=structuredClone(checkpoint);mutate(c);assert.throws(()=>decodeCoordinatorState(c));}
 delete checkpoint.cause.scene_assessment;
 assert.equal(decodeCoordinatorState(checkpoint).cause.scene_assessment.category,'uncertain');
});

test('optional returned inference usage survives restart and invalid metadata is rejected',()=>{
 const camera=investigated();camera.cause.inference_metadata={mode:'cached',usage:{prompt_tokens:null,completion_tokens:null,total_tokens:null}};
 const checkpoint=encodeCoordinatorState(camera);
 assert.deepEqual(decodeCoordinatorState(checkpoint).cause.inference_metadata,camera.cause.inference_metadata);
 checkpoint.cause.inference_metadata.usage.prompt_tokens=-1;
 assert.throws(()=>decodeCoordinatorState(checkpoint));
});

test('v4 persists only a current scene lease bound to its incident, V2 assessment, and reviewed geometry',()=>{
 const camera=withSnapshots();
 camera.evidenceManifest=camera.evidenceState.protected_selection.map(({snapshot_key,...frame})=>frame);
 const frames=camera.evidenceManifest.slice(-2);
 camera.evidenceManifest=frames;
 const zoneId='candle-1';
 const sourceFrames=frames.map((frame,index)=>({frame_id:frame.frame_id,detection_ids:[`det-${index+1}`]}));
 const sceneContext={sources:[{source_id:zoneId,source_type:'candle',reviewed:true,frames:sourceFrames}]};
 camera.siteContext=contextForCamera(JSON.stringify({'cam-1':{reviewed:true,reviewed_by:'operator',
   reviewed_at_ms:0,review_expires_at_ms:30*24*60*60*1000,context_revision:4,geometry_revision:7,
   reviewed_reference_image_sha256:'b'.repeat(64),reference_dimensions:[640,480],crop_rect:[0,0,1,1],
   source_zones:[{zone_id:zoneId,source_type:'candle',bbox_normalized:[0.2,0.2,0.7,0.8]}],
   expected_flame_use:true,occupied_area:false,known_hazards:[],critical_zones:[]}}),'cam-1');
 camera.contextCamera='cam-1';
 const timestamps=frames.map(frame=>frame.ts_ms);
 camera.cause=qualifyModelInvestigation({contract_version:2,
   observations:[{frame_ids:frames.map(frame=>frame.frame_id),kind:'flame_at_tool',description:'Flame remains at candle wick.'}],
   hypothesis:{ignition_source:'unknown',ignition_tool:'unknown',fuel_type:'unknown',confidence:'low',
     action_frame_ids:[],ignition_frame_id:null},
   scene_assertions:frames.map((frame,index)=>({frame_id:frame.frame_id,source_id:zoneId,
     detection_ids:[`det-${index+1}`],source_type:'candle',containment:'contained',smoke:'not_observed',
     secondary_burning:'not_observed',spread_outside_source:'not_observed',occlusion:'not_observed'}))},
   {frames,sceneContext});
 assert.deepEqual(camera.cause.validation_errors,[]);
 camera.analysisJob=2;
 camera.lastReceiptAtMs=12_500;
 const currentTs=camera.lastObservationTs;
 const frameIds=[...new Set([...timestamps,currentTs])].sort((a,b)=>a-b).map(ts=>`frame-${ts}`);
 const gaps=frameIds.slice(1).map((id,index)=>Number(id.slice(6))-Number(frameIds[index].slice(6)));
 const currentFrame=camera.evidenceManifest.find(frame=>frame.ts_ms===currentTs);
 const candidate={camera_id:'cam-1',incident_id:camera.incidentId,analysis_job_id:camera.analysisJob,
   cancellation_generation:camera.sceneLeaseGeneration,session_id:camera.sessionId,source_zone_id:zoneId,
   source_type:'candle',site_context:camera.siteContext,scene_assessment:camera.cause.scene_assessment,
   supporting_frames:frames.map((frame,index)=>({frame_id:frame.frame_id,source_ts_ms:frame.ts_ms,
     received_at_ms:10_000+index*1_000,detection_ids:[`det-${index+1}`]})),
   current_observation:{source_ts_ms:currentTs,received_at_ms:12_500},now_ms:12_500,
   continuity:{qualified:true,camera_id:'cam-1',incident_id:camera.incidentId,session_id:camera.sessionId,
     source_zone_id:zoneId,context_revision:4,geometry_revision:7,reference_image_sha256:'b'.repeat(64),
     chain_start_ts_ms:Number(frameIds[0].slice(6)),chain_end_ts_ms:currentTs,frame_ids:frameIds,
     max_source_gap_ms:Math.max(0,...gaps),all_fire_regions_inside_zone:true,unique_region_match:true,
     image_quality_usable:true,background_stable:true,camera_motion:false,smoke_absent:true,
     secondary_burning_absent:true,spread_absent:true,source_geometry_matched:true}};
 assert.ok(currentFrame || currentTs===timestamps.at(-1));
 camera.sceneLease=createSceneLease(candidate);
 assert.ok(camera.sceneLease);
 const checkpoint=encodeCoordinatorState(camera);
 assert.equal(checkpoint.version,7);
 assert.deepEqual(decodeCoordinatorState(structuredClone(checkpoint)).sceneLease,camera.sceneLease);
 for(const mutate of [s=>s.sceneLease.expires_at_ms++,s=>s.sceneLeaseGeneration++,
   s=>s.sceneLease.scene_assessment_json=s.sceneLease.scene_assessment_json.replace('contained_flame','uncertain'),
   s=>s.sceneHazardLatchIncidentId=s.incidentId]){
   const altered=structuredClone(checkpoint);mutate(altered);assert.throws(()=>decodeCoordinatorState(altered));
 }
});
