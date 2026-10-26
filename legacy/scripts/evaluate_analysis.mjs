// Policy evaluation of actual captured runs. Not a model-quality benchmark.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {classifyReplay, finalPriority, flameLabel, priorityPolicyFailures, summarizePriorities} from './evaluation/replay-policy.mjs';
import {emptyExtendedMetrics, extendMetrics} from './evaluation/analysis-metrics.mjs';
import {buildReadinessReport} from './evaluation/readiness.mjs';

export function evaluateRuns(runs, annotations, readinessEvidence = {mode: 'offline'}) {
  const clips = Array.isArray(annotations?.clips) ? annotations.clips.map(label => label && ({...label,
    fire_present: flameLabel(label), onset_ms: label.visible_flame_onset_ms ?? label.onset_ms})) : [];
  const report = {passed: true, evaluation_kind: 'annotated_policy_checks', counts: {
    expected_clips: clips.length, clips: 0, confirmed: 0, accepted_known_causes: 0,
    unverified_hypotheses: 0, investigations: 0,
  }, cause_accuracy: null, detection_delay_ms: null, detection_delays_ms: [],
    detection_counts: null,
    accepted_unverified_attributions:0, model_hypothesis_frequency:null, false_alerts_per_camera_hour:null,
    ...emptyExtendedMetrics(), results: [], limitations: [], errors: [],
    readiness: buildReadinessReport(readinessEvidence)};
  let negativeAlerts = 0, negativeAlertCountsComplete = true;
  let negativeDurationMs=0, negativeDurationComplete=true, negativeClips=0;
  const positiveClips = clips.filter(c => c?.fire_present === true);
  const onsetComplete = positiveClips.length > 0 && positiveClips.every(c => Number.isFinite(c.onset_ms) && c.onset_ms >= 0);
  let sourceTimeComplete = true;
  if (!Array.isArray(runs) || !clips.length || annotations?.version !== 1) {
    report.errors.push('invalid_or_empty_evaluation_input');
    report.passed = false;
    return report;
  }
  const expectedNames = clips.map(c => c?.video);
  if (new Set(expectedNames).size !== expectedNames.length || expectedNames.some(name => typeof name !== 'string' || !name)) {
    report.errors.push('invalid_or_duplicate_annotations');
    report.passed = false;
    return report;
  }
  report.detection_counts = {true_positive:0,false_negative:0,false_positive:0,true_negative:0};
  for (const run of runs) {
    if (!expectedNames.includes(run?.video)) report.errors.push(`unexpected_captured_run: ${run?.video ?? '<missing video>'}`);
  }
  for (const label of clips) {
    const matching = runs.filter(run => run?.video === label.video);
    if (matching.length !== 1) {
      report.errors.push(`${label.video}: expected exactly one captured run, got ${matching.length}`);
      continue;
    }
    report.counts.clips++;
    const run = matching[0], failures = [];
    if (label.status === 'missing') report.errors.push(`${label.video}: missing_independent_footage`);
    if (label.split != null && !['development', 'held_out'].includes(label.split)) report.errors.push(`${label.video}: invalid_split_annotation`);
    if (label.category != null && !['smoke', 'contained', 'material', 'reflection', 'obscured'].includes(label.category)) report.errors.push(`${label.video}: invalid_category_annotation`);
    // Absence of a captured alert is not negative evidence after failed/partial replay.
    const completion = classifyReplay(run);
    if (!completion.eligible) failures.push(...completion.failures);
    if (!completion.eligible && completion.failures.includes('incomplete_capture')) report.errors.push(`${label.video}: incomplete_capture`);
    const confirmed = run.confirmation?.type === 'fire_confirmed' ||
      (run.confirmation && run.confirmation.type == null && Number.isFinite(run.confirmation.ts_ms));
    if (run.confirmation !== null && (!confirmed || typeof run.confirmation !== 'object')) {
      report.errors.push(`${label.video}: invalid_or_missing_confirmation_capture`);
    }
    if (confirmed) report.counts.confirmed++;
    if (typeof label.fire_present === 'boolean') {
      const key=label.fire_present ? (confirmed?'true_positive':'false_negative') : (confirmed?'false_positive':'true_negative');
      report.detection_counts[key]++;
      if (Boolean(confirmed)!==label.fire_present) failures.push('detection_expectation_failed');
      if (!label.fire_present) {
        negativeClips++;
        const alertCount = run.event_counts?.fire_confirmed ?? 0;
        if (!run.event_counts || typeof run.event_counts !== 'object' || !Number.isInteger(alertCount) ||
            alertCount < 0 || Boolean(alertCount) !== Boolean(confirmed)) negativeAlertCountsComplete = false;
        else negativeAlerts += alertCount;
        if (Number.isFinite(label.duration_ms)&&label.duration_ms>0) negativeDurationMs+=label.duration_ms;
        else negativeDurationComplete=false;
      }
      if (label.fire_present && confirmed) {
        const derivedOffset = Number.isFinite(run.source_start_ts_ms) && Number.isFinite(run.confirmation.ts_ms) ?
          run.confirmation.ts_ms - run.source_start_ts_ms : null;
        const offset = Number.isFinite(run.confirmation_offset_ms) ? run.confirmation_offset_ms : derivedOffset;
        const conflicting = Number.isFinite(run.confirmation_offset_ms) && Number.isFinite(derivedOffset) &&
          run.confirmation_offset_ms !== derivedOffset;
        if (!Number.isFinite(offset) || offset < 0 || conflicting) sourceTimeComplete = false;
        else if (onsetComplete) report.detection_delays_ms.push(offset - label.onset_ms);
      }
    }
    const causes = Array.isArray(run.causes) ? run.causes : [];
    if (label.fire_present && causes.length === 0) failures.push('missing_investigation');
    if (label.fire_present === false && (run.confirmation !== null || causes.length || run.analysis_status?.latest_job_id !== 0 ||
        run.event_counts?.fire_confirmed !== 0)) failures.push('negative_clip_investigation');
    for (const event of causes) {
      const cause = event.cause;
      if (!cause || typeof cause !== 'object') {failures.push('missing_investigation_payload'); continue;}
      report.counts.investigations++;
      // Count investigations with any accepted causal claim, including compatibility aliases.
      const causalFields = ['ignition_source', 'probable_cause', 'accepted_cause', 'ignition_tool', 'tool_used'];
      const hasClaim = value => causalFields.some(field => typeof value?.[field] === 'string' && value[field] !== '' && value[field] !== 'unknown');
      const acceptedKnown = hasClaim(cause);
      if (acceptedKnown) report.counts.accepted_known_causes++;
      const hypothesis=cause.model_hypothesis??cause.hypothesis;
      if (hasClaim(hypothesis)) report.counts.unverified_hypotheses++;
      if (acceptedKnown &&
          (cause.requires_human_review!==false || cause.cause_status!=='verified' || cause.source!=='human_review')) {
        report.accepted_unverified_attributions++;
        failures.push('unverified_attribution_accepted');
      }
      if (label.accepted_cause_expected && (cause.ignition_source !== label.accepted_cause_expected ||
          cause.probable_cause !== label.accepted_cause_expected ||
          (cause.accepted_cause != null && cause.accepted_cause !== label.accepted_cause_expected))) failures.push('accepted_cause_expectation_failed');
    }
    const priorities = ['monitor', 'inspect_urgently', 'escalate'];
    if (label.priority_expected != null && !priorities.includes(label.priority_expected)) {
      report.errors.push(`${label.video}: invalid_priority_annotation`);
    }
    if (label.interval_priority_expected != null && !priorities.includes(label.interval_priority_expected)) report.errors.push(`${label.video}: invalid_interval_priority_annotation`);
    if (label.scene_expected != null && !['contained_flame', 'contained_tool_flame', 'material_burning', 'smoke_only', 'uncertain'].includes(label.scene_expected)) report.errors.push(`${label.video}: invalid_scene_annotation`);
    failures.push(...priorityPolicyFailures(run, label));
    if (run.confirmation?.response_priority != null &&
        (!priorities.includes(run.confirmation.response_priority) || run.confirmation.response_priority !== run.confirmation.operator_priority)) {
      failures.push('response_priority_contract_failed');
    }
    report.results.push({video: label.video, confirmed: Boolean(confirmed),
      accepted_causes: causes.map(e => e.cause?.ignition_source ?? null),
      model_hypotheses: causes.map(e => e.cause?.model_hypothesis ?? e.cause?.hypothesis ?? null),
      operator_priority: finalPriority(run), replay_eligible: completion.eligible,
      ...summarizePriorities(run), split: label.split ?? null, category: label.category ?? null,
      annotation_basis: label.annotation_basis ?? null, failures});
  }
  if (negativeClips && negativeDurationComplete && negativeAlertCountsComplete && negativeDurationMs>0) {
    report.false_alerts_per_camera_hour=negativeAlerts/(negativeDurationMs/3600000);
  }
  if (!negativeAlertCountsComplete) report.limitations.push('negative_alert_counts_unavailable');
  if (!negativeDurationComplete) report.limitations.push('negative_duration_annotations_unavailable');
  if (clips.some(c => c.causal_ground_truth == null)) report.limitations.push('causal_ground_truth_unavailable');
  else report.limitations.push('causal_accuracy_not_established_by_policy_checks');
  if (!clips.some(c => c.fire_present === false)) report.limitations.push('independent_negative_footage_not_evaluated');
  if (positiveClips.length && !onsetComplete) report.limitations.push('detection_onset_annotations_unavailable');
  if (!sourceTimeComplete) report.limitations.push('source_time_confirmation_unavailable');
  if (!onsetComplete || !sourceTimeComplete) report.detection_delays_ms = [];
  report.limitations.push('not_a_physical_risk_validation', 'not_a_pi_performance_benchmark', 'model_confidence_not_calibrated');
  if (clips.some(c => typeof c.fire_present !== 'boolean')) {
    report.detection_counts = null;
    report.detection_delays_ms = [];
    report.false_alerts_per_camera_hour = null;
    report.limitations.push('fire_presence_annotations_unavailable');
  }
  if (report.errors.length) {
    report.detection_counts = null;
    report.detection_delays_ms = [];
    report.false_alerts_per_camera_hour = null;
    report.limitations.push('captured_run_coverage_incomplete');
  }
  // Descriptive claim frequency among captured investigation payloads, never correctness or calibration.
  if (report.counts.investigations) {
    report.model_hypothesis_frequency = report.counts.unverified_hypotheses / report.counts.investigations;
  }
  // Arithmetic mean of source-time delays among detected positives; misses remain in the confusion counts.
  if (report.detection_delays_ms.length) {
    report.detection_delay_ms = report.detection_delays_ms.reduce((sum, delay) => sum + delay, 0) / report.detection_delays_ms.length;
  }
  report.passed = report.errors.length === 0 && report.results.length === clips.length && report.results.every(r => r.failures.length === 0);
  const corpusComplete = report.errors.length === 0 && report.results.length === clips.length &&
    report.results.every(result => result.replay_eligible);
  if (!corpusComplete) {
    report.detection_counts = null;
    report.detection_delays_ms = [];
    report.detection_delay_ms = null;
    report.false_alerts_per_camera_hour = null;
    report.limitations.push('captured_run_coverage_incomplete');
  }
  return extendMetrics(report, runs, clips);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log([
      'node scripts/evaluate_analysis.mjs --run-dir DIR [--annotations JSON] [--readiness-evidence JSON] [--output JSON]',
      'Reads DIR/summary.json and version-1 policy annotations; output creation is exclusive (no overwrite).',
      'Every annotation needs exactly one captured run; extra, missing and duplicate runs fail.',
      'Metric capture: code:0, agentVerified:true, positive equal sampled_frames/uploaded_frames, no socketError.',
      'No captured alert must be explicit confirmation:null, not an omitted or malformed confirmation.',
      'Detection confusion is clip-level and needs complete fire_present annotations and captures.',
      'visible_flame_present supersedes legacy fire_present; actionable_fire_present is separately annotated.',
      'detection_delay_ms is mean source-time delay for confirmed positives, NOT processing latency.',
      'Delay requires onset_ms for every positive plus confirmation_offset_ms or source_start_ts_ms/confirmation.ts_ms.',
      'False alerts/camera-hour requires complete negatives, duration_ms and event_counts.fire_confirmed (counts all alerts).',
      'false_urgent_alerts_per_camera_hour counts distinct incidents ever live urgent over actionable-negative exposure, including later downgrades; observed_interval updates are excluded.',
      'priority_expected uses greatest source timestamp, ties prefer live; interval_priority_expected and scene_expected check historical interval separately.',
      'actionable_incident_counts uses latest live priority; observed_interval assessments cannot overwrite it.',
      'Schema failure rate covers received workers_ai outputs only (no vlm_error; fresh/cached when metadata exists); fallback/skipped outputs are excluded; no eligible outputs is null.',
      'Pipeline uncertainty includes fallback investigations; complete scene_assessment coverage is required.',
      'Priorities: monitor | inspect_urgently | escalate; these are policy, not physical risk scores.',
      'model_hypothesis_frequency is the fraction of captured investigations with a source/tool claim, not accuracy.',
      'cause_accuracy remains null: policy labels do not supply an independent causal corpus.',
      'Readiness evidence is accepted through --readiness-evidence JSON; captured evaluation alone leaves cloud readiness not_run.',
    ].join('\n'));
    return;
  }
  const value = name => args[args.indexOf(name) + 1];
  if (!args.includes('--run-dir')) throw new Error('--run-dir is required');
  const annotations = args.includes('--annotations') ? value('--annotations') : fileURLToPath(new URL('./evaluation/analysis-policy-labels.json', import.meta.url));
  const readinessEvidence = args.includes('--readiness-evidence') ?
    JSON.parse(fs.readFileSync(value('--readiness-evidence'), 'utf8')) : {mode: 'offline'};
  const report = evaluateRuns(JSON.parse(fs.readFileSync(path.join(value('--run-dir'), 'summary.json'), 'utf8')),
    JSON.parse(fs.readFileSync(annotations, 'utf8')), readinessEvidence);
  const json = JSON.stringify(report, null, 2) + '\n';
  if (args.includes('--output')) fs.writeFileSync(value('--output'), json, {flag: 'wx'});
  console.log(json);
  if (!report.passed) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
