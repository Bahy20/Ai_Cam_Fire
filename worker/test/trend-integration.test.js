import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraDO } from '../src/camera-do.js';

function harness() {
  const events = [];
  const camera = new CameraDO({
    storage: { get: async () => null, delete: async () => {} },
    getWebSockets: () => [{ send: text => {
      const wire = JSON.parse(text);
      events.push(...(Array.isArray(wire) ? wire : [wire]));
    } }],
  }, { DB: { prepare: () => ({ bind: () => ({ run: async () => {} }) }) } });
  return { camera, events, last: () => events.filter(e => ['fire_confirmed', 'fire_update'].includes(e.type)).at(-1) };
}
function frame(ts_ms, width = 10, extra = {}) {
  return { ts_ms, frame_wh: [100, 100], visibility: 'adequate',
    detections: width === null ? [] : [{ cls: 'fire', conf: 0.8, bbox_xyxy: [0, 0, width, 100] }], ...extra };
}
function confirm(h, widths = [10, 20, 30, 40, 50], extra = {}) {
  widths.forEach((width, i) => h.camera.ingest(frame(i * 1000, width, extra), 'trend-cam'));
  assert.equal(h.camera.alert, 'confirmed');
}
async function state(h) {
  return (await h.camera.fetch(new Request('https://do/trend-cam'))).json();
}

// Behavior changes below were introduced in individual RED -> GREEN slices.
test('recovery after more than two seconds without reliable area cannot bridge a measurement gap', () => {
  const h = harness();
  confirm(h, [90, 80, 70, 60, 50]);
  h.camera.ingest(frame(5000, null), 'trend-cam');
  h.camera.ingest(frame(6000, 10, { visibility: 'degraded' }), 'trend-cam');
  h.camera.ingest(frame(7000, 20), 'trend-cam');
  assert.equal(h.last().visual_activity, 'unknown');
  assert.equal(h.last().trend_sample_count, 1);
  assert.ok(h.last().trend_limitations.includes('reliable_observation_gap_reset'));
});

test('emitted footprint uses clipped normalized union, never duplicate-box sums or box count as spread', async () => {
  const single = harness();
  const duplicate = harness();
  confirm(single);
  confirm(duplicate);
  const box = { cls: 'fire', conf: 0.8, bbox_xyxy: [-10, 0, 50, 100], area_px: 999999 };
  single.camera.ingest(frame(5000, 50, { detections: [box] }), 'trend-cam');
  duplicate.camera.ingest(frame(5000, 50, { detections: [box, box, box] }), 'trend-cam');
  for (const payload of [single.last(), duplicate.last(), await state(duplicate)]) {
    assert.equal(payload.area_px, 5000);
    assert.equal(payload.area_fraction, 0.5);
    assert.equal(payload.area_reliable, true);
    assert.deepEqual(payload.frame_wh, [100, 100]);
    assert.equal(payload.severity, 'unknown');
    assert.ok(payload.severity_details.limitations.includes('spatial_spread_not_assessed'));
    assert.ok(!payload.severity_details.reasons.some(reason => reason.startsWith('multiple_spots')));
  }
  assert.equal(single.last().normalized_rate_per_s, duplicate.last().normalized_rate_per_s);
});

test('actual shrinking or missed evidence never becomes low hazard without independently validated context', async () => {
  const h = harness();
  confirm(h, [90, 80, 70, 60, 50]);
  const confirmed = h.last();
  h.camera.ingest(frame(5000, 1, { detections: [{ cls: 'fire', conf: 0.1, bbox_xyxy: [0, 0, 1, 1] }] }), 'trend-cam');
  for (const payload of [confirmed, h.last(), await state(h)]) {
    assert.equal(payload.severity, 'unknown');
    assert.equal(payload.hazard_level, 'unknown');
    assert.equal(payload.advisory_only, true);
    assert.equal(payload.severity_details.confidence, 'low');
    assert.equal(payload.severity_details.score, null);
    assert.ok(payload.severity_details.limitations.includes('fuel_scale_exposure_not_assessed'));
    assert.ok(payload.severity_details.limitations.includes('visual_activity_does_not_establish_hazard'));
    assert.ok(!payload.severity_details.reasons.includes('flash_burn_collapsing'));
  }
});

test('updates and snapshots retire endpoint pixel growth rather than calling it spreading', async () => {
  const h = harness();
  confirm(h);
  h.camera.ingest(frame(5000, 60), 'trend-cam');
  h.camera.ingest(frame(6000, 70), 'trend-cam');
  for (const payload of [h.last(), await state(h)]) {
    assert.equal(payload.visual_activity, 'growing');
    assert.equal(payload.growth_rate_px_per_s, null);
    assert.equal(payload.growth_rate_deprecated, true);
    assert.equal(payload.trend, 'growing');
    assert.equal(payload.trend_deprecated, true);
  }
  assert.ok(!('areaHistory' in h.camera.fire), 'no unbounded incident-long pixel history');
});

test('only a positive camera motion flag invalidates the entire recent window, including missed frames', () => {
  for (const detections of [undefined, []]) {
    const h = harness();
    confirm(h, undefined, { camera_motion: false });
    assert.equal(h.last().trend_limitations.includes('camera_motion_not_assessed'), false,
      'explicit stationary metadata is assessed; only omitted motion is unknown');
    h.camera.ingest(frame(5000, 60, { camera_motion: true, ...(detections ? { detections } : {}) }), 'trend-cam');
    assert.equal(h.last().visual_activity, 'unknown');
    assert.equal(h.last().normalized_rate_per_s, null);
    assert.ok(h.last().trend_limitations.includes('camera_motion'));
    h.camera.ingest(frame(6000, 70, { camera_motion: false }), 'trend-cam');
    assert.equal(h.last().visual_activity, 'unknown');
    for (let ts = 7000; ts <= 14000; ts += 1000) h.camera.ingest(frame(ts, 70), 'trend-cam');
    assert.equal(h.last().visual_activity, 'steady');
    assert.ok(h.last().trend_limitations.includes('camera_motion_not_assessed'));
  }
});

test('gaps and dimension changes reset trend before collecting fresh support', () => {
  for (const [ts, extra, reason] of [
    [6001, {}, 'observation_gap_reset'],
    [5000, { frame_wh: [200, 100] }, 'frame_dimensions_changed'],
  ]) {
    const h = harness();
    confirm(h);
    h.camera.ingest(frame(ts, 30, extra), 'trend-cam');
    assert.equal(h.last().visual_activity, 'unknown');
    assert.equal(h.last().normalized_rate_per_s, null);
    assert.equal(h.last().trend_sample_count, 1);
    assert.ok(h.last().trend_limitations.includes(reason));
    h.camera.ingest(frame(ts + 1000, 40, extra), 'trend-cam');
    assert.equal(h.last().visual_activity, 'unknown');
    h.camera.ingest(frame(ts + 2000, 50, extra), 'trend-cam');
    assert.equal(h.last().visual_activity, 'growing');
    assert.equal(h.last().trend_sample_count, 3);
  }
});

test('delayed timestamps leave the actual trend and latest assessment unchanged', () => {
  const h=harness(); confirm(h);
  const before=structuredClone(h.camera.trendWindow);
  const event=h.last();
  const result=h.camera.ingest(frame(3500,99),'trend-cam');
  assert.deepEqual(result.published,[]);
  assert.deepEqual(h.camera.trendWindow,before);
  assert.equal(h.last(),event);
});

test('trend window expires observations older than eight seconds inclusively', () => {
  const h = harness();
  confirm(h);
  for (let ts = 5000; ts <= 12000; ts += 1000) h.camera.ingest(frame(ts, 50), 'trend-cam');
  assert.equal(h.camera.trendWindow[0].ts, 4000);
  assert.equal(h.last().trend_sample_count, 9);
  assert.equal(h.last().visual_activity, 'steady');
});

test('recent trend is capped at 24 observations rather than incident lifetime', () => {
  const h = harness();
  confirm(h);
  for (let i = 1; i <= 100; i++) h.camera.ingest(frame(4000 + i * 100, 50 - i * 0.2), 'trend-cam');
  assert.equal(h.last().visual_activity, 'shrinking');
  assert.equal(h.last().trend_sample_count, 24);
  assert.equal(h.camera.trendWindow.length, 24);
});

test('actual confirmation uses normalized preconfirmation history in WebSocket and HTTP state', async () => {
  const h = harness();
  confirm(h);
  const event = h.last();
  assert.equal(event.type, 'fire_confirmed');
  assert.equal(event.visual_activity, 'growing');
  assert.ok(Math.abs(event.normalized_rate_per_s - 0.1) < 1e-12);
  assert.equal(event.trend_confidence, 'medium');
  assert.equal(event.trend_sample_count, 5);
  assert.ok(event.trend_limitations.includes('visual_footprint_not_physical_growth_or_hazard'));
  assert.ok(event.trend_limitations.includes('camera_motion_not_assessed'));
  const snapshot = await state(h);
  for (const key of ['visual_activity', 'normalized_rate_per_s', 'trend_confidence', 'trend_sample_count', 'trend_limitations']) {
    assert.deepEqual(snapshot[key], event[key], key);
  }
});

test('a currently missing, weak or poorly visible observation cannot repeat a stale shrinking claim', async () => {
  for (const extra of [
    { detections: [] },
    { detections: [{ cls: 'fire', conf: 0.249, bbox_xyxy: [0, 0, 1, 1] }] },
    { visibility: 'degraded' },
    { detections: [{ cls: 'fire', conf: 0.8, bbox_xyxy: [0, 0, 20, 100] },
      { cls: 'fire', conf: 0.1, bbox_xyxy: [0, 0, 2, 2] }] },
  ]) {
    const h = harness();
    confirm(h, [90, 80, 70, 60, 50]);
    assert.equal(h.last().visual_activity, 'shrinking');
    h.camera.ingest(frame(5000, 10, extra), 'trend-cam');
    assert.equal(h.last().type, 'fire_update');
    assert.equal(h.last().visual_activity, 'unknown');
    assert.equal(h.last().normalized_rate_per_s, null);
    assert.equal(h.last().trend_confidence, 'low');
    assert.ok(h.last().trend_limitations.includes('current_fire_area_unreliable'));
    assert.equal((await state(h)).visual_activity, 'unknown');
    assert.equal(h.camera.trendWindow.at(-1).reliable, false);
    assert.notEqual(h.camera.trendWindow.at(-1).area_ratio, 0);
  }
});

// Additional boundary regressions for the behavior slices above.
test('actual POST ingress preserves response shape and accepts the exact 0.25 reliability boundary', async () => {
  const h = harness();
  let response;
  for (let i = 0; i < 5; i++) {
    response = await h.camera.fetch(new Request('https://do/trend-cam', { method: 'POST',
      body: JSON.stringify(frame(i * 1000, 10 + i * 10, {
        detections: [{ cls: 'fire', conf: 0.25, bbox_xyxy: [0, 0, 10 + i * 10, 100] }],
      })) }));
    assert.equal(response.status, 200);
  }
  assert.deepEqual(await response.json(), { alert: 'confirmed', hits: 5, published: ['fire_confirmed'] });
  assert.equal(h.last().visual_activity, 'growing');
  assert.equal(h.last().area_reliable, true);
});

test('real persistent confirmation does not turn weak candidate area into measured zero', () => {
  const h = harness();
  for (let i = 0; i < 24; i++) h.camera.ingest(frame(i * 500, 20, {
    detections: [{ cls: 'fire', conf: 0.08, bbox_xyxy: [0, 0, 20, 100] }],
  }), 'trend-cam');
  assert.equal(h.last().type, 'fire_confirmed');
  assert.equal(h.last().lane, 'persistent');
  assert.equal(h.last().area_px, 2000);
  assert.equal(h.last().area_reliable, false);
  assert.equal(h.last().visual_activity, 'unknown');
  assert.equal(h.last().normalized_rate_per_s, null);
  assert.equal(h.last().severity, 'unknown');
});

test('real confirmation cannot bypass minimum distinct timestamps or two-second trend support', () => {
  const duplicate = harness();
  for (let i = 0; i < 5; i++) duplicate.camera.ingest(frame(0, 10 + i), 'trend-cam');
  assert.equal(duplicate.camera.alert, 'idle');
  assert.equal(duplicate.last(), undefined, 'retries cannot confirm or inflate temporal support');
  assert.equal(duplicate.camera.trendWindow.length, 1);
  const h = harness();
  for (let i = 0; i < 5; i++) h.camera.ingest(frame(i * 100, 10 + i), 'trend-cam');
  assert.equal(h.last().type, 'fire_confirmed');
  assert.equal(h.last().visual_activity, 'unknown');
  assert.equal(h.last().normalized_rate_per_s, null);
  assert.equal(h.last().trend_sample_count, 5);
  assert.ok(h.last().trend_limitations.includes('insufficient_time_support'));
});

test('identical frame fractions have identical rates across fixed camera resolutions', () => {
  const a = harness();
  const b = harness();
  confirm(a);
  confirm(b, [20, 40, 60, 80, 100], { frame_wh: [200, 100] });
  assert.equal(a.last().normalized_rate_per_s, b.last().normalized_rate_per_s);
  assert.equal(a.last().visual_activity, b.last().visual_activity);
  assert.equal(b.last().area_px, 10000);
});

test('a single excluded middle observation reduces confidence without being a reliable zero', () => {
  const h = harness();
  confirm(h);
  h.camera.ingest(frame(5000, null), 'trend-cam');
  h.camera.ingest(frame(6000, 70), 'trend-cam');
  assert.equal(h.last().visual_activity, 'growing');
  assert.equal(h.last().trend_confidence, 'low');
  assert.ok(Math.abs(h.last().normalized_rate_per_s - 0.1) < 1e-12);
  assert.equal(h.camera.trendWindow.find(sample => sample.ts === 5000).area_ratio, null);
});
