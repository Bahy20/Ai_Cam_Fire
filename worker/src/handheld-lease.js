import {isReviewedHandheldUseContext, MAX_SITE_REVIEW_AGE_MS} from './site-context.js';

export const HANDHELD_LEASE_MS = 5_000;
const MAX_CANDIDATE_GAP_MS = 2_000;
const CANDIDATE_FIELDS = Object.freeze(['version', 'camera_id', 'incident_id', 'session_id', 'generation',
  'candidate_id', 'model_sha256', 'source_ts_ms', 'frame_ids', 'tool_type', 'flame_relation', 'image_quality',
  'fire_region_count', 'smoke_evidence', 'secondary_burning_evidence']);
const LEASE_FIELDS = Object.freeze(['version', 'camera_id', 'incident_id', 'session_id', 'generation',
  'candidate_id', 'model_sha256', 'frame_ids', 'first_frame_ts_ms', 'source_ts_ms', 'issued_at_ms',
  'expires_at_ms', 'policy_expires_at_ms', 'tool_type', 'flame_relation']);
const trustedLeases = new WeakSet();
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => isRecord(value) && Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 80 &&
  /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const validUuid = value => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const validTime = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;

function candidateTimes(candidate) {
  if (!Array.isArray(candidate?.frame_ids) || candidate.frame_ids.length !== 2) return null;
  const times = candidate.frame_ids.map(id => {
    if (typeof id !== 'string' || !/^frame-\d+(?:\.\d+)?$/.test(id)) return null;
    const value = Number(id.slice(6));
    return Number.isFinite(value) && value >= 0 && id === `frame-${value}` ? value : null;
  });
  return times.every(Number.isFinite) && times[0] < times[1] && times[1] - times[0] <= MAX_CANDIDATE_GAP_MS ? times : null;
}

function normalizeCandidate(candidate, expected = {}) {
  if (!exactKeys(candidate, CANDIDATE_FIELDS) || candidate.version !== 1 ||
      !validId(candidate.camera_id) || !validId(candidate.incident_id) || !validUuid(candidate.session_id) ||
      !Number.isSafeInteger(candidate.generation) || candidate.generation < 1 || !validId(candidate.candidate_id) ||
      typeof candidate.model_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.model_sha256) ||
      !validTime(candidate.source_ts_ms) || !['lighter', 'other', 'uncertain'].includes(candidate.tool_type) ||
      !['at_tool_tip', 'separate', 'uncertain'].includes(candidate.flame_relation) ||
      !['adequate', 'unknown', 'degraded'].includes(candidate.image_quality) ||
      !Number.isSafeInteger(candidate.fire_region_count) || candidate.fire_region_count < 0 || candidate.fire_region_count > 64 ||
      !['not_detected', 'detected', 'unknown'].includes(candidate.smoke_evidence) ||
      !['not_detected', 'detected', 'unknown'].includes(candidate.secondary_burning_evidence)) return null;
  const times = candidateTimes(candidate);
  if (!times || candidate.source_ts_ms !== times[1] ||
      (expected.camera_id !== undefined && candidate.camera_id !== expected.camera_id) ||
      (expected.incident_id !== undefined && candidate.incident_id !== expected.incident_id) ||
      (expected.session_id !== undefined && candidate.session_id !== expected.session_id) ||
      (expected.generation !== undefined && candidate.generation !== expected.generation) ||
      (expected.candidate_id !== undefined && candidate.candidate_id !== expected.candidate_id) ||
      (expected.model_sha256 !== undefined && candidate.model_sha256 !== expected.model_sha256) ||
      (expected.after_ts_ms !== undefined && candidate.source_ts_ms <= expected.after_ts_ms) ||
      (expected.ts_ms !== undefined && candidate.source_ts_ms !== expected.ts_ms) ||
      !validTime(expected.now_ms) || candidate.source_ts_ms > expected.now_ms ||
      expected.now_ms - candidate.source_ts_ms > HANDHELD_LEASE_MS) return null;
  if (candidate.tool_type !== 'lighter' || candidate.flame_relation !== 'at_tool_tip' ||
      candidate.image_quality !== 'adequate' || candidate.fire_region_count !== 1 ||
      candidate.smoke_evidence !== 'not_detected' || candidate.secondary_burning_evidence !== 'not_detected') return null;
  return {candidate, times};
}

function contextExpiry(context) {
  return context.review_expires_at_ms ?? context.reviewed_at_ms + MAX_SITE_REVIEW_AGE_MS;
}

function makeLease(candidate, times, issuedAtMs, policyExpiresAtMs, expiresAtMs) {
  const lease = Object.freeze({version:1, camera_id:candidate.camera_id, incident_id:candidate.incident_id,
    session_id:candidate.session_id, generation:candidate.generation, candidate_id:candidate.candidate_id,
    model_sha256:candidate.model_sha256, frame_ids:Object.freeze([...candidate.frame_ids]),
    first_frame_ts_ms:times[0], source_ts_ms:times[1], issued_at_ms:issuedAtMs,
    expires_at_ms:expiresAtMs, policy_expires_at_ms:policyExpiresAtMs,
    tool_type:'lighter', flame_relation:'at_tool_tip'});
  trustedLeases.add(lease);
  return lease;
}

function validLeaseShape(value) {
  return exactKeys(value, LEASE_FIELDS) && value.version === 1 && validId(value.camera_id) &&
    validId(value.incident_id) && validUuid(value.session_id) && Number.isSafeInteger(value.generation) &&
    value.generation >= 1 && validId(value.candidate_id) && typeof value.model_sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.model_sha256) && Array.isArray(value.frame_ids) && value.frame_ids.length === 2 &&
    value.frame_ids.every((id, index) => id === `frame-${index ? value.source_ts_ms : value.first_frame_ts_ms}`) &&
    validTime(value.first_frame_ts_ms) && validTime(value.source_ts_ms) &&
    value.first_frame_ts_ms < value.source_ts_ms && value.source_ts_ms - value.first_frame_ts_ms <= MAX_CANDIDATE_GAP_MS &&
    validTime(value.issued_at_ms) && validTime(value.expires_at_ms) && validTime(value.policy_expires_at_ms) &&
    value.expires_at_ms <= value.policy_expires_at_ms && value.expires_at_ms <= value.issued_at_ms + HANDHELD_LEASE_MS &&
    value.tool_type === 'lighter' && value.flame_relation === 'at_tool_tip';
}

/** Make a five-second incident lease from authenticated, two-frame local evidence. */
export function createHandheldLease(candidate, reviewedContext, nowMs) {
  const normalized = normalizeCandidate(candidate, {now_ms:nowMs});
  if (!normalized || !isReviewedHandheldUseContext(reviewedContext, candidate.camera_id,
      candidate.source_ts_ms, nowMs)) return null;
  const policyExpiresAtMs = contextExpiry(reviewedContext);
  if (!validTime(policyExpiresAtMs) || nowMs > policyExpiresAtMs) return null;
  return makeLease(candidate, normalized.times, nowMs, policyExpiresAtMs,
    Math.min(nowMs + HANDHELD_LEASE_MS, policyExpiresAtMs));
}

/** Rebrand a checkpoint lease only after its camera policy and bounded wire shape are rechecked. */
export function restoreHandheldLease(value, reviewedContext, nowMs) {
  if (!validLeaseShape(value) || !validTime(nowMs) || nowMs < value.issued_at_ms || nowMs >= value.expires_at_ms ||
      nowMs > value.policy_expires_at_ms || nowMs - value.source_ts_ms > HANDHELD_LEASE_MS ||
      contextExpiry(reviewedContext ?? {}) !== value.policy_expires_at_ms ||
      !isReviewedHandheldUseContext(reviewedContext, value.camera_id, value.source_ts_ms, nowMs)) return null;
  return makeLease(value, [value.first_frame_ts_ms, value.source_ts_ms], value.issued_at_ms,
    value.policy_expires_at_ms, value.expires_at_ms);
}

/** Renew only from a new qualified local two-frame track; gaps cancel immediately. */
export function advanceHandheldLease(lease, observation, nowMs) {
  const cancel = (reason, urgent = false) => ({lease:null, cancelled:true, reason, urgent});
  if (!trustedLeases.has(lease) || !validLeaseShape(lease)) return cancel('invalid_lease');
  if (!validTime(nowMs) || nowMs >= lease.expires_at_ms || nowMs > lease.policy_expires_at_ms) return cancel('lease_expired');
  if (!isRecord(observation) || observation.observation_valid !== true || !validTime(observation.ts_ms)) {
    return cancel('observation_gap');
  }
  if (observation.smoke_evidence === 'detected' || observation.handheld_candidate?.smoke_evidence === 'detected') {
    return cancel('smoke_detected', true);
  }
  if (observation.secondary_burning_evidence === 'detected' ||
      observation.handheld_candidate?.secondary_burning_evidence === 'detected') return cancel('secondary_burning_detected', true);
  if (observation.fire_region_count !== undefined && observation.fire_region_count !== 1) {
    return cancel('additional_or_missing_fire_region', observation.fire_region_count > 1);
  }
  const normalized = normalizeCandidate(observation.handheld_candidate, {
    camera_id:lease.camera_id, incident_id:lease.incident_id, session_id:lease.session_id,
    generation:lease.generation, candidate_id:lease.candidate_id, model_sha256:lease.model_sha256,
    after_ts_ms:lease.source_ts_ms, ts_ms:observation.ts_ms, now_ms:nowMs,
  });
  if (!normalized) return cancel('local_relation_unqualified');
  const expiresAtMs = Math.min(nowMs + HANDHELD_LEASE_MS, lease.policy_expires_at_ms);
  if (expiresAtMs <= nowMs) return cancel('policy_expired');
  return {lease:makeLease(observation.handheld_candidate, normalized.times, nowMs,
    lease.policy_expires_at_ms, expiresAtMs), cancelled:false, reason:null, urgent:false};
}

/** Check an in-memory lease and all incident/session/time bindings. */
export function isHandheldLeaseCurrent(lease, {cameraId, incidentId, sessionId, sourceTsMs, nowMs} = {}) {
  return trustedLeases.has(lease) && validLeaseShape(lease) && validId(cameraId) && validId(incidentId) &&
    validUuid(sessionId) && validTime(sourceTsMs) && validTime(nowMs) && cameraId === lease.camera_id &&
    incidentId === lease.incident_id && sessionId === lease.session_id && nowMs >= lease.issued_at_ms &&
    nowMs < lease.expires_at_ms && nowMs <= lease.policy_expires_at_ms && nowMs - lease.source_ts_ms <= HANDHELD_LEASE_MS &&
    sourceTsMs >= lease.source_ts_ms && sourceTsMs - lease.source_ts_ms <= HANDHELD_LEASE_MS &&
    sourceTsMs <= nowMs && nowMs - sourceTsMs <= HANDHELD_LEASE_MS;
}
