import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createEvidenceState, appendEvidence, selectEvidence, selectLaterEvidence, protectEvidence, releaseEvidence,
} from '../src/evidence.js';
import { normalizeObservation } from '../src/observations.js';

function observation(ts_ms, area = null, overrides = {}) {
  return normalizeObservation({
    ts_ms, frame_wh: [100, 100], visibility: 'adequate',
    detections: area === null ? [] : [{
      cls: 'fire', conf: 0.8, bbox_xyxy: [0, 0, area, 100],
    }], ...overrides,
  });
}

function append(state, ts, area = null, key = `snap:${ts}`, overrides = {}) {
  const result = appendEvidence(state, observation(ts, area, overrides), key);
  assert.equal(result.accepted, true);
  return result.state;
}

test('a later unrelated-person annotation is not promoted to ignition evidence or copied into grounding metadata', () => {
  // Scene annotations are test fixtures, not an image classifier. Selection only
  // establishes temporal roles; a consumer must ground visual claims separately.
  const scenes = new Map([
    [0, 'first observed flame'], [10, 'flame'], [20, 'unrelated person appears'],
  ]);
  let state = append(createEvidenceState(), 0, 20);
  state = append(state, 10, 80);
  const input = { ...observation(20, 10), frame_id: 'forged-onset',
    scene: scenes.get(20), cause: { source: 'person', frame_id: 'frame-0' } };
  state = appendEvidence(state, input, 'snap:20').state;
  const selected = selectEvidence(state);
  assert.deepEqual(selected.map((frame) => [frame.frame_id, frame.roles]), [
    ['frame-0', ['early', 'onset']],
    ['frame-10', ['early', 'context_after_onset', 'peak']],
    ['frame-20', ['recent']],
  ]);
  const later = selected.find((frame) => scenes.get(frame.ts_ms) === 'unrelated person appears');
  assert.equal(later.pre_ignition_verified, false);
  assert.equal(later.roles.includes('onset'), false);
  assert.ok(selected.every((frame) => !('scene' in frame) && !('cause' in frame)));
  assert.deepEqual(state.pre_onset, [], 'stream starts with flame, not pre-ignition context');
});

test('an unreliable observed maximum stays weak/degraded rather than becoming a hazard or a reliable peak', () => {
  let state = append(createEvidenceState(), 0, 20);
  state = append(state, 1, 95, 'snap:1', { visibility: 'degraded', detections: [{
    cls: 'fire', conf: 0.1, bbox_xyxy: [0, 0, 95, 100],
  }] });
  state = append(state, 2, 80);
  const peak = selectEvidence(state).find((frame) => frame.roles.includes('peak'));
  assert.equal(peak.frame_id, 'frame-1');
  assert.equal(peak.peak_scope, 'observed_so_far');
  assert.equal(peak.area_fraction, 0.95);
  assert.equal(peak.area_reliable, false);
  assert.equal(peak.fire_evidence, 'weak');
  assert.equal(peak.confidence, 0.1);
  assert.equal(peak.visibility, 'degraded');
  for (const field of ['hazard', 'risk', 'severity', 'physical_area', 'ignition_verified']) {
    assert.equal(field in peak, false);
  }
  const protectedResult = protectEvidence(state); // confirmation at t=2
  const later = append(protectedResult.state, 3, 99);
  assert.equal(selectEvidence(later).find((frame) => frame.roles.includes('peak')).frame_id, 'frame-3');
  assert.deepEqual(protectEvidence(later).selection, protectedResult.selection,
    'a future maximum must not rewrite evidence already submitted for confirmation');
});

test('missing adjacent images never borrow convenient frames or fabricate missing onset and peak', () => {
  const cases = [
    { rows: [[0, null, 'snap:0'], [1, null, null], [2, 20, null],
      [3, 30, 'snap:3'], [4, 90, null], [5, 10, 'snap:5']],
    expected: [[0, ['early']], [3, ['early', 'context_after_onset']], [5, ['recent']]] },
    { rows: [[0, null, 'snap:0'], [1, null, 'snap:1'], [2, 20, 'snap:2'],
      [3, 30, null], [4, 90, null], [5, 10, 'snap:5']],
    expected: [[0, ['early']], [1, ['early', 'context_before_onset']],
      [2, ['onset']], [5, ['recent']]] },
  ];
  for (const { rows, expected } of cases) {
    let state = createEvidenceState();
    for (const [ts, area, key] of rows) state = append(state, ts, area, key);
    const selected = selectEvidence(state);
    assert.deepEqual(selected.map((frame) => [frame.ts_ms, frame.roles]), expected);
    assert.equal(state.onset.ts_ms, 2);
    assert.equal(state.peak.ts_ms, 4);
    assert.ok(selected.every((frame) => frame.peak_scope === null && !frame.pre_ignition_verified));
  }
});

test('1000 frames preserve adjacent context and one job pack under the 24-key budget across JSON restart', () => {
  let state = createEvidenceState();
  let original;
  const liveImages = new Set();
  for (let ts = 0; ts < 1000; ts++) {
    const area = ts < 500 ? null : ts === 550 ? 80 : ts === 750 ? 90 : 10;
    const key = `snap:${ts}`;
    liveImages.add(key);
    const result = appendEvidence(state, observation(ts, area), key);
    assert.equal(result.accepted, true);
    state = result.state;
    for (const retired of result.retired_keys) assert.equal(liveImages.delete(retired), true);
    assert.deepEqual([...liveImages].sort(), state.snapshots.map((frame) => frame.snapshot_key).sort());
    assert.ok(liveImages.size <= 24);
    assert.ok(state.history.length <= 120);
    assert.ok(state.pre_onset.length <= 2);
    const selection = selectEvidence(state);
    assert.ok(selection.length <= 6);
    assert.equal(new Set(selection.map((frame) => frame.frame_id)).size, selection.length);
    assert.deepEqual(selection.map((frame) => frame.ts_ms),
      selection.map((frame) => frame.ts_ms).sort((a, b) => a - b));
    if (ts === 600) {
      const pinned = protectEvidence(state);
      original = pinned.selection;
      state = JSON.parse(JSON.stringify(pinned.state));
    }
    if (original) {
      assert.deepEqual(protectEvidence(state).selection, original);
      for (const frame of original) assert.ok(liveImages.has(frame.snapshot_key));
    }
  }
  assert.deepEqual(state.pre_onset.map((frame) => frame.ts_ms), [498, 499]);
  assert.deepEqual(selectEvidence(state).map((frame) => frame.ts_ms), [0, 499, 500, 501, 750, 999]);
  assert.deepEqual(original.map((frame) => frame.ts_ms), [0, 499, 500, 501, 550, 600]);
  const restoredPin = protectEvidence(JSON.parse(JSON.stringify(state)));
  assert.ok(Object.isFrozen(restoredPin.selection[0].frame_wh));
  assert.deepEqual(restoredPin.selection, original);
  assert.equal(releaseEvidence(state, { archived: true }).state.protected_selection, null);
  const fresh = append(createEvidenceState(), 1000, 10);
  assert.deepEqual(fresh.pre_onset, []);
  assert.equal(fresh.onset.ts_ms, 1000, 'incident reset cannot inherit old onset or a job pack');
  assert.equal(fresh.protected_selection, null);
});

test('fractional timestamps keep deterministic frame IDs and rejected timestamps cannot change context', () => {
  let state = append(createEvidenceState(), 0.25, null);
  state = append(state, 10.5, 20);
  state = append(state, 20.75, 80);
  const before = JSON.stringify(state);
  for (const ts of [20.75, 10.5, 5]) {
    const result = appendEvidence(state, observation(ts, 99), `unused:${ts}`);
    assert.equal(result.accepted, false);
    assert.strictEqual(result.state, state);
    assert.equal(JSON.stringify(result.state), before);
    assert.deepEqual(result.retired_keys, [`unused:${ts}`]);
  }
  assert.deepEqual(selectEvidence(state).map((frame) => [frame.frame_id, frame.ts_ms, frame.roles]), [
    ['frame-0.25', 0.25, ['early', 'context_before_onset']],
    ['frame-10.5', 10.5, ['early', 'onset']],
    ['frame-20.75', 20.75, ['context_after_onset', 'peak', 'recent']],
  ]);
});

test('malformed optional frame dimensions are rejected instead of throwing or storing unbounded metadata', () => {
  const state = createEvidenceState();
  for (const frame_wh of [{}, '100x100', [], [100, 100, 100], [0, 100],
    [1.5, 100], [Infinity, 100], [Number.MAX_SAFE_INTEGER, 2]]) {
    const input = { ...observation(0, 20), frame_wh };
    const result = appendEvidence(state, input, 'unused:invalid-dimensions');
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'invalid_observation');
    assert.strictEqual(result.state, state);
    assert.deepEqual(result.retired_keys, ['unused:invalid-dimensions']);
  }
  for (const frame_wh of [undefined, null]) {
    const state = appendEvidence(createEvidenceState(), { ...observation(0, 20), frame_wh }, 'snap:0').state;
    assert.equal('frame_wh' in selectEvidence(state)[0], false, 'optional dimensions stay absent when unavailable');
  }
});

test('near-onset context outranks a second distant early frame in the six-frame confirmation pack', () => {
  let state = createEvidenceState();
  for (let ts = 0; ts <= 80; ts++) {
    state = append(state, ts, ts < 40 ? null : ts === 43 ? 90 : 10);
  }
  assert.deepEqual(state.pre_onset?.map((frame) => frame.ts_ms), [38, 39]);
  assert.equal(state.onset_successor.ts_ms, 41);
  assert.deepEqual(selectEvidence(state).map((frame) => [frame.ts_ms, frame.roles]), [
    [0, ['early']], [39, ['context_before_onset']], [40, ['onset']],
    [41, ['context_after_onset']], [43, ['peak']], [80, ['recent']],
  ]);
  assert.ok(state.snapshots.some((frame) => frame.snapshot_key === 'snap:39'));
  assert.ok(state.snapshots.some((frame) => frame.snapshot_key === 'snap:41'));
});

test('later investigation selects a fresh, time-spread post-confirmation sequence', () => {
  let state = createEvidenceState();
  for (let ts = 0; ts <= 12000; ts += 333) state = append(state, ts, 10);
  const selection = selectLaterEvidence(state, 5000, 12000);
  assert.equal(selection.length, 6);
  assert.ok(selection.every(frame => frame.ts_ms > 5000 && frame.ts_ms <= 12000));
  assert.ok(selection.at(-1).ts_ms >= 11000, 'follow-up should use current scene evidence');
  assert.ok(selection.at(-1).ts_ms - selection[0].ts_ms >= 2000);
  assert.ok(selection.every(frame => frame.roles.includes('followup_context')));
  assert.ok(selection.at(-1).roles.includes('recent'));
});

test('later investigation waits when post-confirmation evidence is sparse or stale', () => {
  let state = createEvidenceState();
  for (const ts of [0, 1000, 2000, 3000]) state = append(state, ts, 10);
  assert.equal(selectLaterEvidence(state, 1000, 3000), null, 'two post-confirmation images do not make a sequence');
  assert.equal(selectLaterEvidence(state, 500, 6000), null, 'old images do not count as current scene evidence');
});

test('first fire at stream start has real frame IDs and measured metadata, never invented preroll', () => {
  const input = observation(0, 20);
  const state = appendEvidence(createEvidenceState(), input, 'snap:0').state;
  const selected = selectEvidence(state);
  assert.deepEqual(selected, [{
    frame_id: 'frame-0', ts_ms: 0, snapshot_key: 'snap:0',
    roles: ['early', 'onset', 'peak', 'recent'],
    pre_ignition_verified: false, peak_scope: 'observed_so_far',
    fire_evidence: 'strong', smoke_evidence: 'not_detected',
    confidence: 0.8, area_px: 2000, area_fraction: 0.2,
    area_reliable: true, visibility: 'adequate', frame_wh: [100, 100],
  }]);
  input.frame_wh[0] = 999;
  assert.deepEqual(state.onset.frame_wh, [100, 100], 'no alias to input dimensions');
  assert.equal(Object.isFrozen(selected[0].frame_wh), true);
  assert.throws(() => { selected[0].frame_wh[0] = 777; }, TypeError);
  state.snapshots[0].frame_wh[0] = 888;
  assert.deepEqual(selected[0].frame_wh, [100, 100], 'selection cannot alias mutable state');
});
