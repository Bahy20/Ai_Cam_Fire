import { validateInferenceMetadata } from './inference-runtime.js';
import { validateSceneAssessment, unknownSceneAssessment } from './investigation.js';
/**
 * Bounded metadata-only CameraDO checkpoint codec (no I/O, clocks or scheduling).
 *
 * encodeCoordinatorState(camera) -> plain JSON-compatible {version: 7, ...}.
 * Checkpoint fields (all required):
 *   cameraId: string|null; lastObservationTs/lastReceiptAtMs: number|null;
 *   window: <=24 {ts, area:number|null, strong:boolean, any:boolean, detected:boolean};
 *   trendWindow: <=24 {ts, area_ratio:number|null, reliable, camera_motion:boolean|null,
 *     visibility, frame_wh:[w,h], reset:null|string}; undefined initial reset becomes null.
 *   evidenceState: evidence.js v1 metadata (history<=120, snapshots<=24,
 *     pre_onset<=2, protected_selection<=6|null, onset/peak/latest/onset_successor);
 *   measurement: {area_px, area_fraction, area_reliable, frame_wh, visibility_status};
 *   currentObservation: full canonical normalizeObservation() result|null;
 *   alert:'idle'|'watch'|'confirmed'; fire:{peakArea,startedAt}|null;
 *   incidentId/closedIncidentId:string|null; incidentSequence/analysisJob: counters;
 *   cause: qualified investigation.js output|null; evidenceManifest: <=6 actual-image frames;
 *   followupUsed:boolean; followupRequested/initialPeakTs:number|null; persistCount:0..24;
 *   eventSequence: monotonically increasing camera-event watermark;
 *   sceneLease/generation/hazardLatch: v1 bounded source-evidence lease metadata;
 *   handheldQualificationRequiredAfterTs: latest source time before which a
 *     local track cannot requalify after uncertain assessment or restart.
 *   edgeGeneration/session/attempt/batch watermarks and a bounded batch ACK ledger.
 *   analysisActive/pendingAnalysis/nativeInference: BOOLEAN presence flags, never work contents;
 *   analysisInterrupted/nativeInferenceInterrupted: persistent boolean recovery warnings.
 *
 * decodeCoordinatorState(undefined) -> null ONLY for genuinely fresh storage.
 * Every other value must validate atomically or throws (including unknown versions).
 * Returns the camelCase fields above, WITHOUT version, with analysisActive:false,
 * pendingAnalysis:null, nativeInference:null and explicit interruption warnings.
 * Any interrupted work clears protected_selection and followupRequested; otherwise
 * protected_selection and its frame/role/dimension metadata are deeply frozen.
 * Recovery warnings survive subsequent encodes until explicitly resolved by owner.
 * No detection boxes are invented for compact historical confirmation entries.
 *
 * Encoder whitelists fields; decoder rejects extras at every persisted boundary.
 * Both enforce a <=256 KiB serialized UTF-8 JSON budget; failure is explicit.
 * No JPEG bytes, Map/Promise contents, auth, env or identity-branded site context
 * are serialized/restored. Owner MUST reload site context from reviewed env.
 * Lifecycle event transactions, generation fencing, outbox and recovery policy
 * remain with the caller; the lease fields here only persist the finite proof.
 */
import { normalizeObservation } from './observations.js';
import { DEFAULT_ADVICE, INVESTIGATION_ENUMS, INVESTIGATION_OBSERVATION_KINDS, VLM_ERROR_CODES } from './investigation.js';
import { validateStoredSceneLease } from './scene-lease.js';

const FIELDS = ['cameraId', 'lastObservationTs', 'lastReceiptAtMs', 'window', 'trendWindow',
  'evidenceState', 'measurement', 'currentObservation', 'alert', 'fire', 'cause',
  'evidenceManifest', 'incidentId', 'closedIncidentId', 'incidentSequence', 'analysisJob',
  'followupUsed', 'followupRequested', 'initialPeakTs', 'persistCount', 'eventSequence',
  'sceneLease', 'sceneLeaseGeneration', 'sceneHazardLatchIncidentId', 'edgeSessionId',
  'edgeGeneration', 'edgeAttemptSequence', 'edgeAttemptTs', 'edgeBatchSequence', 'observationBatchLedger',
  'pendingEvidenceRequest','completedEvidenceRequests','handheldHazardLatchIncidentId',
  'handheldQualificationRequiredAfterTs'];
const V3_FIELDS = ['sceneLease', 'sceneLeaseGeneration', 'sceneHazardLatchIncidentId'];
const V4_FIELDS = ['edgeSessionId', 'edgeGeneration', 'edgeAttemptSequence', 'edgeAttemptTs', 'edgeBatchSequence', 'observationBatchLedger'];
const V5_FIELDS = ['pendingEvidenceRequest','completedEvidenceRequests'];
const V6_FIELDS = ['handheldHazardLatchIncidentId'];
const V7_FIELDS = ['handheldQualificationRequiredAfterTs'];
const WORK_FLAGS = ['analysisActive', 'pendingAnalysis', 'nativeInference', 'analysisInterrupted', 'nativeInferenceInterrupted'];
const VISIBILITY = ['adequate', 'unknown', 'degraded'];
const MEASUREMENT = ['area_px', 'area_fraction', 'area_reliable', 'frame_wh', 'visibility_status'];
function fail(message) { throw new Error(`invalid_coordinator_state: ${message}`); }
function requireThat(condition, message) { if (!condition) fail(message); }
function object(value, fields, strict = true, optional = []) {
  requireThat(value !== null && typeof value === 'object' &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'expected plain object');
  requireThat(fields.every(key => Object.hasOwn(value, key) || optional.includes(key)), 'missing fields');
  if (strict) requireThat(Reflect.ownKeys(value).every(key => fields.includes(key)), 'unexpected fields');
  const result = {};
  for (const key of fields) if (Object.hasOwn(value, key)) {
    requireThat('value' in Object.getOwnPropertyDescriptor(value, key), 'accessor field');
    result[key] = value[key];
  }
  return result;
}
function array(value, max, map = item => item) {
  requireThat(Array.isArray(value) && value.length <= max &&
    Object.keys(value).length === value.length, 'expected bounded dense array');
  for (let i = 0; i < value.length; i++) requireThat(Object.hasOwn(value, i), 'sparse array');
  return value.map(map);
}
function number(value, max = Infinity) { requireThat(Number.isFinite(value) && value >= 0 && value <= max, 'invalid nonnegative finite number'); return value; }
function nullable(value, parse) { return value === null ? null : parse(value); }
function boolean(value) { requireThat(typeof value === 'boolean', 'expected boolean'); return value; }
function enumeration(value, values) { requireThat(values.includes(value), 'invalid enum'); return value; }
function counter(value, max = Number.MAX_SAFE_INTEGER) { number(value, max); requireThat(Number.isSafeInteger(value), 'invalid counter'); return value; }
function dimensions(value) {
  const result = array(value, 2, v => { counter(v, 8192); requireThat(v > 0, 'invalid dimension'); return v; });
  requireThat(result.length === 2 && result[0] * result[1] <= 16 * 1024 * 1024, 'invalid dimensions');
  return result;
}
function same(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && same(a[key], b[key]));
}
function ordered(items, field, watermark) {
  for (let i = 0; i < items.length; i++) {
    number(items[i][field]);
    requireThat(watermark !== null && items[i][field] <= watermark &&
      (i === 0 || items[i - 1][field] < items[i][field]), 'future or unordered timestamp');
  }
  return items;
}
function parseWindow(value, strict) {
  return array(value, 24, frame => {
    const result = object(frame, ['ts', 'area', 'strong', 'any', 'detected'], strict);
    number(result.ts); nullable(result.area, number);
    for (const key of ['strong', 'any', 'detected']) boolean(result[key]);
    requireThat((!result.strong || result.any) && (!result.any || result.detected), 'contradictory confirmation flags');
    return result;
  });
}
function parseTrend(value, strict) {
  return array(value, 24, sample => {
    const s = object(sample, ['ts', 'area_ratio', 'reliable', 'camera_motion', 'visibility', 'frame_wh', 'reset'], strict);
    number(s.ts); nullable(s.area_ratio, v => number(v, 1)); boolean(s.reliable);
    nullable(s.camera_motion, boolean); enumeration(s.visibility, VISIBILITY); s.frame_wh = dimensions(s.frame_wh);
    enumeration(s.reset, [null, 'frame_dimensions_changed', 'observation_gap_reset', 'reliable_observation_gap_reset']);
    requireThat(!s.reliable || (s.area_ratio !== null && s.area_ratio > 0 && s.visibility !== 'degraded'), 'unreliable trend geometry');
    return s;
  });
}
function parseObservation(value, strict) {
  if (value === null) return null;
  const s = object(value, ['observation_valid', 'http_status', 'validation_errors', 'ts_ms', 'frame_wh',
    'detections', 'visibility', 'camera_motion', 'fire', 'smoke'], strict);
  dimensions(s.frame_wh);
  s.validation_errors = array(s.validation_errors, 0);
  s.detections = array(s.detections, 256, raw => {
    const d = object(raw, ['cls', 'conf', 'bbox_xyxy', 'area_px', 'centroid_xy'], strict);
    d.bbox_xyxy = array(d.bbox_xyxy, 4, v => { requireThat(Number.isFinite(v), 'invalid box'); return v; });
    requireThat(d.bbox_xyxy.length === 4, 'invalid box');
    d.centroid_xy = array(d.centroid_xy, 2, v => number(v));
    return d;
  });
  for (const key of ['fire', 'smoke']) s[key] = object(s[key],
    ['evidence_level', 'confidence', 'detection_count', 'area_px', 'area_fraction', 'area_reliable'], strict);
  const normalized = normalizeObservation(s);
  requireThat(normalized.observation_valid && same(normalized, s), 'invalid or contradictory normalized observation');
  return normalized;
}
function parseMeasurement(value, strict) {
  const s = object(value, MEASUREMENT, strict);
  nullable(s.area_px, number); nullable(s.area_fraction, v => number(v, 1)); boolean(s.area_reliable);
  s.frame_wh = nullable(s.frame_wh, dimensions); enumeration(s.visibility_status, VISIBILITY);
  return s;
}
function incident(value, cameraId, sequence, watermark) {
  if (value === null) return null;
  requireThat(typeof value === 'string' && value.length <= 256, 'invalid incident identity');
  const parts = value.split(':');
  requireThat(parts.length === 3 && parts[0] === cameraId && parts[1] !== '' && parts[2] !== '', 'cross-camera incident');
  const ts = Number(parts[1]), seq = Number(parts[2]);
  number(ts); counter(seq);
  requireThat(String(ts) === parts[1] && String(seq) === parts[2] && seq > 0 && seq <= sequence &&
    watermark !== null && ts <= watermark, 'invalid incident timestamp or sequence');
  return {id: value, ts, seq};
}
const SAMPLE = ['ts_ms', 'fire_evidence', 'smoke_evidence', 'confidence', 'area_px',
  'area_fraction', 'area_reliable', 'visibility', 'frame_wh'];
const ROLES = ['early', 'context_before_onset', 'onset', 'context_after_onset', 'peak', 'recent', 'handheld_context', 'followup_context'];
function parseFrame(value, strict, kind = 'sample') {
  const selected = kind === 'selection' || kind === 'manifest';
  const references = kind === 'snapshot' || kind === 'selection' || kind === 'manifest';
  const requiresReference = kind === 'snapshot' || kind === 'selection';
  const s = object(value, [...SAMPLE, ...(references ? ['snapshot_key','local_ref'] : []),
    ...(selected ? ['frame_id', 'roles', 'pre_ignition_verified', 'peak_scope'] : [])], strict,
    references ? ['snapshot_key','local_ref'] : []);
  number(s.ts_ms); s.frame_wh = dimensions(s.frame_wh);
  for (const key of ['fire_evidence', 'smoke_evidence']) enumeration(s[key], ['strong', 'weak', 'not_detected']);
  nullable(s.confidence, v => number(v, 1)); nullable(s.area_px, v => number(v, s.frame_wh[0] * s.frame_wh[1]));
  nullable(s.area_fraction, v => number(v, 1)); boolean(s.area_reliable); enumeration(s.visibility, VISIBILITY);
  if (s.fire_evidence === 'not_detected') requireThat(s.confidence === null && s.area_px === null &&
    s.area_fraction === null && !s.area_reliable, 'contradictory absent fire measurement');
  else {
    requireThat(s.confidence !== null && s.area_px > 0 && s.area_fraction > 0 &&
      Math.abs(s.area_fraction - s.area_px / (s.frame_wh[0] * s.frame_wh[1])) <= Number.EPSILON &&
      (s.fire_evidence === 'strong') === (s.confidence >= 0.25), 'contradictory evidence geometry');
    requireThat(!s.area_reliable || (s.fire_evidence === 'strong' && s.visibility !== 'degraded'), 'invalid evidence reliability');
  }
  if (Object.hasOwn(s, 'snapshot_key')) requireThat(s.snapshot_key === `snap:${s.ts_ms}`, 'invalid snapshot identity');
  if (Object.hasOwn(s, 'local_ref')) {
    const ref=object(s.local_ref,['session_id','generation','attempt_sequence','jpeg_sha256'],strict);
    requireThat(typeof ref.session_id==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ref.session_id), 'invalid local image session');
    counter(ref.generation); requireThat(ref.generation>0,'invalid local image generation');
    counter(ref.attempt_sequence); requireThat(ref.attempt_sequence>0,'invalid local image attempt');
    requireThat(typeof ref.jpeg_sha256==='string' && /^[0-9a-f]{64}$/.test(ref.jpeg_sha256),'invalid local image hash');
    s.local_ref=ref;
  }
  if (requiresReference) requireThat(Object.hasOwn(s,'snapshot_key') || Object.hasOwn(s,'local_ref'),'missing image reference');
  if (selected) {
    requireThat(s.frame_id === `frame-${s.ts_ms}` && s.pre_ignition_verified === false, 'invalid selected frame identity or authority');
    s.roles = array(s.roles, 8, role => enumeration(role, ROLES));
    requireThat(s.roles.length > 0 && new Set(s.roles).size === s.roles.length &&
      s.peak_scope === (s.roles.includes('peak') ? 'observed_so_far' : null), 'invalid selection roles/scope');
  }
  return s;
}
function baseFrame(frame) { return Object.fromEntries(SAMPLE.map(key => [key, frame[key]])); }
function parseEvidence(value, strict, watermark, observation) {
  const s = object(value, ['version', 'history', 'snapshots', 'onset', 'peak', 'latest',
    'pre_onset', 'onset_successor', 'protected_selection'], strict);
  requireThat(s.version === 1, 'unsupported evidence version');
  s.history = ordered(array(s.history, 120, v => parseFrame(v, strict)), 'ts_ms', watermark);
  s.snapshots = ordered(array(s.snapshots, 24, v => parseFrame(v, strict, 'snapshot')), 'ts_ms', watermark);
  s.pre_onset = ordered(array(s.pre_onset, 2, v => parseFrame(v, strict)), 'ts_ms', watermark);
  for (const key of ['onset', 'peak', 'latest', 'onset_successor']) {
    s[key] = nullable(s[key], v => parseFrame(v, strict));
    if (s[key]) requireThat(watermark !== null && s[key].ts_ms <= watermark, 'future evidence');
  }
  s.protected_selection = nullable(s.protected_selection, v => ordered(array(v, 6,
    frame => parseFrame(frame, strict, 'selection')), 'ts_ms', watermark));
  const known = new Map();
  const samples = [...s.history, ...s.snapshots, ...s.pre_onset,
    ...['onset', 'peak', 'latest', 'onset_successor'].flatMap(key => s[key] ? [s[key]] : []), ...(s.protected_selection ?? [])];
  for (const frame of samples) {
    const base = baseFrame(frame), previous = known.get(frame.ts_ms);
    requireThat(!previous || same(previous, base), 'contradictory evidence summary');
    known.set(frame.ts_ms, base);
  }
  requireThat(same(s.latest, s.history.at(-1) ?? null), 'latest/history mismatch');
  requireThat((watermark === null) === (s.latest === null), 'missing evidence watermark');
  if (s.latest) {
    requireThat(s.latest.ts_ms === watermark, 'stale evidence history');
    const o = observation;
    requireThat(o !== null && same(s.latest, {ts_ms: o.ts_ms, fire_evidence: o.fire.evidence_level,
      smoke_evidence: o.smoke.evidence_level, confidence: o.fire.confidence, area_px: o.fire.area_px,
      area_fraction: o.fire.area_fraction, area_reliable: o.fire.area_reliable, visibility: o.visibility,
      frame_wh: o.frame_wh}), 'evidence/observation mismatch');
  }
  const fireFrames = [...known.values()].filter(frame => frame.fire_evidence !== 'not_detected');
  requireThat((s.onset !== null) === (fireFrames.length > 0), 'missing or invented onset');
  if (s.onset) {
    requireThat(s.onset.fire_evidence !== 'not_detected' && fireFrames.every(frame => frame.ts_ms >= s.onset.ts_ms) &&
      s.pre_onset.every(frame => frame.ts_ms < s.onset.ts_ms && frame.fire_evidence === 'not_detected'), 'invalid onset context');
    requireThat((s.latest.ts_ms > s.onset.ts_ms) === (s.onset_successor !== null), 'missing onset successor');
    if (s.onset_successor) requireThat(s.onset_successor.ts_ms > s.onset.ts_ms &&
      [...known.values()].every(frame => frame.ts_ms <= s.onset.ts_ms || frame.ts_ms >= s.onset_successor.ts_ms), 'invalid onset successor');
  } else requireThat(s.peak === null && s.onset_successor === null &&
    same(s.pre_onset, s.history.slice(-2)), 'invalid pre-onset state');
  requireThat((s.peak !== null) === fireFrames.some(frame => frame.area_fraction !== null), 'missing or invented peak');
  if (s.peak) requireThat(s.peak.fire_evidence !== 'not_detected' && fireFrames.every(frame =>
    frame.area_fraction <= s.peak.area_fraction && (frame.area_fraction !== s.peak.area_fraction || frame.ts_ms >= s.peak.ts_ms)), 'invalid observed peak');
  for (const frame of s.protected_selection ?? []) {
    const snapshot = s.snapshots.find(item => item.ts_ms === frame.ts_ms);
    requireThat(snapshot && snapshot.snapshot_key === frame.snapshot_key && same(snapshot.local_ref ?? null,frame.local_ref ?? null), 'unretained protected selection');
  }
  return s;
}

function parseEvidenceRequest(value, strict) {
  if (value === null) return null;
  const request=object(value,['request_id','session_id','generation','incident_id','analysis_job_id',
    'reason','ts_ms','expires_at_ms','status','frames'],strict);
  text(request.request_id,256); text(request.incident_id,256);
  requireThat(typeof request.session_id==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.session_id), 'invalid evidence request session');
  counter(request.generation); requireThat(request.generation>0,'invalid evidence request generation');
  counter(request.analysis_job_id); requireThat(request.analysis_job_id>0,'invalid evidence request job');
  enumeration(request.reason,['initial_confirmation','later_measured_peak','later_scene_evidence']);
  enumeration(request.status,['awaiting_images','ready']);
  number(request.ts_ms); number(request.expires_at_ms);
  request.frames=array(request.frames,6,raw=>{
    const frame=object(raw,['frame_id','ts_ms','attempt_sequence','jpeg_sha256','frame_wh'],strict);
    requireThat(typeof frame.frame_id==='string' && /^frame-[0-9]+(?:\.[0-9]+)?$/.test(frame.frame_id),'invalid requested frame id');
    number(frame.ts_ms); requireThat(frame.frame_id===`frame-${frame.ts_ms}`,'requested frame timestamp mismatch');
    counter(frame.attempt_sequence); requireThat(frame.attempt_sequence>0,'invalid requested frame attempt');
    requireThat(typeof frame.jpeg_sha256==='string' && /^[0-9a-f]{64}$/.test(frame.jpeg_sha256),'invalid requested image hash');
    frame.frame_wh=dimensions(frame.frame_wh);
    return frame;
  });
  requireThat(request.frames.length>0 && new Set(request.frames.map(frame=>frame.frame_id)).size===request.frames.length &&
    request.frames.every((frame,index)=>index===0 || request.frames[index-1].ts_ms<frame.ts_ms), 'invalid requested frame order');
  return request;
}

function freezeSelection(selection) {
  if (selection === null) return null;
  return Object.freeze(selection.map(frame => Object.freeze({...frame,
    roles: Object.freeze([...frame.roles]), frame_wh: Object.freeze([...frame.frame_wh]),
    ...(frame.local_ref ? {local_ref:Object.freeze({...frame.local_ref})} : {})})));
}

function text(value, max = 300) {
  requireThat(typeof value === 'string' && value.length <= max * 2 && Array.from(value).length <= max &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), 'invalid bounded text');
  return value;
}
const strings = (value, max = 8) => array(value, max, item => text(item));
function references(value, manifest) {
  const refs = array(value, 8, id => { text(id, 80); requireThat(manifest.some(f => f.frame_id === id), 'unknown evidence reference'); return id; });
  requireThat(new Set(refs).size === refs.length && refs.every((id, i) => i === 0 ||
    manifest.find(f => f.frame_id === refs[i - 1]).ts_ms < manifest.find(f => f.frame_id === id).ts_ms), 'unordered evidence references');
  return refs;
}
function claim(value, strict, manifest, mode) {
  const core = ['ignition_source', 'ignition_tool', 'fuel_type', 'confidence'];
  const canonical = ['action_frame_ids', 'ignition_frame_id'];
  const legacy = ['fire_class', 'grounding_status', 'evidence_refs'];
  const qualified = ['status', 'confidence_calibrated', 'limitations'];
  const fields = [...core, ...canonical, ...legacy, ...qualified];
  const required = mode === 'raw' ? [...core, ...canonical] : core;
  const c = object(value, fields, strict, fields.filter(key => !required.includes(key)));
  for (const key of core) enumeration(c[key], INVESTIGATION_ENUMS[key]);
  if ('action_frame_ids' in c) c.action_frame_ids = references(c.action_frame_ids, manifest);
  if ('ignition_frame_id' in c) nullable(c.ignition_frame_id, id => references([id], manifest));
  if ('fire_class' in c) enumeration(c.fire_class, INVESTIGATION_ENUMS.fire_class);
  if ('grounding_status' in c) enumeration(c.grounding_status, ['unsupported', 'frame_referenced']);
  if ('evidence_refs' in c) c.evidence_refs = references(c.evidence_refs, manifest);
  if ('status' in c) enumeration(c.status, ['insufficient_evidence', 'frame_linked_unverified']);
  if ('confidence_calibrated' in c) requireThat(c.confidence_calibrated === false, 'calibrated model authority');
  if ('limitations' in c) c.limitations = strings(c.limitations, 16);
  if (mode === 'raw') requireThat(Object.keys(c).length === required.length, 'invalid raw model hypothesis');
  else {
    requireThat(c.confidence_calibrated === false &&
      (Object.hasOwn(c, 'action_frame_ids') || Object.hasOwn(c, 'evidence_refs')), 'unqualified hypothesis');
    if (Object.hasOwn(c, 'status')) requireThat(Array.isArray(c.limitations), 'missing hypothesis limitations');
  }
  return c;
}
function observations(value, strict, manifest) {
  const result = array(value, 16, raw => {
    const item = object(raw, ['frame_ids', 'kind', 'description'], strict);
    item.frame_ids = references(item.frame_ids, manifest);
    requireThat(item.frame_ids.length > 0, 'empty observation reference');
    enumeration(item.kind, INVESTIGATION_OBSERVATION_KINDS); text(item.description);
    requireThat(item.description.trim().length > 0, 'empty observation description');
    return item;
  });
  requireThat(result.every((item, i) => i === 0 || manifest.find(f => f.frame_id === result[i - 1].frame_ids[0]).ts_ms <=
    manifest.find(f => f.frame_id === item.frame_ids[0]).ts_ms), 'unordered observations');
  return result;
}
function parseCause(value, strict, manifest) {
  if (value === null) { requireThat(manifest.length === 0, 'manifest without cause'); return null; }
  const common = [...Object.keys(INVESTIGATION_ENUMS), 'reasons', 'evidence', 'validation_errors', 'aftercare',
    'advisory_only', 'cause_status', 'requires_human_review', 'hazard_absence_verified', 'model_hypothesis',
    'cause_limitations', 'source', 'accepted_cause', 'require_human_review', 'hypothesis', 'model_claims'];
  const optional = ['model', 'vlm_error', 'evidence_refs', 'visual_observations', 'observations', 'scene_assessment', 'inference_metadata'];
  const c = object(value, [...common, ...optional], strict, optional);
  for (const [key, values] of Object.entries(INVESTIGATION_ENUMS)) enumeration(c[key], values);
  for (const key of ['ignition_source', 'ignition_tool', 'probable_cause', 'accepted_cause', 'fuel_type', 'fire_class']) {
    requireThat(c[key] === 'unknown', 'unreviewed accepted cause or classification');
  }
  requireThat(c.confidence === 'low' && c.evidence_status === 'inferred' &&
    c.requires_human_review === true && c.require_human_review === true && c.hazard_absence_verified === false &&
    c.advisory_only === true && c.recommended_agent === 'undetermined' && c.aftercare === DEFAULT_ADVICE &&
    c.electrical_hazard !== 'absent' && c.incompatible_fuel_hazard !== 'absent', 'unsafe qualified cause');
  enumeration(c.cause_status, ['unknown', 'unverified']);
  for (const key of ['reasons', 'evidence', 'validation_errors']) c[key] = strings(c[key]);
  c.cause_limitations = strings(c.cause_limitations, 16);
  c.hypothesis = claim(c.hypothesis, strict, manifest, 'qualified');
  c.model_hypothesis = claim(c.model_hypothesis, strict, manifest, 'qualified');
  if ('observations' in c) c.observations = observations(c.observations, strict, manifest);
  if ('evidence_refs' in c) c.evidence_refs = references(c.evidence_refs, manifest);
  if ('visual_observations' in c) c.visual_observations = array(c.visual_observations, 16, raw => {
    const item = object(raw, ['kind', 'frame_id', 'description'], strict);
    enumeration(item.kind, ['person_present', 'hand_fuel_contact', 'ignition_action', 'flame_visible',
      'smoke_visible', 'tool_visible', 'fuel_visible', 'unknown']);
    references([item.frame_id], manifest); text(item.description); return item;
  });
  const raw = c.model_claims;
  const modern = raw !== null && typeof raw === 'object' && Object.hasOwn(raw, 'observations');
  const rawKeys = modern ? ['provenance', 'observations', 'hypothesis'] :
    ['provenance', ...Object.keys(INVESTIGATION_ENUMS).filter(key => key !== 'recommended_agent'), 'reasons', 'evidence'];
  c.model_claims = object(raw, rawKeys, strict);
  requireThat(c.model_claims.provenance === 'untrusted_model_output', 'model claims authority');
  if (modern) {
    c.model_claims.observations = observations(raw.observations, strict, manifest);
    c.model_claims.hypothesis = claim(raw.hypothesis, strict, manifest, 'raw');
    requireThat(same(c.observations, c.model_claims.observations) && same(c.hypothesis, c.model_hypothesis), 'contradictory qualified claims');
    for (const key of ['ignition_source', 'ignition_tool', 'fuel_type', 'confidence', 'action_frame_ids', 'ignition_frame_id'])
      requireThat(same(c.hypothesis[key], c.model_claims.hypothesis[key]), 'hypothesis/model claim mismatch');
  } else {
    for (const key of Object.keys(INVESTIGATION_ENUMS).filter(key => key !== 'recommended_agent')) enumeration(c.model_claims[key], INVESTIGATION_ENUMS[key]);
    for (const key of ['reasons', 'evidence']) c.model_claims[key] = strings(c.model_claims[key]);
  }
  c.scene_assessment = Object.hasOwn(c, 'scene_assessment') ?
    validateSceneAssessment(c.scene_assessment, manifest, c.observations ?? [], c.validation_errors) : unknownSceneAssessment();
  text(c.source, 64); requireThat(/^[a-z][a-z0-9_-]{0,63}$/.test(c.source), 'invalid analysis source');
  if ('model' in c) { text(c.model, 160); requireThat(c.model.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(c.model), 'invalid model'); }
  if ('inference_metadata' in c) c.inference_metadata = validateInferenceMetadata(c.inference_metadata);
  if ('vlm_error' in c) enumeration(c.vlm_error, VLM_ERROR_CODES);
  return c;
}

function parseState(value, strict) {
  const s = object(value, ['version', ...FIELDS, ...WORK_FLAGS], strict,
    ['eventSequence', ...V3_FIELDS, ...V4_FIELDS, ...V5_FIELDS, ...V6_FIELDS, ...V7_FIELDS]);
  requireThat(s.version === 1 || s.version === 2 || s.version === 3 || s.version === 4 || s.version === 5 || s.version === 6 || s.version === 7, 'unsupported version');
  if (s.version === 1) {
    requireThat(!Object.hasOwn(value, 'eventSequence'), 'legacy event watermark');
    s.eventSequence = 0;
  } else counter(s.eventSequence);
  if (s.version < 3) {
    requireThat(V3_FIELDS.every(key => !Object.hasOwn(value, key)), 'unexpected lease fields in legacy checkpoint');
    s.sceneLease = null;
    s.sceneLeaseGeneration = 0;
    s.sceneHazardLatchIncidentId = null;
  } else {
    requireThat(V3_FIELDS.every(key => Object.hasOwn(value, key)), 'missing lease fields');
    s.sceneLease = nullable(s.sceneLease, validateStoredSceneLease);
    counter(s.sceneLeaseGeneration);
    nullable(s.sceneHazardLatchIncidentId, v => {
      requireThat(typeof v === 'string' && v.length <= 256, 'invalid scene hazard incident');
      return v;
    });
  }
  nullable(s.cameraId, v => { requireThat(typeof v === 'string' && /^[\w-]+$/.test(v) && v.length <= 128, 'invalid camera identity'); return v; });
  for (const key of ['lastObservationTs', 'lastReceiptAtMs', 'followupRequested', 'initialPeakTs']) nullable(s[key], number);
  for (const key of ['incidentSequence', 'analysisJob']) counter(s[key]);
  counter(s.persistCount, 24); boolean(s.followupUsed);
  for (const key of WORK_FLAGS) boolean(s[key]);
  enumeration(s.alert, ['idle', 'watch', 'confirmed']);
  s.window = ordered(parseWindow(s.window, strict), 'ts', s.lastObservationTs);
  s.trendWindow = ordered(parseTrend(s.trendWindow, strict), 'ts', s.lastObservationTs);
  s.currentObservation = parseObservation(s.currentObservation, strict);
  s.measurement = parseMeasurement(s.measurement, strict);
  s.evidenceState = parseEvidence(s.evidenceState, strict, s.lastObservationTs, s.currentObservation);
  s.evidenceManifest = ordered(array(s.evidenceManifest, 6, frame => parseFrame(frame, strict, 'manifest')), 'ts_ms', s.lastObservationTs);
  s.cause = parseCause(s.cause, strict, s.evidenceManifest);
  requireThat(s.cause === null || s.alert === 'confirmed', 'cause without active incident');
  const active = incident(s.incidentId, s.cameraId, s.incidentSequence, s.lastObservationTs);
  const closed = incident(s.closedIncidentId, s.cameraId, s.incidentSequence, s.lastObservationTs);
  requireThat(!active || !closed, 'active and closed incident');
  requireThat((active ?? closed) === null || (active ?? closed).seq === s.incidentSequence, 'incident sequence mismatch');
  requireThat(!(s.analysisActive || s.pendingAnalysis || s.nativeInference) ||
    (s.analysisJob > 0 && s.incidentSequence > 0), 'in-flight work without incident/job');
  requireThat((s.alert === 'confirmed') === (active !== null) && (s.fire !== null) === (active !== null), 'inconsistent alert/incident');
  if (s.sceneLease !== null) {
    requireThat(s.version >= 3 && active !== null && s.alert === 'confirmed' &&
      s.sceneHazardLatchIncidentId === null && s.sceneLease.camera_id === s.cameraId &&
      s.sceneLease.incident_id === active.id && s.sceneLease.analysis_job_id === s.analysisJob &&
      s.sceneLease.cancellation_generation === s.sceneLeaseGeneration &&
      s.sceneLease.issue_source_ts_ms === s.lastObservationTs &&
      s.sceneLease.issue_received_at_ms === s.lastReceiptAtMs && s.cause?.scene_assessment &&
      s.sceneLease.scene_assessment_json === JSON.stringify(s.cause.scene_assessment),
      'lease does not match current incident/evidence');
  }
  if (s.sceneHazardLatchIncidentId !== null) {
    const latched = incident(s.sceneHazardLatchIncidentId, s.cameraId, s.incidentSequence, s.lastObservationTs);
    requireThat(s.version >= 3 && active !== null && s.alert === 'confirmed' && latched?.id === active.id &&
      s.sceneLease === null, 'invalid scene hazard latch');
  }
  if (s.version < 6) {
    requireThat(V6_FIELDS.every(key=>!Object.hasOwn(value,key)),'unexpected handheld hazard latch in legacy checkpoint');
    s.handheldHazardLatchIncidentId=null;
  } else {
    requireThat(V6_FIELDS.every(key=>Object.hasOwn(value,key)),'missing handheld hazard latch field');
    nullable(s.handheldHazardLatchIncidentId,v=>{
      requireThat(typeof v==='string' && v.length<=256,'invalid handheld hazard incident');
      return v;
    });
  }
  if (s.handheldHazardLatchIncidentId !== null) {
    const latched=incident(s.handheldHazardLatchIncidentId,s.cameraId,s.incidentSequence,s.lastObservationTs);
    requireThat(s.version>=6 && active!==null && s.alert==='confirmed' && latched?.id===active.id,
      'invalid handheld hazard latch');
  }
  if (s.version < 7) {
    requireThat(V7_FIELDS.every(key=>!Object.hasOwn(value,key)),'unexpected handheld qualification watermark in legacy checkpoint');
    // A legacy active incident has no durable record of the last local track
    // invalidation. Requiring a wholly newer pair is the conservative upgrade.
    s.handheldQualificationRequiredAfterTs=s.alert==='confirmed' && s.handheldHazardLatchIncidentId===null ?
      s.lastObservationTs : null;
  } else {
    requireThat(V7_FIELDS.every(key=>Object.hasOwn(value,key)),'missing handheld qualification watermark');
    nullable(s.handheldQualificationRequiredAfterTs,number);
  }
  if (s.handheldQualificationRequiredAfterTs !== null) {
    requireThat(active!==null && s.alert==='confirmed' &&
      s.handheldHazardLatchIncidentId===null && s.lastObservationTs!==null &&
      s.handheldQualificationRequiredAfterTs<=s.lastObservationTs,
      'invalid handheld qualification watermark');
  }
  if (s.version < 4) {
    requireThat(V4_FIELDS.every(key => !Object.hasOwn(value, key)), 'unexpected edge batch fields in legacy checkpoint');
    s.edgeSessionId = null; s.edgeGeneration = 0; s.edgeAttemptSequence = 0; s.edgeAttemptTs = null; s.edgeBatchSequence = 0;
    s.observationBatchLedger = [];
  } else {
    requireThat(V4_FIELDS.every(key => Object.hasOwn(value, key)), 'missing edge batch fields');
    nullable(s.edgeSessionId, v => {requireThat(typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v), 'invalid edge session'); return v;});
    counter(s.edgeGeneration); counter(s.edgeAttemptSequence); nullable(s.edgeAttemptTs,number); counter(s.edgeBatchSequence);
    s.observationBatchLedger = array(s.observationBatchLedger, 64, raw => {
      const entry = object(raw, ['session_id','generation','batch_sequence','payload_hash','ack'], strict);
      requireThat(entry.session_id === s.edgeSessionId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entry.session_id), 'batch ledger session mismatch');
      counter(entry.generation); counter(entry.batch_sequence); requireThat(entry.generation === s.edgeGeneration && entry.batch_sequence > 0 &&
        typeof entry.payload_hash === 'string' && /^[0-9a-f]{64}$/.test(entry.payload_hash), 'invalid batch ledger identity');
      const ack = object(entry.ack, ['protocol_version','session_id','generation','batch_sequence','payload_hash','accepted_through','dispositions',
        'final_state','event_watermark','events','pending_evidence_requests'], strict);
      requireThat(ack.protocol_version === 2 && ack.session_id === entry.session_id && ack.generation === entry.generation &&
        ack.batch_sequence === entry.batch_sequence && ack.payload_hash === entry.payload_hash, 'batch acknowledgement mismatch');
      counter(ack.accepted_through); counter(ack.event_watermark); const dispositions=array(ack.dispositions, 12, item => {
        const d = object(item, ['attempt_sequence','status'], strict); counter(d.attempt_sequence);
        enumeration(d.status, ['accepted','gap','skipped_stale']); return d;
      });
      requireThat(dispositions.length > 0 && dispositions.every((d,index) => d.attempt_sequence ===
        (index === 0 ? ack.accepted_through - dispositions.length + 1 : dispositions[index-1].attempt_sequence + 1)) &&
        dispositions.at(-1).attempt_sequence === ack.accepted_through, 'invalid acknowledged attempt range');
      const final = object(ack.final_state, ['alert','incident_id','last_observation_ts','hits'], strict);
      enumeration(final.alert, ['idle','watch','confirmed']); nullable(final.incident_id, v => text(v, 256)); nullable(final.last_observation_ts, number);
      counter(final.hits,12);
      const events=array(ack.events, 24, item => {
        const event = object(item, ['type','event_sequence','ts_ms','incident_id'], strict);
        text(event.type, 40); counter(event.event_sequence); number(event.ts_ms); nullable(event.incident_id, v => text(v,256)); return event;
      });
      requireThat(events.every((event,index) => event.event_sequence <= ack.event_watermark &&
        (index === 0 || events[index-1].event_sequence < event.event_sequence)), 'invalid acknowledged event range');
      ack.pending_evidence_requests=array(ack.pending_evidence_requests,6,item=>parseEvidenceRequest(item,strict));
      requireThat(ack.pending_evidence_requests.every(request=>request.session_id===entry.session_id &&
        request.generation===entry.generation),'acknowledged evidence request session mismatch');
      return entry;
    });
    requireThat(s.observationBatchLedger.every((entry,index) => index === 0 ||
      entry.batch_sequence > s.observationBatchLedger[index - 1].batch_sequence) &&
      (!s.edgeSessionId ? s.edgeGeneration === 0 && s.edgeAttemptSequence === 0 && s.edgeAttemptTs === null && s.edgeBatchSequence === 0 && !s.observationBatchLedger.length :
        s.edgeGeneration > 0 && s.edgeBatchSequence >= (s.observationBatchLedger.at(-1)?.batch_sequence ?? 0)), 'inconsistent edge batch watermark');
    requireThat(s.observationBatchLedger.every(entry => entry.batch_sequence <= s.edgeBatchSequence &&
      entry.ack.accepted_through <= s.edgeAttemptSequence && entry.ack.event_watermark <= s.eventSequence) &&
      (!s.observationBatchLedger.length || (s.observationBatchLedger.at(-1).batch_sequence === s.edgeBatchSequence &&
        s.observationBatchLedger.at(-1).ack.accepted_through === s.edgeAttemptSequence)), 'future batch acknowledgement');
    requireThat(s.observationBatchLedger.every((entry,index) => index === 0 ||
      entry.batch_sequence === s.observationBatchLedger[index-1].batch_sequence + 1), 'batch ledger sequence gap');
    requireThat((s.edgeAttemptSequence === 0) === (s.edgeAttemptTs === null), 'attempt sequence/timestamp mismatch');
  }
  if (s.version < 5) {
    requireThat(V5_FIELDS.every(key=>!Object.hasOwn(value,key)),'unexpected pending image request in legacy checkpoint');
    s.pendingEvidenceRequest=null;
    s.completedEvidenceRequests=[];
  } else {
    requireThat(V5_FIELDS.every(key=>Object.hasOwn(value,key)),'missing pending image request fields');
    s.pendingEvidenceRequest=parseEvidenceRequest(s.pendingEvidenceRequest,strict);
    s.completedEvidenceRequests=array(s.completedEvidenceRequests,64,item=>text(item,256));
    requireThat(new Set(s.completedEvidenceRequests).size===s.completedEvidenceRequests.length,'duplicate completed evidence request');
    if (s.pendingEvidenceRequest!==null) {
      const request=s.pendingEvidenceRequest;
      requireThat(request.session_id===s.edgeSessionId && request.generation===s.edgeGeneration &&
        request.incident_id===s.incidentId && request.analysis_job_id===s.analysisJob && s.alert==='confirmed' &&
        !s.completedEvidenceRequests.includes(request.request_id) &&
        request.frames.every(frame=>s.evidenceState.protected_selection?.some(selected=>selected.frame_id===frame.frame_id &&
          selected.local_ref?.session_id===request.session_id && selected.local_ref.generation===request.generation &&
          selected.local_ref.attempt_sequence===frame.attempt_sequence && selected.local_ref.jpeg_sha256===frame.jpeg_sha256)),
        'pending evidence request is detached from protected incident evidence');
    }
  }
  if (s.fire !== null) {
    s.fire = object(s.fire, ['peakArea', 'startedAt'], strict);
    number(s.fire.peakArea); number(s.fire.startedAt);
    requireThat(s.fire.startedAt === active.ts && s.fire.startedAt <= s.lastObservationTs, 'invalid fire start');
  }
  for (const key of ['followupRequested', 'initialPeakTs']) requireThat(s[key] === null ||
    (s.lastObservationTs !== null && s[key] <= s.lastObservationTs), 'future followup timestamp');
  requireThat(s.followupRequested === null || (active !== null && !s.followupUsed), 'invalid followup request');
  if (s.lastObservationTs === null) {
    requireThat((s.cameraId === null || s.edgeSessionId !== null) && s.lastReceiptAtMs === null && s.currentObservation === null &&
      s.window.length === 0 && s.trendWindow.length === 0 && s.alert === 'idle' &&
      s.incidentSequence === 0 && s.analysisJob === 0 && s.initialPeakTs === null, 'missing source watermark');
    requireThat(same(s.measurement, {area_px: null, area_fraction: null, area_reliable: false,
      frame_wh: null, visibility_status: 'unknown'}), 'invalid initial measurement');
  } else {
    requireThat(s.cameraId !== null && s.lastReceiptAtMs !== null && s.currentObservation?.ts_ms === s.lastObservationTs, 'watermark/observation mismatch');
    const o = s.currentObservation;
    requireThat(same(s.measurement, {area_px: o.fire.area_px, area_fraction: o.fire.area_fraction,
      area_reliable: o.fire.area_reliable, frame_wh: o.frame_wh, visibility_status: o.visibility}), 'measurement/observation mismatch');
    requireThat(!s.window.length || s.window.at(-1).ts === s.lastObservationTs, 'stale confirmation window');
    requireThat(!s.trendWindow.length || s.trendWindow.at(-1).ts === s.lastObservationTs, 'stale trend window');
  }
  for (const frame of s.window) {
    const sample = s.evidenceState.history.find(item => item.ts_ms === frame.ts);
    if (sample) requireThat(frame.area === sample.area_px && frame.strong === (sample.confidence >= 0.25) &&
      frame.any === (sample.confidence >= 0.08) && frame.detected ===
        (sample.fire_evidence !== 'not_detected' || sample.smoke_evidence !== 'not_detected'), 'confirmation/evidence mismatch');
    if (s.fire && frame.ts >= s.fire.startedAt) requireThat((frame.area ?? 0) <= s.fire.peakArea, 'invalid incident peak');
  }
  for (const trend of s.trendWindow) {
    const sample = s.evidenceState.history.find(item => item.ts_ms === trend.ts);
    if (sample) requireThat(trend.area_ratio === sample.area_fraction && trend.reliable === sample.area_reliable &&
      trend.visibility === sample.visibility && same(trend.frame_wh, sample.frame_wh), 'trend/evidence mismatch');
  }
  return s;
}

/** Bounded serialized UTF-8 metadata ceiling for the SQLite-backed coordinator. */
const CHECKPOINT_BYTES = 256 * 1024;
function checkBudget(value) {
  let bytes = 0, nodes = 0;
  const ancestors = new Set();
  const charge = count => { bytes += count; if (bytes > CHECKPOINT_BYTES) throw new Error('coordinator_state_too_large'); };
  const stringBytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
  function visit(item, depth) {
    requireThat(++nodes <= 20000 && depth <= 16, 'checkpoint nesting or node limit');
    if (item === null) { charge(4); return; }
    if (typeof item === 'string') { charge(stringBytes(item)); return; }
    if (typeof item === 'number') { requireThat(Number.isFinite(item), 'nonfinite JSON value'); charge(String(item).length); return; }
    if (typeof item === 'boolean') { charge(item ? 4 : 5); return; }
    requireThat(typeof item === 'object' && !ancestors.has(item), 'non-JSON or cyclic value');
    ancestors.add(item);
    const isArray = Array.isArray(item);
    requireThat(isArray || [Object.prototype, null].includes(Object.getPrototypeOf(item)), 'non-JSON container');
    const keys = Reflect.ownKeys(item).filter(key => !isArray || key !== 'length');
    if (isArray) requireThat(keys.length === item.length && keys.every((key, index) => key === String(index)), 'invalid dense JSON array');
    charge(2 + Math.max(0, keys.length - 1));
    for (const key of keys) {
      requireThat(typeof key === 'string', 'symbol JSON field');
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      requireThat(descriptor.enumerable && 'value' in descriptor, 'accessor or hidden JSON field');
      if (!isArray) charge(stringBytes(key) + 1);
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
  }
  visit(value, 0);
}

export function encodeCoordinatorState(camera) {
  const value = {version: 7};
  for (const key of FIELDS) value[key] = camera[key];
  value.window = array(camera.window, 24, frame => {
    if (frame.dets !== undefined) array(frame.dets, 256, d => {
      enumeration(d?.cls, ['fire', 'smoke']); number(d.conf, 1);
      const box = array(d.bbox_xyxy, 4, v => { requireThat(Number.isFinite(v), 'invalid historical box'); return v; });
      requireThat(box.length === 4 && box[0] < box[2] && box[1] < box[3], 'invalid historical geometry');
    });
    return {ts: frame.ts, area: frame.area,
      strong: frame.dets ? frame.dets.some(d => d.cls === 'fire' && d.conf >= 0.25) : frame.strong,
      any: frame.dets ? frame.dets.some(d => d.cls === 'fire' && d.conf >= 0.08) : frame.any,
      detected: frame.dets ? frame.dets.length > 0 : frame.detected};
  });
  value.trendWindow = array(camera.trendWindow, 24, sample => ({...sample, reset: sample.reset ?? null}));
  value.analysisActive = camera.analysisActive;
  value.pendingAnalysis = camera.pendingAnalysis !== null;
  value.nativeInference = camera.nativeInference !== null;
  value.analysisInterrupted = camera.analysisInterrupted === undefined ? false : boolean(camera.analysisInterrupted);
  value.nativeInferenceInterrupted = camera.nativeInferenceInterrupted === undefined ? false : boolean(camera.nativeInferenceInterrupted);
  const checkpoint = parseState(value, false);
  checkBudget(checkpoint);
  return structuredClone(checkpoint);
}

export function decodeCoordinatorState(value) {
  if (value === undefined) return null;
  checkBudget(value);
  const result = structuredClone(parseState(value, true));
  delete result.version;
  const nativeInferenceInterrupted = result.nativeInferenceInterrupted || result.nativeInference;
  const analysisInterrupted = result.analysisInterrupted || result.analysisActive || result.pendingAnalysis || nativeInferenceInterrupted;
  result.evidenceState.protected_selection = analysisInterrupted && result.pendingEvidenceRequest === null ? null :
    freezeSelection(result.evidenceState.protected_selection);
  if (analysisInterrupted) result.followupRequested = null;
  return {...result, analysisActive: false, pendingAnalysis: null, nativeInference: null,
    analysisInterrupted, nativeInferenceInterrupted};
}
