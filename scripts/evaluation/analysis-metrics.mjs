import {classifyReplay, latestLivePriority, liveUrgentAlerts, priorities, receivedProviderOutput, summarizeInference, urgent} from './replay-policy.mjs';

const confusion = () => ({true_positive: 0, false_negative: 0, false_positive: 0, true_negative: 0});
const add = (counts, expected, observed) => counts[expected
  ? (observed ? 'true_positive' : 'false_negative') : (observed ? 'false_positive' : 'true_negative')]++;
const average = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

export function emptyExtendedMetrics() {
  return {flame_detection_counts: null, actionable_incident_counts: null,
    false_urgent_alerts_per_camera_hour: null, actionable_detection_delay_ms: null,
    actionable_detection_delays_ms: [], schema_failure_rate: null, schema_eligible_outputs: 0,
    schema_excluded_investigations: 0, uncertainty_rate: null,
    inference_counts: null, fresh_inference_usage: null, split_counts: {}, category_counts: {},
    coverage: null, metric_coverage: {}};
}

export function extendMetrics(report, runs, clips) {
  const byVideo = new Map(runs.filter(run => run && typeof run === 'object').map(run => [run.video, run]));
  const complete = report.errors.length === 0 && clips.every(label => classifyReplay(byVideo.get(label.video) ?? {}).eligible);
  const causes = clips.flatMap(label => byVideo.get(label.video)?.causes ?? []);
  Object.assign(report, summarizeInference(causes));
  const received = causes.filter(event => receivedProviderOutput(event?.cause));
  report.schema_eligible_outputs = received.length;
  report.schema_excluded_investigations = causes.length - received.length;
  if (received.length && received.every(event => Array.isArray(event.cause?.validation_errors))) {
    report.schema_failure_rate = received.filter(event => event.cause.validation_errors.length > 0).length / received.length;
  } else if (!received.length) report.limitations.push('provider_outputs_unavailable');
  else report.limitations.push('schema_validation_capture_unavailable');
  const categories = ['contained_flame', 'contained_tool_flame', 'material_burning', 'smoke_only', 'uncertain'];
  if (causes.length && causes.every(event => categories.includes(event.cause?.scene_assessment?.category))) {
    report.uncertainty_rate = causes.filter(event => event.cause.scene_assessment.category === 'uncertain').length / causes.length;
  } else report.limitations.push('scene_uncertainty_capture_unavailable');
  if (report.inference_counts === null) report.limitations.push('inference_metadata_unavailable');
  for (const label of clips) {
    const split = label.split ?? 'unmeasured', category = label.category ?? 'unmeasured';
    report.split_counts[split] = (report.split_counts[split] ?? 0) + 1;
    report.category_counts[category] = (report.category_counts[category] ?? 0) + 1;
  }
  report.flame_detection_counts = report.detection_counts;
  const actionableComplete = complete && clips.every(label => typeof label.actionable_fire_present === 'boolean') &&
    clips.every(label => {
      const run = byVideo.get(label.video);
      return run.confirmation === null || priorities.includes(latestLivePriority(run));
    });
  if (actionableComplete) {
    report.actionable_incident_counts = confusion();
    for (const label of clips) add(report.actionable_incident_counts, label.actionable_fire_present, urgent(latestLivePriority(byVideo.get(label.video))));
  } else report.limitations.push('actionable_presence_or_priority_annotations_unavailable');

  const negatives = clips.filter(label => label.actionable_fire_present === false);
  let urgentCount = 0, exposure = 0;
  let urgentComplete = complete && clips.every(label => typeof label.actionable_fire_present === 'boolean') && negatives.length > 0;
  for (const label of negatives) {
    const run = byVideo.get(label.video);
    if (!Number.isFinite(label.duration_ms) || label.duration_ms <= 0 || !Array.isArray(run?.urgent_alerts)) {urgentComplete = false; continue;}
    const alerts = liveUrgentAlerts(run);
    const observedUrgent = urgent(latestLivePriority(run)) || urgent(run.confirmation?.response_priority ?? run.confirmation?.operator_priority) ||
      (run.causes ?? []).some(event => event.priority_scope !== 'observed_interval' && urgent(event.response_priority));
    if (observedUrgent && alerts.length === 0) {urgentComplete = false; continue;}
    if (alerts.some(event => typeof event?.incident_id !== 'string' || !event.incident_id ||
      !urgent(event.response_priority ?? event.operator_priority))) {urgentComplete = false; continue;}
    // Capture includes initial urgent admission even if a later model result downgrades it.
    urgentCount += new Set(alerts.map(event => event.incident_id)).size;
    exposure += label.duration_ms;
  }
  if (urgentComplete && exposure > 0) report.false_urgent_alerts_per_camera_hour = urgentCount / (exposure / 3600000);
  else report.limitations.push('urgent_alert_capture_or_negative_exposure_unavailable');

  const positives = clips.filter(label => label.actionable_fire_present === true);
  let delayComplete = actionableComplete && positives.length > 0;
  const delays = [];
  for (const label of positives) {
    const run = byVideo.get(label.video);
    if (!Number.isFinite(label.actionable_onset_ms) || label.actionable_onset_ms < 0) {delayComplete = false; continue;}
    if (!urgent(latestLivePriority(run))) continue; // Misses stay in the confusion denominator.
    const alerts = liveUrgentAlerts(run);
    if (!alerts?.length || !Number.isFinite(run.source_start_ts_ms) ||
      alerts.some(event => !Number.isFinite(event.ts_ms))) {delayComplete = false; continue;}
    const offset = Math.min(...alerts.map(event => event.ts_ms)) - run.source_start_ts_ms;
    if (offset < 0) {delayComplete = false; continue;}
    delays.push(offset - label.actionable_onset_ms);
  }
  if (delayComplete) {
    report.actionable_detection_delays_ms = delays;
    report.actionable_detection_delay_ms = average(delays);
  } else report.limitations.push('actionable_source_time_or_onset_unavailable');
  report.metric_definitions = {
    flame_detection_counts: 'Clip-level visible flame confirmation; legacy fire_present is a compatibility alias.',
    actionable_incident_counts: 'Clip-level latest live source priority inspect_urgently/escalate against independent actionable_fire_present labels; historical observed_interval assessments never replace live status.',
    false_urgent_alerts_per_camera_hour: 'Distinct incidents ever announced live urgent/escalate, including later downgrades, per labeled actionable-negative camera hour; historical observed_interval updates excluded.',
    schema_failure_rate: 'Received provider outputs with nonempty validation_errors / eligible received outputs: source workers_ai, no vlm_error, inference mode fresh/cached when metadata exists; fallback/skipped/unknown source excluded; complete validation field coverage required.',
    uncertainty_rate: 'Pipeline investigations with scene_assessment.category uncertain / all pipeline investigations, including fallback, only with complete field coverage; not provider-only uncertainty.',
    fresh_inference_usage: 'Provider-reported tokens for fresh calls only; cached replay tokens are not charged again; missing fields remain null.',
  };
  const excludedRuns = clips.flatMap(label => {
    const run = byVideo.get(label.video);
    if (!run) return [{video: label.video, reason_codes: ['captured_run_missing']}];
    const result = classifyReplay(run);
    return result.eligible ? [] : [{video: label.video, reason_codes: result.failures}];
  });
  const runCorpusComplete = report.errors.length === 0 && clips.length > 0 && excludedRuns.length === 0;
  report.coverage = {requested_count: clips.length,
    matched_count: clips.filter(label => byVideo.has(label.video)).length,
    eligible_count: clips.length - excludedRuns.length,
    full_corpus_eligible: runCorpusComplete, exclusions: excludedRuns};
  const exclusionsFor = predicate => clips.flatMap(label => {
    const run = byVideo.get(label.video);
    const reasons = [];
    if (!predicate(label)) reasons.push('required_annotation_missing');
    if (!run) reasons.push('captured_run_missing');
    else reasons.push(...classifyReplay(run).failures);
    return reasons.length ? [{video: label.video, reason_codes: [...new Set(reasons)]}] : [];
  });
  const coverageMetric = (numerator, denominator, requestedCount, eligibleCount, exclusions, completeMetric) => ({
    numerator: completeMetric ? numerator : null,
    denominator: completeMetric ? denominator : null,
    requested_count: requestedCount,
    eligible_count: eligibleCount,
    exclusions,
    complete: completeMetric,
  });
  const flameLabels = clips.filter(label => typeof label.visible_flame_present === 'boolean' || typeof label.fire_present === 'boolean');
  const flameComplete = runCorpusComplete && flameLabels.length === clips.length && report.detection_counts !== null;
  const flameCounts = report.detection_counts;
  const flameDenominator = flameCounts ? Object.values(flameCounts).reduce((sum, count) => sum + count, 0) : null;
  const flameNumerator = flameCounts ? flameCounts.true_positive + flameCounts.true_negative : null;
  const schemaComplete = runCorpusComplete && received.length > 0 &&
    received.every(event => Array.isArray(event.cause?.validation_errors));
  const uncertaintyComplete = runCorpusComplete && causes.length > 0 &&
    causes.every(event => categories.includes(event.cause?.scene_assessment?.category));
  const freshCalls = report.inference_counts?.fresh ?? null;
  const freshUsageComplete = runCorpusComplete && Number.isSafeInteger(report.fresh_inference_usage?.total_tokens);
  report.metric_coverage = {
    visible_flame_detection: coverageMetric(flameNumerator, flameDenominator, clips.length,
      flameLabels.filter(label => byVideo.has(label.video) && classifyReplay(byVideo.get(label.video)).eligible).length,
      exclusionsFor(label => typeof label.visible_flame_present === 'boolean' || typeof label.fire_present === 'boolean'), flameComplete),
    actionable_incidents: coverageMetric(
      report.actionable_incident_counts ? report.actionable_incident_counts.true_positive + report.actionable_incident_counts.true_negative : null,
      report.actionable_incident_counts ? Object.values(report.actionable_incident_counts).reduce((sum, count) => sum + count, 0) : null,
      clips.length, clips.filter(label => typeof label.actionable_fire_present === 'boolean' &&
        byVideo.has(label.video) && classifyReplay(byVideo.get(label.video)).eligible).length,
      exclusionsFor(label => typeof label.actionable_fire_present === 'boolean'), actionableComplete),
    false_urgent_alerts_per_camera_hour: coverageMetric(urgentComplete ? urgentCount : null,
      urgentComplete ? exposure / 3600000 : null, negatives.length, negatives.filter(label =>
        byVideo.has(label.video) && Number.isFinite(label.duration_ms) && Array.isArray(byVideo.get(label.video)?.urgent_alerts) &&
        classifyReplay(byVideo.get(label.video)).eligible).length,
      exclusionsFor(label => label.actionable_fire_present === false && Number.isFinite(label.duration_ms) && label.duration_ms > 0),
      urgentComplete && report.false_urgent_alerts_per_camera_hour !== null),
    actionable_detection_delay_ms: coverageMetric(delayComplete ? delays.reduce((sum, value) => sum + value, 0) : null,
      delayComplete ? delays.length : null, positives.length, delayComplete ? positives.length : 0,
      exclusionsFor(label => label.actionable_fire_present === true && Number.isFinite(label.actionable_onset_ms)), delayComplete),
    schema_failure_rate: coverageMetric(schemaComplete ? received.filter(event => event.cause.validation_errors.length > 0).length : null,
      schemaComplete ? received.length : null, causes.length, received.length,
      [{count: causes.length - received.length, reason_code: 'provider_output_not_received_or_unverifiable'}], schemaComplete),
    uncertainty_rate: coverageMetric(uncertaintyComplete ? causes.filter(event => event.cause.scene_assessment.category === 'uncertain').length : null,
      uncertaintyComplete ? causes.length : null, causes.length, uncertaintyComplete ? causes.length : 0,
      uncertaintyComplete ? [] : [{count: causes.length, reason_code: 'scene_coverage_incomplete'}], uncertaintyComplete),
    fresh_inference_usage: coverageMetric(report.fresh_inference_usage?.total_tokens ?? null, freshCalls,
      causes.length, freshCalls ?? 0, report.inference_counts?.cached ? [{count: report.inference_counts.cached, reason_code: 'cached_not_fresh_usage'}] : [],
      freshUsageComplete),
  };
  return report;
}
