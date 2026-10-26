import { validateInferenceMetadata } from './inference-runtime.js';
import { INVESTIGATION_ENUMS, INVESTIGATION_OBSERVATION_KINDS, normalizeInvestigation, DEFAULT_ADVICE, validateSceneAssessment, unknownSceneAssessment } from './investigation.js';

// Portable metadata only. Never persist images or arbitrary configuration.
const MAX_JSON_BYTES = 65536;
const PRIORITIES = ['monitor', 'inspect_urgently', 'escalate'];
const fail = label => { throw new TypeError(`${label}: invalid or unbounded metadata`); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const member = (value, allowed, label) => { if (!allowed.includes(value)) fail(label); };
function keys(value, allowed, label) {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(label);
}
function text(value, max, label) {
  if (typeof value !== 'string' || value.length > max * 2 || Array.from(value).length > max) fail(label);
}
function id(value, max, label, colon = true) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max ||
    !(colon ? /^[A-Za-z0-9_-][A-Za-z0-9._:-]*$/ : /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/).test(value)) fail(label);
}
function timestamp(value, label = 'timestamp') {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 8640000000000000) fail(label);
}
function identity(cameraId, incidentId, ts) {
  id(cameraId, 128, 'camera_id', false);
  if (!/^[A-Za-z0-9_-]+$/.test(cameraId)) fail('camera_id');
  id(incidentId, 256, 'incident_id'); timestamp(ts);
}
function list(value, max, label, check) {
  if (!Array.isArray(value) || value.length > max) fail(label);
  for (const item of value) check(item);
}
const strings = (value, max, label) => list(value, max, label, item => text(item, 300, label));
const refs = (value, label) => list(value, 8, label, item => id(item, 80, label));

// Avoid silent JSON coercion and user-defined accessors/toJSON. Bounded before
// serialization: 4096 nodes, depth 8, 32 items/array, 48 keys/object.
function jsonCopy(value) {
  let nodes = 0;
  const active = new Set();
  function visit(item, depth) {
    if (++nodes > 4096 || depth > 8) fail('JSON bounds');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') { if (!Number.isFinite(item)) fail('JSON number'); return item; }
    if (typeof item === 'string') { text(item, 1200, 'JSON string'); return item; }
    if (!Array.isArray(item) && !plain(item)) fail('JSON object');
    if (active.has(item) || Reflect.ownKeys(item).some(key => typeof key === 'symbol')) fail('JSON cycle/keys');
    active.add(item);
    let result;
    if (Array.isArray(item)) {
      if (item.length > 32 || Object.keys(item).length !== item.length ||
        Object.keys(item).some((key, index) => key !== String(index))) fail('JSON array');
      result = [];
      for (let index = 0; index < item.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('JSON accessor');
        result.push(visit(descriptor.value, depth + 1));
      }
    } else {
      if (Object.keys(item).length > 48) fail('JSON fields');
      result = {};
      for (const key of Object.getOwnPropertyNames(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') ||
          ['__proto__', 'prototype', 'constructor', 'toJSON'].includes(key)) fail('JSON field');
        result[key] = visit(descriptor.value, depth + 1);
      }
    }
    active.delete(item);
    return result;
  }
  return visit(value, 0);
}
function encode(value) {
  const result = JSON.stringify(value);
  if (new TextEncoder().encode(result).byteLength > MAX_JSON_BYTES) fail('JSON byte bounds');
  return result;
}
function hypothesis(value, label) {
  keys(value, ['ignition_source', 'ignition_tool', 'fuel_type', 'fire_class', 'confidence', 'confidence_calibrated',
    'grounding_status', 'evidence_refs', 'action_frame_ids', 'ignition_frame_id', 'status', 'limitations'], label);
  for (const key of ['ignition_source', 'ignition_tool', 'fuel_type', 'fire_class', 'confidence']) {
    if (Object.hasOwn(value, key)) member(value[key], INVESTIGATION_ENUMS[key], `${label}.${key}`);
  }
  for (const [key, allowed] of Object.entries({ confidence_calibrated: [false],
    grounding_status: ['frame_referenced', 'unsupported'], status: ['insufficient_evidence', 'frame_linked_unverified'] })) {
    if (Object.hasOwn(value, key)) member(value[key], allowed, `${label}.${key}`);
  }
  for (const key of ['evidence_refs', 'action_frame_ids']) if (Object.hasOwn(value, key)) refs(value[key], label);
  if (Object.hasOwn(value, 'ignition_frame_id') && value.ignition_frame_id !== null) id(value.ignition_frame_id, 80, label);
  if (Object.hasOwn(value, 'limitations')) strings(value.limitations, 16, label);
}
function observations(value, legacy = false) {
  list(value, 16, 'cause.observations', item => {
    keys(item, legacy ? ['kind', 'frame_id', 'description'] : ['kind', 'frame_ids', 'description'], 'cause.observation');
    member(item.kind, legacy ? ['person_present', 'hand_fuel_contact', 'ignition_action', 'flame_visible',
      'smoke_visible', 'tool_visible', 'fuel_visible', 'unknown'] : INVESTIGATION_OBSERVATION_KINDS, 'cause.observation.kind');
    text(item.description, 300, 'cause.observation.description');
    if (legacy) id(item.frame_id, 80, 'cause.observation.frame_id');
    else { refs(item.frame_ids, 'cause.observation.frame_ids'); if (!item.frame_ids.length) fail('cause.observation.frame_ids'); }
  });
}
function toolAssertions(value, label = 'cause.model_claims.tool_assertions') {
  list(value, 16, label, item => {
    keys(item, ['frame_id', 'candidate_id', 'tool_type', 'flame_relation',
      'secondary_burning', 'smoke', 'occlusion'], label);
    id(item.frame_id, 80, label);
    if (item.candidate_id !== null) id(item.candidate_id, 80, label);
    member(item.tool_type, ['lighter', 'other', 'uncertain'], `${label}.tool_type`);
    member(item.flame_relation, ['at_tool_tip', 'separate', 'uncertain'], `${label}.flame_relation`);
    for (const key of ['secondary_burning', 'smoke', 'occlusion'])
      member(item[key], ['present', 'not_observed', 'uncertain'], `${label}.${key}`);
  });
}
function manifest(value) {
  const result = jsonCopy(value);
  let previous = -1;
  list(result, 32, 'evidence_manifest', frame => {
    keys(frame, ['frame_id', 'ts_ms', 'roles', 'pre_ignition_verified', 'peak_scope', 'frame_wh',
      'fire_evidence', 'smoke_evidence', 'confidence', 'area_px', 'area_fraction', 'area_reliable', 'visibility',
      'local_ref'], 'evidence_manifest');
    id(frame.frame_id, 80, 'evidence_manifest.frame_id'); timestamp(frame.ts_ms, 'evidence_manifest.ts_ms');
    if (frame.ts_ms <= previous) fail('evidence_manifest chronology');
    previous = frame.ts_ms;
    list(frame.roles, 8, 'evidence_manifest.roles', role => member(role,
      ['early', 'context_before_onset', 'onset', 'context_after_onset', 'peak', 'recent', 'handheld_context', 'followup_context'], 'evidence_manifest.roles'));
    if (new Set(frame.roles).size !== frame.roles.length) fail('evidence_manifest.roles');
    if (Object.hasOwn(frame, 'pre_ignition_verified')) member(frame.pre_ignition_verified, [false], 'evidence_manifest.pre_ignition_verified');
    if (Object.hasOwn(frame, 'peak_scope')) member(frame.peak_scope, [null, 'observed_so_far'], 'evidence_manifest.peak_scope');
    if (Object.hasOwn(frame, 'frame_wh')) {
      list(frame.frame_wh, 2, 'evidence_manifest.frame_wh', n => { if (!Number.isInteger(n) || n < 1 || n > 65535) fail('evidence_manifest.frame_wh'); });
      if (frame.frame_wh.length !== 2) fail('evidence_manifest.frame_wh');
    }
    for (const key of ['fire_evidence', 'smoke_evidence']) if (Object.hasOwn(frame, key)) member(frame[key], ['strong', 'weak', 'not_detected', 'unknown'], `evidence_manifest.${key}`);
    if (Object.hasOwn(frame, 'visibility')) member(frame.visibility, ['adequate', 'degraded', 'unknown'], 'evidence_manifest.visibility');
    if (Object.hasOwn(frame, 'area_reliable')) member(frame.area_reliable, [false, true], 'evidence_manifest.area_reliable');
    if (Object.hasOwn(frame, 'local_ref')) {
      keys(frame.local_ref, ['session_id', 'generation', 'attempt_sequence', 'jpeg_sha256'], 'evidence_manifest.local_ref');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(frame.local_ref.session_id)) fail('evidence_manifest.local_ref.session_id');
      if (!Number.isSafeInteger(frame.local_ref.generation) || frame.local_ref.generation < 1) fail('evidence_manifest.local_ref.generation');
      if (!Number.isSafeInteger(frame.local_ref.attempt_sequence) || frame.local_ref.attempt_sequence < 1) fail('evidence_manifest.local_ref.attempt_sequence');
      if (typeof frame.local_ref.jpeg_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(frame.local_ref.jpeg_sha256)) fail('evidence_manifest.local_ref.jpeg_sha256');
    }
    for (const [key, max] of [['confidence', 1], ['area_fraction', 1], ['area_px', 65535 ** 2]]) {
      if (Object.hasOwn(frame, key) && frame[key] !== null &&
        (typeof frame[key] !== 'number' || !Number.isFinite(frame[key]) || frame[key] < 0 || frame[key] > max)) fail(`evidence_manifest.${key}`);
    }
  });
  if (new Set(result.map(frame => frame.frame_id)).size !== result.length) fail('evidence_manifest duplicate ID');
  return result;
}

const FIELDS = ['camera_id', 'ts_ms', 'incident_id', 'event_key', 'event_kind', 'cause',
  'confidence', 'snapshot_key', 'analysis_json', 'operator_priority'];

// Revalidate durable/outbox records at the write boundary too; persistence is
// not an alternate authorization path for hand-built or restored JSON.
export function validateIncidentRecord(record) {
  keys(record, FIELDS, 'record');
  if (Reflect.ownKeys(record).length !== FIELDS.length) fail('record fields');
  for (const key of FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('record descriptor');
  }
  if (typeof record.analysis_json !== 'string' || record.analysis_json.length > MAX_JSON_BYTES ||
    new TextEncoder().encode(record.analysis_json).byteLength > MAX_JSON_BYTES) fail('record JSON bounds');
  let parsed;
  try { parsed = JSON.parse(record.analysis_json); } catch { fail('record JSON'); }
  const body = jsonCopy(parsed);
  if (!plain(body)) fail('record analysis body');
  const args = { cameraId: record.camera_id, incidentId: record.incident_id, ts: record.ts_ms,
    priority: body.priority_assessment === null ? body.response_priority : body.priority_assessment,
    priority_scope: body.priority_scope };
  member(record.event_kind, ['confirmation', 'analysis'], 'record.event_kind');
  const expected = record.event_kind === 'confirmation' ? createConfirmationRecord(args) :
    createAnalysisRecord({ ...args, cause: body.cause, evidence_manifest: body.evidence_manifest,
      jobId: body.analysis_job_id, reason: body.analysis_reason, incident_closed: body.incident_closed });
  for (const key of FIELDS) if (key !== 'analysis_json' && record[key] !== expected[key]) fail(`record.${key}`);
  if (record.event_kind === 'analysis' && !Object.hasOwn(body.cause, 'scene_assessment')) body.cause.scene_assessment = unknownSceneAssessment();
  const ordered = value => Array.isArray(value) ? value.map(ordered) : plain(value) ?
    Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
  if (JSON.stringify(ordered(body)) !== JSON.stringify(ordered(JSON.parse(expected.analysis_json)))) fail('record.analysis_json');
}

export async function writeIncidentRecord(DB, record) {
  validateIncidentRecord(record);
  const result = await DB.prepare(`INSERT INTO events (${FIELDS.join(', ')}) VALUES (${FIELDS.map(() => '?').join(', ')}) ON CONFLICT(event_key) DO NOTHING`)
    .bind(...FIELDS.map(key => record[key])).run();
  if (result?.success === false) throw new Error('incident record write failed');
  return result;
}

function priorityMetadata(value) {
  const priority = jsonCopy(value);
  if (typeof priority === 'string') {
    member(priority, PRIORITIES, 'priority');
    return { response_priority: priority, priority_assessment: null };
  }
  keys(priority, ['response_priority', 'operator_priority', 'context_status', 'detection_status',
    'priority_reasons', 'basis', 'assessment_quality', 'limitations', 'operator_review_required',
    'policy_version', 'severity', 'hazard_level', 'advisory_only'], 'priority');
  member(priority.response_priority, PRIORITIES, 'priority');
  for (const [key, allowed] of Object.entries({ operator_priority: [priority.response_priority],
    context_status: ['missing', 'rejected', 'reviewed'], detection_status: ['idle', 'watch', 'confirmed', 'unknown'],
    assessment_quality: ['invalid', 'limited', 'supported'], operator_review_required: [true],
    severity: ['unknown'], hazard_level: ['unknown'], advisory_only: [true] })) {
    if (Object.hasOwn(priority, key)) member(priority[key], allowed, `priority.${key}`);
  }
  for (const key of ['priority_reasons', 'basis', 'limitations']) if (Object.hasOwn(priority, key)) strings(priority[key], 32, `priority.${key}`);
  if (Object.hasOwn(priority, 'policy_version')) id(priority.policy_version, 80, 'priority.policy_version');
  return { response_priority: priority.response_priority, priority_assessment: priority };
}

function unreviewedCause(value) {
  const input = jsonCopy(value);
  keys(input, [...Object.keys(INVESTIGATION_ENUMS), 'reasons', 'evidence', 'validation_errors', 'aftercare', 'advisory_only',
    'accepted_cause', 'cause_status', 'evidence_refs', 'require_human_review', 'requires_human_review', 'hazard_absence_verified',
    'hypothesis', 'model_hypothesis', 'model_claims', 'cause_limitations', 'observations', 'visual_observations', 'source', 'model', 'vlm_error', 'scene_assessment', 'inference_metadata'], 'cause');
  for (const key of ['ignition_source', 'probable_cause', 'accepted_cause', 'ignition_tool', 'fuel_type', 'fire_class']) {
    if (Object.hasOwn(input, key) && input[key] !== 'unknown') fail(`cause.${key}: accepted promotion forbidden`);
  }
  for (const [key, allowed] of Object.entries({ confidence: ['low'], recommended_agent: ['undetermined'],
    electrical_hazard: ['unknown', 'present'], incompatible_fuel_hazard: ['unknown', 'present'],
    requires_human_review: [true], require_human_review: [true], hazard_absence_verified: [false],
    evidence_status: ['unknown', 'inferred'], cause_status: ['unknown', 'unverified'], advisory_only: [true], aftercare: [DEFAULT_ADVICE] })) {
    if (Object.hasOwn(input, key)) member(input[key], allowed, `cause.${key}`);
  }
  for (const key of ['reasons', 'evidence', 'validation_errors']) if (Object.hasOwn(input, key)) strings(input[key], 8, `cause.${key}`);
  if (Object.hasOwn(input, 'cause_limitations')) strings(input.cause_limitations, 16, 'cause.cause_limitations');
  if (Object.hasOwn(input, 'evidence_refs')) refs(input.evidence_refs, 'cause.evidence_refs');
  for (const key of ['hypothesis', 'model_hypothesis']) if (Object.hasOwn(input, key)) hypothesis(input[key], `cause.${key}`);
  if (Object.hasOwn(input, 'observations')) observations(input.observations);
  if (Object.hasOwn(input, 'visual_observations')) observations(input.visual_observations, true);
  if (Object.hasOwn(input, 'model_claims')) {
    const claims = input.model_claims;
    keys(claims, ['provenance', 'observations', 'hypothesis', 'tool_assertions', ...Object.keys(INVESTIGATION_ENUMS).filter(key => key !== 'recommended_agent'), 'reasons', 'evidence'], 'cause.model_claims');
    member(claims.provenance, ['untrusted_model_output'], 'cause.model_claims.provenance');
    if (Object.hasOwn(claims, 'observations')) observations(claims.observations);
    if (Object.hasOwn(claims, 'hypothesis')) hypothesis(claims.hypothesis, 'cause.model_claims.hypothesis');
    if (Object.hasOwn(claims, 'tool_assertions')) toolAssertions(claims.tool_assertions);
    for (const key of Object.keys(INVESTIGATION_ENUMS)) if (Object.hasOwn(claims, key)) member(claims[key], INVESTIGATION_ENUMS[key], `cause.model_claims.${key}`);
    for (const key of ['reasons', 'evidence']) if (Object.hasOwn(claims, key)) strings(claims[key], 8, `cause.model_claims.${key}`);
  }
  if (Object.hasOwn(input, 'source') && (typeof input.source !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(input.source))) fail('cause.source');
  if (Object.hasOwn(input, 'model')) {
    text(input.model, 160, 'cause.model');
    if (!input.model.length || /[\u0000-\u001f\u007f]/.test(input.model)) fail('cause.model');
  }
  if (Object.hasOwn(input, 'inference_metadata')) input.inference_metadata = validateInferenceMetadata(input.inference_metadata);
  if (Object.hasOwn(input, 'vlm_error')) id(input.vlm_error, 80, 'cause.vlm_error');
  return { ...normalizeInvestigation({}), ...input, accepted_cause: 'unknown', require_human_review: true,
    requires_human_review: true, hazard_absence_verified: false };
}

export function createAnalysisRecord({ cameraId, incidentId, ts, jobId, cause, evidence_manifest,
  priority, reason, incident_closed, priority_scope }) {
  identity(cameraId, incidentId, ts);
  if (typeof jobId === 'number') { if (!Number.isSafeInteger(jobId) || jobId < 1) fail('analysis job'); }
  else id(jobId, 80, 'analysis job', false);
  id(reason, 80, 'analysis reason'); member(incident_closed, [false, true], 'incident_closed');
  if (priority_scope !== undefined) member(priority_scope, ['observed_interval'], 'priority_scope');
  cause = unreviewedCause(cause);
  evidence_manifest = manifest(evidence_manifest);
  cause.scene_assessment = Object.hasOwn(cause, 'scene_assessment') ?
    validateSceneAssessment(cause.scene_assessment, evidence_manifest, cause.observations ?? [], cause.validation_errors ?? []) : unknownSceneAssessment();
  const metadata = priorityMetadata(priority);
  return { camera_id: cameraId, ts_ms: ts, incident_id: incidentId,
    event_key: `${incidentId}:analysis:${jobId}`, event_kind: 'analysis',
    cause: 'unknown', confidence: 'low', snapshot_key: null,
    analysis_json: encode({ cause, evidence_manifest, ...metadata,
      ...(priority_scope === undefined ? {} : {priority_scope}),
      event_kind: 'analysis', analysis_status: 'complete', analysis_job_id: jobId,
      analysis_reason: reason, incident_closed }), operator_priority: metadata.response_priority };
}

export function createConfirmationRecord({ cameraId, incidentId, ts, priority, priority_scope }) {
  identity(cameraId, incidentId, ts);
  if (priority_scope !== undefined) member(priority_scope, ['live'], 'priority_scope');
  const metadata = priorityMetadata(priority);
  const cause = { ...normalizeInvestigation({}), accepted_cause: 'unknown',
    requires_human_review: true, require_human_review: true, hazard_absence_verified: false };
  return { camera_id: cameraId, ts_ms: ts, incident_id: incidentId,
    event_key: `${incidentId}:confirmation`, event_kind: 'confirmation',
    cause: 'unknown', confidence: 'low', snapshot_key: null,
    analysis_json: encode({ cause, evidence_manifest: [], ...metadata,
      ...(priority_scope === undefined ? {} : {priority_scope}),
      event_kind: 'confirmation', analysis_status: 'pending' }),
    operator_priority: metadata.response_priority };
}
