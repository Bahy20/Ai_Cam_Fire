import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeObservation } from '../src/observations.js';

const detection = (overrides = {}) => ({
  cls: 'fire', conf: 0.8, bbox_xyxy: [10, 20, 50, 60], ...overrides,
});
function assertInvalid(input, status, path) {
  let actual;
  assert.doesNotThrow(() => { actual = normalizeObservation(input); });
  assert.equal(actual.observation_valid, false, `accepted ${path}: ${String(input)}`);
  assert.equal(actual.http_status, status);
  assert.ok(actual.validation_errors.some((error) => error.startsWith(`${path}:`)),
    JSON.stringify(actual.validation_errors));
  assert.deepEqual(actual.detections, [], 'never partially accept an invalid result');
  assert.equal(actual.fire.area_px, null, 'invalid area must not become zero');
  return actual;
}

const frame = (overrides = {}) => ({
  camera_id: 'cam-01', ts_ms: 1_000, frame_wh: [100, 100],
  detections: [detection()], ...overrides,
});

test('normalizes decoded pixel boxes and recomputes untrusted derived measurements', () => {
  const input = frame({ detections: [detection({
    bbox_xyxy: [-10, 20, 50, 120], area_px: 999_999, centroid_xy: [999, 999],
  })] });
  const original = structuredClone(input);
  const actual = normalizeObservation(input);
  assert.equal(actual.observation_valid, true);
  assert.equal(actual.http_status, 200);
  assert.deepEqual(actual.validation_errors, []);
  assert.equal(actual.ts_ms, 1_000);
  assert.deepEqual(actual.frame_wh, [100, 100]);
  assert.deepEqual(actual.detections, [{
    cls: 'fire', conf: 0.8, bbox_xyxy: [0, 20, 50, 100],
    area_px: 4_000, centroid_xy: [25, 60],
  }]);
  assert.equal(actual.fire.area_px, 4_000);
  assert.equal(actual.fire.area_fraction, 0.4);
  assert.deepEqual(input, original, 'normalizer must not mutate its input');
});

test('rejects non-object result envelopes with a 400-compatible failure', () => {
  for (const input of [undefined, null, [], 'frame', 42, true]) {
    assertInvalid(input, 400, '$');
  }
});

test('requires finite nonnegative event time and positive decoded integer dimensions', () => {
  for (const ts_ms of [undefined, null, '1000', NaN, Infinity, -Infinity, -1]) {
    assertInvalid(frame({ ts_ms }), 422, 'ts_ms');
  }
  for (const frame_wh of [undefined, null, {}, [], [100], [100, 100, 100],
    [0, 100], [-1, 100], [100, 0], [1.5, 100], ['100', 100],
    [NaN, 100], [100, Infinity], [Number.MAX_SAFE_INTEGER, 2]]) {
    assertInvalid(frame({ frame_wh }), 422, 'frame_wh');
  }
  assert.equal(normalizeObservation(frame({ ts_ms: 0 })).observation_valid, true);
  assert.equal(normalizeObservation(frame({ ts_ms: 1.25 })).ts_ms, 1.25);
});

test('requires a detections array and rejects every malformed detection atomically', () => {
  for (const detections of [undefined, null, {}, 'fire']) {
    assertInvalid(frame({ detections }), 422, 'detections');
  }
  for (const bad of [null, [], true, 'fire']) {
    assertInvalid(frame({ detections: [detection(), bad] }), 422, 'detections[1]');
  }
  for (const cls of [undefined, null, 'Fire', 'person', 'spark', 0]) {
    assertInvalid(frame({ detections: [detection({ cls })] }), 422, 'detections[0].cls');
  }
  for (const conf of [undefined, null, '0.8', NaN, Infinity, -Infinity, -0.01, 1.01]) {
    assertInvalid(frame({ detections: [detection({ conf })] }), 422, 'detections[0].conf');
  }
  for (const bbox_xyxy of [undefined, null, {}, [], [1, 2, 3], [1, 2, 3, 4, 5],
    ['1', 2, 3, 4], [NaN, 2, 3, 4], [1, 2, Infinity, 4],
    [50, 20, 10, 60], [10, 60, 50, 20], [10, 20, 10, 60],
    [10, 20, 50, 20], [-20, 10, -10, 20], [101, 0, 110, 10]]) {
    assertInvalid(frame({ detections: [detection({ bbox_xyxy })] }), 422,
      'detections[0].bbox_xyxy');
  }
  for (const conf of [0, 1]) {
    assert.equal(normalizeObservation(frame({ detections: [detection({ conf })] }))
      .observation_valid, true);
  }
});

for (const [name, boxes, expected] of [
  ['duplicates', [[0, 0, 40, 40], [0, 0, 40, 40]], 1_600],
  ['overlap', [[0, 0, 40, 40], [20, 20, 60, 60]], 2_800],
  ['containment', [[0, 0, 80, 80], [20, 20, 40, 40]], 6_400],
  ['disjoint', [[0, 0, 10, 10], [90, 90, 100, 100]], 200],
  ['cross', [[0, 0, 60, 20], [20, 0, 40, 60], [0, 40, 60, 60]], 2_800],
]) {
  test(`computes box union rather than summed or enclosing area: ${name}`, () => {
    const actual = normalizeObservation(frame({
      detections: boxes.map((bbox_xyxy) => detection({ bbox_xyxy })),
    }));
    assert.equal(actual.fire.area_px, expected);
    assert.equal(actual.fire.area_fraction, expected / 10_000);
    const reversed = normalizeObservation(frame({
      detections: boxes.toReversed().map((bbox_xyxy) => detection({ bbox_xyxy })),
    }));
    assert.equal(reversed.fire.area_px, expected, 'order must not affect union area');
  });
}

test('classifies strong fire independently of smoke and does not infer visibility from decoding', () => {
  const actual = normalizeObservation(frame({ detections: [
    detection({ conf: 0.25 }),
    detection({ cls: 'smoke', conf: 0.7, bbox_xyxy: [0, 0, 100, 100] }),
  ] }));
  assert.equal(actual.visibility, 'unknown');
  assert.deepEqual(actual.fire, {
    evidence_level: 'strong', confidence: 0.25, detection_count: 1,
    area_px: 1_600, area_fraction: 0.16, area_reliable: true,
  });
  assert.deepEqual(actual.smoke, {
    evidence_level: 'strong', confidence: 0.7, detection_count: 1,
    area_px: 10_000, area_fraction: 1, area_reliable: false,
  });
});

test('retains weak candidate footprints including sub-tier boxes without claiming a reliable decline', () => {
  for (const conf of [0.249, 0.08, 0.05, 0]) {
    const actual = normalizeObservation(frame({ detections: [detection({ conf })] }));
    assert.equal(actual.observation_valid, true);
    assert.deepEqual(actual.fire, {
      evidence_level: 'weak', confidence: conf, detection_count: 1,
      area_px: 1_600, area_fraction: 0.16, area_reliable: false,
    });
  }
});

test('valid empty results mean not_detected, with unknown rather than zero measured area', () => {
  const actual = normalizeObservation(frame({ detections: [] }));
  assert.equal(actual.observation_valid, true);
  for (const key of ['fire', 'smoke']) {
    assert.deepEqual(actual[key], {
      evidence_level: 'not_detected', confidence: null, detection_count: 0,
      area_px: null, area_fraction: null, area_reliable: false,
    });
  }
  assert.equal(actual.visibility, 'unknown');
  assert.equal('extinguished' in actual, false);
  assert.equal('safe' in actual, false);
});

test('smoke-only frames preserve residual smoke without measuring flame loss as collapse', () => {
  const actual = normalizeObservation(frame({ detections: [detection({ cls: 'smoke', conf: 0.1 })] }));
  assert.equal(actual.fire.evidence_level, 'not_detected');
  assert.equal(actual.fire.area_px, null);
  assert.equal(actual.fire.area_reliable, false);
  assert.equal(actual.smoke.evidence_level, 'weak');
  assert.equal(actual.smoke.area_px, 1_600);
});

// Reliability here means a measured positive fire-box footprint, not visibility
// verification. The old adequate-only assertion made real detector trends unusable.
test('permits qualified positive fire measurements with unverified visibility but blocks degraded visibility', () => {
  for (const visibility of ['adequate', 'unknown', 'degraded']) {
    const actual = normalizeObservation(frame({ visibility }));
    assert.equal(actual.visibility, visibility);
    assert.equal(actual.fire.area_reliable, visibility !== 'degraded');
    assert.equal(actual.fire.evidence_level, 'strong', 'visibility must not erase positive evidence');
  }
  for (const visibility of [null, false, 1, '', 'clear', 'Adequate', []]) {
    assertInvalid(frame({ visibility }), 422, 'visibility');
  }
  for (const detections of [
    [detection({ conf: 0.1 })],
    [detection(), detection({ conf: 0.1, bbox_xyxy: [60, 60, 90, 90] })],
  ]) {
    const actual = normalizeObservation(frame({ visibility: 'adequate', detections }));
    assert.equal(actual.fire.area_reliable, false,
      'a union containing any weak candidate cannot support confident collapse');
  }
});

test('per-result decode errors are invalid unknown evidence, never clean, even with adequate visibility metadata', () => {
  const inputs = [
    { camera_id: 'cam-01', ts_ms: 1_000, detections: [], error: 'jpeg_decode_failed', inference_ms: 0 },
    frame({ detections: [], error: 'jpeg_decode_failed', visibility: 'adequate' }),
    frame({ error: 'inference_failed' }),
    ...['', false, 0, {}].map((error) => frame({ error })),
  ];
  for (const input of inputs) {
    const actual = assertInvalid(input, 422, 'error');
    assert.equal(actual.visibility, 'degraded');
    for (const key of ['fire', 'smoke']) {
      assert.deepEqual(actual[key], {
        evidence_level: 'unknown', confidence: null, detection_count: 0,
        area_px: null, area_fraction: null, area_reliable: false,
      });
    }
  }
  assert.equal(normalizeObservation(frame({ error: null })).observation_valid, true);
});

test('normalizes only reported camera-motion metadata and leaves missing motion unknown', () => {
  assert.equal(normalizeObservation(frame()).camera_motion, null,
    'decoding/detections cannot establish a stationary camera');
  for (const camera_motion of [true, false, null]) {
    assert.equal(normalizeObservation(frame({ camera_motion })).camera_motion, camera_motion);
  }
  for (const camera_motion of ['true', 'false', 0, 1, {}, []]) {
    assertInvalid(frame({ camera_motion }), 422, 'camera_motion');
  }
  const invalid = normalizeObservation(frame({ ts_ms: -1, camera_motion: false }));
  assert.equal(invalid.camera_motion, null, 'invalid envelopes cannot establish no motion');
});

test('malformed observations expose unknown evidence rather than absence or a fabricated timestamp', () => {
  const actual = assertInvalid(frame({ detections: undefined }), 422, 'detections');
  assert.equal(actual.fire.evidence_level, 'unknown');
  assert.equal(actual.smoke.evidence_level, 'unknown');
  assert.equal(actual.visibility, 'unknown');
  assert.equal(actual.ts_ms, null);
  assert.equal(actual.frame_wh, null);
});

// Additional regression coverage for the dimension/clipping/union tracer bullets above.
// These already-supported cases do not introduce new production behavior.
test('uses decoded portrait dimensions rather than declared source dimensions after resize', () => {
  const actual = normalizeObservation(frame({
    width: 1_920, height: 1_080, frame_wh: [360, 1_080],
    detections: [detection({ bbox_xyxy: [120, -200, 240, 800] })],
  }));
  assert.deepEqual(actual.detections[0].bbox_xyxy, [120, 0, 240, 800]);
  assert.equal(actual.fire.area_px, 96_000);
  assert.equal(actual.fire.area_fraction, 96_000 / (360 * 1_080));
  assert.equal('width' in actual, false, 'do not spread unvalidated input metadata');
  const scaled = normalizeObservation(frame({ frame_wh: [360, 1_080],
    detections: [detection({ bbox_xyxy: [36, 216, 180, 648] })],
  }));
  assert.equal(scaled.fire.area_px, 62_208);
  assert.equal(scaled.fire.area_fraction, 0.16, 'normalized area is resize-independent');
  assertInvalid(frame({ frame_wh: undefined, width: 100, height: 100 }), 422, 'frame_wh');
});

test('preserves fractional coordinates without integer rounding and unions after clipping', () => {
  const fractional = normalizeObservation(frame({
    detections: [detection({ bbox_xyxy: [0.5, 0.5, 1, 1] })],
  }));
  assert.equal(fractional.fire.area_px, 0.25);
  assert.equal(fractional.fire.area_fraction, 0.000025);
  const clipped = normalizeObservation(frame({ detections: [
    detection({ bbox_xyxy: [-50, -50, 100, 100] }),
    detection({ bbox_xyxy: [0, 0, 150, 150] }),
  ] }));
  assert.equal(clipped.fire.area_px, 10_000);
  assert.equal(clipped.fire.area_fraction, 1);
});

test('rejects sparse arrays instead of skipping missing detection or coordinate entries', () => {
  assertInvalid(frame({ detections: Array(1) }), 422, 'detections[0]');
  assertInvalid(frame({ detections: [detection({ bbox_xyxy: Array(4) })] }), 422,
    'detections[0].bbox_xyxy');
  assertInvalid(frame({ frame_wh: Array(2) }), 422, 'frame_wh');
});

test('absence with adequate visibility still has no measured area or extinction assertion', () => {
  const actual = normalizeObservation(frame({ visibility: 'adequate', detections: [] }));
  assert.equal(actual.visibility, 'adequate');
  assert.equal(actual.fire.evidence_level, 'not_detected');
  assert.equal(actual.fire.area_px, null);
  assert.equal(actual.fire.area_fraction, null);
  assert.equal(actual.fire.area_reliable, false);
  assert.equal('extinguished' in actual, false);
  assert.equal('safe' in actual, false);
});

test('normalized arrays never alias the detector input or summaries from other calls', () => {
  const input = frame();
  const first = normalizeObservation(input);
  const second = normalizeObservation(input);
  first.detections[0].bbox_xyxy[0] = 99;
  first.detections[0].centroid_xy[0] = 99;
  first.frame_wh[0] = 99;
  first.fire.confidence = 0;
  assert.deepEqual(input.detections[0].bbox_xyxy, [10, 20, 50, 60]);
  assert.deepEqual(input.frame_wh, [100, 100]);
  assert.deepEqual(second.detections[0].bbox_xyxy, [10, 20, 50, 60]);
  assert.deepEqual(second.detections[0].centroid_xy, [30, 40]);
  assert.equal(second.fire.confidence, 0.8);
});

test('rectangle unions agree with a deterministic independent raster oracle', () => {
  let seed = 17;
  const next = () => { seed = (seed * 16_807) % 2_147_483_647; return seed; };
  for (let sample = 0; sample < 50; sample++) {
    const boxes = Array.from({ length: 6 }, () => {
      const x1 = next() % 12;
      const y1 = next() % 12;
      return [x1, y1, x1 + 1 + next() % (12 - x1), y1 + 1 + next() % (12 - y1)];
    });
    let expected = 0;
    for (let x = 0; x < 12; x++) {
      for (let y = 0; y < 12; y++) {
        if (boxes.some(([x1, y1, x2, y2]) => x >= x1 && x < x2 && y >= y1 && y < y2)) {
          expected++;
        }
      }
    }
    const actual = normalizeObservation(frame({ frame_wh: [12, 12],
      detections: [...boxes, boxes[0]].map((bbox_xyxy) => detection({ bbox_xyxy })),
    }));
    assert.equal(actual.fire.area_px, expected, `raster mismatch in sample ${sample}`);
    assert.ok(actual.fire.area_fraction > 0 && actual.fire.area_fraction <= 1);
  }
});
