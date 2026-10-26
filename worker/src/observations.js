/**
 * Normalize ONE local-YOLO observation from edge/agent.py or the trusted ingress.
 * Pure, synchronous, dependency-free; accepts JSON-like values, not a batch or JSON text.
 *
 * Required input: {ts_ms, frame_wh: [decodedWidth, decodedHeight], detections: [
 *   {cls: 'fire'|'smoke', conf: number, bbox_xyxy: [x1,y1,x2,y2]}
 * ]}. Dimensions must be positive safe integers with a safe-integer frame area;
 * ts_ms must be finite nonnegative milliseconds (zero/fractions are accepted).
 * Numeric strings are not coerced. Reversed/empty/nonfinite boxes are rejected;
 * valid boxes are clipped to decoded dimensions and must retain positive area.
 * Supplied area_px/centroid_xy are ignored and recomputed. Other keys, including
 * camera_id/inference_ms and declared width/height, are NOT copied to the result.
 * Camera identity and timestamp ordering/skew belong to the calling adapter.
 *
 * Optional visibility: 'adequate'|'unknown'|'degraded', default 'unknown'. Only
 * supply 'adequate' from independently established visibility metadata; a decoded
 * JPEG, a detection, or absence of smoke does not establish adequate visibility.
 * Any non-null/undefined error field makes the result invalid and degraded,
 * including the detector's {error:'jpeg_decode_failed', detections:[]} response.
 * Optional camera_motion: boolean|null; omitted/null means unknown. It is only
 * validated/copied, never inferred from box positions or successful decoding.
 *
 * Returns {observation_valid, http_status, validation_errors, ts_ms, frame_wh,
 *   detections, visibility, camera_motion, fire, smoke}. Each class summary is:
 *   {evidence_level, confidence, detection_count, area_px, area_fraction,
 *    area_reliable}.
 * Evidence: strong = any conf >= 0.25 (legacy, NOT a validated safety threshold);
 * weak = boxes exist but all conf < 0.25, including boxes below the legacy 0.08
 * confirmation tier; not_detected = valid empty class; unknown = invalid result.
 * Confidence is maximum reported box confidence, not a calibrated probability.
 * Area is the clipped rectangle UNION for that class, not segmentation/physical
 * area or a count of separate fire spots. area_fraction = area_px / frame area.
 * Weak candidate area is retained but unreliable. Fire area_reliable requires
 * every contributing box >= 0.25 and visibility not explicitly degraded. Unknown
 * visibility permits ONLY measured positive fire footprints, not absence/clearance
 * evidence; it remains unknown and MUST lower trend confidence. Smoke reliability
 * still requires adequate visibility. These are measurement-quality gates, never
 * proof of physical decline/collapse, extinction, or safety.
 * Missing class/invalid result => confidence/area_px/area_fraction are NULL, not 0.
 * No detections means not_detected, never extinguished, even with adequate visibility.
 *
 * Validation is atomic: malformed top-level values => http_status 400; invalid
 * fields/detector errors => 422; valid => 200. Errors are 'field.path: message'
 * strings. Invalid results discard ALL detections and return unknown summaries,
 * null ts_ms/frame_wh, and unknown visibility unless a detector error degraded it.
 * Callers MUST reject invalid results using http_status, not feed detections:[]
 * to an absence counter. This module performs no HTTP/I/O, expiry or transitions.
 * Ingress must bound request/detection count before calling (union O(n^2 log n)).
 *
 * @param {unknown} input Single result, optionally with visibility/camera_motion.
 * @returns {object} Fresh normalized data; never mutates or aliases input arrays.
 */
export function normalizeObservation(input) {
  if (!isRecord(input)) return invalidObservation(400, ['$: expected a result object']);
  if (input.error !== undefined && input.error !== null) {
    return invalidObservation(422, ['error: detector reported a failure'], 'degraded');
  }
  const errors = [];
  const visibility = input.visibility === undefined ? 'unknown' : input.visibility;
  if (!['adequate', 'unknown', 'degraded'].includes(visibility)) {
    errors.push('visibility: expected adequate, unknown or degraded');
  }
  const camera_motion = input.camera_motion === undefined ? null : input.camera_motion;
  if (camera_motion !== null && typeof camera_motion !== 'boolean') {
    errors.push('camera_motion: expected boolean or null');
  }
  if (!Number.isFinite(input.ts_ms) || input.ts_ms < 0) {
    errors.push('ts_ms: expected finite nonnegative milliseconds');
  }
  const dimensionsValid = Array.isArray(input.frame_wh) && input.frame_wh.length === 2 &&
    input.frame_wh.every((v) => Number.isSafeInteger(v) && v > 0) &&
    Number.isSafeInteger(input.frame_wh[0] * input.frame_wh[1]);
  if (!dimensionsValid) errors.push('frame_wh: expected positive decoded integer width and height');
  if (!Array.isArray(input.detections)) errors.push('detections: expected an array');

  const detections = [];
  if (Array.isArray(input.detections)) {
    for (const [index, d] of input.detections.entries()) {
      const path = `detections[${index}]`;
      if (!isRecord(d)) {
        errors.push(`${path}: expected a detection object`);
        continue;
      }
      if (d.cls !== 'fire' && d.cls !== 'smoke') errors.push(`${path}.cls: expected fire or smoke`);
      if (!Number.isFinite(d.conf) || d.conf < 0 || d.conf > 1) {
        errors.push(`${path}.conf: expected finite confidence in 0..1`);
      }
      const box = d.bbox_xyxy;
      if (!Array.isArray(box) || box.length !== 4 || ![...box].every(Number.isFinite) ||
          box[0] >= box[2] || box[1] >= box[3]) {
        errors.push(`${path}.bbox_xyxy: expected finite ordered xyxy coordinates with positive area`);
        continue;
      }
      if (!dimensionsValid) continue;
      const [width, height] = input.frame_wh;
      const [x1, y1, x2, y2] = box.map((v, i) =>
        Math.max(0, Math.min(v, i % 2 === 0 ? width : height)));
      const area = (x2 - x1) * (y2 - y1);
      if (!(area > 0)) {
        errors.push(`${path}.bbox_xyxy: box has no area inside the decoded frame`);
        continue;
      }
      detections.push({
        cls: d.cls, conf: d.conf, bbox_xyxy: [x1, y1, x2, y2],
        area_px: area, centroid_xy: [(x1 + x2) / 2, (y1 + y2) / 2],
      });
    }
  }
  if (errors.length) return invalidObservation(422, errors);
  const [width, height] = input.frame_wh;
  const frameArea = width * height;
  return {
    observation_valid: true, http_status: 200, validation_errors: [],
    ts_ms: input.ts_ms, frame_wh: [width, height], detections, visibility, camera_motion,
    fire: summarizeEvidence(detections, 'fire', frameArea, visibility),
    smoke: summarizeEvidence(detections, 'smoke', frameArea, visibility),
  };
}

function summarizeEvidence(detections, cls, frameArea, visibility) {
  const selected = detections.filter((d) => d.cls === cls);
  if (selected.length === 0) return emptyEvidence('not_detected');
  const area = unionArea(selected.map((d) => d.bbox_xyxy));
  const confidence = selected.reduce((max, d) => Math.max(max, d.conf), 0);
  return {
    evidence_level: confidence >= 0.25 ? 'strong' : 'weak',
    confidence,
    detection_count: selected.length,
    area_px: area, area_fraction: area / frameArea,
    area_reliable: (visibility === 'adequate' || (cls === 'fire' && visibility === 'unknown')) &&
      selected.every((d) => d.conf >= 0.25),
  };
}

// Exact rectangle union: sweep distinct x edges and merge occupied y intervals.
// Unlike an enclosing box, this preserves holes and disjoint regions.
function unionArea(boxes) {
  const edges = [...new Set(boxes.flatMap((box) => [box[0], box[2]]))].sort((a, b) => a - b);
  let area = 0;
  for (let i = 1; i < edges.length; i++) {
    const left = edges[i - 1];
    const right = edges[i];
    const intervals = boxes.filter((box) => box[0] < right && box[2] > left)
      .map((box) => [box[1], box[3]]).sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let end = -Infinity;
    for (const [bottom, top] of intervals) {
      covered += Math.max(0, top - Math.max(bottom, end));
      end = Math.max(end, top);
    }
    area += (right - left) * covered;
  }
  return area;
}

function emptyEvidence(evidence_level) {
  return {
    evidence_level, confidence: null, detection_count: 0,
    area_px: null, area_fraction: null, area_reliable: false,
  };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidObservation(http_status, validation_errors, visibility = 'unknown') {
  return {
    observation_valid: false, http_status, validation_errors,
    ts_ms: null, frame_wh: null, detections: [], visibility, camera_motion: null,
    fire: emptyEvidence('unknown'), smoke: emptyEvidence('unknown'),
  };
}
