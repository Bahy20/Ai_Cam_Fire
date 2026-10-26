import test from 'node:test';
import assert from 'node:assert/strict';
import * as rules from '../src/rules.js';

const input = extra => ({ camera_id: 'cam-a', ts_ms: 2000, detection_status: 'idle',
  observation_valid: true, evidence_current: true, visibility_status: 'adequate',
  camera_motion: false, visual_activity: 'unknown', trend_confidence: 'low',
  trend_sample_count: 0, trend_duration_s: 0, trend_limitations: [],
  smoke_evidence: 'not_detected', ...extra });

// v1's review/urgent_review and raw JSON zone provenance contract is superseded.
// The detailed v2 safety behaviors live in response-priority.test.js.
test('legacy evaluator name and operator_priority are aliases of the single new policy', () => {
  assert.equal(rules.evaluateResponsePriority, rules.assessResponsePriority);
  assert.equal(rules.RESPONSE_PRIORITY_POLICY_VERSION, rules.OPERATIONAL_RESPONSE_POLICY_VERSION);
  for (const detection_status of ['idle', 'watch', 'confirmed']) {
    const result = rules.evaluateResponsePriority(input({ detection_status }));
    assert.equal(result.operator_priority, result.response_priority);
    assert.equal(result.operator_review_required, true);
    assert.equal(result.hazard_level, 'unknown');
  }
});

test('invalid camera/time metadata and conflicting freshness cannot establish clean monitoring', () => {
  for (const extra of [{ ts_ms: NaN }, { ts_ms: '2000' }, { ts_ms: -1 },
    { camera_id: '' }, { camera_id: null }, { evidence_ts_ms: 1000 },
    { evidence_ts_ms: '2000' }, { area_reliable: 'true' }]) {
    const result = rules.assessResponsePriority(input(extra));
    assert.equal(result.response_priority, 'inspect_urgently', JSON.stringify(extra));
    assert.equal(result.assessment_quality, 'invalid');
  }
});

test('legacy model/zone-shaped context cannot gain authority through syntactic review claims', () => {
  const site_context = { schema_version: 1, camera_id: 'cam-a', verified: true,
    verified_by: 'operator', verified_at_ms: 1, valid_until_ms: 10000,
    zones: [{ id: 'zone', type: 'occupied_area', bbox_normalized: [0, 0, 1, 1] }] };
  const result = rules.assessResponsePriority(input({ detection_status: 'confirmed', site_context,
    detections: [{ cls: 'fire', conf: 0.8, bbox_xyxy: [0, 0, 100, 100] }], frame_wh: [100, 100] }));
  assert.equal(result.response_priority, 'inspect_urgently');
  assert.equal(result.context_status, 'rejected');
  assert.ok(result.limitations.includes('spatial_spread_unassessed'));
  assert.equal(rules.evaluateSeverity({ site_context }).score, null);
});