"""Optional, hash-pinned local detector adapter for handheld lighter scenes.

This adapter is inert without a separately trained/evaluated model. It never
downloads weights, calls a cloud model, or labels a scene safe. A candidate is
only a local two-frame observation for server-side policy evaluation.
"""
import hashlib
import math
from pathlib import Path
import re
import uuid


WIRE_FIELDS = ('version', 'camera_id', 'session_id', 'generation', 'candidate_id', 'model_sha256',
    'source_ts_ms', 'frame_ids', 'tool_type', 'flame_relation', 'image_quality', 'fire_region_count',
    'smoke_evidence', 'secondary_burning_evidence')
REQUIRED_CLASSES = frozenset({'fire', 'smoke', 'lighter_flame', 'secondary_burning'})
MAX_TRACK_GAP_MS = 2_000
MIN_CONFIDENCE = .60
# Provisional association veto, not an evaluated operating threshold. Both
# classes must describe the same flame in each frame before tracking it.
MIN_RELATION_IOU = .50


def _sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _time_from_frame_id(value):
    if not isinstance(value, str) or not re.fullmatch(r'frame-\d+(?:\.\d+)?', value):
        return None
    try:
        result = float(value[6:])
    except ValueError:
        return None
    return result if math.isfinite(result) and result >= 0 else None


def validate_candidate_wire(value, *, camera_id, session_id, generation, ts_ms):
    """Validate bounded metadata that may travel through the authenticated batch."""
    if not isinstance(value, dict) or set(value) != set(WIRE_FIELDS):
        return False
    if (type(value['version']) is not int or value['version'] != 1 or value['camera_id'] != camera_id or
            value['session_id'] != session_id or type(value['generation']) is not int or value['generation'] != generation or
            not isinstance(value['candidate_id'], str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}', value['candidate_id']) or
            value['candidate_id'] in ('__proto__', 'constructor', 'prototype') or
            not isinstance(value['model_sha256'], str) or not re.fullmatch(r'[a-f0-9]{64}', value['model_sha256']) or
            type(value['source_ts_ms']) not in (int, float) or not math.isfinite(value['source_ts_ms']) or
            value['source_ts_ms'] != ts_ms or not isinstance(value['frame_ids'], list) or len(value['frame_ids']) != 2 or
            value['tool_type'] not in ('lighter', 'other', 'uncertain') or
            value['flame_relation'] not in ('at_tool_tip', 'separate', 'uncertain') or
            value['image_quality'] not in ('adequate', 'unknown', 'degraded') or
            type(value['fire_region_count']) is not int or not 0 <= value['fire_region_count'] <= 64 or
            value['smoke_evidence'] not in ('not_detected', 'detected', 'unknown') or
            value['secondary_burning_evidence'] not in ('not_detected', 'detected', 'unknown')):
        return False
    times = [_time_from_frame_id(frame_id) for frame_id in value['frame_ids']]
    return (all(time is not None for time in times) and times[0] < times[1] and
            times[1] - times[0] <= MAX_TRACK_GAP_MS and times[1] == value['source_ts_ms'])


def _scalar(value):
    return value.item() if hasattr(value, 'item') else value


def _coordinates(value):
    if hasattr(value, 'tolist'):
        value = value.tolist()
    if isinstance(value, (tuple, list)) and len(value) == 1 and isinstance(value[0], (tuple, list)):
        value = value[0]
    try:
        result = tuple(float(item) for item in value)
    except (TypeError, ValueError):
        return None
    return result if len(result) == 4 and all(math.isfinite(item) for item in result) else None


def _iou(left, right):
    x1, y1 = max(left[0], right[0]), max(left[1], right[1])
    x2, y2 = min(left[2], right[2]), min(left[3], right[3])
    intersection = max(0., x2 - x1) * max(0., y2 - y1)
    left_area = max(0., left[2] - left[0]) * max(0., left[3] - left[1])
    right_area = max(0., right[2] - right[0]) * max(0., right[3] - right[1])
    union = left_area + right_area - intersection
    return intersection / union if union > 0 else 0.


class HandheldSceneTracker:
    """Track a model's explicitly trained lighter-flame class across two frames."""

    def __init__(self, model_path=None, *, expected_sha256=None, model_factory=None,
                 device='cpu', imgsz=640, max_det=128):
        self.model_path = None
        self.model_factory = model_factory
        self.model = None
        self.device = device
        self.imgsz = imgsz
        self.max_det = max_det
        self._track = None
        self._session = None
        if model_path is None and expected_sha256 is None:
            self.model_sha256 = None
            self.enabled = False
            return
        if (model_path is None or expected_sha256 is None or not isinstance(expected_sha256, str) or
                not re.fullmatch(r'[a-f0-9]{64}', expected_sha256) or device != 'cpu' or
                type(imgsz) is not int or not 32 <= imgsz <= 2048 or type(max_det) is not int or not 1 <= max_det <= 256):
            raise ValueError('invalid_handheld_model_configuration')
        path = Path(model_path)
        if path.is_symlink() or not path.is_file():
            raise ValueError('handheld_model_not_found')
        actual = _sha256(path)
        if actual != expected_sha256:
            raise ValueError('handheld_model_hash_mismatch')
        self.model_path = path
        self.model_sha256 = actual
        self.enabled = True

    def _load(self):
        if self.model is not None:
            return self.model
        if self.model_factory is None:
            try:
                from ultralytics import YOLO
            except ImportError:
                raise ValueError('handheld_model_runtime_unavailable') from None
            self.model_factory = YOLO
        try:
            self.model = self.model_factory(str(self.model_path))
        except Exception:
            raise ValueError('handheld_model_load_failed') from None
        return self.model

    def _predict(self, image):
        try:
            result = self._load().predict(image, conf=.05, max_det=self.max_det,
                device=self.device, imgsz=self.imgsz, verbose=False)[0]
        except ValueError:
            raise
        except Exception:
            self._track = None
            return None
        names_raw = getattr(result, 'names', getattr(self.model, 'names', None))
        if isinstance(names_raw, dict):
            names = {int(key): value for key, value in names_raw.items()}
        elif isinstance(names_raw, (list, tuple)):
            names = dict(enumerate(names_raw))
        else:
            raise ValueError('handheld_model_classes_missing')
        if not REQUIRED_CLASSES.issubset(set(names.values())):
            raise ValueError('handheld_model_classes_missing')
        detections = []
        for box in getattr(result, 'boxes', []):
            try:
                class_id = int(_scalar(box.cls[0]))
                confidence = float(_scalar(box.conf[0]))
                coordinates = _coordinates(box.xyxy)
            except (AttributeError, IndexError, TypeError, ValueError):
                self._track = None
                return None
            label = names.get(class_id)
            if label not in REQUIRED_CLASSES or not math.isfinite(confidence) or not 0 <= confidence <= 1:
                continue
            if coordinates is None or coordinates[0] >= coordinates[2] or coordinates[1] >= coordinates[3]:
                continue
            if confidence >= MIN_CONFIDENCE:
                detections.append((label, confidence, coordinates))
        return detections

    def observe(self, image, camera_id, session_id, ts_ms, generation, *, image_quality='unknown'):
        if not self.enabled:
            return None
        if (not isinstance(camera_id, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}', camera_id) or
                not isinstance(session_id, str) or not _valid_uuid(session_id) or type(generation) is not int or generation < 1 or
                type(ts_ms) not in (int, float) or not math.isfinite(ts_ms) or ts_ms < 0 or
                image_quality not in ('adequate', 'unknown', 'degraded')):
            self._track = None
            return None
        session = (camera_id, session_id, generation)
        if self._session != session:
            self._track = None
            self._session = session
        detections = self._predict(image)
        if detections is None:
            return None
        fires = [row for row in detections if row[0] == 'fire']
        smokes = [row for row in detections if row[0] == 'smoke']
        secondary = [row for row in detections if row[0] == 'secondary_burning']
        tools = [row for row in detections if row[0] == 'lighter_flame']
        if image_quality != 'adequate' or len(fires) != 1 or len(smokes) or len(secondary) or len(tools) != 1:
            self._track = None
            return None
        fire, tool = fires[0], tools[0]
        if _iou(fire[2], tool[2]) < MIN_RELATION_IOU:
            self._track = None
            return None
        frame_id = f'frame-{ts_ms}'
        current = {'ts_ms':ts_ms,'frame_id':frame_id,'fire_box':fire[2], 'tool_box':tool[2]}
        previous = self._track
        matched = (previous is not None and ts_ms > previous['ts_ms'] and
            ts_ms - previous['ts_ms'] <= MAX_TRACK_GAP_MS and
            _iou(previous['fire_box'], fire[2]) >= .2 and _iou(previous['tool_box'], tool[2]) >= .2)
        if not matched:
            candidate_seed = f'{camera_id}\0{session_id}\0{generation}\0{ts_ms}\0{self.model_sha256}'
            current['candidate_id'] = hashlib.sha256(candidate_seed.encode()).hexdigest()[:24]
            self._track = current
            return None
        candidate_id = previous['candidate_id']
        self._track = {**current, 'candidate_id':candidate_id}
        return {'version':1,'camera_id':camera_id,'session_id':session_id,'generation':generation,
            'candidate_id':candidate_id,'model_sha256':self.model_sha256,'source_ts_ms':ts_ms,
            'frame_ids':[previous['frame_id'],frame_id],'tool_type':'lighter','flame_relation':'at_tool_tip',
            'image_quality':image_quality,'fire_region_count':len(fires),'smoke_evidence':'not_detected',
            'secondary_burning_evidence':'not_detected'}


def _valid_uuid(value):
    try:
        return str(uuid.UUID(value)) == value.lower()
    except (ValueError, TypeError, AttributeError):
        return False
