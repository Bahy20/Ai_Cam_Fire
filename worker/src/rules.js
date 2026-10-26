// Pure event builders. Visual activity and hazard assessment are independent.
// No I/O, runtime bindings or Python dependencies.
import { isReviewedSiteContext, isReviewedSourceContext } from './site-context.js';
import { isReviewedHandheldUseContext } from './site-context.js';
import { isHandheldLeaseCurrent } from './handheld-lease.js';
import { sceneAssessmentApplies } from './investigation.js';
export { parseCameraContexts, contextForCamera } from './site-context.js';

/**
 * Fail closed until an independently validated hazard/context policy exists.
 * Footprint, decline, duration, box count and fuel guesses do not establish
 * physical scale, exposure, controllability or low danger. Missing/weak boxes
 * cannot assert flash collapse. VLM enrichment is not verified hazard context.
 * Even supplied context currently yields unknown: a calibrated hazard policy
 * and temporal region association have not been integrated. No shrinking cap.
 */
export function evaluateSeverity(_input = {}) {
  return {
    level: "unknown", score: null, confidence: "low",
    reasons: ["insufficient_validated_hazard_context"],
    limitations: ["fuel_scale_exposure_not_assessed",
      "visual_activity_does_not_establish_hazard",
      "spatial_spread_not_assessed", "hazard_policy_not_validated"],
  };
}

export const OPERATIONAL_RESPONSE_POLICY_VERSION = 'operational-response-v2-experimental';
export const RESPONSE_PRIORITY_POLICY_VERSION = OPERATIONAL_RESPONSE_POLICY_VERSION;

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const boundedStrings = value => Array.isArray(value) && value.length <= 32 &&
  [...value].every(v => typeof v === 'string' && v.length <= 96);
const finiteRange = (value, max) => Number.isFinite(value) && value >= 0 && value <= max;
const neutralTrendLimitations = new Set(['visual_footprint_not_physical_growth_or_hazard',
  'footprint_change_not_extinction_or_safety']);

/**
 * Experimental human-response policy, not a physical hazard/suppression rating.
 * Input is JSON-like, assembled ONLY by trusted server code, never by a VLM or
 * directly from a client upload. This helper validates shape, not authentication.
 * Required: camera_id (<=80 identifier chars), ts_ms (finite event time >=0),
 * detection_status:'idle'|'watch'|'confirmed', observation_valid:boolean,
 * evidence_current:boolean (caller-established freshness), visibility_status:
 * 'adequate'|'unknown'|'degraded', visual_activity:'growing'|'steady'|'shrinking'|
 * 'unknown', trend_confidence:'low'|'medium', trend_sample_count:integer 0..10000,
 * trend_duration_s:number 0..3600 (ACTUAL trend window, NOT incident duration_s),
 * trend_limitations:dense string[<=32] (each <=96 chars), smoke_evidence:
 * 'strong'|'weak'|'not_detected'|'unknown' from normalizeObservation().smoke.evidence_level.
 * Optional: area_reliable:boolean, camera_motion:boolean|null, evidence_ts_ms
 * (must equal ts_ms), site_context (uncloned contextForCamera() reference),
 * scene_assessment (qualified model claim), scene_evidence_current and
 * scene_chronological_match (caller-established current incident/job and local
 * evidence association). A supported contained claim plus reviewed expected_flame_use
 * can monitor a confirmed observation; unknown global visibility does not clear
 * surroundings, and degraded visibility, positive smoke/growth or site hazards veto.
 * Robust visual escalation additionally requires current reliable positive area,
 * adequate visibility, explicitly stationary camera, medium trend confidence,
 * >=3 samples over >=2 seconds and no nongeneric trend warnings. Those quality
 * gates cannot be inferred merely from successful image decoding. Unknown motion
 * or missing trend support cannot escalate, and never clears a confirmed fire.
 * Reviewed known hazards/occupancy/critical areas escalate a confirmed incident
 * precautionarily even when current evidence is missing/shrinking: this is
 * camera-wide context, not claimed proximity, physical contact or tracked spread.
 * Result: response_priority and operator_priority (identical string enums:
 * monitor|inspect_urgently|escalate), priority_reasons[], basis[], limitations[],
 * detection_status (unknown if invalid), assessment_quality:invalid|limited|
 * supported (evidence support, NOT accuracy probability), context_status:
 * missing|rejected|reviewed, operator_review_required:true, policy_version,
 * advisory_only:true, severity:unknown, hazard_level:unknown. No numeric risk.
 */
export function assessResponsePriority(value = {}) {
  const input = record(value) ? value : {};
  const status = ['idle', 'watch', 'confirmed'].includes(input.detection_status) ? input.detection_status : 'unknown';
  const validMetadata = status !== 'unknown' && typeof input.camera_id === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(input.camera_id) && finiteRange(input.ts_ms, 8640000000000000) &&
    (input.now_ms === undefined || (Number.isSafeInteger(input.now_ms) && finiteRange(input.now_ms, 8640000000000000))) &&
    (input.evidence_ts_ms === undefined || (Number.isFinite(input.evidence_ts_ms) && input.evidence_ts_ms === input.ts_ms)) &&
    (input.area_reliable === undefined || typeof input.area_reliable === 'boolean') &&
    (input.fire_region_count === undefined || (Number.isSafeInteger(input.fire_region_count) &&
      finiteRange(input.fire_region_count, 64))) &&
    (input.scout_handheld_priority_enabled === undefined || typeof input.scout_handheld_priority_enabled === 'boolean') &&
    (input.scout_handheld_live_test_enabled === undefined || typeof input.scout_handheld_live_test_enabled === 'boolean') &&
    (input.scout_handheld_review_pending === undefined || typeof input.scout_handheld_review_pending === 'boolean') &&
    (input.scout_handheld_scene_qualified === undefined || typeof input.scout_handheld_scene_qualified === 'boolean') &&
    (input.scout_interval_reassessment === undefined || typeof input.scout_interval_reassessment === 'boolean') &&
    typeof input.observation_valid === 'boolean' &&
    typeof input.evidence_current === 'boolean' &&
    ['adequate', 'unknown', 'degraded'].includes(input.visibility_status) &&
    ['growing', 'steady', 'shrinking', 'unknown'].includes(input.visual_activity) &&
    ['low', 'medium'].includes(input.trend_confidence) &&
    Number.isSafeInteger(input.trend_sample_count) && finiteRange(input.trend_sample_count, 10000) &&
    finiteRange(input.trend_duration_s, 3600) && boundedStrings(input.trend_limitations) &&
    ['strong', 'weak', 'not_detected', 'unknown'].includes(input.smoke_evidence) &&
    (input.camera_motion === undefined || input.camera_motion === null || typeof input.camera_motion === 'boolean');
  const policyNowMs = Number.isSafeInteger(input.now_ms) ? input.now_ms : input.ts_ms;
  const context = isReviewedSiteContext(input.site_context, input.camera_id, input.ts_ms, policyNowMs) ? input.site_context : null;
  const sourceContext = isReviewedSourceContext(input.site_context, input.camera_id, input.ts_ms, policyNowMs) ?
    input.site_context : null;
  const handheldContext = isReviewedHandheldUseContext(input.site_context, input.camera_id, input.ts_ms, policyNowMs) ?
    input.site_context : null;
  const sceneZone = sourceContext?.source_zones.find(zone => zone.zone_id === input.scene_source_zone_id) ?? null;
  const sceneAssertions = input.scene_assessment?.assertions;
  const sourceAssertionsMatch = Boolean(sceneZone && Array.isArray(sceneAssertions) && sceneAssertions.length >= 2 &&
    sceneAssertions.every(row => row?.source_id === sceneZone.zone_id && row?.source_type === sceneZone.source_type));
  const sceneGeometryCurrent = Boolean(sourceAssertionsMatch && input.scene_context_revision === sourceContext.context_revision &&
    input.scene_geometry_revision === sourceContext.geometry_revision &&
    input.scene_reference_image_sha256 === sourceContext.reviewed_reference_image_sha256);
  const contextStatus = context ? 'reviewed' : input.site_context == null ? 'missing' : 'rejected';
  const reasons = [];
  const limitations = ['experimental_uncalibrated_response_policy', 'physical_hazard_unassessed',
    'physical_scale_unassessed', 'spatial_spread_unassessed', 'suppression_safety_unassessed',
    'fuel_unassessed', 'crop_scale_unassessed',
    'no_detection_does_not_establish_safety', 'hazard_absence_not_established',
    'site_context_review_recency_unassessed'];
  if (contextStatus !== 'reviewed') limitations.push(`site_context_${contextStatus}`);
  if (contextStatus === 'rejected') reasons.push('invalid_site_context_requires_review');
  const contextEscalation = status === 'confirmed' && context &&
    (context.known_hazards.length > 0 || context.occupied_area || context.critical_zones.length > 0);
  const robustGrowing = validMetadata && status === 'confirmed' && input.observation_valid &&
    input.evidence_current && input.area_reliable === true && input.camera_motion === false &&
    input.visibility_status === 'adequate' && input.visual_activity === 'growing' &&
    input.trend_confidence === 'medium' && input.trend_sample_count >= 3 && input.trend_duration_s >= 2 &&
    input.trend_limitations.every(item => neutralTrendLimitations.has(item));
  const basis = ['temporal_detection_status'];
  if (robustGrowing) {
    reasons.push('robust_growing_visual_activity');
    basis.push('quality_gated_visual_activity');
  } else if (input.visual_activity === 'growing') limitations.push('visual_activity_not_reliably_supported');
  if (contextEscalation) {
    reasons.push('reviewed_site_hazard_requires_escalation');
    basis.push('independently_reviewed_site_context');
    limitations.push('site_context_does_not_establish_physical_contact');
  }
  const containedMonitor = validMetadata && status === 'confirmed' && sourceContext?.expected_flame_use === true &&
    !contextEscalation && !robustGrowing && input.observation_valid && input.evidence_current &&
    input.visibility_status !== 'degraded' && input.camera_motion !== true &&
    input.visual_activity !== 'growing' && input.smoke_evidence === 'not_detected' &&
    sceneGeometryCurrent && input.scene_continuity_qualified === true && input.scene_lease_current === true &&
    sceneAssessmentApplies(input.scene_assessment, {ts_ms: input.ts_ms,
      evidence_current: input.scene_evidence_current, chronological_match: input.scene_chronological_match});
  const handheldLeaseCurrent = input.handheld_feature_enabled === true && handheldContext !== null &&
    typeof input.incident_id === 'string' && typeof input.session_id === 'string' &&
    isHandheldLeaseCurrent(input.handheld_lease, {cameraId:input.camera_id, incidentId:input.incident_id,
      sessionId:input.session_id, sourceTsMs:input.ts_ms, nowMs:policyNowMs});
  const containedHandheldMonitor = validMetadata && status === 'confirmed' && handheldLeaseCurrent &&
    !contextEscalation && !robustGrowing && input.observation_valid && input.evidence_current &&
    input.visibility_status === 'adequate' && input.camera_motion !== true && input.visual_activity !== 'growing' &&
    input.smoke_evidence === 'not_detected';
  const scoutHandheldMonitor = validMetadata && status === 'confirmed' &&
    input.scout_handheld_priority_enabled === true && input.scout_interval_reassessment === true &&
    input.priority_scope === 'observed_interval' && input.scout_handheld_scene_qualified === true &&
    input.scene_assessment?.contract_version === 3 && input.scene_assessment?.category === 'contained_tool_flame' &&
    input.scene_evidence_current === true && input.scene_chronological_match === true && input.fire_region_count === 1 &&
    handheldContext !== null && !contextEscalation && !robustGrowing && input.observation_valid && input.evidence_current &&
    input.visibility_status !== 'degraded' && input.camera_motion !== true && input.visual_activity !== 'growing' &&
    input.smoke_evidence === 'not_detected';
  // Development-only live-camera acceptance path. The caller derives these
  // flags from Worker configuration and reviewed camera policy; clients cannot
  // submit priority inputs. While Scout checks a short frame sequence, hold a
  // single-region, smoke-free test scene at monitor and require operator review.
  const liveHandheldReviewPending = validMetadata && status === 'confirmed' &&
    input.scout_handheld_live_test_enabled === true && input.scout_handheld_review_pending === true &&
    handheldContext !== null && !contextEscalation && !robustGrowing && input.observation_valid &&
    input.evidence_current && input.visibility_status !== 'degraded' && input.camera_motion !== true &&
    input.visual_activity !== 'growing' && input.smoke_evidence === 'not_detected' && input.fire_region_count === 1;
  const scoutHandheldLiveTestMonitor = validMetadata && status === 'confirmed' &&
    input.scout_handheld_live_test_enabled === true && input.scout_handheld_priority_enabled === true &&
    input.scout_handheld_scene_qualified === true &&
    input.scene_assessment?.contract_version === 3 && input.scene_assessment?.category === 'contained_tool_flame' &&
    Array.isArray(input.scene_assessment?.validation_errors) && input.scene_assessment.validation_errors.length === 0 &&
    Array.isArray(input.scene_assessment?.tool_assertions) && input.scene_assessment.tool_assertions.length >= 3 &&
    input.scene_evidence_current === true && input.scene_chronological_match === true &&
    input.fire_region_count === 1 && handheldContext !== null && !contextEscalation && !robustGrowing &&
    input.observation_valid && input.evidence_current && input.visibility_status !== 'degraded' &&
    input.camera_motion !== true && input.visual_activity !== 'growing' && input.smoke_evidence === 'not_detected';
  if (containedMonitor) {
    reasons.push('reviewed_source_geometry_with_supported_local_containment');
    basis.push('unverified_scene_claim_and_reviewed_source_geometry');
    limitations.push('local_containment_does_not_establish_surroundings_safe');
  } else if (status === 'confirmed') {
    if (liveHandheldReviewPending) {
      reasons.push('scout_handheld_live_scene_review_pending');
      basis.push('development_live_test_and_reviewed_camera_policy');
      limitations.push('test_assessment_pending', 'monitor_is_not_clearance_or_hazard_assessment');
    } else if (scoutHandheldLiveTestMonitor) {
      reasons.push('scout_v3_live_handheld_scene_test');
      basis.push('reviewed_camera_policy_current_detector_and_multiframe_scout_scene');
      limitations.push('scout_scene_is_unverified_model_output', 'development_live_test_only',
        'monitor_is_not_clearance_or_hazard_assessment');
    } else if (containedHandheldMonitor) {
      reasons.push('reviewed_handheld_policy_with_current_local_tool_track');
      basis.push('reviewed_camera_policy_and_incident_bound_local_evidence');
      limitations.push('monitor_is_not_clearance_or_hazard_assessment');
    } else if (scoutHandheldMonitor) {
      reasons.push('scout_v3_handheld_scene_with_reviewed_camera_policy');
      basis.push('reviewed_camera_policy_current_detector_and_multiframe_scout_scene');
      limitations.push('scout_scene_is_unverified_model_output', 'post_confirmation_interval_only',
        'monitor_is_not_clearance_or_hazard_assessment');
    } else reasons.push('confirmed_fire_requires_urgent_review');
    if (context?.expected_flame_use === true && !sceneGeometryCurrent) limitations.push('reviewed_source_geometry_or_assertions_missing');
    if (context?.expected_flame_use === true && !input.scene_continuity_qualified) limitations.push('source_continuity_not_qualified');
    if (context?.expected_flame_use === true && !input.scene_lease_current) limitations.push('scene_evidence_lease_unavailable');
  }
  if (status === 'watch') reasons.push('candidate_fire_requires_review');
  if (!validMetadata) reasons.push('invalid_or_missing_input_requires_review');
  if (input.observation_valid !== true) limitations.push('current_observation_unavailable');
  if (input.evidence_current !== true) {
    reasons.push('stale_or_unverified_evidence_requires_review');
    limitations.push('evidence_freshness_unverified');
  }
  if (input.visibility_status !== 'adequate' && !containedMonitor) {
    reasons.push('visibility_uncertain_requires_review');
    limitations.push('visibility_not_adequate');
  }
  if (['strong', 'weak', 'unknown'].includes(input.smoke_evidence)) {
    reasons.push('smoke_present_or_unassessed_requires_review');
  }
  if (input.visual_activity === 'shrinking') limitations.push('shrinking_does_not_establish_safety');
  const monitor = validMetadata && input.observation_valid && input.evidence_current &&
    status === 'idle' && contextStatus !== 'rejected' && input.visual_activity === 'unknown' &&
    input.area_reliable !== true && input.visibility_status === 'adequate' && input.smoke_evidence === 'not_detected';
  const priority = contextEscalation || robustGrowing ? 'escalate' :
    monitor || containedMonitor || containedHandheldMonitor || scoutHandheldMonitor ||
      liveHandheldReviewPending || scoutHandheldLiveTestMonitor ? 'monitor' : 'inspect_urgently';
  return {
    response_priority: priority,
    operator_priority: priority,
    context_status: contextStatus,
    detection_status: status,
    priority_reasons: reasons.length ? reasons : [monitor ? 'no_current_positive_evidence' : 'observation_requires_review'],
    basis,
    assessment_quality: !validMetadata || contextStatus === 'rejected' ? 'invalid' : robustGrowing ? 'supported' : 'limited',
    limitations,
    operator_review_required: true,
    policy_version: OPERATIONAL_RESPONSE_POLICY_VERSION,
    severity: 'unknown', hazard_level: 'unknown', advisory_only: true,
  };
}

// Compatibility name only: there is one operational policy, not two engines.
export const evaluateResponsePriority = assessResponsePriority;

export function fireConfirmed(e) {
  const sev = evaluateSeverity(e);
  const priority = evaluateResponsePriority({ ...e, detection_status: 'confirmed', scout_interval_reassessment: false });
  const { site_context, now_ms, handheld_feature_enabled, handheld_lease, session_id,
    scout_handheld_priority_enabled, scout_handheld_scene_qualified, scout_handheld_live_test_enabled,
    scout_handheld_review_pending, scout_interval_reassessment,
    fire_region_count, ...publicFields } = e;
  return { ...publicFields, type: "fire_confirmed", severity: sev.level, hazard_level: sev.level,
    severity_details: sev, advisory_only: true, ...priority };
}

export function fireUpdate(e) {
  const sev = evaluateSeverity(e);
  const priority = evaluateResponsePriority({ ...e, detection_status: 'confirmed', scout_interval_reassessment: false });
  const { site_context, now_ms, handheld_feature_enabled, handheld_lease, session_id,
    scout_handheld_priority_enabled, scout_handheld_scene_qualified, scout_handheld_live_test_enabled,
    scout_handheld_review_pending, scout_interval_reassessment,
    fire_region_count, ...publicFields } = e;
  return { ...publicFields, type: "fire_update", severity: sev.level, hazard_level: sev.level,
    severity_details: sev, advisory_only: true, ...priority };
}

export function fireCleared(e) {
  return { type: "fire_cleared", ...e };
}
