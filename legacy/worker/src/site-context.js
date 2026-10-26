// Read ONLY operator-managed CAMERA_CONTEXTS_JSON; never upload or model data.
// Validation cannot authenticate an environment's author. The caller owns that
// trust boundary. Private identity branding prevents plain JSON from silently
// entering the authoritative site_context slot after parsing.
const trusted = new WeakMap();
const cameraId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(id) &&
  !['__proto__', 'constructor', 'prototype'].includes(id);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const SITE_HAZARDS = Object.freeze(['electrical', 'flammable_liquid', 'flammable_gas',
  'combustible_dust', 'reactive_materials', 'compressed_gas', 'battery_storage']);
export const CRITICAL_ZONE_TYPES = Object.freeze(['escape_route', 'emergency_exit', 'occupied_area', 'critical_equipment']);
export const REVIEWED_SOURCE_TYPES = Object.freeze(['candle', 'stationary_burner']);
export const MAX_SITE_REVIEW_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const baseKeys = ['reviewed', 'reviewed_by', 'reviewed_at_ms', 'occupied_area', 'known_hazards', 'critical_zones'];
const optionalBaseKeys = ['expected_flame_use', 'expected_handheld_flame_use', 'review_expires_at_ms'];
const geometryKeys = ['context_revision', 'geometry_revision', 'reviewed_reference_image_sha256',
  'reference_dimensions', 'crop_rect', 'source_zones'];
const emptyMap = () => Object.freeze(Object.create(null));
const choices = (value, allowed) => Array.isArray(value) && value.length <= allowed.length &&
  [...value].every(v => allowed.includes(v)) && new Set(value).size === value.length;
const validRect = value => Array.isArray(value) && value.length === 4 &&
  value.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1) &&
  value[0] < value[2] && value[1] < value[3];
const validCrop = value => Array.isArray(value) && value.length === 4 &&
  value.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1) &&
  value[2] > 0 && value[3] > 0 && value[0] + value[2] <= 1 && value[1] + value[3] <= 1;
const validDimensions = value => Array.isArray(value) && value.length === 2 &&
  value.every(n => Number.isSafeInteger(n) && n > 0 && n <= 8192);

function normalizeSourceZones(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) return null;
  const seen = new Set();
  const zones = [];
  for (const zone of value) {
    if (!record(zone) || Object.keys(zone).length !== 3 ||
        !Object.keys(zone).every(key => ['zone_id', 'source_type', 'bbox_normalized'].includes(key)) ||
        typeof zone.zone_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(zone.zone_id) ||
        ['__proto__', 'constructor', 'prototype'].includes(zone.zone_id) || seen.has(zone.zone_id) ||
        !REVIEWED_SOURCE_TYPES.includes(zone.source_type) || !validRect(zone.bbox_normalized)) return null;
    seen.add(zone.zone_id);
    zones.push(Object.freeze({zone_id: zone.zone_id, source_type: zone.source_type,
      bbox_normalized: Object.freeze([...zone.bbox_normalized])}));
  }
  // Overlapping source zones make a fire detection's source ambiguous.
  for (let i = 0; i < zones.length; i++) for (let j = i + 1; j < zones.length; j++) {
    const a = zones[i].bbox_normalized, b = zones[j].bbox_normalized;
    if (a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]) return null;
  }
  return Object.freeze(zones);
}

function normalizeContext(context) {
  if (!record(context)) return null;
  const allowed = [...baseKeys, ...optionalBaseKeys, ...geometryKeys];
  if (Object.keys(context).some(key => !allowed.includes(key)) ||
      !baseKeys.every(key => Object.hasOwn(context, key)) ||
      (Object.hasOwn(context, 'expected_flame_use') && typeof context.expected_flame_use !== 'boolean') ||
      (Object.hasOwn(context, 'expected_handheld_flame_use') && typeof context.expected_handheld_flame_use !== 'boolean') ||
      (Object.hasOwn(context, 'review_expires_at_ms') && (!Number.isSafeInteger(context.review_expires_at_ms) ||
        context.review_expires_at_ms < context.reviewed_at_ms ||
        context.review_expires_at_ms - context.reviewed_at_ms > MAX_SITE_REVIEW_AGE_MS)) ||
      context.reviewed !== true || typeof context.reviewed_by !== 'string' || !context.reviewed_by.trim() ||
      context.reviewed_by.length > 80 || /[\x00-\x1f\x7f]/.test(context.reviewed_by) ||
      !Number.isSafeInteger(context.reviewed_at_ms) || context.reviewed_at_ms < 0 ||
      context.reviewed_at_ms > 8640000000000000 || typeof context.occupied_area !== 'boolean' ||
      !choices(context.known_hazards, SITE_HAZARDS) || !choices(context.critical_zones, CRITICAL_ZONE_TYPES)) return null;

  const geometryPresent = geometryKeys.some(key => Object.hasOwn(context, key));
  if (!geometryPresent) return Object.freeze({reviewed: true, reviewed_by: context.reviewed_by,
    reviewed_at_ms: context.reviewed_at_ms, occupied_area: context.occupied_area,
    ...(Object.hasOwn(context, 'expected_flame_use') ? {expected_flame_use: context.expected_flame_use} : {}),
    ...(Object.hasOwn(context, 'expected_handheld_flame_use') ? {expected_handheld_flame_use: context.expected_handheld_flame_use} : {}),
    ...(Object.hasOwn(context, 'review_expires_at_ms') ? {review_expires_at_ms: context.review_expires_at_ms} : {}),
    known_hazards: Object.freeze([...context.known_hazards]),
    critical_zones: Object.freeze([...context.critical_zones])});

  if (!geometryKeys.every(key => Object.hasOwn(context, key)) ||
      !Number.isSafeInteger(context.context_revision) || context.context_revision < 1 ||
      !Number.isSafeInteger(context.geometry_revision) || context.geometry_revision < 1 ||
      typeof context.reviewed_reference_image_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(context.reviewed_reference_image_sha256) ||
      !validDimensions(context.reference_dimensions) || !validCrop(context.crop_rect) ||
      Object.hasOwn(context, 'review_expires_at_ms') && context.review_expires_at_ms < context.reviewed_at_ms) return null;
  const sourceZones = normalizeSourceZones(context.source_zones);
  if (!sourceZones) return null;
  return Object.freeze({reviewed: true, reviewed_by: context.reviewed_by,
    reviewed_at_ms: context.reviewed_at_ms, review_expires_at_ms: context.review_expires_at_ms,
    context_revision: context.context_revision, geometry_revision: context.geometry_revision,
    reviewed_reference_image_sha256: context.reviewed_reference_image_sha256,
    reference_dimensions: Object.freeze([...context.reference_dimensions]),
    crop_rect: Object.freeze([...context.crop_rect]), source_zones: sourceZones,
    occupied_area: context.occupied_area,
    ...(Object.hasOwn(context, 'expected_flame_use') ? {expected_flame_use: context.expected_flame_use} : {}),
    ...(Object.hasOwn(context, 'expected_handheld_flame_use') ? {expected_handheld_flame_use: context.expected_handheld_flame_use} : {}),
    ...(Object.hasOwn(context, 'review_expires_at_ms') ? {review_expires_at_ms: context.review_expires_at_ms} : {}),
    known_hazards: Object.freeze([...context.known_hazards]),
    critical_zones: Object.freeze([...context.critical_zones])});
}

/** Fail atomically to an empty map. Max 64Ki characters and 128 cameras.
 * Legacy reviewed context remains useful for operator hazard escalation, but
 * it has no source geometry and cannot authorize contained-flame monitoring.
 * Advanced geometry is all-or-nothing and binds a short-lived review to a JPEG.
 */
export function parseCameraContexts(value) {
  if (typeof value !== 'string' || value.length > 65536) return emptyMap();
  let parsed;
  try { parsed = JSON.parse(value); } catch { return emptyMap(); }
  if (!record(parsed) || Object.keys(parsed).length > 128) return emptyMap();
  const result = Object.create(null);
  for (const [id, raw] of Object.entries(parsed)) {
    if (!cameraId(id)) return emptyMap();
    const clean = normalizeContext(raw);
    if (!clean) return emptyMap();
    trusted.set(clean, id);
    result[id] = clean;
  }
  return Object.freeze(result);
}

/** Return a trusted context reference or null; do not clone/serialize before assessment. */
export function contextForCamera(envvalue, cameraid) {
  if (!cameraId(cameraid)) return null;
  return parseCameraContexts(envvalue)[cameraid] ?? null;
}

function reviewedNow(value, ts_ms, now_ms) {
  if (!Number.isFinite(ts_ms) || ts_ms < value.reviewed_at_ms || ts_ms > 8640000000000000 ||
      !Number.isSafeInteger(now_ms) || now_ms < value.reviewed_at_ms) return false;
  const expiry = value.review_expires_at_ms ?? value.reviewed_at_ms + MAX_SITE_REVIEW_AGE_MS;
  return ts_ms <= expiry && now_ms <= expiry;
}

export function isReviewedSiteContext(value, cameraid, ts_ms, now_ms = ts_ms) {
  return record(value) && cameraId(cameraid) && trusted.get(value) === cameraid &&
    reviewedNow(value, ts_ms, now_ms);
}

/** Only fully reviewed fixed-source geometry with a matching, unexpired review qualifies. */
export function isReviewedSourceContext(value, cameraid, ts_ms, now_ms = ts_ms) {
  return isReviewedSiteContext(value, cameraid, ts_ms, now_ms) &&
    value.expected_flame_use === true && value.source_zones?.length > 0 &&
    Number.isSafeInteger(value.context_revision) && Number.isSafeInteger(value.geometry_revision) &&
    /^[a-f0-9]{64}$/.test(value.reviewed_reference_image_sha256);
}

/** Reviewed permission for expected handheld lighter use; never implied by fixed-source zones. */
export function isReviewedHandheldUseContext(value, cameraid, ts_ms, now_ms = ts_ms) {
  return isReviewedSiteContext(value, cameraid, ts_ms, now_ms) && value.expected_handheld_flame_use === true;
}
