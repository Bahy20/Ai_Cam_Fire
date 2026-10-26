const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const BODY_FIELDS = ['protocol_version','session_id','generation','batch_sequence','payload_hash','clock_mode','samples'];
const SAMPLE_FIELDS = ['attempt_sequence','ts_ms','status','frame_wh','detections','jpeg_sha256',
  'local_image_available','visibility','camera_motion','quality','reason'];
const OPTIONAL_SAMPLE_FIELDS = ['handheld_candidate'];
const CANDIDATE_FIELDS = ['version','camera_id','session_id','generation','candidate_id','model_sha256',
  'source_ts_ms','frame_ids','tool_type','flame_relation','image_quality','fire_region_count',
  'smoke_evidence','secondary_burning_evidence'];

function invalid() { throw new Error('invalid_observation_batch'); }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype,null].includes(Object.getPrototypeOf(value)); }
function exact(value, keys) { return plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key)); }
function exactWithOptional(value, required, optional) { return plain(value) && required.every(key => Object.hasOwn(value,key)) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key)); }
function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
function dimensionPair(value) { return Array.isArray(value) && value.length === 2 && value.every(v => Number.isSafeInteger(v) && v > 0 && v <= 8192) && value[0]*value[1] <= 16*1024*1024; }

function validHandheldCandidate(value, {cameraId,sessionId,generation,ts_ms,status}) {
  if (value === null) return true;
  if (status !== 'ok' || !exact(value,CANDIDATE_FIELDS) || value.version !== 1 || value.camera_id !== cameraId ||
      value.session_id !== sessionId || value.generation !== generation ||
      typeof value.candidate_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(value.candidate_id) ||
      ['__proto__','constructor','prototype'].includes(value.candidate_id) ||
      typeof value.model_sha256 !== 'string' || !HASH.test(value.model_sha256) ||
      !finite(value.source_ts_ms) || value.source_ts_ms !== ts_ms || !Array.isArray(value.frame_ids) ||
      value.frame_ids.length !== 2 || !['lighter','other','uncertain'].includes(value.tool_type) ||
      !['at_tool_tip','separate','uncertain'].includes(value.flame_relation) ||
      !['adequate','unknown','degraded'].includes(value.image_quality) ||
      !Number.isSafeInteger(value.fire_region_count) || value.fire_region_count < 0 || value.fire_region_count > 64 ||
      !['not_detected','detected','unknown'].includes(value.smoke_evidence) ||
      !['not_detected','detected','unknown'].includes(value.secondary_burning_evidence)) return false;
  const times = value.frame_ids.map(id => {
    if (typeof id !== 'string' || !/^frame-\d+(?:\.\d+)?$/.test(id)) return null;
    const time = Number(id.slice(6));
    return Number.isFinite(time) && id === `frame-${time}` ? time : null;
  });
  return times.every(Number.isFinite) && times[0] < times[1] && times[1] - times[0] <= 2_000 &&
    times[1] === value.source_ts_ms;
}

/** Validate the strict V2 activation/CAS message before any state mutation. */
export function validateSessionActivation(input) {
  if (!exact(input,['protocol_version','session_id','expected_generation']) || input.protocol_version !== 2 ||
      typeof input.session_id !== 'string' || !UUID.test(input.session_id) ||
      !Number.isSafeInteger(input.expected_generation) || input.expected_generation < 0) {
    throw new Error('invalid_session_activation');
  }
  return {...input};
}

/**
 * Canonical request fingerprint shared with edge/agent.py. Keys are sorted at
 * every object level; the digest covers all batch identity and sample fields,
 * excluding only payload_hash itself.
 */
export async function canonicalObservationBatchHash(input) {
  if (!plain(input)) invalid();
  const {payload_hash: _ignored, ...payload} = input;
  const canonical = JSON.stringify(sortKeys(payload));
  const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!plain(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key=>[key,sortKeys(value[key])]));
}

/** Strict metadata-only camera batch envelope. Detection geometry is normalized by observations.js. */
export function validateObservationBatch(input, cameraId) {
  if (!exact(input,BODY_FIELDS) || input.protocol_version !== 2 || input.session_id === undefined ||
      typeof input.session_id !== 'string' || !UUID.test(input.session_id) ||
      !Number.isSafeInteger(input.generation) || input.generation < 1 ||
      !Number.isSafeInteger(input.batch_sequence) || input.batch_sequence < 1 ||
      typeof input.payload_hash !== 'string' || !HASH.test(input.payload_hash) ||
      !['live','replay'].includes(input.clock_mode) || !Array.isArray(input.samples) ||
      input.samples.length < 1 || input.samples.length > 12 ||
      typeof cameraId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(cameraId)) invalid();
  let previousAttempt = null, previousTs = null;
  const samples = input.samples.map(sample => {
    if (!exactWithOptional(sample,SAMPLE_FIELDS,OPTIONAL_SAMPLE_FIELDS) || !Number.isSafeInteger(sample.attempt_sequence) || sample.attempt_sequence < 1 ||
        !finite(sample.ts_ms) || sample.ts_ms < 0 || sample.ts_ms > 8640000000000000 ||
        !['ok','gap'].includes(sample.status) || typeof sample.local_image_available !== 'boolean' ||
        !['adequate','unknown','degraded'].includes(sample.visibility) ||
        (sample.camera_motion !== null && typeof sample.camera_motion !== 'boolean') ||
        !exact(sample.quality,['stability','blur_score','occlusion']) ||
        !['stable','moving','unknown'].includes(sample.quality.stability) ||
        (sample.quality.blur_score !== null && (!finite(sample.quality.blur_score) || sample.quality.blur_score < 0 || sample.quality.blur_score > 1)) ||
        !['none','partial','heavy','unknown'].includes(sample.quality.occlusion)) invalid();
    if (Object.hasOwn(sample,'handheld_candidate') && !validHandheldCandidate(sample.handheld_candidate, {
      cameraId,sessionId:input.session_id,generation:input.generation,ts_ms:sample.ts_ms,status:sample.status})) invalid();
    if (previousAttempt !== null && sample.attempt_sequence !== previousAttempt + 1) invalid();
    if (previousTs !== null && sample.ts_ms <= previousTs) invalid();
    previousAttempt = sample.attempt_sequence; previousTs = sample.ts_ms;
    if (sample.status === 'gap') {
      if (sample.frame_wh !== null || sample.detections !== null || sample.jpeg_sha256 !== null ||
          sample.local_image_available || typeof sample.reason !== 'string' ||
          !['capture_failed','inference_failed','image_encode_failed','queue_overflow','network_recovery','stale_source'].includes(sample.reason)) invalid();
    } else if (!dimensionPair(sample.frame_wh) || !Array.isArray(sample.detections) || sample.detections.length > 256 ||
        typeof sample.jpeg_sha256 !== 'string' || !HASH.test(sample.jpeg_sha256) || sample.reason !== null ||
        !sample.detections.every(d => plain(d) && d.cls && finite(d.conf) && Array.isArray(d.bbox_xyxy))) invalid();
    return structuredClone(sample);
  });
  return {...structuredClone(input),samples};
}

