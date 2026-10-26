import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTrend } from '../src/trend.js';
import { normalizeObservation } from '../src/observations.js';

// These synthetic measurements explicitly have verified visibility. Legacy callers
// omitting visibility are tested separately and must not inherit that assumption.
const observation = (ts, area_ratio, extra = {}) => ({
  ts, area_ratio, reliable: true, visibility: 'adequate', ...extra,
});

test('normalizer-qualified positive fire footprints work through legacy helper inputs without claiming visibility', () => {
  const observations = [10, 20, 30].map((width, i) => normalizeObservation({
    ts_ms: i * 1000, frame_wh: [100, 100],
    detections: [{ cls: 'fire', conf: 0.8, bbox_xyxy: [0, 0, width, 100] }],
  }));
  assert.ok(observations.every((sample) => sample.visibility === 'unknown'));
  // Same three fields currently routed by CameraDO; visibility must default to
  // unverified, not silently adequate, when the caller has not carried it yet.
  const result = estimateTrend(observations.map((sample) => ({
    ts: sample.ts_ms, area_ratio: sample.fire.area_fraction, reliable: sample.fire.area_reliable,
  })));
  assert.equal(result.visual_activity, 'growing');
  assertRate(result.normalized_rate_per_s, 0.1);
  assert.equal(result.sample_count, 3);
  assert.equal(result.confidence, 'low');
  assert.ok(result.limitations.includes('visibility_unverified'));
});

function assertRate(actual, expected, tolerance = 1e-12) {
  assert.ok(Number.isFinite(actual), `expected finite rate, got ${actual}`);
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `expected ${expected}, got ${actual}`);
}

// Regression coverage for the positive-only path above: these cases exercise
// existing gates after the RED/GREEN tracer bullets, without new production code.
test('unknown visibility supports observed steady and shrinking positive fire footprints, not safety conclusions', () => {
  for (const [widths, activity, rate] of [
    [[20, 20, 20], 'steady', 0],
    [[30, 20, 10], 'shrinking', -0.1],
  ]) {
    const samples = widths.map((width, i) => normalizeObservation({
      ts_ms: i * 1000, frame_wh: [100, 100],
      detections: [{ cls: 'fire', conf: 0.8, bbox_xyxy: [0, 0, width, 100] }],
    }));
    const result = estimateTrend(samples.map((sample) => ({
      ts: sample.ts_ms, area_ratio: sample.fire.area_fraction,
      reliable: sample.fire.area_reliable, visibility: sample.visibility,
    })));
    assert.equal(result.visual_activity, activity);
    assertRate(result.normalized_rate_per_s, rate);
    assert.equal(result.confidence, 'low');
    assert.ok(result.limitations.includes('visibility_unverified'));
    assert.ok(result.limitations.includes('footprint_change_not_extinction_or_safety'));
    for (const claim of ['safe', 'extinguished', 'hazard_assessment', 'recommended_agent']) {
      assert.equal(claim in result, false);
    }
  }
});

test('normalizer misses and weak or mixed-confidence boxes cannot become measured footprint decline', () => {
  for (const detections of [
    [],
    [{ cls: 'smoke', conf: 0.9, bbox_xyxy: [0, 0, 10, 100] }],
    [{ cls: 'fire', conf: 0.1, bbox_xyxy: [0, 0, 10, 100] }],
    [{ cls: 'fire', conf: 0.8, bbox_xyxy: [0, 0, 10, 100] },
      { cls: 'fire', conf: 0.1, bbox_xyxy: [20, 0, 30, 100] }],
  ]) {
    const samples = [
      { ts_ms: 0, detections: [{ cls: 'fire', conf: 0.8, bbox_xyxy: [0, 0, 30, 100] }] },
      { ts_ms: 1000, detections: [{ cls: 'fire', conf: 0.8, bbox_xyxy: [0, 0, 20, 100] }] },
      { ts_ms: 2000, detections },
    ].map((sample) => normalizeObservation({ frame_wh: [100, 100], ...sample }));
    assert.equal(samples[2].fire.area_reliable, false);
    const result = estimateTrend(samples.map((sample) => ({
      ts: sample.ts_ms, area_ratio: sample.fire.area_fraction,
      reliable: sample.fire.area_reliable, visibility: sample.visibility,
    })));
    assertUnknown(result, 2);
    assert.ok(result.limitations.includes('visibility_unverified'));
  }
});

test('normalized degraded visibility and reported motion reach the helper as blocking warnings', () => {
  for (const warning of [{ visibility: 'degraded' }, { camera_motion: true }]) {
    const samples = [10, 20, 30, 40].map((width, i) => normalizeObservation({
      ts_ms: i * 1000, frame_wh: [100, 100],
      detections: [{ cls: 'fire', conf: 0.8, bbox_xyxy: [0, 0, width, 100] }],
      ...(i === 1 ? warning : {}),
    }));
    const result = estimateTrend(samples.map((sample) => ({
      ts: sample.ts_ms, area_ratio: sample.fire.area_fraction,
      reliable: sample.fire.area_reliable, visibility: sample.visibility,
      camera_motion: sample.camera_motion,
    })));
    assertUnknown(result, warning.camera_motion ? 4 : 3);
    assert.ok(result.limitations.includes(warning.camera_motion ? 'camera_motion' : 'degraded_visibility'));
  }
});

test('fits normalized footprint growth from at least three reliable event times', () => {
  const result = estimateTrend([
    observation(0, 0.1), observation(1000, 0.12), observation(2000, 0.14),
  ]);
  assert.equal(result.visual_activity, 'growing');
  assertRate(result.normalized_rate_per_s, 0.02);
  assert.equal(result.confidence, 'medium');
  assert.equal(result.sample_count, 3);
  assert.ok(Array.isArray(result.limitations));
  assert.ok(result.limitations.includes('visual_footprint_not_physical_growth_or_hazard'));
});

test('classifies flat, subthreshold, and shrinking footprints symmetrically', () => {
  for (const [ratios, activity, rate] of [
    [[0.2, 0.2, 0.2], 'steady', 0],
    [[0.2, 0.2005, 0.201], 'steady', 0.0005],
    [[0.2, 0.1995, 0.199], 'steady', -0.0005],
    [[0.2, 0.18, 0.16], 'shrinking', -0.02],
  ]) {
    const result = estimateTrend(ratios.map((ratio, i) => observation(i * 1000, ratio)));
    assert.equal(result.visual_activity, activity);
    assertRate(result.normalized_rate_per_s, rate);
  }
});

test('supports an explicit nonnegative slope threshold in fraction per second', () => {
  const history = [observation(0, 0), observation(1000, 0.002), observation(2000, 0.004)];
  assert.equal(estimateTrend(history, { slope_threshold_per_s: 0.003 }).visual_activity, 'steady');
  assert.equal(estimateTrend(history, { slope_threshold_per_s: 0 }).visual_activity, 'growing');
  for (const threshold of [-1, NaN, Infinity, '0.001', null]) {
    assert.throws(() => estimateTrend(history, { slope_threshold_per_s: threshold }), RangeError);
  }
});

test('fits all samples rather than only comparing endpoints', () => {
  const result = estimateTrend([
    observation(0, 0.1), observation(1000, 0.2),
    observation(2000, 0.1), observation(4000, 0.1),
  ]);
  assert.equal(result.visual_activity, 'shrinking');
  assertRate(result.normalized_rate_per_s, -3 / 350);
});

function assertUnknown(result, sampleCount) {
  assert.equal(result.visual_activity, 'unknown');
  assert.equal(result.normalized_rate_per_s, null);
  assert.equal(result.confidence, 'low');
  assert.equal(result.sample_count, sampleCount);
}

test('requires three distinct timestamps and at least 2000 ms of support', () => {
  for (const [history, count] of [
    [[], 0],
    [[observation(0, 0.1)], 1],
    [[observation(0, 0.1), observation(3000, 0.2)], 2],
    [[observation(0, 0.1), observation(1000, 0.2), observation(1999, 0.3)], 3],
    [[observation(0, 0.1), observation(0, 0.2), observation(2000, 0.3)], 2],
    [[observation(0, 0.1), observation(0, 0.2), observation(0, 0.3)], 1],
  ]) assertUnknown(estimateTrend(history), count);
});

test('duplicate timestamps share one averaged footprint and cannot overweight the fit', () => {
  const result = estimateTrend([
    observation(0, 0.1), observation(1000, 0.1),
    observation(1000, 0.2), observation(1000, 0.3), observation(2000, 0.3),
  ]);
  assertRate(result.normalized_rate_per_s, 0.1);
  assert.equal(result.sample_count, 3);
  assert.equal(result.confidence, 'low');
  assert.ok(result.limitations.includes('duplicate_timestamps_averaged'));
});

test('missed or low-confidence middle observations are excluded, not converted to zero', () => {
  for (const middle of [
    { ts: 1000, reliable: true },
    observation(1000, 0, { reliable: false }),
    { ts: 1000, area_ratio: 0 },
    observation(1000, 0, { reliable: 'true' }),
  ]) {
    assertUnknown(estimateTrend([observation(0, 0.2), middle, observation(2000, 0.2)]), 2);
    const result = estimateTrend([
      observation(0, 0.2), middle, observation(2000, 0.2), observation(3000, 0.2),
    ]);
    assert.equal(result.visual_activity, 'steady');
    assertRate(result.normalized_rate_per_s, 0);
    assert.equal(result.sample_count, 3);
    assert.equal(result.confidence, 'low');
  }
});

test('rejects invalid timestamps, ratios, and malformed observations without coercion', () => {
  const invalid = [
    null, undefined, [], 5, {},
    ...[undefined, null, NaN, Infinity, -Infinity, -0.1, 1.1, '0.2'].map((ratio) => observation(1000, ratio)),
    ...[undefined, null, NaN, Infinity, -Infinity, '1000'].map((ts) => observation(ts, 0.2)),
  ];
  for (const sample of invalid) {
    const result = estimateTrend([observation(0, 0.2), sample, observation(2000, 0.2)]);
    assertUnknown(result, 2);
    assert.ok(result.limitations.includes('invalid_observations_excluded'));
  }
  for (const history of [undefined, null, {}, 'bad history']) assertUnknown(estimateTrend(history), 0);
});

test('accepts explicit reliable zero and unit footprints as real measurements', () => {
  const result = estimateTrend([observation(0, 0), observation(1000, 0.5), observation(2000, 1)]);
  assert.equal(result.visual_activity, 'growing');
  assertRate(result.normalized_rate_per_s, 0.5);
  assert.equal(result.confidence, 'medium');
});

test('unverified visibility excludes zero footprints even if callers mark them reliable', () => {
  for (const visibility of [undefined, 'unknown']) {
    const result = estimateTrend([
      observation(0, 0.2, { visibility }),
      observation(1000, 0.1, { visibility }),
      observation(2000, 0, { visibility }),
    ]);
    assertUnknown(result, 2);
    assert.ok(result.limitations.includes('visibility_unverified'));
    assert.ok(result.limitations.includes('unreliable_observations_excluded'));
    assert.ok(result.limitations.includes('footprint_change_not_extinction_or_safety'));
  }
});

test('camera motion anywhere in the selected history invalidates the estimate', () => {
  const baseline = [observation(0, 0.1), observation(1000, 0.2), observation(2000, 0.3)];
  for (const motion of [
    observation(1000, 0.2, { camera_motion: true }),
    observation(1000, 0, { reliable: false, camera_motion: true }),
    { ts: 1000, camera_motion: true },
  ]) {
    const result = estimateTrend([...baseline, motion]);
    assertUnknown(result, 3);
    assert.ok(result.limitations.includes('camera_motion'));
  }
});

test('invalid visibility metadata is excluded rather than treated as verified', () => {
  for (const visibility of [null, false, 0, '', 'clear', 'Adequate', [], {}]) {
    const result = estimateTrend([
      observation(0, 0.1), observation(1000, 0.9, { visibility }),
      observation(2000, 0.2), observation(3000, 0.25),
    ]);
    assert.equal(result.visual_activity, 'growing');
    assertRate(result.normalized_rate_per_s, 0.05);
    assert.equal(result.sample_count, 3);
    assert.equal(result.confidence, 'low');
    assert.ok(result.limitations.includes('invalid_observations_excluded'));
  }
});

test('explicit degraded visibility anywhere in the selected history blocks the estimate', () => {
  const baseline = [observation(0, 0.1), observation(1000, 0.2), observation(2000, 0.3)];
  for (const degraded of [
    observation(1500, 0.2, { visibility: 'degraded' }),
    observation(1500, 0, { reliable: false, visibility: 'degraded' }),
    { ts: 1500, visibility: 'degraded' },
  ]) {
    const result = estimateTrend([...baseline, degraded]);
    assertUnknown(result, 3);
    assert.ok(result.limitations.includes('degraded_visibility'));
  }
});

test('large absolute timestamps preserve the same least-squares estimate', () => {
  for (const offset of [0, 1_800_000_000_000, 8_000_000_000_000_000]) {
    const history = [
      observation(offset + 4000, 0.18), observation(offset, 0.1),
      observation(offset + 1000, 0.12), observation(offset + 2500, 0.15),
    ];
    const before = structuredClone(history);
    const result = estimateTrend(history);
    assert.equal(result.visual_activity, 'growing');
    assertRate(result.normalized_rate_per_s, 0.02);
    assert.equal(result.confidence, 'medium');
    assert.deepEqual(history, before, 'must not sort or alter caller observations');
  }
});

test('unrepresentable regression arithmetic abstains instead of emitting NaN or Infinity', () => {
  const result = estimateTrend([
    observation(-Number.MAX_VALUE, 0.1), observation(0, 0.2),
    observation(Number.MAX_VALUE, 0.3),
  ]);
  assertUnknown(result, 3);
  assert.ok(result.limitations.includes('unstable_time_support'));
});
