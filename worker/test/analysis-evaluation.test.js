import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {withPersistenceEvidence} from './test-inference-budget.js';
// All in-memory runs and clip names in this file are synthetic unit fixtures.
const moduleUrl = new URL('../../scripts/evaluate_analysis.mjs', import.meta.url);

test('CLI help explains metric eligibility without requiring captured data', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(moduleUrl), '--help'], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--run-dir DIR/);
  assert.match(result.stdout, /confirmed positives/);
  assert.match(result.stdout, /independent causal corpus/);
  assert.match(result.stdout, /confirmation:null/);
});

test('provided positive-clip policy labels use current priority without inventing onset or causal truth', () => {
  const labels = JSON.parse(readFileSync(new URL('../../scripts/evaluation/analysis-policy-labels.json', import.meta.url), 'utf8'));
  assert.equal(labels.clips.length, 3);
  for (const label of labels.clips.slice(0, 2)) {
    assert.equal(label.fire_present, true);
    assert.equal(label.accepted_cause_expected, 'unknown');
    assert.equal(label.priority_expected, 'inspect_urgently');
    assert.equal(label.onset_ms, null);
    assert.equal(label.causal_ground_truth, null);
    assert.match(label.source_sha256, /^[A-F0-9]{64}$/);
    assert.equal(label.source_provenance, 'user_supplied_local');
    assert.ok(Number.isFinite(label.duration_ms) && label.duration_ms > 0);
  }
  const contained = labels.clips.find(label => label.video === '63658-506816251.mp4');
  assert.equal(contained.visible_flame_present, true);
  assert.equal(contained.actionable_fire_present, null);
  assert.equal(contained.priority_expected, 'inspect_urgently');
  assert.equal(contained.priority_with_reviewed_context, 'monitor');
  assert.equal(contained.scene_expected, 'contained_tool_flame');
  assert.equal(contained.causal_ground_truth, null);
  assert.equal(contained.onset_ms, null);
  assert.equal(contained.duration_ms, 11050);
  assert.match(contained.source_sha256, /^[A-F0-9]{64}$/);
  assert.equal(contained.split, 'development');
});

test('analysis evaluation distinguishes unverified hypotheses from accepted cause and never calls policy tests accuracy', async () => {
  assert.ok(existsSync(moduleUrl), 'analysis evaluation tool must exist');
  const {evaluateRuns} = await import(moduleUrl);
  const labels = {version: 1, clips: [{video: 'clip.mp4', fire_present: true,
    accepted_cause_expected: 'unknown', priority_expected: 'inspect_urgently', causal_ground_truth: null,
    onset_ms: null, annotation_basis: 'policy-abstention, not a forensic annotation'}]};
  const current = [withPersistenceEvidence({video: 'clip.mp4', code: 0, agentVerified: true, socketError: null,
    sampled_frames: 3, uploaded_frames: 3, analysisComplete: true, persistedMatch: true,
    analysis_status: {active: false, queued: false, pending_followup: false,
      native_inference_pending: false, latest_job_id: 1}, event_counts: {fire_confirmed: 1},
    event_sequence_start: 0, final_event_watermark: 2, captured_event_sequences: [1, 2],
    confirmation: {ts_ms: 1000, operator_priority: 'inspect_urgently'},
    causes: [{ts_ms: 1000, cause: {ignition_source: 'unknown', probable_cause: 'unknown',
      confidence: 'low', cause_status: 'unverified', model_hypothesis: {ignition_source: 'human'}}}]})];
  const result = evaluateRuns(current, labels);
  assert.equal(result.passed, true);
  assert.equal(result.counts.clips, 1);
  assert.equal(result.counts.accepted_known_causes, 0);
  assert.equal(result.counts.unverified_hypotheses, 1);
  assert.equal(result.cause_accuracy, null);
  assert.ok(result.limitations.includes('causal_ground_truth_unavailable'));
  assert.ok(result.limitations.includes('independent_negative_footage_not_evaluated'));
  const legacy = structuredClone(current);
  legacy[0].causes[0].cause.ignition_source = 'human';
  legacy[0].causes[0].cause.probable_cause = 'human';
  assert.equal(evaluateRuns(legacy, labels).passed, false, 'unverified accepted causation must fail');
  const acceptedAlias = structuredClone(current);
  Object.assign(acceptedAlias[0].causes[0].cause, {accepted_cause: 'human',
    requires_human_review: false, cause_status: 'verified', source: 'human_review'});
  const aliasResult = evaluateRuns(acceptedAlias, labels);
  assert.equal(aliasResult.passed, false, 'accepted_cause alias cannot contradict the unknown policy label');
  assert.ok(aliasResult.results[0].failures.includes('accepted_cause_expectation_failed'));
});

test('analysis evaluation rejects missing/duplicate clips and missing investigations rather than narrowing the requested total', async () => {
  assert.ok(existsSync(moduleUrl));
  const {evaluateRuns} = await import(moduleUrl);
  const labels = {version: 1, clips: [{video: 'a.mp4', fire_present: true, accepted_cause_expected: 'unknown'}]};
  for (const runs of [[], [{video: 'a.mp4', confirmation: {}, causes: []}],
    [{video: 'a.mp4'}, {video: 'a.mp4'}]]) {
    const result = evaluateRuns(runs, labels);
    assert.equal(result.passed, false);
    assert.equal(result.counts.expected_clips, 1);
  }
});

test('evaluation rejects retired priority labels even when the captured output agrees', async () => {
  const {evaluateRuns} = await import(moduleUrl);
  const run = withPersistenceEvidence({video: 'priority.mp4', code: 0, agentVerified: true, socketError: null,
    sampled_frames: 3, uploaded_frames: 3, analysisComplete: true, persistedMatch: true,
    analysis_status: {active: false, queued: false, pending_followup: false,
      native_inference_pending: false, latest_job_id: 1}, event_counts: {fire_confirmed: 1},
    event_sequence_start: 0, final_event_watermark: 2, captured_event_sequences: [1, 2],
    confirmation: {ts_ms: 1, operator_priority: 'inspect_urgently', response_priority: 'inspect_urgently'},
    causes: [{cause: {ignition_source: 'unknown', probable_cause: 'unknown'}}]});
  for (const priority of ['monitor', 'inspect_urgently', 'escalate']) {
    const current = structuredClone(run);
    current.confirmation.operator_priority = priority;
    current.confirmation.response_priority = priority;
    delete current.persisted_events;
    Object.assign(current, withPersistenceEvidence(current));
    assert.equal(evaluateRuns([current], {version: 1, clips: [
      {video: run.video, fire_present: true, priority_expected: priority},
    ]}).passed, true);
  }
  for (const priority of ['review', 'urgent_review']) {
    const legacy = structuredClone(run);
    legacy.confirmation.operator_priority = priority;
    const result = evaluateRuns([legacy], {version: 1, clips: [
      {video: run.video, fire_present: true, priority_expected: priority},
    ]});
    assert.equal(result.passed, false);
    assert.ok(result.errors.some(e => e.includes('invalid_priority_annotation')));
  }
  run.confirmation.response_priority = 'escalate';
  const mismatch = evaluateRuns([run], {version: 1, clips: [
    {video: run.video, fire_present: true, priority_expected: 'inspect_urgently'},
  ]});
  assert.equal(mismatch.passed, false, 'response and operator priorities must agree');
});

test('invalid or empty evaluation inputs fail without presenting zero-valued detection metrics', async () => {
  const {evaluateRuns} = await import(moduleUrl);
  for (const annotations of [null, {version: 1, clips: []}, {version: 2, clips: [{video: 'a.mp4'}]},
    {version: 1, clips: [null]}, {version: 1, clips: [{video: 'a.mp4'}, {video: 'a.mp4'}]}]) {
    const result = evaluateRuns([], annotations);
    assert.equal(result.passed, false);
    assert.equal(result.detection_counts, null);
    assert.equal(result.detection_delay_ms, null);
    assert.equal(result.false_alerts_per_camera_hour, null);
    assert.equal(result.cause_accuracy, null);
  }
});

test('extra captured runs cannot silently disappear from the evaluation or its metric denominators', async () => {
  const {evaluateRuns} = await import(moduleUrl);
  const run = {video: 'negative.mp4', confirmation: null, causes: []};
  const labels = {version: 1, clips: [{video: run.video, fire_present: false, duration_ms: 3600000}]};
  const result = evaluateRuns([run, {video: 'unlabelled.mp4', confirmation: {ts_ms: 1}}], labels);
  assert.equal(result.passed, false);
  assert.ok(result.errors.some(e => e.includes('unexpected_captured_run')));
  assert.equal(result.detection_counts, null);
  assert.equal(result.false_alerts_per_camera_hour, null);
  assert.deepEqual(result.detection_delays_ms, []);
});
