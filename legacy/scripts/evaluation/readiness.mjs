const states = new Set(['pass', 'fail', 'blocked', 'not_run']);
const withResult = (status, reasonCodes = [], evidencePaths = []) => ({
  status, reason_codes: [...new Set(reasonCodes)], evidence_paths: evidencePaths.filter(path => typeof path === 'string' && path.length > 0),
});
const hasEvidence = value => Array.isArray(value?.evidence_paths) &&
  value.evidence_paths.some(path => typeof path === 'string' && path.trim().length > 0);
const bool = (value, key) => value?.[key] === true;
const SHA256 = /^[a-f0-9]{64}$/i;
const HANDHELD_CLASSES = ['fire', 'smoke', 'lighter_flame', 'secondary_burning'];
export const FREE_TIER_METERS = Object.freeze({
  workers_requests: 'daily',
  workers_cpu_ms_per_invocation: 'per_invocation_max',
  durable_object_requests: 'daily',
  durable_object_duration: 'daily',
  durable_object_sqlite_rows_read: 'daily',
  durable_object_sqlite_rows_written: 'daily',
  durable_object_sqlite_storage: 'current',
  d1_rows_read: 'daily',
  d1_rows_written: 'daily',
  d1_storage_account_total: 'current',
  workers_ai_neurons: 'daily',
});

function corePc(evidence) {
  if (!evidence || !Number.isInteger(evidence.exit_code)) return withResult('not_run', ['core_pc_tests_not_run']);
  if (!hasEvidence(evidence)) return withResult('blocked', ['core_pc_test_report_missing']);
  return evidence.exit_code === 0 ? withResult('pass', [], evidence.evidence_paths) :
    withResult('fail', ['core_pc_tests_failed'], evidence.evidence_paths);
}

function cloudContract(evidence, offline) {
  if (offline) return withResult('not_run', ['offline_evaluation']);
  if (!evidence?.attempted) return withResult('not_run', ['fresh_contract_probe_not_run']);
  if (evidence.provider_available === false || evidence.fresh_outputs === 0) {
    return withResult('blocked', ['fresh_provider_output_unavailable'], evidence?.evidence_paths ?? []);
  }
  if (evidence.exact_image_schema_supported === false || evidence.schema_valid === false) {
    return withResult('fail', ['cloud_contract_rejected'], evidence?.evidence_paths ?? []);
  }
  if (bool(evidence, 'exact_image_schema_supported') && bool(evidence, 'schema_valid') &&
      Number.isSafeInteger(evidence.fresh_outputs) && evidence.fresh_outputs > 0 && hasEvidence(evidence)) {
    return withResult('pass', [], evidence.evidence_paths);
  }
  return withResult('blocked', ['contract_evidence_incomplete'], evidence?.evidence_paths ?? []);
}

function cloudReplay(evidence, offline) {
  if (offline) return withResult('not_run', ['offline_evaluation']);
  if (!evidence?.attempted) return withResult('not_run', ['fresh_cloud_video_replay_not_run']);
  if (evidence.provider_available === false || evidence.fresh_outputs === 0) {
    return withResult('blocked', ['fresh_provider_output_unavailable'], evidence?.evidence_paths ?? []);
  }
  const gates = ['actual_video', 'analysis_complete', 'schema_valid', 'persisted_match'];
  if (gates.some(key => evidence[key] === false)) return withResult('fail', ['cloud_replay_gate_failed'], evidence?.evidence_paths ?? []);
  if (gates.every(key => bool(evidence, key)) && evidence.fresh_outputs > 0 && hasEvidence(evidence)) {
    return withResult('pass', [], evidence.evidence_paths);
  }
  return withResult('blocked', ['cloud_replay_evidence_incomplete'], evidence?.evidence_paths ?? []);
}

function handheldModel(evidence) {
  if (!evidence) return withResult('blocked', ['local_handheld_model_evidence_missing']);
  const paths = evidence.evidence_paths ?? [];
  const reasons = [];
  const failures = [];
  const hashes = ['model_bundle_sha256', 'weights_sha256', 'quality_profile_sha256'];
  if (hashes.some(key => typeof evidence[key] !== 'string' || !SHA256.test(evidence[key]))) {
    reasons.push('handheld_model_hashes_missing_or_invalid');
  }
  const classes = Array.isArray(evidence.class_mapping) ? evidence.class_mapping : [];
  if (new Set(classes).size !== classes.length || HANDHELD_CLASSES.some(name => !classes.includes(name))) {
    reasons.push('handheld_model_class_mapping_incomplete');
  }
  if (!bool(evidence, 'training_data_rights_cleared')) reasons.push('handheld_training_data_rights_unverified');
  if (!bool(evidence, 'bundle_frozen')) reasons.push('handheld_model_bundle_not_frozen');
  if (!bool(evidence, 'development_coverage_complete')) reasons.push('handheld_development_coverage_incomplete');
  if (!bool(evidence, 'candidate_path_replay_complete')) reasons.push('handheld_candidate_path_replay_incomplete');
  if (!bool(evidence, 'cpu_inference_measured') || !Number.isFinite(evidence.p95_inference_ms) ||
      evidence.p95_inference_ms < 0) reasons.push('handheld_cpu_inference_unmeasured');
  if (!Number.isFinite(evidence.uncertain_rate) || evidence.uncertain_rate < 0 || evidence.uncertain_rate > 1) {
    reasons.push('handheld_uncertainty_rate_unmeasured');
  }
  for (const key of ['development_unsafe_monitor_intervals', 'development_missed_actionable_transitions']) {
    if (!Number.isSafeInteger(evidence[key]) || evidence[key] < 0) reasons.push(`handheld_${key}_unmeasured`);
    else if (evidence[key] > 0) failures.push(`handheld_${key}_nonzero`);
  }
  if (failures.length) return withResult('fail', failures, paths);
  if (reasons.length) return withResult('blocked', reasons, paths);
  if (!hasEvidence(evidence)) return withResult('blocked', ['handheld_model_evidence_paths_missing']);
  return withResult('pass', [], paths);
}

function heldOut(evidence, modelEvidence, modelStatus) {
  if (!evidence) return withResult('blocked', ['independent_held_out_corpus_missing']);
  const counts = ['missed_actionable_incidents', 'unsafe_downgrades', 'false_urgent_normal_backgrounds'];
  if (counts.some(key => Number.isSafeInteger(evidence[key]) && evidence[key] > 0)) {
    return withResult('fail', ['held_out_quality_gate_failed'], evidence.evidence_paths ?? []);
  }
  const gates = ['independent_labels', 'frozen_corpus', 'complete_coverage'];
  const measuredCounts = counts.every(key => Number.isSafeInteger(evidence[key]) && evidence[key] >= 0);
  const complete = measuredCounts && gates.every(key => bool(evidence, key)) &&
    Number.isSafeInteger(evidence.actionable_positive_count) && evidence.actionable_positive_count >= 6 &&
    hasEvidence(evidence);
  if (complete && modelStatus === 'pass' &&
      typeof evidence.model_bundle_sha256 === 'string' &&
      evidence.model_bundle_sha256 === modelEvidence?.model_bundle_sha256) {
    return withResult('pass', [], evidence.evidence_paths);
  }
  if (complete && modelStatus === 'pass') {
    return withResult('blocked', ['held_out_model_bundle_mismatch'], evidence.evidence_paths);
  }
  if (complete && modelStatus !== 'pass') {
    return withResult('blocked', ['held_out_edge_model_not_qualified'], evidence.evidence_paths);
  }
  return withResult('blocked', ['held_out_evidence_incomplete'], evidence.evidence_paths ?? []);
}

function freeTier(evidence) {
  if (!evidence) return withResult('blocked', ['measured_free_tier_profile_missing']);
  const reasons = [];
  const paths = evidence.evidence_paths ?? [];
  const measuredWrites = evidence.measured_row_writes_per_day;
  if (Number.isFinite(measuredWrites) && (measuredWrites < 0 || measuredWrites >= 60000)) {
    reasons.push('durable_object_row_write_budget_failed');
  }
  if (evidence.simulation_complete === false) reasons.push('profile_simulation_failed');
  if (Number.isFinite(evidence.simulated_duration_ms) && evidence.simulated_duration_ms < 86400000) {
    reasons.push('profile_simulation_duration_failed');
  }

  const meters = evidence.meters && typeof evidence.meters === 'object' && !Array.isArray(evidence.meters)
    ? evidence.meters : {};
  const headroom = {};
  const missingMeters = [];
  const overBudgetMeters = [];
  for (const [name, expectedWindow] of Object.entries(FREE_TIER_METERS)) {
    const measurement = meters[name];
    if (!measurement || !Number.isFinite(measurement.used) || !Number.isFinite(measurement.limit) ||
        measurement.limit <= 0 || measurement.used < 0 || measurement.window !== expectedWindow) {
      missingMeters.push(name);
      continue;
    }
    const fraction = Math.max(0, (measurement.limit - measurement.used) / measurement.limit);
    headroom[name] = fraction;
    if (fraction < 0.2) overBudgetMeters.push(name);
  }
  if (overBudgetMeters.length) reasons.push('free_tier_meter_headroom_failed');
  if (Number.isFinite(measuredWrites) && measuredWrites >= 60000) reasons.push('free_tier_budget_gate_failed');
  if (reasons.length) {
    const result = withResult('fail', reasons, paths);
    result.meter_headroom_fraction = headroom;
    result.over_budget_meters = overBudgetMeters;
    return result;
  }

  if (!bool(evidence, 'simulation_complete')) reasons.push('profile_simulation_incomplete');
  if (!Number.isFinite(evidence.simulated_duration_ms) || evidence.simulated_duration_ms < 86400000) {
    reasons.push('profile_simulation_duration_missing');
  }
  if (!Number.isFinite(measuredWrites)) reasons.push('durable_object_row_write_measurement_missing');
  if (missingMeters.length) reasons.push('meter_headroom_incomplete');
  if (!bool(evidence, 'cloudflare_runtime_measurements')) reasons.push('cloudflare_runtime_measurements_missing');
  if (!bool(evidence, 'account_reconciled')) reasons.push('account_reconciliation_missing');
  if (!hasEvidence(evidence)) reasons.push('free_tier_evidence_paths_missing');
  const result = reasons.length ? withResult('blocked', reasons, paths) : withResult('pass', [], paths);
  result.meter_headroom_fraction = headroom;
  if (missingMeters.length) result.missing_meters = missingMeters;
  return result;
}

function corePi(evidence) {
  if (!evidence?.hardware_available) return withResult('blocked', ['raspberry_pi_unavailable'], evidence?.evidence_paths ?? []);
  if (evidence.gap_bound_violations > 0 || evidence.soak_duration_ms < 86400000) {
    return withResult('fail', ['pi_sustainability_gate_failed'], evidence.evidence_paths ?? []);
  }
  if (evidence.gap_bound_violations === 0 && evidence.soak_duration_ms >= 86400000 &&
      bool(evidence, 'restart_tested') && bool(evidence, 'network_loss_tested') && hasEvidence(evidence)) {
    return withResult('pass', [], evidence.evidence_paths);
  }
  return withResult('blocked', ['pi_measurement_incomplete'], evidence.evidence_paths ?? []);
}

/** Readiness is an evidence report, never a single test-suite green flag. */
export function buildReadinessReport(evidence = {}) {
  const offline = evidence.mode === 'offline';
  const edgeHandheldModel = handheldModel(evidence.edge_handheld_model);
  const stages = {
    core_pc: corePc(evidence.core_pc),
    cloud_contract: cloudContract(evidence.cloud_contract, offline),
    cloud_replay: cloudReplay(evidence.cloud_replay, offline),
    edge_handheld_model: edgeHandheldModel,
    quality_held_out: heldOut(evidence.quality_held_out, evidence.edge_handheld_model, edgeHandheldModel.status),
    free_tier_profile: freeTier(evidence.free_tier_profile),
    core_pi: corePi(evidence.core_pi),
  };
  const values = Object.values(stages).map(stage => stage.status);
  const status = values.includes('fail') ? 'fail' : values.includes('blocked') ? 'blocked' :
    values.every(value => value === 'pass') ? 'pass' : 'not_run';
  return {status, stages};
}
