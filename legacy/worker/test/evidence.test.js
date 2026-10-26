import test from 'node:test';
import assert from 'node:assert/strict';
import * as evidence from '../src/evidence.js';
import { normalizeObservation } from '../src/observations.js';

function observation(ts_ms, area = null, overrides = {}) {
  return normalizeObservation({
    ts_ms, frame_wh: [100, 100], visibility: 'adequate',
    detections: area === null ? [] : [{
      cls: 'fire', conf: 0.8, bbox_xyxy: [0, 0, area, 100],
    }], ...overrides,
  });
}

const append = (state, ts, area = null, key = `snap:${ts}`) =>
  evidence.appendEvidence(state, observation(ts, area), key);

test('1000 frames bound numeric history and snapshot keys while preserving original onset and measured peak', () => {
  let state = evidence.createEvidenceState();
  const retired = new Set();
  for (let ts = 0; ts < 1000; ts++) {
    const result = append(state, ts, ts < 5 ? null : ts === 8 ? 90 : 10);
    assert.equal(result.accepted, true);
    assert.ok(result.state.history.length <= 120);
    assert.ok(result.state.snapshots.length <= 24);
    assert.ok(result.retired_keys.length <= 1);
    result.retired_keys.forEach((key) => retired.add(key));
    state = result.state;
    for (const frame of state.snapshots) assert.equal(retired.has(frame.snapshot_key), false);
  }
  assert.equal(state.history.length, 120);
  assert.equal(state.history[0].ts_ms, 880);
  assert.equal(state.snapshots.length, 24);
  assert.equal(retired.size, 976);
  assert.equal(state.onset.ts_ms, 5);
  assert.equal(state.peak.ts_ms, 8);
  assert.equal(state.peak.area_fraction, 0.9);
  assert.equal(state.latest.ts_ms, 999);
  assert.deepEqual(state.snapshots.slice(0, 2).map((f) => f.ts_ms), [0, 1]);
  assert.ok(state.snapshots.some((f) => f.ts_ms === 5));
  assert.ok(state.snapshots.some((f) => f.ts_ms === 8));
  assert.equal(state.history.some((f) => 'detections' in f), false);
});

test('selection preserves measured peak before confirmation and returns immutable chronological roles', () => {
  let state = evidence.createEvidenceState();
  for (const [ts, area] of [[0, null], [1, null], [2, 10], [3, 80], [4, 20], [5, 10]]) {
    state = append(state, ts, area).state;
  }
  // The caller may confirm at t=5; confirmation is not a new peak measurement.
  const selected = evidence.selectEvidence(state);
  assert.deepEqual(selected.map((f) => [f.ts_ms, f.roles]), [
    [0, ['early']], [1, ['early', 'context_before_onset']], [2, ['onset']],
    [3, ['context_after_onset', 'peak']], [5, ['recent']],
  ]);
  assert.ok(selected.length <= 6);
  assert.ok(selected.every((f) => f.pre_ignition_verified === false));
  assert.equal(selected.find((f) => f.roles.includes('peak')).peak_scope, 'observed_so_far');
  assert.equal(Object.isFrozen(selected), true);
  assert.equal(Object.isFrozen(selected[0]), true);
  assert.equal(Object.isFrozen(selected[0].roles), true);
  assert.throws(() => selected[0].roles.push('onset'), TypeError);
  assert.throws(() => { selected[0].snapshot_key = 'changed'; }, TypeError);
  assert.equal(state.snapshots[0].snapshot_key, 'snap:0');
});

test('protects one immutable selection through pruning and restart until archive is acknowledged', () => {
  let state = evidence.createEvidenceState();
  for (let ts = 0; ts < 10; ts++) state = append(state, ts, ts < 2 ? null : ts === 4 ? 90 : 10).state;
  const protectedResult = evidence.protectEvidence(state);
  const original = protectedResult.selection;
  assert.ok(original.some((f) => f.ts_ms === 9 && f.roles.includes('recent')));
  state = JSON.parse(JSON.stringify(protectedResult.state));
  for (let ts = 10; ts < 1000; ts++) {
    const result = append(state, ts, ts === 20 ? 95 : 10);
    state = result.state;
    assert.ok(state.snapshots.length <= 24);
    assert.ok(state.protected_selection.length <= 6);
    for (const frame of original) {
      assert.equal(result.retired_keys.includes(frame.snapshot_key), false);
      assert.ok(state.snapshots.some((s) => s.snapshot_key === frame.snapshot_key));
    }
  }
  const again = evidence.protectEvidence(state);
  assert.deepEqual(again.selection, original, 'one pending archive cannot be replaced by a later selection');
  assert.equal(Object.isFrozen(again.selection[0].roles), true);
  assert.throws(() => evidence.releaseEvidence(state), /archiv/i);
  const released = evidence.releaseEvidence(state, { archived: true });
  assert.equal(released.state.protected_selection, null);
  assert.deepEqual(released.retired_keys, []);
  let cleanup = append(released.state, 1000, 10);
  assert.ok(cleanup.retired_keys.includes('snap:4'), 'superseded peak can retire after archive');
  cleanup = append(cleanup.state, 1001, 10);
  assert.ok(cleanup.retired_keys.includes('snap:9'), 'captured recent can retire after archive');
  assert.deepEqual(original.map((f) => f.ts_ms), [0, 1, 2, 3, 4, 9]);
});

test('duplicate and out-of-order timestamps cannot duplicate frames or change aggregates', () => {
  let state = append(evidence.createEvidenceState(), 10, 40).state;
  state = append(state, 20, 20).state;
  const before = structuredClone(state);
  for (const [ts, key, reason, retired] of [
    [20, 'unused:duplicate', 'duplicate_timestamp', ['unused:duplicate']],
    [19, 'unused:old', 'out_of_order', ['unused:old']],
    [20, 'snap:20', 'duplicate_timestamp', []],
    [19, 'snap:10', 'out_of_order', []],
  ]) {
    const result = append(state, ts, 95, key);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, reason);
    assert.deepEqual(result.retired_keys, retired, 'never delete a retained key on rejection');
    assert.deepEqual(result.state, before);
    assert.deepEqual(state, before);
  }
  assert.deepEqual(evidence.selectEvidence(state).map((f) => f.ts_ms), [10, 20]);
});

test('rejects invalid observations instead of recording detector failures or unbounded metadata', () => {
  const state = evidence.createEvidenceState();
  const valid = observation(10, 10);
  for (const input of [null, {}, normalizeObservation({ error: 'jpeg_decode_failed' }),
    { ...valid, ts_ms: NaN }, { ...valid, ts_ms: Infinity }, { ...valid, ts_ms: -1 },
    { ...valid, fire: { ...valid.fire, area_fraction: Infinity } },
    { ...valid, visibility: 'x'.repeat(1000) },
    { ...valid, fire: { ...valid.fire, evidence_level: 'x'.repeat(1000) } },
  ]) {
    const result = evidence.appendEvidence(state, input, 'unused:invalid');
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'invalid_observation');
    assert.deepEqual(result.retired_keys, ['unused:invalid']);
    assert.deepEqual(result.state, evidence.createEvidenceState());
  }
});

test('snapshot keys are bounded scalar identifiers unique to a retained timestamp', () => {
  const state = append(evidence.createEvidenceState(), 0, null, 'snap:first').state;
  for (const key of ['', 12, {}, [], 'x'.repeat(513)]) {
    const result = append(state, 1, 10, key);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'invalid_snapshot_key');
    assert.deepEqual(result.retired_keys, [], 'invalid identifiers must never reach storage deletion');
    assert.deepEqual(result.state, state);
  }
  const reused = append(state, 1, 10, 'snap:first');
  assert.equal(reused.accepted, false);
  assert.equal(reused.reason, 'snapshot_key_reused');
  assert.deepEqual(reused.retired_keys, []);
  const bounded = append(state, 1, 10, 'x'.repeat(512));
  assert.equal(bounded.accepted, true);
});

// Boundary regressions for the bounded-buffer/selection tracer bullets above.
test('missing onset and peak snapshots do not relabel available frames as replacements', () => {
  let state = evidence.createEvidenceState();
  for (const [ts, area, key] of [
    [0, null, 'snap:0'], [1, 20, null], [2, 90, null], [3, 10, 'snap:3'],
    [4, 5, 'snap:4'], [5, null, null],
  ]) state = append(state, ts, area, key).state;
  assert.equal(state.onset.ts_ms, 1);
  assert.equal(state.peak.ts_ms, 2);
  assert.equal(state.latest.ts_ms, 5);
  const selected = evidence.selectEvidence(state);
  assert.deepEqual(selected.map((f) => [f.ts_ms, f.roles]), [
    [0, ['early', 'context_before_onset']], [3, ['early']], [4, ['recent']],
  ]);
  assert.ok(selected.every((f) => f.peak_scope === null));
});

test('empty and single-frame windows select only existing evidence with deduplicated roles', () => {
  assert.deepEqual(evidence.selectEvidence(evidence.createEvidenceState()), []);
  const state = append(evidence.createEvidenceState(), 0, 20).state;
  assert.deepEqual(evidence.selectEvidence(state), [{
    frame_id: 'frame-0', ts_ms: 0, snapshot_key: 'snap:0',
    roles: ['early', 'onset', 'peak', 'recent'],
    pre_ignition_verified: false, peak_scope: 'observed_so_far',
    fire_evidence: 'strong', smoke_evidence: 'not_detected', confidence: 0.8,
    area_px: 2000, area_fraction: 0.2, area_reliable: true,
    visibility: 'adequate', frame_wh: [100, 100],
  }]);
  const withoutSnapshot = append(evidence.createEvidenceState(), 0, 20, null).state;
  assert.deepEqual(evidence.selectEvidence(withoutSnapshot), []);
});

test('non-fire and smoke-only short windows never invent onset or peak or verified preignition', () => {
  let state = append(evidence.createEvidenceState(), 3).state;
  const smoke = observation(20, null, { detections: [{
    cls: 'smoke', conf: 0.8, bbox_xyxy: [0, 0, 80, 80],
  }] });
  state = evidence.appendEvidence(state, smoke, 'snap:20').state;
  state = append(state, 25).state;
  assert.equal(state.onset, null);
  assert.equal(state.peak, null);
  assert.equal(state.history[1].smoke_evidence, 'strong');
  assert.deepEqual(evidence.selectEvidence(state).map((f) => [f.ts_ms, f.roles]), [
    [3, ['early']], [20, ['early']], [25, ['recent']],
  ]);
  assert.ok(evidence.selectEvidence(state).every((f) => !f.pre_ignition_verified));
});

test('equal measured peaks keep the first timestamp and weak measurements retain uncertainty', () => {
  let state = evidence.createEvidenceState();
  const weak = observation(1, 80, { visibility: 'unknown', detections: [{
    cls: 'fire', conf: 0.1, bbox_xyxy: [0, 0, 80, 100],
  }] });
  state = evidence.appendEvidence(state, weak, 'snap:1').state;
  state = append(state, 2, 80).state;
  assert.equal(state.onset.ts_ms, 1);
  assert.equal(state.onset.fire_evidence, 'weak');
  assert.equal(state.peak.ts_ms, 1);
  assert.equal(state.peak.area_reliable, false);
  assert.equal(state.peak.visibility, 'unknown');
  assert.deepEqual(evidence.selectEvidence(state).find((f) => f.roles.includes('peak')).ts_ms, 1);
});

test('JSON-restored state evolves identically and input states and normalized observations are not mutated', () => {
  let state = evidence.createEvidenceState();
  for (let ts = 0; ts < 150; ts++) state = append(state, ts, ts < 3 ? null : ts === 8 ? 90 : 10).state;
  state = evidence.protectEvidence(state).state;
  const restored = JSON.parse(JSON.stringify(state));
  const before = structuredClone(state);
  const input = observation(150, 30);
  const originalInput = structuredClone(input);
  const next = evidence.appendEvidence(state, input, 'snap:150');
  const recreatedNext = evidence.appendEvidence(restored, input, 'snap:150');
  assert.deepEqual(next, recreatedNext);
  assert.equal(Object.isFrozen(recreatedNext.state.protected_selection), true,
    'append must restore immutable protection after a JSON round-trip');
  assert.equal(Object.isFrozen(recreatedNext.state.protected_selection[0].roles), true);
  assert.deepEqual(state, before);
  assert.deepEqual(input, originalInput);
  assert.deepEqual(JSON.parse(JSON.stringify(next.state)), next.state);
  assert.deepEqual(evidence.selectEvidence(restored), evidence.selectEvidence(state));
  assert.equal(evidence.releaseEvidence(state, { archived: true }).state.protected_selection, null);
  assert.deepEqual(state, before, 'release never mutates the original state');
});

