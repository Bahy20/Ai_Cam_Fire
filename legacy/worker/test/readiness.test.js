import test from 'node:test';
import assert from 'node:assert/strict';
import {buildReadinessReport} from '../../scripts/evaluation/readiness.mjs';
import {evaluateRuns} from '../../scripts/evaluate_analysis.mjs';

test('offline captured evaluation leaves both cloud stages not_run and reports unresolved gates', () => {
  const report = buildReadinessReport({mode: 'offline',
    cloud_contract: {attempted: true, exact_image_schema_supported: true, schema_valid: true,
      fresh_outputs: 99, evidence_paths: ['probe.json']},
    cloud_replay: {attempted: true, actual_video: true, analysis_complete: true, schema_valid: true,
      persisted_match: true, fresh_outputs: 99, evidence_paths: ['replay.json']}});
  assert.equal(report.stages.cloud_contract.status, 'not_run');
  assert.equal(report.stages.cloud_replay.status, 'not_run');
  assert.equal(report.stages.edge_handheld_model.status, 'blocked');
  assert.equal(report.stages.quality_held_out.status, 'blocked');
  assert.equal(report.stages.free_tier_profile.status, 'blocked');
  assert.equal(report.stages.core_pi.status, 'blocked');
  assert.equal(report.status, 'blocked');
});

test('cloud readiness requires fresh provider evidence and persisted actual-video results', () => {
  const report = buildReadinessReport({
    cloud_contract: {attempted: true, provider_available: false, fresh_outputs: 0,
      evidence_paths: ['contract-attempt.json']},
    cloud_replay: {attempted: true, provider_available: true, actual_video: true,
      analysis_complete: true, schema_valid: true, persisted_match: true, fresh_outputs: 0,
      evidence_paths: ['failed-replay.json']},
  });
  assert.equal(report.stages.cloud_contract.status, 'blocked');
  assert.equal(report.stages.cloud_replay.status, 'blocked');
  assert.ok(report.stages.cloud_contract.reason_codes.includes('fresh_provider_output_unavailable'));
});

test('held-out readiness requires measured nonnegative error counts, never absent values', () => {
  const measured={independent_labels:true,frozen_corpus:true,complete_coverage:true,
    actionable_positive_count:6,missed_actionable_incidents:0,unsafe_downgrades:0,
    false_urgent_normal_backgrounds:0,evidence_paths:['held-out.json']};
  for (const key of ['missed_actionable_incidents','unsafe_downgrades','false_urgent_normal_backgrounds']) {
    for (const value of [undefined,null,NaN,-1,0.5,'0']) {
      const report=buildReadinessReport({quality_held_out:{...measured,[key]:value}});
      assert.equal(report.stages.quality_held_out.status,'blocked',`${key}=${value} must remain unmeasured`);
    }
  }
});

test('lighter-priority readiness requires a frozen, licensed, evaluated local model', () => {
  const base={model_bundle_sha256:'a'.repeat(64),weights_sha256:'b'.repeat(64),
    quality_profile_sha256:'c'.repeat(64),class_mapping:['fire','smoke','lighter_flame','secondary_burning'],
    training_data_rights_cleared:true,bundle_frozen:true,development_coverage_complete:true,
    candidate_path_replay_complete:true,development_unsafe_monitor_intervals:0,
    development_missed_actionable_transitions:0,uncertain_rate:0.2,cpu_inference_measured:true,p95_inference_ms:120,
    evidence_paths:['edge-model.json']};
  const missing=buildReadinessReport({});
  assert.equal(missing.stages.edge_handheld_model.status,'blocked');

  for (const [key,value] of [['development_unsafe_monitor_intervals',1],
    ['development_missed_actionable_transitions',1]]) {
    const report=buildReadinessReport({edge_handheld_model:{...base,[key]:value}});
    assert.equal(report.stages.edge_handheld_model.status,'fail',`${key}=${value}`);
  }

  const unlicensed=buildReadinessReport({edge_handheld_model:{...base,training_data_rights_cleared:false}});
  assert.equal(unlicensed.stages.edge_handheld_model.status,'blocked');
  const incomplete=buildReadinessReport({edge_handheld_model:{...base,class_mapping:['fire','smoke','lighter_flame']}});
  assert.equal(incomplete.stages.edge_handheld_model.status,'blocked');
});

test('held-out results must identify the exact frozen edge-model bundle', () => {
  const report=buildReadinessReport({
    edge_handheld_model:{model_bundle_sha256:'a'.repeat(64),weights_sha256:'b'.repeat(64),
      quality_profile_sha256:'c'.repeat(64),class_mapping:['fire','smoke','lighter_flame','secondary_burning'],
      training_data_rights_cleared:true,bundle_frozen:true,development_coverage_complete:true,
      candidate_path_replay_complete:true,development_unsafe_monitor_intervals:0,
      development_missed_actionable_transitions:0,uncertain_rate:0.2,cpu_inference_measured:true,p95_inference_ms:120,
      evidence_paths:['edge-model.json']},
    quality_held_out:{independent_labels:true,frozen_corpus:true,complete_coverage:true,
      model_bundle_sha256:'d'.repeat(64),actionable_positive_count:6,missed_actionable_incidents:0,
      unsafe_downgrades:0,false_urgent_normal_backgrounds:0,evidence_paths:['held-out.json']},
  });
  assert.equal(report.stages.edge_handheld_model.status,'pass');
  assert.equal(report.stages.quality_held_out.status,'blocked');
  assert.ok(report.stages.quality_held_out.reason_codes.includes('held_out_model_bundle_mismatch'));
  assert.equal(report.status,'blocked');
});

test('all readiness stages need measured evidence before the aggregate may pass', () => {
  const path = name => [`evidence/${name}.json`];
  const meters = Object.fromEntries([
    ['workers_requests','daily'], ['workers_cpu_ms_per_invocation','per_invocation_max'],
    ['durable_object_requests','daily'], ['durable_object_duration','daily'],
    ['durable_object_sqlite_rows_read','daily'], ['durable_object_sqlite_rows_written','daily'],
    ['durable_object_sqlite_storage','current'], ['d1_rows_read','daily'],
    ['d1_rows_written','daily'], ['d1_storage_account_total','current'],
    ['workers_ai_neurons','daily'],
  ].map(([name,window]) => [name,{used:80,limit:100,window}]));
  const report = buildReadinessReport({
    core_pc: {exit_code: 0, evidence_paths: path('core-pc')},
    cloud_contract: {attempted: true, exact_image_schema_supported: true, schema_valid: true,
      fresh_outputs: 1, evidence_paths: path('cloud-contract')},
    cloud_replay: {attempted: true, actual_video: true, analysis_complete: true,
      schema_valid: true, persisted_match: true, fresh_outputs: 1, evidence_paths: path('cloud-replay')},
    edge_handheld_model: {model_bundle_sha256:'a'.repeat(64),weights_sha256:'b'.repeat(64),
      quality_profile_sha256:'c'.repeat(64),class_mapping:['fire','smoke','lighter_flame','secondary_burning'],
      training_data_rights_cleared:true,bundle_frozen:true,development_coverage_complete:true,
      candidate_path_replay_complete:true,development_unsafe_monitor_intervals:0,
      development_missed_actionable_transitions:0,uncertain_rate:0.2,cpu_inference_measured:true,p95_inference_ms:120,
      evidence_paths:path('edge-model')},
    quality_held_out: {independent_labels: true, frozen_corpus: true, complete_coverage: true,
      model_bundle_sha256:'a'.repeat(64),actionable_positive_count: 6, missed_actionable_incidents: 0, unsafe_downgrades: 0,
      false_urgent_normal_backgrounds: 0, evidence_paths: path('held-out')},
    free_tier_profile: {simulated_duration_ms: 86400000, simulation_complete: true,
      cloudflare_runtime_measurements: true, measured_row_writes_per_day: 54000,
      meters, account_reconciled: true, evidence_paths: path('free-tier')},
    core_pi: {hardware_available: true, gap_bound_violations: 0, soak_duration_ms: 86400000,
      restart_tested: true, network_loss_tested: true, evidence_paths: path('pi')},
  });
  assert.equal(report.status, 'pass');
  for (const stage of Object.values(report.stages)) assert.equal(stage.status, 'pass');
});

test('free-tier readiness requires headroom for every named meter and real account reconciliation', () => {
  const path = ['evidence/cloudflare-profile.json'];
  const meters = Object.fromEntries([
    ['workers_requests','daily'], ['workers_cpu_ms_per_invocation','per_invocation_max'],
    ['durable_object_requests','daily'], ['durable_object_duration','daily'],
    ['durable_object_sqlite_rows_read','daily'], ['durable_object_sqlite_rows_written','daily'],
    ['durable_object_sqlite_storage','current'], ['d1_rows_read','daily'],
    ['d1_rows_written','daily'], ['d1_storage_account_total','current'],
    ['workers_ai_neurons','daily'],
  ].map(([name,window]) => [name,{used:100,limit:1000,window}]));
  const common = {simulated_duration_ms: 86400000, simulation_complete: true,
    cloudflare_runtime_measurements: true, measured_row_writes_per_day: 50000,
    meters, account_reconciled: true, evidence_paths: path};

  const oneMeterOverBudget = buildReadinessReport({free_tier_profile:{...common,
    meters:{...meters,d1_rows_written:{used:810,limit:1000,window:'daily'}}}});
  assert.equal(oneMeterOverBudget.stages.free_tier_profile.status, 'fail');

  const rowWriteCutoff = buildReadinessReport({free_tier_profile:{...common,
    measured_row_writes_per_day:60000}});
  assert.equal(rowWriteCutoff.stages.free_tier_profile.status, 'fail');

  const missingMeter = {...meters};
  delete missingMeter.workers_ai_neurons;
  const incomplete = buildReadinessReport({free_tier_profile:{...common,
    meters:missingMeter}});
  assert.equal(incomplete.stages.free_tier_profile.status, 'blocked');
  assert.ok(incomplete.stages.free_tier_profile.reason_codes.includes('meter_headroom_incomplete'));

  const localOnly = buildReadinessReport({free_tier_profile:{...common,
    cloudflare_runtime_measurements:false, account_reconciled:false}});
  assert.equal(localOnly.stages.free_tier_profile.status, 'blocked');
  assert.ok(localOnly.stages.free_tier_profile.reason_codes.includes('cloudflare_runtime_measurements_missing'));
});

test('standalone evaluation records readiness and coverage instead of presenting policy checks as product readiness', () => {
  const report = evaluateRuns([], {version: 1, clips: [{video: 'x.mp4'}]});
  assert.equal(report.readiness.stages.cloud_contract.status, 'not_run');
  assert.equal(report.readiness.stages.cloud_replay.status, 'not_run');
  assert.equal(report.readiness.status, 'blocked');
  assert.equal(report.coverage.requested_count, 1);
  assert.equal(report.coverage.eligible_count, 0);
  assert.equal(report.metric_coverage.visible_flame_detection.denominator, null);
});
