import test from 'node:test';
import assert from 'node:assert/strict';
import * as replay from '../../scripts/test_edge_runtime.mjs';
import {evaluateRuns} from '../../scripts/evaluate_analysis.mjs';
import {withPersistenceEvidence} from './test-inference-budget.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// Deliberately synthetic unit fixtures; these are not independent video evidence.
const complete = (video, patch = {}) => {
  const run = {video, code: 0, agentVerified: true,
    socketError: null, sampled_frames: 3, uploaded_frames: 3, confirmation: null,
    causes: [], event_counts: {fire_confirmed: 0}, analysisComplete: true, persistedMatch: true,
    analysis_status: {active: false, queued: false, pending_followup: false,
      native_inference_pending: false, latest_job_id: 0}, modelSafetyVerified: true,
    event_sequence_start: 0, final_event_watermark: 0, captured_event_sequences: [], ...patch};
  if (!Object.hasOwn(patch, 'event_counts')) run.event_counts.fire_confirmed = run.confirmation === null ? 0 : 1;
  if (!Object.hasOwn(patch, 'captured_event_sequences')) {
    const count = (run.confirmation === null ? 0 : 1) + run.causes.length + (run.last_update ? 1 : 0);
    run.captured_event_sequences = Array.from({length: count}, (_value, index) => index + 1);
    run.final_event_watermark = count;
  }
  return withPersistenceEvidence(run);
};
const label = (video, patch = {}) => ({video, visible_flame_present: false,
  actionable_fire_present: false, duration_ms: 3600000, split: 'held_out', ...patch});

test('annotated negative replay passes only with no confirmation, analysis job or investigation', () => {
  assert.equal(typeof replay.judgeReplay, 'function');
  assert.equal(typeof replay.classifyReplay, 'function');
  const negative = complete('negative.mp4');
  assert.equal(replay.judgeReplay(negative, label(negative.video), {requireAi: true}).passed, true);
  for (const patch of [{confirmation: {type: 'fire_confirmed', ts_ms: 1}},
    {analysis_status: {latest_job_id: 1}}, {causes: [{cause: {}}]},
    {event_counts: {fire_confirmed: 1}}, {agentVerified: false}, {persistedMatch: false},
    {persisted_events: [{event_kind: 'analysis', analysis_json: '{}'}]}]) {
    assert.equal(replay.judgeReplay({...negative, ...patch}, label(negative.video)).passed, false);
  }
});

test('replay completion rejects unfinished analysis, active jobs, and persistence mismatches', () => {
  const run = complete('partial.mp4');
  const summaryOnly = {...run}; delete summaryOnly.persisted_events;
  assert.equal(replay.classifyReplay(summaryOnly).eligible, false,
    'a true persistedMatch summary cannot replace saved evidence rows');
  for (const patch of [
    {analysisComplete: false},
    {analysis_status: {...run.analysis_status, active: true}},
    {analysis_status: {...run.analysis_status, queued: true}},
    {analysis_status: {...run.analysis_status, pending_followup: true}},
    {analysis_status: {...run.analysis_status, pending_evidence: true}},
    {analysis_status: {...run.analysis_status, native_inference_pending: true}},
    {analysis_status: {active: false, queued: false, pending_followup: false,
      native_inference_pending: false}},
    {persistedMatch: false},
    {persisted_events: [{event_kind: 'analysis', analysis_json: '{}'}]},
  ]) {
    assert.equal(replay.classifyReplay({...run, ...patch}).eligible, false);
  }
});

test('event sequence gaps and a mismatched final-state watermark invalidate replay coverage', () => {
  const run = complete('event-gap.mp4', {confirmation: {type: 'fire_confirmed', ts_ms: 10}});
  assert.equal(replay.classifyReplay(run).eligible, true);
  assert.equal(replay.classifyReplay({...run, captured_event_sequences: []}).eligible, false);
  assert.equal(replay.classifyReplay({...run, captured_event_sequences: [2]}).eligible, false);
  assert.equal(replay.classifyReplay({...run, final_event_watermark: 2}).eligible, false);
});

test('--require-ai applies to actual incidents regardless of the annotation label', () => {
  const negative = label('false-positive.mp4');
  const falsePositive = complete(negative.video, {confirmation: {type: 'fire_confirmed', ts_ms: 10},
    event_counts: {fire_confirmed: 1}, analysis_status: {active: false, queued: false,
      pending_followup: false, native_inference_pending: false, latest_job_id: 0}});
  const required = replay.judgeReplay(falsePositive, negative, {requireAi: true});
  assert.ok(required.failures.includes('ai_verification_failed'));

  const unknown = {video: 'unknown.mp4', visible_flame_present: null};
  const quiet = complete(unknown.video);
  assert.equal(replay.judgeReplay(quiet, unknown, {requireAi: true}).failures.includes('ai_verification_failed'), false,
    'a run with no incident and no investigation needs no AI call');
});

test('budget preflight rejects oversubscription before replay and reserves zero calls for labeled negatives', () => {
  assert.equal(typeof replay.planReplayBatch, 'function');
  const annotations = {version: 1, clips: [label('n.mp4'), label('p.mp4', {visible_flame_present: true})]};
  assert.deepEqual(replay.planReplayBatch(['n.mp4', 'p.mp4'], annotations, 2).reservations, [0, 2]);
  assert.throws(() => replay.planReplayBatch(['p.mp4', 'p.mp4', 'p.mp4', 'p.mp4'], annotations, 6), /ai_call_budget_exceeded/);
  assert.equal(replay.planReplayBatch(Array(4).fill('p.mp4'), annotations, 8).reserved_calls, 8);
  assert.throws(() => replay.planReplayBatch(['unknown.mp4'], annotations), /missing_annotation/);
  for (const invalid of [-1, 1.5, NaN, Infinity]) assert.throws(() => replay.planReplayBatch(['p.mp4'], annotations, invalid), /invalid_ai_call_budget/);
  assert.equal(replay.planReplayBatch(['legacy.mp4'], null).max_calls, 256);
});

test('contained visible flame and actionable incidents have separate denominators and urgency exposure', () => {
  const runs = [complete('contained.mp4', {confirmation: {ts_ms: 100, operator_priority: 'monitor'},
    causes: [{cause: {ignition_source: 'unknown', probable_cause: 'unknown'}}],
    event_counts: {fire_confirmed: 1}, urgent_alerts: []}), complete('reflection.mp4', {urgent_alerts: []})];
  const annotations = {version: 1, clips: [label('contained.mp4', {visible_flame_present: true, priority_expected: 'monitor', category: 'contained'}),
    label('reflection.mp4', {category: 'reflection'})]};
  const report = evaluateRuns(runs, annotations);
  assert.equal(report.passed, true);
  assert.deepEqual(report.flame_detection_counts, {true_positive: 1, false_negative: 0, false_positive: 0, true_negative: 1});
  assert.deepEqual(report.actionable_incident_counts, {true_positive: 0, false_negative: 0, false_positive: 0, true_negative: 2});
  assert.equal(report.false_urgent_alerts_per_camera_hour, 0);
  assert.deepEqual(report.metric_coverage.visible_flame_detection, {
    numerator: 2, denominator: 2, requested_count: 2, eligible_count: 2, exclusions: [], complete: true,
  });
  assert.equal(report.metric_coverage.false_urgent_alerts_per_camera_hour.numerator, 0);
  assert.equal(report.metric_coverage.false_urgent_alerts_per_camera_hour.denominator, 2);
  assert.equal(report.readiness.stages.cloud_replay.status, 'not_run');
  runs[0].urgent_alerts = [{incident_id: 'incident1', ts_ms: 50, operator_priority: 'inspect_urgently'},
    {incident_id: 'incident1', ts_ms: 75, operator_priority: 'inspect_urgently'}];
  assert.equal(evaluateRuns(runs, annotations).false_urgent_alerts_per_camera_hour, 0.5,
    'a false initial urgent alert remains an alert after a later downgrade; duplicate updates count once');
});

test('missing independent labels and incomplete capture keep new metrics explicitly unmeasured', () => {
  const run = complete('unknown.mp4');
  const report = evaluateRuns([run], {version: 1, clips: [{video: run.video}]});
  assert.equal(report.flame_detection_counts, null);
  assert.equal(report.actionable_incident_counts, null);
  assert.equal(report.false_urgent_alerts_per_camera_hour, null);
  assert.equal(report.schema_failure_rate, null);
  assert.equal(report.uncertainty_rate, null);
  const incomplete = evaluateRuns([{...run, code: 1, urgent_alerts: []}], {version: 1, clips: [label(run.video)]});
  assert.equal(incomplete.false_urgent_alerts_per_camera_hour, null);
  assert.equal(incomplete.actionable_incident_counts, null);
});

test('incomplete analysis and mismatched persistence cannot pass as a negative or enter alert metrics', () => {
  const run = complete('unfinished-negative.mp4', {analysisComplete: false, persistedMatch: false,
    analysis_status: {active: true, queued: false, pending_followup: false,
      native_inference_pending: false, latest_job_id: 0}, urgent_alerts: []});
  const report = evaluateRuns([run], {version: 1, clips: [label(run.video)]});
  assert.equal(report.passed, false);
  assert.equal(report.detection_counts, null);
  assert.equal(report.false_alerts_per_camera_hour, null);
  assert.equal(report.actionable_incident_counts, null);
  assert.ok(report.results[0].failures.includes('analysis_incomplete'));
  assert.ok(report.results[0].failures.includes('analysis_not_idle'));
  assert.ok(report.results[0].failures.includes('persistence_mismatch'));
});

test('schema failures, visual uncertainty and fresh/cached calls describe captured payloads, not model accuracy', () => {
  const causes = [
    {cause: {source: 'workers_ai', validation_errors: [], scene_assessment: {category: 'contained_flame'},
      inference_metadata: {mode: 'fresh', usage: {prompt_tokens: 10, completion_tokens: 5, total_tokens: 15}}}},
    {cause: {source: 'workers_ai', validation_errors: ['bad_json'], scene_assessment: {category: 'uncertain'},
      inference_metadata: {mode: 'cached', usage: {prompt_tokens: 10, completion_tokens: 5, total_tokens: 15}}}},
  ];
  const report = evaluateRuns([complete('observed.mp4', {causes})], {version: 1, clips: [{video: 'observed.mp4'}]});
  assert.equal(report.schema_failure_rate, 0.5);
  assert.equal(report.uncertainty_rate, 0.5);
  assert.deepEqual(report.inference_counts, {fresh: 1, cached: 1, skipped: 0});
  assert.deepEqual(report.fresh_inference_usage, {prompt_tokens: 10, completion_tokens: 5, total_tokens: 15});
  const partial = structuredClone(causes); delete partial[0].cause.validation_errors;
  assert.equal(evaluateRuns([complete('observed.mp4', {causes: partial})], {version: 1, clips: [{video: 'observed.mp4'}]}).schema_failure_rate, null);
});

test('actionable source delay uses independently annotated onset and first captured urgent source timestamp', () => {
  const run = complete('material.mp4', {source_start_ts_ms: 1000,
    confirmation: {ts_ms: 1100, operator_priority: 'monitor'},
    causes: [{ts_ms: 1800, response_priority: 'inspect_urgently', cause: {}}],
    urgent_alerts: [{incident_id: 'a', ts_ms: 1800, response_priority: 'inspect_urgently'}]});
  const annotations = {version: 1, clips: [label(run.video, {visible_flame_present: true,
    actionable_fire_present: true, actionable_onset_ms: 500})]};
  const report = evaluateRuns([run], annotations);
  assert.equal(report.actionable_detection_delay_ms, 300);
  assert.equal(report.actionable_incident_counts.true_positive, 1);
  delete annotations.clips[0].actionable_onset_ms;
  assert.equal(evaluateRuns([run], annotations).actionable_detection_delay_ms, null);
});

test('captured-response cache is bounded, explicit, and contains only provider captures', async t => {
  assert.equal(typeof replay.loadInferenceCache, 'function');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-cache-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const file = path.join(directory, 'cache.json');
  assert.deepEqual(replay.loadInferenceCache(file), []);
  const captured = {key: 'a'.repeat(64), raw: '{"response":"captured"}', usage: {total_tokens: 3}};
  replay.saveInferenceCache(file, [captured]);
  assert.deepEqual(replay.loadInferenceCache(file), [captured]);
  assert.throws(() => replay.saveInferenceCache(file, [{key: 'b'.repeat(64), raw: 'x'.repeat(33000)}]), /invalid_inference_cache/);
  replay.saveInferenceCache(file, [{key: 'c'.repeat(64), raw: 'secret removed', redacted: true}, {key: 'd'.repeat(64), raw: 'part', truncated: true}]);
  assert.deepEqual(replay.loadInferenceCache(file), [], 'diagnostic snippets must never seed replay cache');
  fs.writeFileSync(file, JSON.stringify({version: 1, captures: Array.from({length: 13}, (_, n) => ({key: n.toString(16).padStart(64, '0'), raw: 'x'}))}));
  assert.throws(() => replay.loadInferenceCache(file), /invalid_inference_cache/);
});

test('replay refuses remote inference before starting clips unless server enforces the requested batch ceiling', async t => {
  assert.equal(typeof replay.configureInferenceBatch, 'function');
  let maxCalls = 6;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({batch_id: body.batch_id, max_calls: maxCalls, fresh_calls: 0,
      cached_calls: 0, skipped_calls: 0, in_flight: 0, utc_day: '2026-10-19', day_fresh_calls: 0,
      daily_max_calls: null, captures: [], usage: {total_tokens: null}}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = new URL(`http://127.0.0.1:${server.address().port}`);
  const configured = await replay.configureInferenceBatch(origin, {}, {batch_id: 'fixture', max_calls: 6, cache_mode: 'off'});
  assert.equal(configured.max_calls, 6);
  maxCalls = 8;
  await assert.rejects(replay.configureInferenceBatch(origin, {}, {batch_id: 'fixture2', max_calls: 6}), /invalid_inference_batch/);
});

test('replay subtracts already spent batch calls without a six-call UTC-day ceiling', () => {
  const status = {batch_id: 'shared', max_calls: 6, fresh_calls: 1, cached_calls: 0, skipped_calls: 0,
    in_flight: 0, utc_day: '2026-10-19', day_fresh_calls: 1, daily_max_calls: null};
  assert.equal(replay.remainingInferenceCalls(status), 5);
  assert.equal(replay.remainingInferenceCalls({...status, day_fresh_calls: 60}), 5);
  assert.equal(replay.remainingInferenceCalls({...status, fresh_calls: 6}), 0);
});

test('default replay refuses an unavailable shared budget even without require-ai',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'replay-budget-default-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const video=path.join(directory,'input.mp4'),out=path.join(directory,'output');
  fs.writeFileSync(video,'not decoded because admission must fail first');
  const server=http.createServer((_request,response)=>{response.statusCode=404;response.end('{}');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  await assert.rejects(replay.runReplay(['--worker',`http://127.0.0.1:${server.address().port}`,'--video',video,'--out',out]),/inference_batch_unavailable/);
  assert.equal(fs.existsSync(out),false,'no clips or output start without a verified ceiling');
});

test('a final urgent classification cannot report zero false urgent alerts through inconsistent capture', () => {
  const run = complete('reflection.mp4', {confirmation: {ts_ms: 1, operator_priority: 'inspect_urgently'},
    event_counts: {fire_confirmed: 1}, urgent_alerts: [], final_priority: 'inspect_urgently'});
  const report = evaluateRuns([run], {version: 1, clips: [label(run.video)]});
  assert.equal(report.false_urgent_alerts_per_camera_hour, null);
  assert.equal(report.actionable_incident_counts.false_positive, 1);
});

test('latest source priority wins over an older investigation even with a stale arrival-order summary', () => {
  const run = complete('material.mp4', {confirmation: {ts_ms: 1, operator_priority: 'monitor'},
    causes: [{ts_ms: 2000, response_priority: 'monitor', cause: {}}],
    last_update: {type: 'fire_update', ts_ms: 5000, response_priority: 'escalate'}, final_priority: 'monitor'});
  const report = evaluateRuns([run], {version: 1, clips: [label(run.video, {
    visible_flame_present: true, actionable_fire_present: true, priority_expected: 'escalate'})]});
  assert.equal(report.passed, true);
  assert.equal(report.actionable_incident_counts.true_positive, 1);
});

test('late historical monitor cannot erase a newer live urgent classification or pass actionable-negative policy', () => {
  const run = complete('lighter.mp4', {confirmation: {type: 'fire_confirmed', ts_ms: 1000, operator_priority: 'inspect_urgently'},
    last_update: {type: 'fire_update', ts_ms: 5000, response_priority: 'inspect_urgently'},
    causes: [{type: 'cause_update', ts_ms: 2000, priority_scope: 'observed_interval', response_priority: 'monitor',
      cause: {scene_assessment: {category: 'contained_flame'}}}], final_priority: 'monitor'});
  const annotations = {version: 1, clips: [label(run.video, {visible_flame_present: true,
    priority_expected: 'monitor', interval_priority_expected: 'monitor', scene_expected: 'contained_flame'})]};
  const report = evaluateRuns([run], annotations);
  assert.equal(report.passed, false);
  assert.equal(report.actionable_incident_counts.false_positive, 1);
  assert.ok(report.results[0].failures.includes('operator_priority_expectation_failed'));
  assert.equal(report.results[0].latest_live_priority, 'inspect_urgently');
  assert.equal(report.results[0].interval_priority, 'monitor');
  assert.equal(report.results[0].interval_scene, 'contained_flame');
  assert.equal(report.results[0].interval_ts_ms, 2000);
  assert.equal(replay.judgeReplay(run, annotations.clips[0]).passed, false);
});

test('equal source timestamps prefer live priority and later historical-only intervals leave live status separate', () => {
  assert.equal(typeof replay.summarizePriorities, 'function');
  const live = {type: 'fire_update', ts_ms: 5000, response_priority: 'inspect_urgently'};
  const historical = {type: 'cause_update', ts_ms: 5000, priority_scope: 'observed_interval', response_priority: 'monitor',
    cause: {scene_assessment: {category: 'contained_flame'}}};
  for (const priority_events of [[live, historical], [historical, live]]) {
    const summary = replay.summarizePriorities({priority_events, causes: [historical]});
    assert.equal(summary.final_priority, 'inspect_urgently');
    assert.equal(summary.latest_live_priority, 'inspect_urgently');
    assert.equal(summary.interval_priority, 'monitor');
  }
  const later = {...historical, ts_ms: 6000};
  const summary = replay.summarizePriorities({priority_events: [live, later], causes: [later]});
  assert.equal(summary.final_priority, 'monitor', 'priority_expected refers to greatest-source-timestamp evidence');
  assert.equal(summary.latest_live_priority, 'inspect_urgently', 'historical assessment is not a live downgrade');
  const run = complete('latest-interval.mp4', {confirmation: {ts_ms: 1, operator_priority: 'inspect_urgently'},
    priority_events: [live, later], causes: [later]});
  const report = evaluateRuns([run], {version: 1, clips: [label(run.video, {visible_flame_present: true,
    priority_expected: 'monitor', interval_priority_expected: 'monitor', scene_expected: 'contained_flame'})]});
  assert.equal(report.actionable_incident_counts.false_positive, 1);
  assert.equal(report.passed, false, 'live actionable status remains separately checked');
});

test('explicit historical interval and scene expectations cannot be satisfied by unrelated live priority', () => {
  const run = complete('interval.mp4', {confirmation: {ts_ms: 1, operator_priority: 'monitor'},
    causes: [{ts_ms: 2000, priority_scope: 'observed_interval', response_priority: 'inspect_urgently',
      cause: {scene_assessment: {category: 'material_burning'}}}]});
  const report = evaluateRuns([run], {version: 1, clips: [label(run.video, {visible_flame_present: true,
    interval_priority_expected: 'monitor', scene_expected: 'contained_flame'})]});
  assert.equal(report.passed, false);
  assert.ok(report.results[0].failures.includes('interval_priority_expectation_failed'));
  assert.ok(report.results[0].failures.includes('scene_expectation_failed'));
});

test('historical urgent assessments do not count as live false alerts or shorten live source detection delay', () => {
  const historical = {type: 'cause_update', incident_id: 'interval', ts_ms: 1200,
    priority_scope: 'observed_interval', response_priority: 'inspect_urgently', cause: {}};
  const monitor = complete('contained.mp4', {source_start_ts_ms: 1000,
    confirmation: {ts_ms: 1100, operator_priority: 'monitor'}, causes: [historical],
    urgent_alerts: [historical]});
  const negative = evaluateRuns([monitor], {version: 1, clips: [label(monitor.video, {visible_flame_present: true})]});
  assert.equal(negative.false_urgent_alerts_per_camera_hour, 0);
  assert.equal(negative.actionable_incident_counts.true_negative, 1);
  const live = {type: 'fire_update', incident_id: 'live', ts_ms: 1800, response_priority: 'inspect_urgently'};
  const detected = {...monitor, video: 'material.mp4', last_update: live, urgent_alerts: [historical, live]};
  const positive = evaluateRuns([detected], {version: 1, clips: [label(detected.video,
    {visible_flame_present: true, actionable_fire_present: true, actionable_onset_ms: 500})]});
  assert.equal(positive.actionable_detection_delay_ms, 300);
  // Older summary captures omitted scope on urgent entries; full cause capture
  // still identifies this as a historical event rather than a live alert.
  const legacyHistorical = {...historical}; delete legacyHistorical.priority_scope; delete legacyHistorical.cause;
  const legacy = evaluateRuns([{...monitor, urgent_alerts: [legacyHistorical]}],
    {version: 1, clips: [label(monitor.video, {visible_flame_present: true})]});
  assert.equal(legacy.false_urgent_alerts_per_camera_hour, 0);
});

test('fallback, skipped inference and missing provenance cannot pass model schema verification', () => {
  assert.equal(typeof replay.verifyModelSchemas, 'function');
  const received = {source: 'workers_ai', model: 'actual-model', validation_errors: [],
    inference_metadata: {mode: 'fresh', usage: {total_tokens: null}}};
  assert.equal(replay.verifyModelSchemas([{cause: received}]), true);
  assert.equal(replay.verifyModelSchemas([{cause: {...received, inference_metadata: {mode: 'cached'}}}]), true);
  const legacy = {...received}; delete legacy.inference_metadata;
  assert.equal(replay.verifyModelSchemas([{cause: legacy}]), true, 'legacy workers_ai provenance still proves receipt');
  for (const cause of [
    {...received, source: 'rules_fallback', vlm_error: 'workers_ai_binding_missing'},
    {...received, source: 'rules_only'}, {...received, source: undefined},
    {...received, inference_metadata: {mode: 'skipped'}},
    {...received, inference_metadata: {mode: 'unknown'}},
    {...received, vlm_error: 'vlm_timeout'}, {...received, validation_errors: ['invalid_model_json']},
  ]) assert.equal(replay.verifyModelSchemas([{cause}]), false);
  assert.equal(replay.verifyModelSchemas([]), false);
});

test('schema failure denominator includes only received provider outputs while uncertainty covers pipeline fallback', () => {
  const fallback = {source: 'rules_fallback', vlm_error: 'workers_ai_binding_missing',
    validation_errors: [], scene_assessment: {category: 'uncertain'}, inference_metadata: {mode: 'skipped'}};
  const annotations = {version: 1, clips: [{video: 'outputs.mp4'}]};
  const none = evaluateRuns([complete('outputs.mp4', {causes: [{cause: fallback}]})], annotations);
  assert.equal(none.schema_failure_rate, null);
  assert.equal(none.schema_eligible_outputs, 0);
  assert.ok(none.limitations.includes('provider_outputs_unavailable'));
  assert.equal(none.uncertainty_rate, 1, 'fallback remains an unknown pipeline result');
  const received = {source: 'workers_ai', validation_errors: [], scene_assessment: {category: 'contained_flame'},
    inference_metadata: {mode: 'fresh'}};
  const mixed = evaluateRuns([complete('outputs.mp4', {causes: [
    {cause: received}, {cause: {...received, validation_errors: ['invalid_json'], inference_metadata: {mode: 'cached'}}},
    {cause: fallback}, {cause: {validation_errors: [], scene_assessment: {category: 'uncertain'}}},
  ]})], annotations);
  assert.equal(mixed.schema_failure_rate, 0.5);
  assert.equal(mixed.schema_eligible_outputs, 2);
  assert.equal(mixed.schema_excluded_investigations, 2);
  assert.equal(mixed.uncertainty_rate, 0.5);
});

test('V3 contained-tool scenes are valid annotations and remain in uncertainty coverage', () => {
  const cause = {scene_assessment: {category: 'contained_tool_flame'}};
  const run = complete('v3-tool.mp4', {
    confirmation: {type: 'fire_confirmed', ts_ms: 1000,
      operator_priority: 'inspect_urgently', response_priority: 'inspect_urgently'},
    causes: [{type: 'cause_update', ts_ms: 1100, priority_scope: 'observed_interval',
      response_priority: 'inspect_urgently', cause}],
  });
  const annotations = {version: 1, clips: [label(run.video, {visible_flame_present: true,
    priority_expected: 'inspect_urgently', interval_priority_expected: 'inspect_urgently',
    actionable_fire_present: null, scene_expected: 'contained_tool_flame'})]};
  const report = evaluateRuns([run], annotations);
  assert.equal(report.passed, true, JSON.stringify({errors: report.errors, limitations: report.limitations,
    failures: report.results?.[0]?.failures, uncertainty: report.metric_coverage?.uncertainty_rate}));
  assert.equal(report.uncertainty_rate, 0);
  assert.deepEqual(report.metric_coverage.uncertainty_rate, {
    numerator: 0, denominator: 1, requested_count: 1, eligible_count: 1,
    exclusions: [], complete: true,
  });
});
