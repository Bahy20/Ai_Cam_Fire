"""Fail-closed image-quality measurements for exact retained JPEG pixels.

Raw image statistics are diagnostic only. Until a human-reviewed quality
profile and an occlusion assessor are available, this module never labels an
otherwise plausible frame adequate.
"""
import math


def _unknown_result(reasons, metrics=None, visibility='unknown'):
    return {
        'visibility': visibility,
        'camera_motion': None,
        'quality': {'stability': 'unknown', 'blur_score': None, 'occlusion': 'unknown'},
        'reasons': list(dict.fromkeys(reasons)),
        'metrics': metrics or {},
    }


def _normalise_regions(scene_regions):
    if scene_regions is None:
        return [], False
    if not isinstance(scene_regions, (list, tuple)):
        return [], True
    result = []
    invalid = False
    for region in scene_regions:
        if isinstance(region, dict):
            region = region.get('bbox_xyxy')
        if not isinstance(region, (list, tuple)) or len(region) != 4:
            invalid = True
            continue
        try:
            box = tuple(float(value) for value in region)
        except (TypeError, ValueError, OverflowError):
            invalid = True
            continue
        if not all(math.isfinite(value) for value in box) or box[0] >= box[2] or box[1] >= box[3]:
            invalid = True
            continue
        result.append(box)
    return result, invalid


def assess_frame_quality(image, *, profile=None, scene_regions=None, reject_clipped_candidates=True):
    """Measure basic pixel statistics without guessing that a scene is usable.

    `profile` is intentionally not accepted as an authority yet: this checkout
    has no profile tied to independent human labels or validated occlusion
    capability. `metrics` are local diagnostics and must not be treated as
    quality labels. Set reject_clipped_candidates=False for whole-frame analysis:
    a clipped proposal limits object context but does not make all pixels unusable.
    """
    reasons = []
    if profile is None:
        reasons.append('quality_profile_missing')
    else:
        reasons.append('quality_profile_unvalidated')

    try:
        import cv2
        import numpy as np
        if (not isinstance(image, np.ndarray) or image.ndim not in (2, 3) or
                image.shape[0] < 16 or image.shape[1] < 16 or image.dtype != np.uint8 or
                (image.ndim == 3 and image.shape[2] not in (1, 3, 4))):
            reasons.append('image_quality_input_unavailable')
            return _unknown_result(reasons)
        if image.ndim == 2:
            gray = image
        elif image.shape[2] == 1:
            gray = image[:, :, 0]
        else:
            gray = cv2.cvtColor(image[:, :, :3], cv2.COLOR_BGR2GRAY)
        gray = np.ascontiguousarray(gray)
        mean_luminance = float(np.mean(gray))
        dark_fraction = float(np.mean(gray <= 2))
        bright_fraction = float(np.mean(gray >= 253))
        laplacian_variance = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    except Exception:
        reasons.append('image_quality_input_unavailable')
        return _unknown_result(reasons)

    metrics = {
        'frame_wh': [int(gray.shape[1]), int(gray.shape[0])],
        'mean_luminance': mean_luminance,
        'dark_pixel_fraction': dark_fraction,
        'bright_pixel_fraction': bright_fraction,
        'laplacian_variance': laplacian_variance,
    }

    unusable = False
    if dark_fraction >= 0.995 or bright_fraction >= 0.995:
        reasons.append('uniform_extreme_luminance')
        unusable = True
    # A few lit LEDs must not make an otherwise unreadable noisy dark room a
    # usable negative observation. This rejects low exposure; it never grants
    # adequate visibility or establishes absence of fire in the bright pixels.
    if mean_luminance < 12 and float(np.mean(gray <= 20)) >= .99:
        reasons.append('insufficient_scene_illumination')
        unusable = True

    regions, invalid_regions = _normalise_regions(scene_regions)
    if invalid_regions:
        reasons.append('candidate_region_geometry_unavailable')
    height, width = gray.shape
    if any(x1 <= 0 or y1 <= 0 or x2 >= width or y2 >= height for x1, y1, x2, y2 in regions):
        reasons.append('candidate_region_touches_frame_edge')
        unusable = unusable or reject_clipped_candidates

    if not unusable:
        reasons.extend(['blur_threshold_unvalidated', 'occlusion_unassessed'])
    return _unknown_result(reasons, metrics, 'degraded' if unusable else 'unknown')
