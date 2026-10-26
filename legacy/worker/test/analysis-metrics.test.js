import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateRuns} from '../../scripts/evaluate_analysis.mjs';
import {withPersistenceEvidence} from './test-inference-budget.js';

// These runs, times, labels and event counts are synthetic unit fixtures, not footage measurements.
const payload = {ignition_source: 'unknown', probable_cause: 'unknown', hypothesis: {ignition_source: 'human'}};
function captured(video, confirmation = null, extra = {}) {
  const run = {video, code: 0, agentVerified: true, socketError: null,
    sampled_frames: 100, uploaded_frames: 100,
    event_counts: {fire_confirmed: confirmation ? 1 : 0}, confirmation,
    analysisComplete: true, persistedMatch: true,
    analysis_status: {active: false, queued: false, pending_followup: false,
      native_inference_pending: false, latest_job_id: confirmation ? 1 : 0},
    causes: confirmation ? [{cause: payload}] : [], ...extra};
  const count = (confirmation ? 1 : 0) + run.causes.length + (run.last_update ? 1 : 0);
  run.event_sequence_start = 0;
  run.final_event_watermark = count;
  run.captured_event_sequences = Array.from({length: count}, (_value, index) => index + 1);
  return withPersistenceEvidence(run);
}

test('annotated metrics expose false alerts, misses and source-time delay without inventing missing ground truth', () => {
  const labels = {version: 1, clips: [
    {video: 'positive.mp4', fire_present: true, onset_ms: 500},
    {video: 'miss.mp4', fire_present: true, onset_ms: 500},
    {video: 'negative.mp4', fire_present: false, duration_ms: 3600000},
    {video: 'clean.mp4', fire_present: false, duration_ms: 3600000},
  ]};
  const runs = [
    captured('positive.mp4', {ts_ms: 11200}, {source_start_ts_ms: 10000}),
    captured('miss.mp4'),
    captured('negative.mp4', {ts_ms: 500}),
    captured('clean.mp4'),
  ];
  const result = evaluateRuns(runs, labels);
  assert.deepEqual(result.detection_counts, {true_positive: 1, false_negative: 1, false_positive: 1, true_negative: 1});
  assert.deepEqual(result.detection_delays_ms, [700]);
  assert.equal(result.false_alerts_per_camera_hour, 0.5);
  assert.equal(result.cause_accuracy, null);
  assert.equal(result.accepted_unverified_attributions, 0);
  assert.equal(result.counts.unverified_hypotheses, 2);
  const absent = evaluateRuns([runs[0]], {version: 1, clips: [{video: 'positive.mp4', fire_present: true}]});
  assert.equal(absent.false_alerts_per_camera_hour, null);
  assert.deepEqual(absent.detection_delays_ms, []);
});

test('source-time delays require complete positive onset and timing coverage, never a convenient subset', () => {
  const labels = {version: 1, clips: [
    {video: 'first.mp4', fire_present: true, onset_ms: 500},
    {video: 'second.mp4', fire_present: true, onset_ms: 500},
  ]};
  const runs = [
    captured('first.mp4', {ts_ms: 1100}, {source_start_ts_ms: 100, confirmation_offset_ms: 1000}),
    captured('second.mp4', {ts_ms: 2200}, {confirmation_offset_ms: 1200}),
  ];
  const complete = evaluateRuns(runs, labels);
  assert.deepEqual(complete.detection_delays_ms, [500, 700]);
  assert.equal(complete.detection_delay_ms, 600, 'mean source-time delay for confirmed positives only');
  for (const onset_ms of [null, undefined, -1]) {
    const partial = structuredClone(labels);
    partial.clips[1].onset_ms = onset_ms;
    const result = evaluateRuns(runs, partial);
    assert.deepEqual(result.detection_delays_ms, []);
    assert.equal(result.detection_delay_ms, null);
    assert.ok(result.limitations.includes('detection_onset_annotations_unavailable'));
  }
  const missingTiming = structuredClone(runs);
  delete missingTiming[1].confirmation_offset_ms;
  const result = evaluateRuns(missingTiming, labels);
  assert.deepEqual(result.detection_delays_ms, []);
  assert.equal(result.detection_delay_ms, null);
  assert.ok(result.limitations.includes('source_time_confirmation_unavailable'));
  const contradictoryTiming = structuredClone(runs);
  contradictoryTiming[0].confirmation_offset_ms = 9999;
  const contradictory = evaluateRuns(contradictoryTiming, labels);
  assert.deepEqual(contradictory.detection_delays_ms, []);
  assert.equal(contradictory.detection_delay_ms, null);
  assert.ok(contradictory.limitations.includes('source_time_confirmation_unavailable'));
});

test('missing fire-presence annotations suppress confusion and exposure instead of dropping an unknown clip', () => {
  const runs = [captured('negative.mp4'), captured('unknown.mp4')];
  const result = evaluateRuns(runs, {version: 1, clips: [
    {video: 'negative.mp4', fire_present: false, duration_ms: 3600000},
    {video: 'unknown.mp4', duration_ms: 3600000},
  ]});
  assert.equal(result.detection_counts, null);
  assert.equal(result.false_alerts_per_camera_hour, null);
  assert.equal(result.detection_delay_ms, null);
  assert.ok(result.limitations.includes('fire_presence_annotations_unavailable'));
});

test('false-alert rate counts every captured confirmation, not only clips with an alert', () => {
  const labels = {version: 1, clips: [{video: 'negative.mp4', fire_present: false, duration_ms: 3600000}]};
  const run = captured('negative.mp4', {ts_ms: 1}, {event_counts: {fire_confirmed: 3}});
  const result = evaluateRuns([run], labels);
  assert.equal(result.false_alerts_per_camera_hour, 3);
  assert.equal(result.detection_counts.false_positive, 1, 'confusion remains clip-level');
  for (const event_counts of [undefined, {fire_confirmed: -1}, {fire_confirmed: 0}, {fire_confirmed: 1.5}]) {
    const incomplete = evaluateRuns([{...run, event_counts}], labels);
    assert.equal(incomplete.false_alerts_per_camera_hour, null);
    assert.ok(incomplete.limitations.includes('negative_alert_counts_unavailable'));
  }
});

test('hypothesis frequency and unsafe accepted aliases are separate investigation-level metrics, not accuracy', () => {
  const run = captured('claims.mp4', {ts_ms: 1}, {causes: [
    {cause: {ignition_source: 'unknown', probable_cause: 'unknown', model_hypothesis: {ignition_source: 'human'}}},
    {cause: {ignition_source: 'unknown', probable_cause: 'unknown', hypothesis: {ignition_source: 'unknown', ignition_tool: 'lighter'}}},
    {cause: {ignition_source: 'unknown', probable_cause: 'human'}},
  ]});
  const labels = {version: 1, clips: [{video: run.video, fire_present: true}]};
  const result = evaluateRuns([run], labels);
  assert.equal(result.counts.investigations, 3);
  assert.equal(result.counts.unverified_hypotheses, 2);
  assert.equal(result.model_hypothesis_frequency, 2 / 3);
  assert.equal(result.counts.accepted_known_causes, 1);
  assert.equal(result.accepted_unverified_attributions, 1);
  assert.equal(result.passed, false);
  assert.equal(result.cause_accuracy, null);
  for (const field of ['ignition_source', 'probable_cause', 'accepted_cause', 'ignition_tool', 'tool_used']) {
    const unsafe = captured('claims.mp4', {ts_ms: 1}, {causes: [{cause: {[field]: 'human'}}]});
    assert.equal(evaluateRuns([unsafe], labels).accepted_unverified_attributions, 1, field);
  }
  const noInvestigations = evaluateRuns([captured('negative.mp4')], {version: 1, clips: [{video: 'negative.mp4', fire_present: false}]});
  assert.equal(noInvestigations.model_hypothesis_frequency, null);
});

test('known accepted cause without verified review is counted as unsafe attribution, not correct identification', () => {
  const result = evaluateRuns([captured('bystander.mp4', {ts_ms: 1}, {
    causes: [{cause: {ignition_source: 'human', probable_cause: 'human', requires_human_review: true}}],
  })], {version: 1, clips: [{video: 'bystander.mp4', fire_present: true}]});
  assert.equal(result.accepted_unverified_attributions, 1);
  assert.equal(result.passed, false);
});

test('false-alert exposure is unavailable for incomplete negative captures rather than treating them as clean footage', () => {
  const labels = {version: 1, clips: [
    {video: 'alert.mp4', fire_present: false, duration_ms: 3600000},
    {video: 'clean.mp4', fire_present: false, duration_ms: 3600000},
  ]};
  const alert = captured('alert.mp4', {ts_ms: 1});
  for (const patch of [
    {code: 1}, {agentVerified: false}, {agentVerified: undefined}, {sampled_frames: 0, uploaded_frames: 0},
    {uploaded_frames: 99}, {socketError: 'disconnected'}, {confirmation: undefined}, {confirmation: {}},
    {confirmation: {type: 'fire_update', ts_ms: 1}},
  ]) {
    const result = evaluateRuns([alert, captured('clean.mp4', null, patch)], labels);
    assert.equal(result.false_alerts_per_camera_hour, null, JSON.stringify(patch));
    assert.equal(result.detection_counts, null, 'an incomplete capture is not a true negative');
    assert.equal(result.passed, false);
  }
  for (const duration_ms of [null, 0, -1, undefined]) {
    const partial = structuredClone(labels);
    partial.clips[1].duration_ms = duration_ms;
    assert.equal(evaluateRuns([alert, captured('clean.mp4')], partial).false_alerts_per_camera_hour, null);
  }
  assert.equal(evaluateRuns([alert], labels).false_alerts_per_camera_hour, null);
});

