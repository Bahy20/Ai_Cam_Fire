"""Fail-closed reviewed-source geometry and short observation-chain checks.

These checks establish only experimental image association. They do not prove
source identity, safety, fire severity, or ignition cause. The Worker keeps live
priority urgent until its separate finite-lease integration is validated.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import tempfile
import time
from pathlib import Path


MAX_BUNDLE_BYTES = 16 * 1024 * 1024
MAX_CHAIN_OBSERVATIONS = 32
MAX_SOURCE_GAP_MS = 2_000
SUPPORTED_SOURCE_TYPES = frozenset(('candle', 'stationary_burner'))
_BUNDLE_FIELDS = frozenset(('version', 'camera_id', 'context_revision', 'geometry_revision',
                            'reference_image_sha256', 'dimensions', 'crop_rect', 'source_zones',
                            'jpeg_file', 'geometry_sha256'))


def _finite_rect(rect):
    return (isinstance(rect, (list, tuple)) and len(rect) == 4 and
            all(type(n) in (int, float) and math.isfinite(n) and 0 <= n <= 1 for n in rect) and
            rect[0] < rect[2] and rect[1] < rect[3])


def _valid_crop(rect):
    return (isinstance(rect, (list, tuple)) and len(rect) == 4 and
            all(type(n) in (int, float) and math.isfinite(n) and 0 <= n <= 1 for n in rect) and
            rect[2] > 0 and rect[3] > 0 and rect[0] + rect[2] <= 1 and rect[1] + rect[3] <= 1)


def _validate_zones(zones):
    if not isinstance(zones, list) or not 1 <= len(zones) <= 8:
        raise ValueError('reference_bundle_invalid')
    ids = set()
    normalized = []
    for zone in zones:
        if (not isinstance(zone, dict) or set(zone) != {'zone_id', 'source_type', 'bbox_normalized'} or
                not isinstance(zone['zone_id'], str) or not zone['zone_id'] or len(zone['zone_id']) > 80 or
                not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}', zone['zone_id']) or
                zone['zone_id'] in ('__proto__', 'constructor', 'prototype') or zone['zone_id'] in ids or
                not isinstance(zone['source_type'], str) or zone['source_type'] not in SUPPORTED_SOURCE_TYPES or
                not _finite_rect(zone['bbox_normalized'])):
            raise ValueError('reference_bundle_invalid')
        ids.add(zone['zone_id'])
        normalized.append({'zone_id': zone['zone_id'], 'source_type': zone['source_type'],
                           'bbox_normalized': [float(n) for n in zone['bbox_normalized']]})
    for i, a in enumerate(normalized):
        ax1, ay1, ax2, ay2 = a['bbox_normalized']
        for b in normalized[i + 1:]:
            bx1, by1, bx2, by2 = b['bbox_normalized']
            if ax1 < bx2 and bx1 < ax2 and ay1 < by2 and by1 < ay2:
                raise ValueError('reference_bundle_overlapping_source_zones')
    return normalized


def _geometry_payload(context):
    zones = _validate_zones(context['source_zones'])
    if (not isinstance(context.get('camera_id'), str) or
            not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}', context['camera_id']) or
            context['camera_id'] in ('__proto__', 'constructor', 'prototype') or
            type(context.get('context_revision')) is not int or context['context_revision'] < 1 or
            type(context.get('geometry_revision')) is not int or context['geometry_revision'] < 1 or
            not isinstance(context.get('reviewed_reference_image_sha256'), str) or
            len(context['reviewed_reference_image_sha256']) != 64 or
            any(ch not in '0123456789abcdef' for ch in context['reviewed_reference_image_sha256']) or
            not isinstance(context.get('reference_dimensions'), (list, tuple)) or len(context['reference_dimensions']) != 2 or
            any(type(n) is not int or n < 1 or n > 8192 for n in context['reference_dimensions']) or
            not _valid_crop(context.get('crop_rect'))):
        raise ValueError('reference_bundle_invalid')
    return {'camera_id': context['camera_id'], 'context_revision': context['context_revision'],
            'geometry_revision': context['geometry_revision'],
            'reference_image_sha256': context['reviewed_reference_image_sha256'],
            'dimensions': list(context['reference_dimensions']),
            'crop_rect': [float(n) for n in context['crop_rect']], 'source_zones': zones}


def _geometry_hash(payload):
    encoded = json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()


def _decode_jpeg(jpeg_bytes):
    import cv2
    import numpy as np
    if (not isinstance(jpeg_bytes, (bytes, bytearray)) or not 4 <= len(jpeg_bytes) <= MAX_BUNDLE_BYTES or
            not jpeg_bytes.startswith(b'\xff\xd8') or not jpeg_bytes.endswith(b'\xff\xd9')):
        raise ValueError('reference_bundle_invalid_jpeg')
    image = cv2.imdecode(np.frombuffer(jpeg_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None or image.ndim != 3 or image.shape[2] != 3:
        raise ValueError('reference_bundle_invalid_jpeg')
    return image


def write_reference_bundle(jpeg_bytes, output_dir, *, camera_id, context_revision,
                           geometry_revision, source_zones, crop_rect=(0, 0, 1, 1)):
    """Write a new local review draft atomically; never writes active Worker config."""
    image = _decode_jpeg(jpeg_bytes)
    height, width = image.shape[:2]
    payload = {'camera_id': camera_id, 'context_revision': context_revision,
               'geometry_revision': geometry_revision,
               'reviewed_reference_image_sha256': hashlib.sha256(jpeg_bytes).hexdigest(),
               'reference_dimensions': [width, height], 'crop_rect': list(crop_rect),
               'source_zones': source_zones}
    geometry = _geometry_payload(payload)
    document = {'version': 1, **geometry, 'jpeg_file': 'reference.jpg',
                'geometry_sha256': _geometry_hash(geometry)}
    output = Path(output_dir).absolute()
    parent = output.parent
    parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise FileExistsError('reference_bundle_output_exists')
    temporary = Path(tempfile.mkdtemp(prefix='.fireguard-reference-', dir=parent))
    try:
        image_path = temporary / 'reference.jpg'
        with image_path.open('xb') as stream:
            stream.write(jpeg_bytes)
            stream.flush()
            os.fsync(stream.fileno())
        manifest = temporary / 'reference-bundle.json'
        encoded = (json.dumps(document, sort_keys=True, indent=2) + '\n').encode('utf-8')
        with manifest.open('xb') as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.rename(temporary, output)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    return document


def load_reference_bundle(manifest_path, trusted_context, *, now_ms=None):
    """Verify both bundle files and every trusted active-configuration field."""
    import cv2
    import numpy as np
    manifest_path = Path(manifest_path)
    if manifest_path.is_symlink() or manifest_path.name != 'reference-bundle.json':
        raise ValueError('reference_bundle_invalid')
    try:
        if manifest_path.stat().st_size > 64 * 1024:
            raise ValueError('reference_bundle_invalid')
        data = json.loads(manifest_path.read_text(encoding='utf-8'))
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise ValueError('reference_bundle_unavailable') from None
    if (not isinstance(data, dict) or set(data) != _BUNDLE_FIELDS or data.get('version') != 1 or
            data.get('jpeg_file') != 'reference.jpg'):
        raise ValueError('reference_bundle_invalid')
    try:
        geometry = _geometry_payload({'camera_id': data['camera_id'], 'context_revision': data['context_revision'],
            'geometry_revision': data['geometry_revision'], 'reviewed_reference_image_sha256': data['reference_image_sha256'],
            'reference_dimensions': data['dimensions'], 'crop_rect': data['crop_rect'], 'source_zones': data['source_zones']})
    except (KeyError, TypeError, ValueError):
        raise ValueError('reference_bundle_invalid') from None
    if data['geometry_sha256'] != _geometry_hash(geometry):
        raise ValueError('reference_bundle_configuration_hash_mismatch')
    try:
        expected = _geometry_payload(trusted_context)
    except (KeyError, TypeError, ValueError):
        raise ValueError('reference_bundle_context_mismatch') from None
    expected_hash = _geometry_hash(expected)
    if expected != geometry or trusted_context.get('reviewed') is not True or \
            trusted_context.get('expected_flame_use') is not True or \
            type(trusted_context.get('reviewed_at_ms')) is not int or \
            type(trusted_context.get('review_expires_at_ms')) is not int:
        raise ValueError('reference_bundle_context_mismatch')
    jpeg_path = manifest_path.parent / 'reference.jpg'
    if jpeg_path.is_symlink():
        raise ValueError('reference_bundle_invalid')
    try:
        jpeg_bytes = jpeg_path.read_bytes()
    except OSError:
        raise ValueError('reference_bundle_unavailable') from None
    if hashlib.sha256(jpeg_bytes).hexdigest() != data['reference_image_sha256']:
        raise ValueError('reference_bundle_hash_mismatch')
    image = _decode_jpeg(jpeg_bytes)
    height, width = image.shape[:2]
    if [width, height] != data['dimensions'] or [width, height] != trusted_context.get('reference_dimensions'):
        raise ValueError('reference_bundle_dimensions_mismatch')
    if now_ms is None:
        now_ms = time.time_ns() // 1_000_000
    if (type(now_ms) is not int or now_ms < trusted_context['reviewed_at_ms'] or
            now_ms > trusted_context['review_expires_at_ms'] or
            trusted_context['review_expires_at_ms'] - trusted_context['reviewed_at_ms'] > 30 * 24 * 60 * 60 * 1000):
        raise ValueError('reference_bundle_review_expired')
    return {**data, 'image': image, 'verified_geometry_sha256': expected_hash}


def _zone_mask(shape, zones, *, erode=0):
    import cv2
    import numpy as np
    height, width = shape[:2]
    background = np.full((height, width), 255, dtype=np.uint8)
    for zone in zones:
        x1, y1, x2, y2 = zone['bbox_normalized']
        left, top = max(0, int(math.floor(x1 * width))), max(0, int(math.floor(y1 * height)))
        right, bottom = min(width, int(math.ceil(x2 * width))), min(height, int(math.ceil(y2 * height)))
        background[top:bottom, left:right] = 0
    if erode > 0:
        kernel = np.ones((erode * 2 + 1, erode * 2 + 1), dtype=np.uint8)
        background = cv2.erode(background, kernel, iterations=1)
    return background


def compare_background(reference_image, current_image, source_zones):
    """Return stable/unstable/unknown against the reviewed background reference."""
    import cv2
    import numpy as np
    reasons = []
    try:
        if (not isinstance(reference_image, np.ndarray) or not isinstance(current_image, np.ndarray) or
                reference_image.ndim != 3 or current_image.shape != reference_image.shape or
                reference_image.shape[2] != 3):
            return {'status': 'unknown', 'reasons': ['reference_dimensions_mismatch']}
        height, width = reference_image.shape[:2]
        if not isinstance(source_zones, list) or not source_zones:
            return {'status': 'unknown', 'reasons': ['reviewed_source_zones_missing']}
        scale = 320 / width
        scaled_size = (320, max(1, round(height * scale)))
        ref = cv2.resize(reference_image, scaled_size, interpolation=cv2.INTER_AREA)
        cur = cv2.resize(current_image, scaled_size, interpolation=cv2.INTER_AREA)
        gray_ref, gray_cur = cv2.cvtColor(ref, cv2.COLOR_BGR2GRAY), cv2.cvtColor(cur, cv2.COLOR_BGR2GRAY)
        mask = _zone_mask(ref.shape, source_zones, erode=1)
        pixels_ref, pixels_cur = gray_ref[mask > 0], gray_cur[mask > 0]
        if pixels_ref.size < 1000 or pixels_cur.size < 1000:
            return {'status': 'unknown', 'reasons': ['insufficient_background_area']}
        near_boundary = max(float(np.mean((pixels_ref <= 5) | (pixels_ref >= 250))),
                            float(np.mean((pixels_cur <= 5) | (pixels_cur >= 250))))
        laplacian_ref = cv2.Laplacian(gray_ref, cv2.CV_64F)
        laplacian_cur = cv2.Laplacian(gray_cur, cv2.CV_64F)
        blur = min(float(laplacian_ref[mask > 0].var()), float(laplacian_cur[mask > 0].var()))
        if blur < 40:
            reasons.append('image_blur_below_threshold')
        if near_boundary > .25:
            reasons.append('image_exposure_outside_threshold')
        if reasons:
            return {'status': 'unknown', 'reasons': reasons, 'laplacian_variance': blur,
                    'near_black_or_white_fraction': near_boundary}
        orb = cv2.ORB_create(nfeatures=500, scaleFactor=1.2, nlevels=4)
        kp_ref, desc_ref = orb.detectAndCompute(gray_ref, mask)
        kp_cur, desc_cur = orb.detectAndCompute(gray_cur, mask)
        if desc_ref is None or desc_cur is None or len(kp_ref) < 30 or len(kp_cur) < 30:
            return {'status': 'unknown', 'reasons': ['insufficient_background_features'],
                    'laplacian_variance': blur, 'near_black_or_white_fraction': near_boundary}
        matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
        pairs = matcher.knnMatch(desc_ref, desc_cur, k=2)
        good = [first for first, second in pairs if first.distance < .75 * second.distance]
        if len(good) < 30:
            return {'status': 'unknown', 'reasons': ['insufficient_background_matches'],
                    'laplacian_variance': blur, 'near_black_or_white_fraction': near_boundary}
        src = np.float32([kp_ref[match.queryIdx].pt for match in good])
        dst = np.float32([kp_cur[match.trainIdx].pt for match in good])
        affine, inliers = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC,
                                                      ransacReprojThreshold=2.0, maxIters=1000)
        inlier_count = int(inliers.sum()) if inliers is not None else 0
        inlier_fraction = inlier_count / len(good)
        if affine is None or inlier_count < 30 or inlier_fraction < .6:
            return {'status': 'unknown', 'reasons': ['background_transform_unreliable'],
                    'inliers': inlier_count, 'inlier_fraction': inlier_fraction}
        a, b, tx = float(affine[0, 0]), float(affine[1, 0]), float(affine[0, 2])
        c, d, ty = float(affine[0, 1]), float(affine[1, 1]), float(affine[1, 2])
        rotation = abs(math.degrees(math.atan2(b, a)))
        scale_factor = math.sqrt(a * a + b * b)
        translation_x, translation_y = abs(tx) / 320, abs(ty) / scaled_size[1]
        if translation_x > .01 or translation_y > .01:
            reasons.append('background_translation_exceeded')
        if rotation > 1:
            reasons.append('background_rotation_exceeded')
        if not .98 <= scale_factor <= 1.02:
            reasons.append('background_scale_exceeded')
        return {'status': 'unstable' if reasons else 'stable', 'reasons': reasons,
                'inliers': inlier_count, 'inlier_fraction': inlier_fraction,
                'translation_fraction': [translation_x, translation_y],
                'rotation_degrees': rotation, 'scale': scale_factor,
                'laplacian_variance': blur, 'near_black_or_white_fraction': near_boundary}
    except (cv2.error, TypeError, ValueError, OverflowError):
        return {'status': 'unknown', 'reasons': ['background_stability_error']}


def _intersection_over_union(a, b):
    left, top = max(a[0], b[0]), max(a[1], b[1])
    right, bottom = min(a[2], b[2]), min(a[3], b[3])
    intersection = max(0, right - left) * max(0, bottom - top)
    area_a = max(0, a[2] - a[0]) * max(0, a[3] - a[1])
    area_b = max(0, b[2] - b[0]) * max(0, b[3] - b[1])
    return intersection / (area_a + area_b - intersection) if area_a + area_b > intersection else 0.0


def _inside_inset_zone(box, zone, width, height):
    x1, y1, x2, y2 = zone
    left, top, right, bottom = x1 * width, y1 * height, x2 * width, y2 * height
    inset_x, inset_y = (right - left) * .05, (bottom - top) * .05
    return box[0] >= left + inset_x and box[1] >= top + inset_y and \
        box[2] <= right - inset_x and box[3] <= bottom - inset_y


def evaluate_continuity(observations, trusted_context, *, source_zone_id, session_id,
                        incident_id, supporting_frame_ids, reference_bundle=None, now_ms=None):
    """Qualify an actual bounded observation chain for a future lease consumer.

    This function is currently shadow evidence only. It intentionally returns a
    reason list and cannot publish or lower operator priority itself.
    """
    reasons = []
    if not isinstance(observations, list) or not 3 <= len(observations) <= MAX_CHAIN_OBSERVATIONS:
        return {'eligible': False, 'reasons': ['observation_chain_incomplete']}
    if not isinstance(trusted_context, dict) or trusted_context.get('reviewed') is not True:
        return {'eligible': False, 'reasons': ['reviewed_context_missing']}
    if reference_bundle is None or reference_bundle.get('verified_geometry_sha256') is None:
        return {'eligible': False, 'reasons': ['reference_bundle_unavailable']}
    try:
        geometry = _geometry_payload({'camera_id': trusted_context['camera_id'],
            'context_revision': trusted_context['context_revision'], 'geometry_revision': trusted_context['geometry_revision'],
            'reviewed_reference_image_sha256': trusted_context['reviewed_reference_image_sha256'],
            'reference_dimensions': trusted_context['reference_dimensions'], 'crop_rect': trusted_context['crop_rect'],
            'source_zones': trusted_context['source_zones']})
        if _geometry_hash(geometry) != reference_bundle['verified_geometry_sha256']:
            reasons.append('reference_bundle_context_mismatch')
    except (KeyError, TypeError, ValueError):
        reasons.append('reviewed_geometry_invalid')
    if trusted_context.get('expected_flame_use') is not True:
        reasons.append('expected_flame_use_not_reviewed')
    if type(now_ms) is not int:
        now_ms = observations[-1].get('received_at_ms') if isinstance(observations[-1], dict) else None
    expiry = trusted_context.get('review_expires_at_ms')
    reviewed_at = trusted_context.get('reviewed_at_ms')
    if (type(expiry) is not int or type(reviewed_at) is not int or type(now_ms) is not int or
            now_ms < reviewed_at or now_ms > expiry or expiry - reviewed_at > 30 * 24 * 60 * 60 * 1000):
        reasons.append('reviewed_context_expired_or_invalid')
    zones = {zone['zone_id']: zone for zone in trusted_context.get('source_zones', [])
             if isinstance(zone, dict) and isinstance(zone.get('zone_id'), str)}
    zone = zones.get(source_zone_id)
    if zone is None:
        reasons.append('source_zone_unreviewed')
    if len(zones) != 1:
        reasons.append('multiple_stationary_sources_unsupported')
    if reasons:
        return {'eligible': False, 'reasons': list(dict.fromkeys(reasons))}

    previous_ts = None
    previous_receipt = None
    previous_box = None
    observed_ids = set()
    for index, row in enumerate(observations):
        required = {'camera_id', 'source_ts_ms', 'received_at_ms', 'session_id', 'incident_id', 'context_revision',
                    'geometry_revision', 'source_zone_id', 'observation_valid', 'frame_wh',
                    'fire_detections', 'smoke_present', 'visual_activity', 'camera_motion',
                    'image_quality', 'background_stability'}
        if not isinstance(row, dict) or not required.issubset(row):
            reasons.append(f'observation[{index}]:missing_fields')
            continue
        ts, receipt = row['source_ts_ms'], row['received_at_ms']
        if type(ts) is not int or ts < 0 or type(receipt) is not int or receipt < 0:
            reasons.append(f'observation[{index}]:invalid_time')
            continue
        frame_id = f'frame-{ts}'
        if frame_id in observed_ids:
            reasons.append('duplicate_observation_time')
        observed_ids.add(frame_id)
        if previous_ts is not None and (ts <= previous_ts or ts - previous_ts > MAX_SOURCE_GAP_MS):
            reasons.append('source_gap_exceeded')
        if previous_receipt is not None and receipt < previous_receipt:
            reasons.append('receipt_time_reversed')
        previous_ts, previous_receipt = ts, receipt
        if (row['camera_id'] != trusted_context['camera_id'] or
                row['session_id'] != session_id or row['incident_id'] != incident_id or
                row['source_zone_id'] != source_zone_id):
            reasons.append('session_or_incident_changed')
        if type(reviewed_at) is int and type(expiry) is int and not reviewed_at <= ts <= expiry:
            reasons.append('observation_outside_review_period')
        if (row['context_revision'] != trusted_context['context_revision'] or
                row['geometry_revision'] != trusted_context['geometry_revision']):
            reasons.append('reviewed_geometry_revision_changed')
        dimensions = row['frame_wh']
        if (not isinstance(dimensions, (list, tuple)) or len(dimensions) != 2 or
                any(type(n) is not int or n < 1 for n in dimensions) or
                list(dimensions) != trusted_context['reference_dimensions']):
            reasons.append('reference_dimensions_mismatch')
            continue
        if row['observation_valid'] is not True:
            reasons.append('observation_missing_or_invalid')
        if row['smoke_present'] is not False:
            reasons.append('smoke_present_or_unknown')
        if row['visual_activity'] not in ('steady', 'shrinking', 'unknown'):
            reasons.append('supported_growth_or_invalid_activity')
        if row['camera_motion'] is not False:
            reasons.append('camera_motion_not_verified')
        if row['image_quality'] != 'usable':
            reasons.append('image_quality_not_usable')
        if row['background_stability'] != 'stable':
            reasons.append('background_stability_not_verified')
        detections = row['fire_detections']
        if not isinstance(detections, list) or len(detections) != 1:
            reasons.append('unmatched_fire_region')
            previous_box = None
            continue
        box = detections[0]
        width, height = dimensions
        if (not isinstance(box, (list, tuple)) or len(box) != 4 or
                any(type(n) not in (int, float) or not math.isfinite(n) for n in box) or
                box[0] < 0 or box[1] < 0 or box[0] >= box[2] or box[1] >= box[3] or
                box[2] > width or box[3] > height):
            reasons.append('invalid_fire_region')
            previous_box = None
            continue
        box = [float(n) for n in box]
        if not _inside_inset_zone(box, zone['bbox_normalized'], width, height):
            reasons.append('fire_candidate_outside_reviewed_zone')
        if previous_box is not None:
            iou = _intersection_over_union(previous_box, box)
            px = (previous_box[0] + previous_box[2]) / 2
            py = (previous_box[1] + previous_box[3]) / 2
            cx = (box[0] + box[2]) / 2
            cy = (box[1] + box[3]) / 2
            diagonal_half = math.hypot(previous_box[2] - previous_box[0], previous_box[3] - previous_box[1]) / 2
            previous_area = (previous_box[2] - previous_box[0]) * (previous_box[3] - previous_box[1])
            area = (box[2] - box[0]) * (box[3] - box[1])
            ratio = area / previous_area if previous_area else math.inf
            if iou < .5 or math.hypot(cx - px, cy - py) > diagonal_half or not .5 <= ratio <= 2:
                reasons.append('flame_region_identity_unmatched')
        previous_box = box
    support_ids = supporting_frame_ids if isinstance(supporting_frame_ids, list) else []
    if len(support_ids) < 2 or len(set(support_ids)) != len(support_ids) or not set(support_ids).issubset(observed_ids):
        reasons.append('scene_support_frames_not_in_continuity_chain')
    return {'eligible': not reasons, 'reasons': list(dict.fromkeys(reasons)),
            'chain_start_ts_ms': observations[0].get('source_ts_ms'),
            'chain_end_ts_ms': observations[-1].get('source_ts_ms'),
            'observation_count': len(observations), 'source_zone_id': source_zone_id,
            'context_revision': trusted_context['context_revision'],
            'geometry_revision': trusted_context['geometry_revision']}
