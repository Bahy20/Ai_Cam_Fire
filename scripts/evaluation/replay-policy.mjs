// Shared annotation semantics. No labels are inferred from model output.
import {isDeepStrictEqual} from 'node:util';

export const priorities = ['monitor', 'inspect_urgently', 'escalate'];
export const urgent = value => ['inspect_urgently', 'escalate'].includes(value);
export const flameLabel = label => typeof label?.visible_flame_present === 'boolean'
  ? label.visible_flame_present : label?.fire_present;
const eventPriority = event => event?.response_priority ?? event?.operator_priority;
const historical = event => event?.priority_scope === 'observed_interval';
const newest = events => events.reduce((best, event) => {
  if (!best || event.ts_ms > best.ts_ms) return event;
  if (event.ts_ms !== best.ts_ms) return best;
  // A historical model assessment cannot displace a same-source live status.
  if (historical(best) !== historical(event)) return historical(best) ? event : best;
  // Conflicting same-source statuses are resolved conservatively and do not
  // depend on which asynchronous message happened to arrive last.
  if (priorities.indexOf(eventPriority(event)) > priorities.indexOf(eventPriority(best))) return event;
  return best;
}, null);
export function summarizePriorities(run) {
  const causes = Array.isArray(run.causes) ? run.causes : [];
  const candidates = [
    ...(Array.isArray(run.priority_events) ? run.priority_events : []),
    ...(run.confirmation ? [{...run.confirmation, type: run.confirmation.type ?? 'fire_confirmed'}] : []),
    ...(run.last_update ? [{...run.last_update, type: run.last_update.type ?? 'fire_update'}] : []),
    ...causes.map(event => ({...event, type: event.type ?? 'cause_update'})),
  ].filter(event => ['fire_confirmed', 'fire_update', 'cause_update'].includes(event?.type) &&
    Number.isFinite(event.ts_ms) && priorities.includes(eventPriority(event)));
  const latest = newest(candidates), live = newest(candidates.filter(event => !historical(event)));
  const interval = newest(causes.filter(event => Number.isFinite(event?.ts_ms)));
  return {final_priority: latest ? eventPriority(latest) : null,
    final_priority_ts_ms: latest?.ts_ms ?? null,
    final_priority_scope: latest ? (historical(latest) ? 'observed_interval' : 'live') : null,
    latest_live_priority: live ? eventPriority(live) : null,
    latest_live_priority_ts_ms: live?.ts_ms ?? null,
    interval_priority: interval && priorities.includes(eventPriority(interval)) ? eventPriority(interval) : null,
    interval_scene: interval?.cause?.scene_assessment?.category ?? null,
    interval_ts_ms: interval?.ts_ms ?? null};
}
export const finalPriority = run => summarizePriorities(run).final_priority;
export const latestLivePriority = run => summarizePriorities(run).latest_live_priority;
export function liveUrgentAlerts(run) {
  if (!Array.isArray(run.urgent_alerts)) return null;
  return run.urgent_alerts.filter(event => {
    if (historical(event)) return false;
    if (event?.priority_scope == null && event?.type === 'cause_update') {
      const matching = (run.causes ?? []).filter(cause => cause.ts_ms === event.ts_ms &&
        (event.incident_id == null || cause.incident_id === event.incident_id) &&
        (event.analysis_job_id == null || cause.analysis_job_id === event.analysis_job_id));
      if (matching.length && matching.every(historical)) return false;
    }
    return true;
  });
}
export function priorityPolicyFailures(run, annotation) {
  const failures = [], summary = summarizePriorities(run);
  if (annotation?.priority_expected != null &&
    (!priorities.includes(annotation.priority_expected) || summary.final_priority !== annotation.priority_expected)) {
    failures.push('operator_priority_expectation_failed');
  }
  if (annotation?.interval_priority_expected != null &&
    (!priorities.includes(annotation.interval_priority_expected) || summary.interval_priority !== annotation.interval_priority_expected)) {
    failures.push('interval_priority_expectation_failed');
  }
  if (annotation?.scene_expected != null && summary.interval_scene !== annotation.scene_expected) failures.push('scene_expectation_failed');
  if (typeof annotation?.actionable_fire_present === 'boolean') {
    if (run.confirmation !== null && summary.latest_live_priority === null) failures.push('actionable_priority_unmeasured');
    else if (urgent(summary.latest_live_priority) !== annotation.actionable_fire_present) failures.push('actionable_expectation_failed');
  }
  return failures;
}
export const completeCapture = run => run.code === 0 && run.agentVerified === true && run.socketError == null &&
  Number.isInteger(run.sampled_frames) && run.sampled_frames > 0 && run.uploaded_frames === run.sampled_frames;

// The adapter sets workers_ai only after receiving a raw provider response.
// Missing legacy inference metadata is allowed; present metadata must confirm
// a fresh/cached response rather than a skipped request or unknown provenance.
export const receivedProviderOutput = cause => cause?.source === 'workers_ai' &&
  !Object.hasOwn(cause, 'vlm_error') &&
  (cause.inference_metadata === undefined || ['fresh', 'cached'].includes(cause.inference_metadata?.mode));
export const verifyModelSchemas = causes => Array.isArray(causes) && causes.length > 0 &&
  causes.every(event => receivedProviderOutput(event?.cause) &&
    Array.isArray(event.cause.validation_errors) && event.cause.validation_errors.length === 0);

export function verifyPersistedAnalyses(causes, persisted) {
  if (!Array.isArray(causes) || !causes.length || !Array.isArray(persisted) || persisted.length !== causes.length)
    return false;
  const unmatched = [...persisted];
  for (const event of causes) {
    const index = unmatched.findIndex(row => {
      if (row.event_kind !== 'analysis' || row.camera_id !== event.camera_id || row.ts_ms !== event.ts_ms ||
          row.incident_id !== event.incident_id || row.snapshot_key !== null ||
          row.cause !== event.cause?.probable_cause || row.confidence !== event.cause?.confidence ||
          row.operator_priority !== (event.response_priority ?? event.operator_priority) ||
          (event.analysis_job_id !== undefined && row.event_key !== `${event.incident_id}:analysis:${event.analysis_job_id}`)) return false;
      try {
        const analysis = JSON.parse(row.analysis_json);
        return analysis.event_kind === 'analysis' && analysis.analysis_status === 'complete' &&
          (event.analysis_job_id === undefined || analysis.analysis_job_id === event.analysis_job_id) &&
          isDeepStrictEqual(analysis.cause, event.cause) &&
          isDeepStrictEqual(analysis.evidence_manifest, event.evidence_manifest) &&
          analysis.response_priority === (event.response_priority ?? event.operator_priority) &&
          (!analysis.priority_assessment || Object.entries(analysis.priority_assessment)
            .every(([key, value]) => isDeepStrictEqual(event[key], value)));
      } catch { return false; }
    });
    if (index < 0) return false;
    unmatched.splice(index, 1);
  }
  return unmatched.length === 0;
}

function verifyPersistedConfirmation(confirmation, rows) {
  if (confirmation === null) return rows.length === 0;
  if (rows.length !== 1) return false;
  const row = rows[0];
  const priority = confirmation.response_priority ?? confirmation.operator_priority;
  if (row.event_kind !== 'confirmation' || row.camera_id !== confirmation.camera_id ||
      row.ts_ms !== confirmation.ts_ms || row.incident_id !== confirmation.incident_id ||
      row.event_key !== `${confirmation.incident_id}:confirmation` || row.snapshot_key !== null ||
      row.cause !== 'unknown' || row.confidence !== 'low' || row.operator_priority !== priority) return false;
  try {
    const analysis = JSON.parse(row.analysis_json);
    return analysis.event_kind === 'confirmation' && analysis.analysis_status === 'pending' &&
      analysis.response_priority === priority && (!analysis.priority_assessment ||
        Object.entries(analysis.priority_assessment).every(([key, value]) => isDeepStrictEqual(confirmation[key], value)));
  } catch { return false; }
}

export function verifyPersistedRecords(causes, confirmation, persisted) {
  if (!Array.isArray(causes) || !Array.isArray(persisted) ||
      persisted.some(row => !['analysis', 'confirmation'].includes(row?.event_kind))) return false;
  const analyses = persisted.filter(row => row.event_kind === 'analysis');
  const confirmations = persisted.filter(row => row.event_kind === 'confirmation');
  return (causes.length ? verifyPersistedAnalyses(causes, analyses) : analyses.length === 0) &&
    verifyPersistedConfirmation(confirmation, confirmations) &&
    analyses.length + confirmations.length === persisted.length;
}

const analysisFlags = ['active', 'queued', 'pending_followup', 'native_inference_pending'];
const confirmedEvent = value => value?.type === 'fire_confirmed' ||
  (value && value.type == null && Number.isFinite(value.ts_ms));
function safeProviderOutput(event) {
  const cause = event?.cause;
  if (!cause || typeof cause !== 'object' || Array.isArray(cause)) return false;
  if (cause.source !== 'workers_ai') return true;
  return cause.requires_human_review === true && cause.hazard_absence_verified === false &&
    ['ignition_source', 'probable_cause', 'accepted_cause', 'ignition_tool', 'fuel_type', 'fire_class']
      .every(key => cause[key] === 'unknown') &&
    !['water_or_soil_sand', 'wet_chemical'].includes(cause.recommended_agent);
}

/** Shared evidence-completion contract. A saved success flag never substitutes
 * for an idle analysis watermark, an explicit event capture, or persistence. */
export function classifyReplay(run, {requireAi = false, requireFreshAi = false} = {}) {
  const failures = [];
  if (!completeCapture(run)) failures.push('incomplete_capture');
  if (run?.analysisComplete !== true) failures.push('analysis_incomplete');
  const status = run?.analysis_status;
  if (!status || !analysisFlags.every(key => status[key] === false) ||
      status.pending_evidence === true ||
      (status.pending_evidence !== undefined && typeof status.pending_evidence !== 'boolean') ||
      !Number.isSafeInteger(status.latest_job_id) || status.latest_job_id < 0) failures.push('analysis_not_idle');
  const hasConfirmation = confirmedEvent(run?.confirmation);
  if (run?.confirmation !== null && !hasConfirmation) failures.push('invalid_or_missing_confirmation_capture');
  if (!Array.isArray(run?.causes)) failures.push('investigation_capture_incomplete');
  const causes = Array.isArray(run?.causes) ? run.causes : [];
  const persisted = run?.persisted_events;
  const persistenceEvidenceValid = verifyPersistedRecords(causes, run?.confirmation, persisted);
  if (run?.persistedMatch !== true || !persistenceEvidenceValid) failures.push('persistence_mismatch');
  if (!causes.every(safeProviderOutput)) failures.push('unsafe_model_output');
  const fireCount = run?.event_counts?.fire_confirmed;
  if (!run?.event_counts || !Number.isSafeInteger(fireCount) || fireCount < 0 ||
      (hasConfirmation ? fireCount < 1 : fireCount !== 0)) failures.push('event_capture_incomplete');
  const sequenceStart = run?.event_sequence_start, finalWatermark = run?.final_event_watermark;
  const capturedSequences = run?.captured_event_sequences;
  if (!Number.isSafeInteger(sequenceStart) || sequenceStart < 0 ||
      !Number.isSafeInteger(finalWatermark) || finalWatermark < sequenceStart ||
      !Array.isArray(capturedSequences) || capturedSequences.length !== finalWatermark - sequenceStart ||
      !capturedSequences.every((sequence, index) => Number.isSafeInteger(sequence) && sequence === sequenceStart + index + 1)) {
    failures.push('event_capture_incomplete');
  }

  const incidentObserved = hasConfirmation || causes.length > 0;
  if (requireAi && incidentObserved && (!verifyModelSchemas(causes) ||
      (requireFreshAi && !causes.every(event => event?.cause?.inference_metadata?.mode === 'fresh')))) {
    failures.push('ai_verification_failed');
  }
  return {eligible: failures.length === 0, failures: [...new Set(failures)]};
}

export function judgeReplay(run, annotation, {requireAi = false, requireFreshAi = false} = {}) {
  const completion = classifyReplay(run, {requireAi, requireFreshAi});
  const failures = [...completion.failures];
  const expected = annotation ? flameLabel(annotation) : true;
  const causes = Array.isArray(run.causes) ? run.causes : [];
  const confirmed = confirmedEvent(run.confirmation);
  if (typeof expected === 'boolean' && Boolean(confirmed) !== expected) failures.push('detection_expectation_failed');
  if (expected === false) {
    if (run.confirmation !== null || causes.length || run.analysis_status?.latest_job_id !== 0 ||
      run.event_counts?.fire_confirmed !== 0) failures.push('negative_clip_investigation');
  } else if (expected === true) {
    if (!causes.length) failures.push('missing_investigation');
  }
  failures.push(...priorityPolicyFailures(run, annotation));
  return {passed: failures.length === 0, eligible: completion.eligible, failures: [...new Set(failures)]};
}

export function planReplayBatch(videos, annotations, maxCalls = 256) {
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 0 || maxCalls > 256) throw new Error('invalid_ai_call_budget: expected integer 0..256');
  if (annotations && (annotations.version !== 1 || !Array.isArray(annotations.clips))) throw new Error('invalid_annotations');
  const names = annotations?.clips.map(label => label?.video) ?? [];
  if (new Set(names).size !== names.length) throw new Error('duplicate_annotations');
  const labels = videos.map(video => {
    const name = video.replaceAll('\\', '/').split('/').at(-1);
    const found = annotations?.clips.find(label => label?.video === name);
    if (annotations && !found) throw new Error(`missing_annotation: ${name}`);
    if (found?.status === 'missing') throw new Error(`missing_footage: ${name}`);
    return found ?? null;
  });
  const reservations = labels.map(label => flameLabel(label) === false ? 0 : 2);
  const reserved = reservations.reduce((sum, value) => sum + value, 0);
  if (reserved > maxCalls) throw new Error(`ai_call_budget_exceeded: preflight ${reserved} > ${maxCalls}; split the batch`);
  return {max_calls: maxCalls, reserved_calls: reserved, reservations, labels};
}

export function summarizeInference(causes) {
  const metadata = causes.map(event => event.cause?.inference_metadata);
  if (!metadata.length || metadata.some(item => !['fresh', 'cached', 'skipped'].includes(item?.mode))) {
    return {inference_counts: null, fresh_inference_usage: null};
  }
  const counts = {fresh: 0, cached: 0, skipped: 0};
  for (const item of metadata) counts[item.mode]++;
  const fresh = metadata.filter(item => item.mode === 'fresh');
  const usage = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens'].map(key => [key,
    fresh.every(item => Number.isSafeInteger(item.usage?.[key]) && item.usage[key] >= 0)
      ? fresh.reduce((sum, item) => sum + item.usage[key], 0) : null]));
  return {inference_counts: counts, fresh_inference_usage: usage};
}
