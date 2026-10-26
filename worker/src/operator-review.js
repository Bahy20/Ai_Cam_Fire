import { OperatorError, requireOperatorPrincipal } from './operator-auth.js';

const FIELDS = ['request_id', 'incident_id', 'analysis_event_key', 'expected_revision', 'disposition',
  'ignition_source', 'ignition_tool', 'independent_evidence', 'rationale'];
const invalid = () => { throw new OperatorError(400, 'review_invalid_request'); };
function object(value, fields) {
  if (value === null || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== fields.length) invalid();
  const result = {};
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    result[key] = descriptor.value;
  }
  return result;
}
function text(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max * 2 || Array.from(value).length > max ||
      /[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value)) invalid();
}
function camera(value) {
  if (typeof value !== 'string' || !value.length || value.length > 128 || /[^A-Za-z0-9_-]/.test(value)) invalid();
}
function token(value, max) {
  if (typeof value !== 'string' || !value.length || value.length > max || /[^A-Za-z0-9._:-]/.test(value) || !/^[A-Za-z0-9_-]/.test(value)) invalid();
}
function validate(body) {
  const result = object(body, FIELDS);
  if (typeof result.request_id !== 'string' || result.request_id.length !== 36 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result.request_id)) invalid();
  token(result.incident_id, 256); token(result.analysis_event_key, 512);
  if (!Number.isSafeInteger(result.expected_revision) || result.expected_revision < 0 || result.expected_revision >= Number.MAX_SAFE_INTEGER ||
      !['accept', 'reject', 'inconclusive'].includes(result.disposition) ||
      !['human_activity', 'electrical', 'other', 'unknown'].includes(result.ignition_source)) invalid();
  text(result.ignition_tool, 120); text(result.rationale, 2000);
  if (result.independent_evidence !== null) {
    result.independent_evidence = object(result.independent_evidence, ['kind', 'reference', 'summary']);
    if (!['onsite_inspection', 'independent_recording', 'verified_investigation'].includes(result.independent_evidence.kind)) invalid();
    text(result.independent_evidence.reference, 512); text(result.independent_evidence.summary, 2000);
  }
  if (result.disposition === 'accept') {
    if (result.ignition_source === 'unknown' || result.independent_evidence === null) invalid();
  } else if (result.ignition_source !== 'unknown' || result.ignition_tool !== 'unknown') invalid();
  return result;
}

function review(row) {
  return {
    request_id: row.request_id, camera_id: row.camera_id, incident_id: row.incident_id,
    analysis_event_key: row.analysis_event_key, revision: row.revision, expected_revision: row.expected_revision,
    subject: row.subject, email: row.email, created_ms: row.created_ms, disposition: row.disposition,
    ignition_source: row.ignition_source, ignition_tool: row.ignition_tool,
    independent_evidence: row.independent_evidence_json === null ? null : JSON.parse(row.independent_evidence_json),
    rationale: row.rationale, provenance: 'operator_attestation', factual_correctness_verified: false,
  };
}
async function digest(text) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
    value => value.toString(16).padStart(2, '0')).join('');
}

// These are human attestations, not verified facts, model aliases, suppression
// advice or a clearance. Authentication never comes from fields in the DTO.
export async function submitCauseReview(db, principal, cameraId, body, { nowMs = Date.now() } = {}) {
  const actor = requireOperatorPrincipal(principal, 'cause:review', cameraId);
  camera(cameraId);
  body = validate(body);
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > 8640000000000000) invalid();
  const payload = JSON.stringify({ camera_id: cameraId, ...body });
  const hash = await digest(payload);
  const existing = await db.prepare('SELECT * FROM operator_reviews WHERE request_id = ?').bind(body.request_id).first();
  const checked = row => {
    if (row.subject !== actor.subject || row.email !== actor.email || row.camera_id !== cameraId ||
        row.incident_id !== body.incident_id || row.analysis_event_key !== body.analysis_event_key ||
        row.payload_hash !== hash || row.payload_json !== payload) throw new OperatorError(409, 'review_request_conflict');
    return review(row);
  };
  if (existing) return { operator_review: checked(existing), idempotent: true };
  const target = await db.prepare(`SELECT 1 AS found FROM events AS analysis
    WHERE analysis.camera_id = ? AND analysis.incident_id = ? AND analysis.event_key = ? AND analysis.event_kind = 'analysis'
      AND EXISTS (SELECT 1 FROM events AS confirmation WHERE confirmation.camera_id = analysis.camera_id
        AND confirmation.incident_id = analysis.incident_id AND confirmation.event_kind = 'confirmation')`)
    .bind(cameraId, body.incident_id, body.analysis_event_key).first();
  if (!target) throw new OperatorError(404, 'review_target_not_found');
  const result = await db.prepare(`INSERT INTO operator_reviews
    (request_id, camera_id, incident_id, analysis_event_key, revision, expected_revision,
     subject, email, created_ms, disposition, ignition_source, ignition_tool,
     independent_evidence_json, rationale, payload_json, payload_hash)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE (SELECT COALESCE(MAX(revision), 0) FROM operator_reviews WHERE camera_id = ? AND incident_id = ?) = ?
      AND NOT EXISTS (SELECT 1 FROM operator_reviews WHERE request_id = ?)`)
    .bind(body.request_id, cameraId, body.incident_id, body.analysis_event_key, body.expected_revision + 1,
      body.expected_revision, actor.subject, actor.email, nowMs, body.disposition, body.ignition_source,
      body.ignition_tool, body.independent_evidence === null ? null : JSON.stringify(body.independent_evidence),
      body.rationale, payload, hash, cameraId, body.incident_id, body.expected_revision, body.request_id).run();
  if (result?.success === false) throw new OperatorError(503, 'review_write_failed');
  const row = await db.prepare('SELECT * FROM operator_reviews WHERE request_id = ?').bind(body.request_id).first();
  if (!row) {
    if (result?.meta?.changes === 1) throw new OperatorError(503, 'review_readback_failed');
    throw new OperatorError(409, 'review_revision_conflict');
  }
  return { operator_review: checked(row), idempotent: result.meta.changes === 0 };
}

export async function listCauseReviews(db, principal, cameraId, incidentId, { limit = 50, beforeRevision = null } = {}) {
  requireOperatorPrincipal(principal, 'cause:review', cameraId);
  camera(cameraId); token(incidentId, 256);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
      (beforeRevision !== null && (!Number.isSafeInteger(beforeRevision) || beforeRevision < 1))) invalid();
  const confirmed = await db.prepare(`SELECT 1 AS found FROM events WHERE camera_id = ? AND incident_id = ? AND event_kind = 'confirmation' LIMIT 1`)
    .bind(cameraId, incidentId).first();
  if (!confirmed) throw new OperatorError(404, 'review_target_not_found');
  const latest = await db.prepare('SELECT COALESCE(MAX(revision), 0) AS revision FROM operator_reviews WHERE camera_id = ? AND incident_id = ?')
    .bind(cameraId, incidentId).first();
  const result = await db.prepare(`SELECT * FROM operator_reviews WHERE camera_id = ? AND incident_id = ? AND revision <= ?
    AND (? IS NULL OR revision < ?) ORDER BY revision DESC LIMIT ?`)
    .bind(cameraId, incidentId, latest.revision, beforeRevision, beforeRevision, limit + 1).all();
  const hasMore = result.results.length > limit;
  const reviews = result.results.slice(0, limit).map(review);
  return { reviews, latest_revision: latest.revision, has_more: hasMore,
    next_before_revision: hasMore ? reviews.at(-1).revision : null };
}
