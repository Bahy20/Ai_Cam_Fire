import { isReviewedSourceContext, MAX_SITE_REVIEW_AGE_MS } from './site-context.js';
import { sceneAssessmentApplies } from './investigation.js';

export const SCENE_LEASE_MS = 5_000;
export const SCENE_LEASE_USEFUL_REMAINDER_MS = 2_000;
const HASH = /^[a-f0-9]{64}$/;
const CAMERA_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
const ZONE_ID = CAMERA_ID;
const SOURCE_TYPES = ['candle', 'stationary_burner'];
const LEASE_FIELDS = Object.freeze(['version', 'camera_id', 'incident_id', 'analysis_job_id',
  'cancellation_generation', 'session_id', 'source_zone_id', 'source_type', 'context_revision',
  'geometry_revision', 'reference_image_sha256', 'context_expires_at_ms', 'scene_assessment_json',
  'support_frame_ids', 'support_source_ts_ms',
  'support_received_at_ms', 'expires_source_ts_ms', 'expires_at_ms', 'issued_at_ms',
  'issue_source_ts_ms', 'issue_received_at_ms', 'remaining_ms_at_issue', 'useful_at_issue']);

const integer = value => Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const sourceTime = value => Number.isFinite(value) && value >= 0 && value <= 8640000000000000;
const text = (value, pattern, max = 128) => typeof value === 'string' && value.length > 0 &&
  value.length <= max && pattern.test(value) && !/[\u0000-\u001f\u007f]/.test(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, keys) => record(value) && Reflect.ownKeys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));
const frameTimestamp = id => {
  const match = typeof id === 'string' && /^frame-(0|[1-9]\d{0,15})(?:\.(\d{1,12}))?$/.exec(id);
  if (!match) return null;
  const value = Number(id.slice(6));
  return sourceTime(value) && `frame-${value}` === id ? value : null;
};
const uniqueStrings = (value, max, pattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/) =>
  Array.isArray(value) && value.length > 0 && value.length <= max &&
  value.every(item => text(item, pattern, 128)) && new Set(value).size === value.length;

function rejectStored(message) { throw new TypeError(`invalid_scene_lease: ${message}`); }

/** Validate a compact persisted lease. Its wall and source expiries are immutable. */
export function validateStoredSceneLease(value) {
  if (!exact(value, LEASE_FIELDS)) rejectStored('fields');
  if (value.version !== 1 || !text(value.camera_id, CAMERA_ID, 80) ||
      !text(value.incident_id, /^[A-Za-z0-9_.-]+:(0|[1-9]\d{0,15}(?:\.\d{1,12})?):[1-9]\d{0,15}$/, 256) ||
      !integer(value.analysis_job_id) || value.analysis_job_id < 1 ||
      !integer(value.cancellation_generation) || !text(value.session_id, /^[A-Za-z0-9_.:-]+$/, 128) ||
      !text(value.source_zone_id, ZONE_ID, 80) || !SOURCE_TYPES.includes(value.source_type) ||
      !integer(value.context_revision) || value.context_revision < 1 ||
      !integer(value.geometry_revision) || value.geometry_revision < 1 ||
      typeof value.reference_image_sha256 !== 'string' || !HASH.test(value.reference_image_sha256) ||
      !integer(value.context_expires_at_ms) ||
      typeof value.scene_assessment_json !== 'string' || value.scene_assessment_json.length > 16_000 ||
      !Array.isArray(value.support_frame_ids) || value.support_frame_ids.length < 2 ||
      value.support_frame_ids.length > 8 || !value.support_frame_ids.every(id => frameTimestamp(id) !== null) ||
      new Set(value.support_frame_ids).size !== value.support_frame_ids.length ||
      !sourceTime(value.support_source_ts_ms) || !integer(value.support_received_at_ms) ||
      !sourceTime(value.expires_source_ts_ms) || !integer(value.expires_at_ms) ||
      !integer(value.issued_at_ms) || !sourceTime(value.issue_source_ts_ms) || !integer(value.issue_received_at_ms) ||
      !integer(value.remaining_ms_at_issue) || value.remaining_ms_at_issue < 1 || value.remaining_ms_at_issue > SCENE_LEASE_MS ||
      typeof value.useful_at_issue !== 'boolean') rejectStored('invalid value');
  let scene;
  try { scene = JSON.parse(value.scene_assessment_json); } catch { rejectStored('invalid scene assessment binding'); }
  if (JSON.stringify(scene) !== value.scene_assessment_json || scene?.contract_version !== 2 ||
      scene?.category !== 'contained_flame' || JSON.stringify(scene.frame_ids) !== JSON.stringify(value.support_frame_ids) ||
      !Array.isArray(scene.assertions) || !scene.assertions.every(row =>
        row?.source_id === value.source_zone_id && row?.source_type === value.source_type) ||
      !sceneAssessmentApplies(scene, {ts_ms:value.issue_source_ts_ms, evidence_current:true, chronological_match:true})) {
    rejectStored('invalid scene assessment binding');
  }
  const parsed = value.support_frame_ids.map(frameTimestamp);
  if (parsed.some((ts, index) => index > 0 && parsed[index - 1] >= ts) ||
      value.support_frame_ids.at(-1) !== `frame-${value.support_source_ts_ms}` ||
      value.expires_source_ts_ms !== value.support_source_ts_ms + SCENE_LEASE_MS ||
      value.expires_at_ms !== Math.min(value.support_received_at_ms + SCENE_LEASE_MS, value.context_expires_at_ms) ||
      value.issue_source_ts_ms < value.support_source_ts_ms || value.issue_source_ts_ms > value.expires_source_ts_ms ||
      value.issue_received_at_ms < value.support_received_at_ms || value.issued_at_ms < value.issue_received_at_ms ||
      value.issued_at_ms > value.expires_at_ms ||
      value.remaining_ms_at_issue !== Math.min(value.expires_source_ts_ms - value.issue_source_ts_ms,
        value.expires_at_ms - value.issued_at_ms) ||
      value.useful_at_issue !== (value.remaining_ms_at_issue >= SCENE_LEASE_USEFUL_REMAINDER_MS)) {
    rejectStored('inconsistent expiry or evidence');
  }
  return structuredClone(value);
}

function validSceneEvidence(scene, frames, { source_zone_id, source_type, current_source_ts_ms }) {
  if (!record(scene) || scene.contract_version !== 2 || scene.category !== 'contained_flame' ||
      scene.provenance !== 'untrusted_model_output' || scene.support !== 'insufficient_evidence' ||
      !Array.isArray(scene.validation_errors) || scene.validation_errors.length !== 0 ||
      !Array.isArray(scene.frame_ids) || scene.frame_ids.length < 2 || scene.frame_ids.length > 8 ||
      !Array.isArray(scene.assertions) || scene.assertions.length !== scene.frame_ids.length ||
      !record(scene.evidence_interval) || !sourceTime(scene.evidence_interval.start_ts_ms) ||
      !sourceTime(scene.evidence_interval.end_ts_ms)) return false;
  const byFrame = new Map(frames.map(frame => [frame.frame_id, frame]));
  let previousTs = -1;
  for (let index = 0; index < scene.frame_ids.length; index++) {
    const id = scene.frame_ids[index], assertion = scene.assertions[index], frame = byFrame.get(id);
    const timestamp = frameTimestamp(id);
    if (!frame || timestamp === null || timestamp !== frame.source_ts_ms || timestamp <= previousTs ||
        !exact(assertion, ['frame_id', 'source_id', 'detection_ids', 'source_type', 'containment', 'smoke',
          'secondary_burning', 'spread_outside_source', 'occlusion']) || assertion.frame_id !== id ||
        assertion.source_id !== source_zone_id || assertion.source_type !== source_type ||
        !Array.isArray(assertion.detection_ids) || assertion.detection_ids.length < 1 ||
        assertion.detection_ids.length > 8 || new Set(assertion.detection_ids).size !== assertion.detection_ids.length ||
        !assertion.detection_ids.every(detId => frame.detection_ids.includes(detId)) ||
        assertion.containment !== 'contained' || assertion.smoke !== 'not_observed' ||
        assertion.secondary_burning !== 'not_observed' || assertion.spread_outside_source !== 'not_observed' ||
        assertion.occlusion !== 'not_observed') return false;
    previousTs = timestamp;
  }
  const times = scene.frame_ids.map(frameTimestamp);
  return scene.evidence_interval.start_ts_ms === times[0] &&
    scene.evidence_interval.end_ts_ms === times.at(-1) &&
    sceneAssessmentApplies(scene, {ts_ms: current_source_ts_ms, evidence_current: true, chronological_match: true});
}

function validContinuity(chain, candidate, context, zone) {
  if (!exact(chain, ['qualified', 'camera_id', 'incident_id', 'session_id', 'source_zone_id',
    'context_revision', 'geometry_revision', 'reference_image_sha256', 'chain_start_ts_ms', 'chain_end_ts_ms',
    'frame_ids', 'max_source_gap_ms', 'all_fire_regions_inside_zone', 'unique_region_match',
    'image_quality_usable', 'background_stable', 'camera_motion', 'smoke_absent',
    'secondary_burning_absent', 'spread_absent', 'source_geometry_matched'])) return false;
  const frameTimes = Array.isArray(chain.frame_ids) ? chain.frame_ids.map(frameTimestamp) : [];
  const checks=[chain.qualified === true, chain.camera_id === candidate.camera_id,
    chain.incident_id === candidate.incident_id, chain.session_id === candidate.session_id,
    chain.source_zone_id === zone.zone_id, chain.context_revision === context.context_revision,
    chain.geometry_revision === context.geometry_revision,
    chain.reference_image_sha256 === context.reviewed_reference_image_sha256,
    sourceTime(chain.chain_start_ts_ms), sourceTime(chain.chain_end_ts_ms),
    chain.chain_start_ts_ms <= candidate.supporting_frames[0].source_ts_ms,
    chain.chain_end_ts_ms === candidate.current_observation.source_ts_ms,
    uniqueStrings(chain.frame_ids, 32, /^frame-(0|[1-9]\d{0,15})(?:\.\d{1,12})?$/),
    frameTimes.every((ts, index) => ts !== null && (index === 0 ||
      (ts > frameTimes[index - 1] && ts - frameTimes[index - 1] <= 2_000))),
    frameTimes[0] === chain.chain_start_ts_ms, frameTimes.at(-1) === chain.chain_end_ts_ms,
    chain.max_source_gap_ms === Math.max(0, ...frameTimes.slice(1).map((ts, index) => ts - frameTimes[index])),
    chain.max_source_gap_ms <= 2_000, candidate.supporting_frames.every(frame => chain.frame_ids.includes(frame.frame_id)),
    chain.all_fire_regions_inside_zone === true, chain.unique_region_match === true,
    chain.image_quality_usable === true, chain.background_stable === true, chain.camera_motion === false,
    chain.smoke_absent === true, chain.secondary_burning_absent === true, chain.spread_absent === true,
    chain.source_geometry_matched === true];
  return checks.every(Boolean);
}

/** Build a lease only from a current, reviewed, frame- and continuity-linked candidate. */
export function createSceneLease(candidate) {
  if (!record(candidate) || !text(candidate.camera_id, CAMERA_ID, 80) ||
      !text(candidate.incident_id, /^[A-Za-z0-9_.-]+:(0|[1-9]\d{0,15}(?:\.\d{1,12})?):[1-9]\d{0,15}$/, 256) ||
      !integer(candidate.analysis_job_id) || candidate.analysis_job_id < 1 ||
      !integer(candidate.cancellation_generation) || !text(candidate.session_id, /^[A-Za-z0-9_.:-]+$/, 128) ||
      !text(candidate.source_zone_id, ZONE_ID, 80) || !SOURCE_TYPES.includes(candidate.source_type) ||
      !integer(candidate.now_ms) || !record(candidate.current_observation) ||
      !sourceTime(candidate.current_observation.source_ts_ms) || !integer(candidate.current_observation.received_at_ms) ||
      !Array.isArray(candidate.supporting_frames) || candidate.supporting_frames.length < 2 ||
      candidate.supporting_frames.length > 8) return null;
  const current = candidate.current_observation;
  const context = candidate.site_context;
  if (!isReviewedSourceContext(context, candidate.camera_id, current.source_ts_ms, candidate.now_ms)) return null;
  const zone = context.source_zones.find(source => source.zone_id === candidate.source_zone_id);
  if (!zone || zone.source_type !== candidate.source_type ||
      context.known_hazards.length || context.occupied_area || context.critical_zones.length) return null;

  const frames = [];
  for (const raw of candidate.supporting_frames) {
    if (!exact(raw, ['frame_id', 'source_ts_ms', 'received_at_ms', 'detection_ids']) ||
        !sourceTime(raw.source_ts_ms) || !integer(raw.received_at_ms) ||
        raw.frame_id !== `frame-${raw.source_ts_ms}` ||
        !uniqueStrings(raw.detection_ids, 16)) return null;
    frames.push({...raw, detection_ids: [...raw.detection_ids]});
  }
  if (frames.some((frame, index) => index > 0 && (frames[index - 1].source_ts_ms >= frame.source_ts_ms ||
      frames[index - 1].received_at_ms > frame.received_at_ms)) ||
      JSON.stringify(candidate.scene_assessment?.frame_ids) !== JSON.stringify(frames.map(frame=>frame.frame_id)) ||
      !validSceneEvidence(candidate.scene_assessment, frames, {source_zone_id: zone.zone_id,
        source_type: zone.source_type, current_source_ts_ms: current.source_ts_ms}) ||
      !validContinuity(candidate.continuity, candidate, context, zone)) return null;

  const latest = frames.at(-1);
  if (candidate.current_observation.source_ts_ms < latest.source_ts_ms ||
      candidate.current_observation.source_ts_ms - latest.source_ts_ms > SCENE_LEASE_MS ||
      candidate.current_observation.received_at_ms < latest.received_at_ms ||
      candidate.current_observation.received_at_ms - latest.received_at_ms > SCENE_LEASE_MS ||
      candidate.now_ms < latest.received_at_ms || candidate.now_ms >= latest.received_at_ms + SCENE_LEASE_MS) return null;

  const expiresSource = latest.source_ts_ms + SCENE_LEASE_MS;
  const contextExpires = context.review_expires_at_ms ?? context.reviewed_at_ms + MAX_SITE_REVIEW_AGE_MS;
  const expiresWall = Math.min(latest.received_at_ms + SCENE_LEASE_MS, contextExpires);
  const remaining = Math.min(expiresSource - current.source_ts_ms, expiresWall - candidate.now_ms);
  if (!sourceTime(expiresSource) || !integer(expiresWall) || remaining <= 0) return null;
  return validateStoredSceneLease({version: 1, camera_id: candidate.camera_id,
    incident_id: candidate.incident_id, analysis_job_id: candidate.analysis_job_id,
    cancellation_generation: candidate.cancellation_generation, session_id: candidate.session_id,
    source_zone_id: zone.zone_id, source_type: zone.source_type,
    context_revision: context.context_revision, geometry_revision: context.geometry_revision,
    reference_image_sha256: context.reviewed_reference_image_sha256,
    context_expires_at_ms: contextExpires,
    scene_assessment_json: JSON.stringify(candidate.scene_assessment),
    support_frame_ids: frames.map(frame => frame.frame_id), support_source_ts_ms: latest.source_ts_ms,
    support_received_at_ms: latest.received_at_ms, expires_source_ts_ms: expiresSource,
    expires_at_ms: expiresWall, issued_at_ms: candidate.now_ms,
    issue_source_ts_ms: current.source_ts_ms, issue_received_at_ms: current.received_at_ms,
    remaining_ms_at_issue: remaining,
    useful_at_issue: remaining >= SCENE_LEASE_USEFUL_REMAINDER_MS});
}

export function isSceneLeaseExpired(lease, {now_ms, source_ts_ms = null} = {}) {
  try { validateStoredSceneLease(lease); } catch { return true; }
  return !integer(now_ms) || now_ms >= lease.expires_at_ms ||
    (source_ts_ms !== null && (!sourceTime(source_ts_ms) || source_ts_ms > lease.expires_source_ts_ms));
}

/** A new observation can retain a lease only with a fresh, fully qualified chain. */
export function advanceSceneLease(lease, observation) {
  try { validateStoredSceneLease(lease); } catch { return {lease: null, cancelled: true, hazard_latched: false, reason: 'invalid_lease'}; }
  if (!record(observation)) return {lease: null, cancelled: true, hazard_latched: false, reason: 'invalid_observation'};
  if (observation.secondary_burning === true || observation.spread_outside_source === true) {
    return {lease: null, cancelled: true, hazard_latched: true, reason: 'secondary_burning_or_spread'};
  }
  const sameContext = observation.camera_id === lease.camera_id && observation.incident_id === lease.incident_id &&
    observation.session_id === lease.session_id && observation.source_zone_id === lease.source_zone_id &&
    observation.context_revision === lease.context_revision && observation.geometry_revision === lease.geometry_revision &&
    observation.reference_image_sha256 === lease.reference_image_sha256;
  const valid = sameContext && observation.observation_valid === true && sourceTime(observation.source_ts_ms) &&
    integer(observation.received_at_ms) && integer(observation.now_ms) &&
    !isSceneLeaseExpired(lease, {now_ms: observation.now_ms, source_ts_ms: observation.source_ts_ms}) &&
    observation.fire_region_count === 1 && observation.unique_region_match === true &&
    observation.inside_reviewed_zone === true && observation.continuity_qualified === true &&
    observation.camera_motion === false && observation.image_quality_usable === true &&
    observation.background_stable === true && observation.smoke_present === false &&
    observation.secondary_burning === false && observation.spread_outside_source === false;
  if (!valid) return {lease: null, cancelled: true, hazard_latched: false, reason: 'continuity_or_context_changed'};
  return {lease: structuredClone(lease), cancelled: false, hazard_latched: false, reason: null};
}

export function isSceneLeaseCurrent(lease, {camera_id, incident_id, analysis_job_id, cancellation_generation,
  session_id, site_context, scene_assessment, source_ts_ms, now_ms} = {}) {
  try { validateStoredSceneLease(lease); } catch { return false; }
  return lease.useful_at_issue && lease.camera_id === camera_id && lease.incident_id === incident_id &&
    lease.analysis_job_id === analysis_job_id && lease.cancellation_generation === cancellation_generation &&
    lease.session_id === session_id && lease.context_revision === site_context?.context_revision &&
    lease.geometry_revision === site_context?.geometry_revision &&
    lease.reference_image_sha256 === site_context?.reviewed_reference_image_sha256 &&
    JSON.stringify(scene_assessment) === lease.scene_assessment_json &&
    isReviewedSourceContext(site_context, camera_id, source_ts_ms, now_ms) &&
    !isSceneLeaseExpired(lease, {now_ms, source_ts_ms});
}

