"""On-site YOLO observations. Importing never opens a camera/model."""
import base64
import time
import math
import hashlib
import json
import os
import tempfile
import uuid
from decimal import Decimal
from contextlib import contextmanager
from pathlib import Path


def parse_args(argv=None, *, environ=None):
    import argparse
    import os
    import re
    from urllib.parse import urlsplit
    if __package__:
        from .heartbeat import MAX_HEARTBEAT_INTERVAL_SECONDS
    else:
        from heartbeat import MAX_HEARTBEAT_INTERVAL_SECONDS

    env = os.environ if environ is None else environ
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group()
    source.add_argument('--rtsp', default=env.get('EDGE_RTSP_URL'))
    source.add_argument('--video', type=Path)
    source.add_argument('--camera-index', type=int,
                        help='local webcam device index, commonly 0 on Windows/Linux')
    parser.add_argument('--camera', required=True)
    parser.add_argument('--worker')
    parser.add_argument('--allow-http', action='store_true', help='insecure development only')
    parser.add_argument('--model', type=Path, default=Path(__file__).resolve().parents[1] / 'detector/fire_seg.pt')
    parser.add_argument('--handheld-model', type=Path,
                        help='optional local lighter-scene model; requires a pinned SHA-256')
    parser.add_argument('--handheld-model-sha256',
                        help='expected lowercase SHA-256 for --handheld-model')
    parser.add_argument('--device', default='cpu')
    parser.add_argument('--imgsz', type=int, default=640)
    parser.add_argument('--max-det', type=int, default=256)
    parser.add_argument('--fps', type=float, default=3.)
    parser.add_argument('--width', type=int, default=640)
    parser.add_argument('--jpeg-quality', type=int, default=70)
    parser.add_argument('--max-frames', type=int)
    parser.add_argument('--start-ts-ms', type=int)
    parser.add_argument('--timeout', type=float, default=10.)
    parser.add_argument('--heartbeat-interval', type=float, default=15.,
                        help='live network health cadence in seconds (.05-30; experimental)')
    parser.add_argument('--heartbeat-stall-seconds', type=float, default=30.,
                        help='live pipeline progress timeout (.05-300; experimental)')
    parser.add_argument('--attempts', type=int, default=3)
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--realtime', action='store_true')
    parser.add_argument('--report', type=Path)
    parser.add_argument('--output', type=Path, help='stream per-sample metadata as JSONL (no JPEG)')
    parser.add_argument('--evidence-dir', type=Path,
                        default=Path(env.get('EDGE_EVIDENCE_DIR', 'edge-data/evidence')),
                        help='Pi-local incident JPEG/manifest root (also active in dry runs)')
    parser.add_argument('--evidence-max-bytes', type=int, default=256 * 1024 * 1024,
                        help='positive local evidence budget; never prunes retained evidence')
    parser.add_argument('--spool-dir', type=Path, default=None,
                        help='persistent bounded V2 metadata queue (defaults beside evidence)')
    args = parser.parse_args(argv)
    for name, maximum in (('heartbeat_interval', MAX_HEARTBEAT_INTERVAL_SECONDS), ('heartbeat_stall_seconds', 300.)):
        value = getattr(args, name)
        if not math.isfinite(value) or not .05 <= value <= maximum:
            parser.error(f'{name} must be finite in [.05, {maximum}] seconds')
    if args.video is not None or args.camera_index is not None:
        args.rtsp = None  # explicit local source wins over an environment RTSP source
    if not args.rtsp and args.video is None and args.camera_index is None:
        parser.error('provide --video, --camera-index, --rtsp, or EDGE_RTSP_URL')
    if args.camera_index is not None and args.camera_index < 0:
        parser.error('camera-index must be a non-negative integer')
    for name in ('fps', 'timeout', 'width', 'imgsz', 'max_det', 'jpeg_quality', 'attempts',
                 'evidence_max_bytes'):
        value = getattr(args, name)
        if not math.isfinite(value) or value <= 0:
            parser.error(f'{name} must be finite and positive')
    if args.max_det > 256 or args.jpeg_quality > 100 or args.attempts > 10:
        parser.error('max-det <=256, jpeg-quality <=100, attempts <=10 required')
    if (args.handheld_model is None) != (args.handheld_model_sha256 is None):
        parser.error('--handheld-model and --handheld-model-sha256 must be provided together')
    if args.handheld_model_sha256 is not None:
        if not re.fullmatch(r'[a-f0-9]{64}', args.handheld_model_sha256):
            parser.error('--handheld-model-sha256 must be 64 lowercase hexadecimal characters')
        if args.device != 'cpu':
            parser.error('the optional handheld model currently supports CPU inference only')
    if args.max_frames is not None and args.max_frames <= 0:
        parser.error('max-frames must be positive')
    if args.start_ts_ms is not None and args.start_ts_ms <= 0:
        parser.error('start-ts-ms must be positive')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', args.camera):
        parser.error('camera must contain 1-128 letters, digits, hyphens or underscores')
    if not args.device.strip():
        parser.error('device must not be empty')
    if args.worker:
        try:
            url = urlsplit(args.worker)
            valid = (url.scheme in ('https', 'http') and url.hostname and url.port != 0
                     and not url.username and not url.password and not url.query and not url.fragment
                     and (url.scheme == 'https' or args.allow_http))
        except ValueError:
            valid = False
        if not valid:
            parser.error('worker requires HTTPS without credentials/query/fragment; --allow-http is development only')
    args.api_key = env.get('INGEST_API_KEY', '')
    if args.spool_dir is None:
        args.spool_dir = (Path(env['EDGE_SPOOL_DIR']) if env.get('EDGE_SPOOL_DIR') else
                          args.evidence_dir.parent / '.fireguard-spool')
    if not args.dry_run and (not args.worker or not args.api_key):
        parser.error('network mode requires --worker and INGEST_API_KEY in the environment')
    return args


class UploadError(RuntimeError):
    """Sanitized cloud communication failure (never include request URLs/keys)."""


class ObservationTransport:
    def __init__(self, worker, api_key, *, session=None, attempts=3, timeout=10.,
                 sleep=time.sleep):
        if session is None:
            import requests
            session = requests.Session()
            session.trust_env = False  # no implicit proxies/.netrc credentials
        self.worker, self.api_key, self.session = worker.rstrip('/'), api_key, session
        self.attempts, self.timeout, self.sleep = attempts, timeout, sleep

    def send(self, payload):
        from urllib.parse import quote
        url = self.worker + '/observation/camera/' + quote(payload['camera_id'], safe='')
        error = 'cloud_network_error'
        for attempt in range(self.attempts):
            retry = True
            try:
                response = self.session.post(url, json=payload, headers={'x-api-key': self.api_key},
                                             timeout=self.timeout, allow_redirects=False)
                status = response.status_code
                if 200 <= status < 300:
                    body = response.json()
                    if (not isinstance(body, dict) or body.get('camera_id') != payload['camera_id']
                            or not isinstance(body.get('alert'), str)
                            or not isinstance(body.get('hits'), (int, float))
                            or not isinstance(body.get('events'), list)):
                        raise ValueError('invalid_cloud_response')
                    return body
                error = f'cloud_http_{status}'
                retry = status == 429 or status >= 500
            except Exception:
                # Transport and JSON errors can include credential-bearing URLs.
                error = 'cloud_network_or_response_error'
            if not retry or attempt + 1 == self.attempts:
                break
            self.sleep(min(2., .25 * 2 ** attempt))
        raise UploadError(error) from None


def _canonical_json(value):
    """Canonical JSON with ECMAScript-compatible number spelling for V2 hashes."""
    if value is None:
        return 'null'
    if value is True:
        return 'true'
    if value is False:
        return 'false'
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError('non_finite_batch_number')
        if value == 0:
            return '0'
        absolute = abs(value)
        rendered = repr(value).lower()
        if 1e-6 <= absolute < 1e21:
            fixed = format(Decimal(rendered), 'f')
            if '.' in fixed:
                fixed = fixed.rstrip('0').rstrip('.')
            return fixed
        if 'e' not in rendered:
            rendered = format(value, '.15e')
        mantissa, exponent = rendered.split('e', 1)
        mantissa = mantissa.rstrip('0').rstrip('.') if '.' in mantissa else mantissa
        exponent_value = int(exponent)
        return f'{mantissa}e{"+" if exponent_value >= 0 else ""}{exponent_value}'
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    if isinstance(value, list):
        return '[' + ','.join(_canonical_json(item) for item in value) + ']'
    if isinstance(value, dict):
        return '{' + ','.join(_canonical_json(key) + ':' + _canonical_json(value[key])
                              for key in sorted(value)) + '}'
    raise ValueError('invalid_batch_value')


def observation_batch_hash(body):
    if not isinstance(body, dict):
        raise ValueError('invalid_batch_value')
    return hashlib.sha256(_canonical_json({key:value for key,value in body.items()
                                           if key != 'payload_hash'}).encode('utf-8')).hexdigest()


def _read_session_state(path, camera_id):
    path = Path(path)
    if not path.exists():
        return {'version':1,'camera_id':camera_id,'generation':0,
                'pending_session_id':None,'pending_expected_generation':None}
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 2048:
        raise UploadError('camera_session_state_invalid')
    try:
        state = json.loads(path.read_text(encoding='utf-8'))
        if (not isinstance(state,dict) or set(state) != {'version','camera_id','generation',
                'pending_session_id','pending_expected_generation'} or state['version'] != 1 or
                state['camera_id'] != camera_id or not isinstance(state['generation'],int) or
                isinstance(state['generation'],bool) or state['generation'] < 0):
            raise ValueError('invalid_state')
        pending, expected = state['pending_session_id'], state['pending_expected_generation']
        if (pending is None) != (expected is None):
            raise ValueError('invalid_pending')
        if pending is not None and (not isinstance(pending,str) or not isinstance(expected,int) or
                isinstance(expected,bool) or expected != state['generation']):
            raise ValueError('invalid_pending')
        return state
    except Exception:
        raise UploadError('camera_session_state_invalid') from None


def _write_session_state(path, state):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        raise UploadError('camera_session_state_invalid')
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent,
                                         prefix='.session-', suffix='.tmp', delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(json.dumps(state,separators=(',',':'),sort_keys=True))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary,path)
    except Exception:
        if temporary is not None:
            try: temporary.unlink(missing_ok=True)
            except Exception: pass
        raise UploadError('camera_session_state_write_failed') from None


class V2ObservationTransport:
    """Versioned, hashed metadata batches. Exact request bodies are retried unchanged."""
    def __init__(self, worker, api_key, *, session=None, attempts=3, timeout=10., sleep=time.sleep):
        if session is None:
            import requests
            session = requests.Session()
            session.trust_env = False
        self.worker,self.api_key,self.session=worker.rstrip('/'),api_key,session
        self.attempts,self.timeout,self.sleep=attempts,timeout,sleep
        self.session_id=None
        self.generation=None
        self.camera_id=None

    def _post(self,path,payload):
        error='cloud_network_error'
        for attempt in range(self.attempts):
            retry=True
            try:
                response=self.session.post(self.worker+path,json=payload,headers={'x-api-key':self.api_key},
                    timeout=self.timeout,allow_redirects=False)
                if 200 <= response.status_code < 300:
                    body=response.json()
                    if not isinstance(body,dict): raise ValueError('invalid_response')
                    return body
                error=f'cloud_http_{response.status_code}'
                retry=response.status_code==429 or response.status_code>=500
            except Exception:
                error='cloud_network_or_response_error'
            if not retry or attempt+1==self.attempts: break
            self.sleep(min(2.,.25*2**attempt))
        raise UploadError(error) from None

    def prepare_session(self,camera_id,state_path):
        state=_read_session_state(state_path,camera_id)
        session_id=state['pending_session_id'] or str(uuid.uuid4())
        expected=state['pending_expected_generation']
        if expected is None:
            expected=state['generation']
            state={**state,'pending_session_id':session_id,'pending_expected_generation':expected}
            _write_session_state(state_path,state)
        self.session_id,self.generation,self.camera_id=session_id,expected+1,camera_id
        return {'session_id':session_id,'generation':expected+1}

    def activate(self,camera_id,state_path):
        identity=self.prepare_session(camera_id,state_path)
        session_id,generation=identity['session_id'],identity['generation']
        state=_read_session_state(state_path,camera_id)
        expected=state['pending_expected_generation']
        response=self._post('/v2/sessions/camera/'+camera_id,{
            'protocol_version':2,'session_id':session_id,'expected_generation':expected})
        if (response.get('protocol_version')!=2 or response.get('session_id')!=session_id or
                response.get('generation')!=generation):
            raise UploadError('invalid_session_activation_response')
        _write_session_state(state_path,{'version':1,'camera_id':camera_id,'generation':generation,
            'pending_session_id':None,'pending_expected_generation':None})
        self.session_id,self.generation,self.camera_id=session_id,generation,camera_id
        return {'session_id':session_id,'generation':generation}

    def send_batch(self,body):
        if self.session_id is None or body.get('session_id')!=self.session_id or body.get('generation')!=self.generation:
            raise UploadError('camera_session_not_active')
        request={**body,'payload_hash':'0'*64}
        request['payload_hash']=observation_batch_hash(request)
        response=self._post('/v2/observations/camera/'+self.camera_id,request)
        final=response.get('final_state')
        if (response.get('protocol_version')!=2 or response.get('session_id')!=self.session_id or
                response.get('generation')!=self.generation or response.get('batch_sequence')!=body.get('batch_sequence') or
                response.get('payload_hash')!=request['payload_hash'] or
                response.get('accepted_through')!=body['samples'][-1]['attempt_sequence'] or
                not isinstance(final,dict) or final.get('alert') not in ('idle','watch','confirmed') or
                not isinstance(response.get('dispositions'),list) or
                len(response['dispositions'])!=len(body['samples']) or
                not isinstance(response.get('event_watermark'),int)):
            raise UploadError('invalid_batch_acknowledgement')
        return response


class V2EvidenceTransport:
    """Separate HTTP session and timeout for bounded image packs."""
    def __init__(self,worker,api_key,camera_id,*,session=None,attempts=3,timeout=10.,sleep=time.sleep):
        if session is None:
            import requests
            session=requests.Session()
            session.trust_env=False
        self.worker,self.api_key,self.camera_id,self.session=worker.rstrip('/'),api_key,camera_id,session
        self.attempts,self.timeout,self.sleep=attempts,timeout,sleep

    def send_pack(self,body):
        error='cloud_network_error'
        for attempt in range(self.attempts):
            retry=True
            try:
                response=self.session.post(self.worker+'/v2/evidence/camera/'+self.camera_id,
                    json=body,headers={'x-api-key':self.api_key},timeout=self.timeout,allow_redirects=False)
                if 200<=response.status_code<300:
                    result=response.json()
                    if result.get('protocol_version')!=2 or result.get('request_id')!=body.get('request_id') or result.get('accepted') is not True:
                        raise ValueError('invalid_evidence_ack')
                    return result
                error=f'cloud_http_{response.status_code}'
                retry=response.status_code==429 or response.status_code>=500
            except Exception:
                error='cloud_network_or_response_error'
            if not retry or attempt+1==self.attempts: break
            self.sleep(min(2.,.25*2**attempt))
        raise UploadError(error) from None



class YoloDetector:
    """Lazy local model adapter; no network model discovery/downloads."""
    def __init__(self, model_path, *, device='cpu', imgsz=640, max_det=256,
                 model_factory=None):
        path = Path(model_path)
        if not path.is_file():
            raise ValueError('local_model_not_found')
        if not 1 <= max_det <= 256:
            raise ValueError('max_det_out_of_range')
        self.path, self.device, self.imgsz, self.max_det = path, device, imgsz, max_det
        self.model_factory, self.model = model_factory, None

    def __call__(self, image):
        if self.model is None:
            if self.model_factory is None:
                from ultralytics import YOLO
                self.model_factory = YOLO
            self.model = self.model_factory(str(self.path))
        results = self.model.predict(image, conf=.05, max_det=self.max_det,
                                     device=self.device, imgsz=self.imgsz, verbose=False)
        result = results[0]
        names = result.names
        labels = names.values() if isinstance(names, dict) else names
        if not {'fire', 'smoke'}.issubset(set(labels)):
            raise ValueError('model_requires_fire_and_smoke_classes')
        height, width = image.shape[:2]
        detections = []
        for box in result.boxes:
            label = names[int(box.cls.item())]
            confidence = float(box.conf.item())
            coordinates = [float(v) for v in box.xyxy[0].tolist()]
            if (not math.isfinite(confidence) or not 0 <= confidence <= 1
                    or len(coordinates) != 4 or not all(math.isfinite(v) for v in coordinates)):
                raise ValueError('invalid_model_prediction')
            if label not in ('fire', 'smoke') or confidence < .05:
                continue
            x1, y1, x2, y2 = coordinates
            x1, x2 = max(0., min(width, x1)), max(0., min(width, x2))
            y1, y2 = max(0., min(height, y1)), max(0., min(height, y2))
            if x2 <= x1 or y2 <= y1:
                continue
            detections.append({'cls': label, 'conf': confidence,
                               'bbox_xyxy': [x1, y1, x2, y2]})
            if len(detections) >= self.max_det:
                break
        return detections


def build_observation(frame, detector, camera_id, ts_ms, *, width=640,
                      jpeg_quality=70, clock=time.perf_counter, reject_clipped_candidates=True):
    """Infer on precisely the JPEG pixels retained as cloud evidence."""
    import cv2
    import numpy as np

    if __package__:
        from .image_quality import assess_frame_quality
    else:
        from image_quality import assess_frame_quality

    started = clock()
    height, original_width = frame.shape[:2]
    if original_width > width:
        frame = cv2.resize(frame, (width, max(1, round(height * width / original_width))))
    ok, encoded = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, jpeg_quality])
    if not ok:
        raise RuntimeError('jpeg_encode_failed')
    jpeg = encoded.tobytes()
    decoded = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
    if decoded is None:
        raise RuntimeError('jpeg_decode_failed')
    inference_started = clock()
    detections = detector(decoded)
    inference_finished = clock()
    quality = assess_frame_quality(decoded, profile=None,
        scene_regions=[item.get('bbox_xyxy') for item in detections if isinstance(item, dict)],
        reject_clipped_candidates=reject_clipped_candidates)
    finished = clock()
    return {
        'camera_id': camera_id, 'ts_ms': ts_ms,
        'frame_wh': [int(decoded.shape[1]), int(decoded.shape[0])],
        'detections': detections, 'jpeg_b64': base64.b64encode(jpeg).decode('ascii'),
        'visibility': quality['visibility'], 'camera_motion': quality['camera_motion'],
    }, {'inference_ms': (inference_finished - inference_started) * 1000,
        'quality_ms': (finished - inference_finished) * 1000,
        'encode_ms': (inference_started - started) * 1000,
        'quality': quality['quality'], 'quality_reasons': quality['reasons'],
        'quality_metrics': quality['metrics']}


@contextmanager
def quiet_capture():
    """Suppress native decoder stderr that can echo RTSP credentials.

    FD redirection is process-wide. Keep only capture operations inside this
    context; the optional heartbeat thread must never print backend exceptions.
    """
    import contextlib
    import os
    with open(os.devnull, 'w') as sink:
        saved = os.dup(2)
        try:
            os.dup2(sink.fileno(), 2)
            with contextlib.redirect_stderr(sink):
                yield
        finally:
            os.dup2(saved, 2)
            os.close(saved)


def open_capture(source, *, timeout=10., cv=None):
    """FFmpeg capture with bounded open/read operations (fail, never unbounded fallback)."""
    if cv is None:
        import cv2 as cv
    if isinstance(source, int) and not isinstance(source, bool):
        # USB camera capture uses the OS device backend, not FFmpeg timeout
        # properties (which OpenCV does not support for every camera backend).
        if os.name == 'nt':
            backend = getattr(cv, 'CAP_DSHOW', getattr(cv, 'CAP_ANY', 0))
        else:
            backend = getattr(cv, 'CAP_V4L2', getattr(cv, 'CAP_ANY', 0))
        return cv.VideoCapture(source, backend)
    milliseconds = max(1, min(2147483647, round(timeout * 1000)))
    return cv.VideoCapture(source, cv.CAP_FFMPEG,
        [cv.CAP_PROP_OPEN_TIMEOUT_MSEC, milliseconds,
         cv.CAP_PROP_READ_TIMEOUT_MSEC, milliseconds])


def run(args, *, detector=None, capture_factory=None, transport=None, heartbeat_factory=None, handheld_tracker=None,
        clock=time.perf_counter, wall_clock=time.time, sleep=time.sleep, should_stop=None):
    """Run one capture lifetime. EOF is normal for files, a failure for live input.

    Failed inference is a missing observation, NEVER an uploaded empty detection.
    Reports retain the last 256 records; optional JSONL streams every sample.
    """
    import cv2
    import json
    import sys
    from fractions import Fraction
    if __package__:
        from .evidence import EvidenceRecorder, EvidenceError
    else:
        from evidence import EvidenceRecorder, EvidenceError

    started = clock()
    epoch_ms = args.start_ts_ms if args.start_ts_ms is not None else int(wall_clock() * 1000)
    is_video = args.video is not None
    is_camera = args.camera_index is not None
    capture_source = str(args.video) if is_video else args.camera_index if is_camera else args.rtsp
    report = {
        'source': {'kind': 'video' if is_video else 'camera' if is_camera else 'rtsp',
                   'input': str(args.video) if is_video else args.camera_index if is_camera else '<redacted RTSP>',
                   'fps': None, 'timestamp_fallbacks': 0},
        'camera_id': args.camera, 'model': str(args.model), 'device': args.device,
        'imgsz': args.imgsz, 'sample_fps': args.fps, 'max_det': args.max_det,
        'dry_run': args.dry_run, 'start_ts_ms': epoch_ms,
        'frames_read': 0, 'frames_sampled': 0, 'inferred': 0, 'uploaded': 0,
        'inference_errors': 0, 'upload_errors': 0, 'errors': [], 'records': [],
        'handheld_scene': {'enabled': False, 'candidates': 0, 'errors': 0},
        'spooled': 0, 'spool_overflows': 0, 'degraded': False,
        'capture_discontinuities': 0, 'capture_replacements': 0,
        'evidence_packs_uploaded': 0, 'evidence_upload_errors': 0,
        'evidence_lane_overflows': 0, 'evidence_pending_bytes': 0,
        'v2': {'enabled': False, 'batches_acknowledged': 0, 'pending_samples': 0,
               'pending_batches': 0, 'transport_errors': 0},
        'records_limit': 256, 'records_dropped': 0,
        'evidence_errors': 0,
        'evidence': {'enabled': True, 'saved_frames': 0, 'incidents': [],
                     'errors': [], 'max_bytes': args.evidence_max_bytes},
    }
    recorder = None
    spool = None
    uploader = None
    evidence_uploader = None
    evidence_transport = None
    v2_mode = False
    identity = None
    records_by_attempt = {}

    heartbeat = None
    storage_failure_saved_frames = None
    active_stage = 'capture'

    def health(stage, *, failed=False):
        if heartbeat is not None:
            try:
                (heartbeat.fail if failed else heartbeat.progress)(stage)
            except Exception:
                # Optional telemetry must not prevent local evidence writes.
                pass

    def evidence_failure(exc, record=None):
        nonlocal storage_failure_saved_frames
        storage_failure_saved_frames = recorder.saved_frames if recorder is not None else 0
        health('storage', failed=True)
        # Only recorder-owned error codes are printable, never backend paths/URLs.
        allowed = {'evidence_budget_exceeded', 'evidence_write_failed',
                   'evidence_timestamp_conflict', 'evidence_invalid_camera',
                   'evidence_invalid_observation', 'evidence_unsafe_path', 'evidence_scan_failed'}
        error = str(exc) if isinstance(exc, EvidenceError) and str(exc) in allowed else 'evidence_storage_failed'
        report['evidence_errors'] += 1
        report['evidence']['errors'].append(error)
        if record is not None:
            record['evidence_error'] = error
            record['evidence'] = None
        print('[edge] ERROR: ' + error + '; cloud upload will still be attempted', file=sys.stderr)
    cap, output, live_capture = None, None, None
    inference_total = inference_max = upload_total = 0.
    next_deadline = Fraction(0)
    rate = Fraction(str(args.fps))
    previous_source_ms, previous_event_ms = -1., epoch_ms - 1
    first_source_ms = None
    stopped = False
    wall_started_ms = wall_clock() * 1000.
    last_live_sample_offset_ms = None
    last_live_capture_seen_ms = wall_started_ms
    live_capture_sequence = 0

    def queue_v2_sample(sample, record):
        try:
            sequence = spool.enqueue(sample)
        except Exception as exc:
            if __package__:
                from .observation_spool import ObservationSpoolFull
            else:
                from observation_spool import ObservationSpoolFull
            if isinstance(exc, ObservationSpoolFull):
                report['spool_overflows'] += 1
                report['degraded'] = True
                record['status'] = 'spool_overflow'
                record['error'] = 'metadata_spool_full'
                health('upload', failed=True)
                return None
            report['errors'].append('metadata_spool_unavailable')
            report['degraded'] = True
            record['status'] = 'spool_error'
            record['error'] = 'metadata_spool_unavailable'
            return None
        record['attempt_sequence'] = sequence
        record['status'] = 'spooled'
        records_by_attempt[sequence] = record
        report['spooled'] += 1
        if uploader is not None:
            uploader.notify()
        return sequence

    def apply_v2_acks():
        if uploader is None:
            return
        for acknowledgement in uploader.drain_acks():
            report['v2']['batches_acknowledged'] += 1
            report['uploaded'] += len(acknowledgement['dispositions'])
            for disposition in acknowledgement['dispositions']:
                record = records_by_attempt.pop(disposition['attempt_sequence'], None)
                if record is not None:
                    record['server_disposition'] = disposition['status']
                    record['status'] = ('uploaded' if disposition['status'] == 'accepted'
                                        else disposition['status'])
            state = acknowledgement.get('final_state', {})
            for event in acknowledgement.get('events', []):
                if recorder is None:
                    break
                event_type = event.get('type')
                alert = ('confirmed' if event_type in ('fire_confirmed', 'fire_update') and
                         state.get('alert') == 'confirmed' else
                         'watch' if event_type == 'fire_watch' else None)
                if alert is None:
                    continue
                try:
                    recorder.cloud_response({'alert': alert, 'hits': state.get('hits', 0)},
                                             ts_ms=event.get('ts_ms'))
                except Exception as exc:
                    evidence_failure(exc)
            for request in acknowledgement.get('pending_evidence_requests',[]):
                if evidence_uploader is None: continue
                try:
                    if recorder is not None:
                        pack=recorder.build_evidence_pack(request)
                    else:
                        pack={'protocol_version':2,'session_id':request['session_id'],
                            'generation':request['generation'],'request_id':request['request_id'],
                            'incident_id':request['incident_id'],'analysis_job_id':request['analysis_job_id'],
                            'frames':[{key:frame[key] for key in ('frame_id','ts_ms','attempt_sequence','jpeg_sha256')} |
                                {'missing_reason':'not_in_local_archive'} for frame in request['frames']]}
                    if not evidence_uploader.enqueue(pack):
                        report['evidence_lane_overflows']+=1
                        report['degraded']=True
                except Exception:
                    report['evidence_upload_errors']+=1
                    report['degraded']=True
        if evidence_uploader is not None:
            report['evidence_packs_uploaded']+=len(evidence_uploader.drain_acks())

    def record_discontinuity(ts_ms, reason, *, source_frame_index=None):
        report['capture_discontinuities'] += 1
        record = {'source_frame_index':source_frame_index,'ts_ms':ts_ms,'status':reason,
                  'discontinuity':True}
        if v2_mode:
            queue_v2_sample({'ts_ms':ts_ms, 'status':'gap', 'frame_wh':None,
                'detections':None, 'jpeg_sha256':None, 'local_image_available':False,
                'visibility':'unknown', 'camera_motion':None,
                'quality':{'stability':'unknown','blur_score':None,'occlusion':'unknown'},
                'reason':reason}, record)
        report['records'].append(record)
        if len(report['records']) > report['records_limit']:
            report['records'].pop(0)
            report['records_dropped'] += 1
        if output:
            output.write(json.dumps(record, allow_nan=False) + '\n')
            output.flush()
    try:
        if not is_video and not args.dry_run:
            try:
                if heartbeat_factory is None:
                    if __package__:
                        from .heartbeat import ProgressHeartbeat
                    else:
                        from heartbeat import ProgressHeartbeat
                    heartbeat_factory = ProgressHeartbeat
                heartbeat = heartbeat_factory(args.worker, args.api_key, args.camera,
                    interval=args.heartbeat_interval, stall_seconds=args.heartbeat_stall_seconds,
                    clock=clock, wall_clock=wall_clock)
                heartbeat.start()
            except Exception:
                # No exception repr, RTSP URL, key or cloud response is logged.
                print('[edge] WARNING: heartbeat unavailable', file=sys.stderr)
        try:
            recorder = EvidenceRecorder(args.evidence_dir, args.camera, max_bytes=args.evidence_max_bytes)
        except Exception as exc:
            evidence_failure(exc)
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            output = args.output.open('w', encoding='utf-8')
        if detector is None:
            active_stage = 'inference'
            detector = YoloDetector(args.model, device=args.device, imgsz=args.imgsz, max_det=args.max_det)
        if not args.dry_run and transport is None:
            try:
                if __package__:
                    from .observation_spool import ObservationSpool
                    from .observation_uploader import ObservationUploader, EvidenceUploader
                else:
                    from observation_spool import ObservationSpool
                    from observation_uploader import ObservationUploader, EvidenceUploader
                transport = V2ObservationTransport(args.worker, args.api_key, attempts=args.attempts,
                    timeout=args.timeout, sleep=sleep)
                evidence_transport=V2EvidenceTransport(args.worker,args.api_key,args.camera,
                    attempts=args.attempts,timeout=args.timeout,sleep=sleep)
                state_path = args.spool_dir / (args.camera + '.session.json')
                identity = transport.prepare_session(args.camera, state_path)
                spool = ObservationSpool(args.spool_dir / (args.camera + '.metadata.sqlite3'),camera_id=args.camera)
                spool.start_session(identity['session_id'], identity['generation'])
                v2_mode = True
                report['v2']['enabled'] = True
            except Exception:
                # Preserve local inference/evidence if cloud state cannot be opened.
                report['errors'].append('metadata_spool_unavailable')
                report['degraded'] = True
                transport = None
        if v2_mode and handheld_tracker is None and args.handheld_model is not None:
            try:
                if __package__:
                    from .handheld_scene import HandheldSceneTracker
                else:
                    from handheld_scene import HandheldSceneTracker
                handheld_tracker=HandheldSceneTracker(args.handheld_model,
                    expected_sha256=args.handheld_model_sha256,device='cpu',imgsz=args.imgsz,max_det=args.max_det)
            except Exception as error:
                allowed={'invalid_handheld_model_configuration','handheld_model_not_found','handheld_model_hash_mismatch'}
                report['handheld_scene']['errors']+=1
                report['handheld_scene']['last_error']=(str(error) if isinstance(error,ValueError) and
                    str(error) in allowed else 'handheld_model_unavailable')
                handheld_tracker=None
        if v2_mode and handheld_tracker is not None:
            report['handheld_scene']['enabled']=bool(getattr(handheld_tracker,'enabled',True))
        use_live_capture_thread = not is_video and capture_factory is None
        if capture_factory is None:
            capture_factory = lambda source: open_capture(source, timeout=args.timeout)
        active_stage = 'capture'
        with quiet_capture():
            cap = capture_factory(capture_source)
        if not cap.isOpened():
            raise RuntimeError('source_open_failed')
        if use_live_capture_thread:
            if __package__:
                from .live_capture import LatestFrameCapture
            else:
                from live_capture import LatestFrameCapture
            live_capture = LatestFrameCapture(cap, quiet_read=quiet_capture, wall_clock=wall_clock)
            live_capture.start()
        native_fps = float(cap.get(cv2.CAP_PROP_FPS))
        native_fps = native_fps if math.isfinite(native_fps) and native_fps > 0 else None
        report['source']['fps'] = native_fps
        if v2_mode:
            uploader = ObservationUploader(spool, transport, args.camera, state_path,
                clock_mode='replay' if is_video else 'live', retry_delay=.25,
                max_retry_delay=5.)
            evidence_uploader = EvidenceUploader(evidence_transport)
        while args.max_frames is None or report['frames_sampled'] < args.max_frames:
            if should_stop is not None and should_stop():
                stopped = True
                break
            active_stage = 'capture'
            if live_capture is not None:
                packet = live_capture.next_after(live_capture_sequence,
                    timeout=min(.5, max(.1, 1. / args.fps)))
                if packet is None:
                    now_ms = int(wall_clock() * 1000)
                    if now_ms - last_live_capture_seen_ms >= 2000:
                        health('capture', failed=True)
                        report['degraded'] = True
                        gap_ts = max(epoch_ms + round(max(0., now_ms - wall_started_ms)), previous_event_ms + 1)
                        record_discontinuity(gap_ts, 'capture_failed')
                        previous_event_ms = gap_ts
                        last_live_capture_seen_ms = now_ms
                        last_live_sample_offset_ms = max(0., now_ms - wall_started_ms)
                    continue
                live_capture_sequence, capture_ts_ms, frame = packet
                frame_index = live_capture_sequence - 1
                report['frames_read'] = max(report['frames_read'], live_capture_sequence)
                offset_ms = max(0., capture_ts_ms - wall_started_ms)
                last_live_capture_seen_ms = capture_ts_ms
                health('capture')
            else:
                with quiet_capture():
                    ok, frame = cap.read()
                if not ok:
                    if not is_video:
                        health('capture', failed=True)
                        report['errors'].append('live_source_read_failed')
                        print('[edge] WARNING: live source unavailable; no local alarm is implemented', file=sys.stderr)
                        if v2_mode:
                            gap_ts = max(int(wall_clock() * 1000), previous_event_ms + 1)
                            record_discontinuity(gap_ts, 'capture_failed')
                    break
                health('capture')
                frame_index = report['frames_read']
                report['frames_read'] += 1
            if is_video:
                source_ms = float(cap.get(cv2.CAP_PROP_POS_MSEC))
                if not math.isfinite(source_ms) or source_ms < 0 or source_ms <= previous_source_ms:
                    if native_fps is None:
                        raise RuntimeError('source_timestamp_unavailable')
                    source_ms = frame_index * 1000. / native_fps
                    report['source']['timestamp_fallbacks'] += 1
                    if source_ms <= previous_source_ms:
                        raise RuntimeError('source_timestamp_nonmonotonic')
                previous_source_ms = source_ms
                if first_source_ms is None:
                    first_source_ms = source_ms
                offset_ms = source_ms - first_source_ms
            elif live_capture is None:
                offset_ms = (clock() - started) * 1000.
            source_fraction = Fraction(str(offset_ms))
            # Decoder doubles may represent a deadline just below its rational
            # value. One microsecond tolerance affects scheduling only, never ts.
            scheduling_time = source_fraction + Fraction(1, 1000)
            if scheduling_time < next_deadline:
                continue
            if live_capture is not None and last_live_sample_offset_ms is not None:
                period_ms = 1000. / args.fps
                if offset_ms - last_live_sample_offset_ms > 2 * period_ms:
                    gap_offset = last_live_sample_offset_ms + period_ms
                    gap_ts = max(epoch_ms + round(gap_offset), previous_event_ms + 1)
                    record_discontinuity(gap_ts, 'capture_failed')
                    previous_event_ms = gap_ts
                    report['degraded'] = True
            next_deadline = (int(scheduling_time * rate / 1000) + 1) * 1000 / rate
            if is_video and args.realtime:
                delay = started + offset_ms / 1000. - clock()
                if delay > 0:
                    sleep(delay)
            event_ms = epoch_ms + round(offset_ms) if is_video or live_capture is not None else int(wall_clock() * 1000)
            event_ms = max(event_ms, previous_event_ms + 1)
            previous_event_ms = event_ms
            if live_capture is not None:
                last_live_sample_offset_ms = offset_ms
            report['frames_sampled'] += 1
            record = {'source_frame_index': frame_index, 'source_offset_ms': round(offset_ms, 6),
                      'ts_ms': event_ms, 'status': 'inference_error'}
            sample_started = clock()
            active_stage = 'inference'
            try:
                payload, timing = build_observation(frame, detector, args.camera, event_ms,
                    width=args.width, jpeg_quality=args.jpeg_quality, clock=clock)
            except Exception:
                health('inference', failed=True)
                report['inference_errors'] += 1
                record['error'] = 'inference_or_jpeg_failed'
                print('[edge] ERROR: local inference/JPEG failed; observation omitted', file=sys.stderr)
                if v2_mode:
                    queue_v2_sample({'ts_ms':event_ms, 'status':'gap', 'frame_wh':None,
                        'detections':None, 'jpeg_sha256':None, 'local_image_available':False,
                        'visibility':'unknown', 'camera_motion':None,
                        'quality':{'stability':'unknown','blur_score':None,'occlusion':'unknown'},
                        'reason':'inference_failed'}, record)
            else:
                health('inference')
                report['inferred'] += 1
                inference_total += timing['inference_ms']
                inference_max = max(inference_max, timing['inference_ms'])
                record.update(timing)
                record.update({'detections': payload['detections'], 'frame_wh': payload['frame_wh'],
                               'jpeg_bytes': len(base64.b64decode(payload['jpeg_b64'])),
                               'status': 'dry_run' if args.dry_run else ('queued' if v2_mode else 'upload_error')})
                jpeg_bytes = base64.b64decode(payload['jpeg_b64'])
                if recorder is not None:
                    try:
                        record['evidence'] = recorder.observe(payload, source_frame_index=frame_index)
                    except Exception as exc:
                        evidence_failure(exc, record)
                if v2_mode:
                    sample={'ts_ms':event_ms, 'status':'ok',
                        'frame_wh':payload['frame_wh'], 'detections':payload['detections'],
                        'jpeg_sha256':hashlib.sha256(jpeg_bytes).hexdigest(),
                        'local_image_available':recorder is not None and 'evidence_error' not in record,
                        'visibility':payload['visibility'], 'camera_motion':payload['camera_motion'],
                        'quality':timing['quality'],
                        'reason':None}
                    if handheld_tracker is not None and identity is not None:
                        try:
                            import cv2
                            import numpy as np
                            candidate_image=cv2.imdecode(np.frombuffer(jpeg_bytes,np.uint8),cv2.IMREAD_COLOR)
                            candidate=(handheld_tracker.observe(candidate_image,args.camera,identity['session_id'],
                                event_ms,identity['generation'],image_quality=payload['visibility'])
                                if candidate_image is not None else None)
                        except Exception as error:
                            allowed={'handheld_model_runtime_unavailable','handheld_model_classes_missing',
                                'handheld_model_load_failed','invalid_handheld_model_configuration',
                                'handheld_model_not_found','handheld_model_hash_mismatch'}
                            report['handheld_scene']['errors']+=1
                            report['handheld_scene']['last_error']=(str(error) if isinstance(error,ValueError) and
                                str(error) in allowed else 'handheld_candidate_failed')
                            try: handheld_tracker.enabled=False
                            except Exception: pass
                            candidate=None
                        if candidate is not None:
                            sample['handheld_candidate']=candidate
                            report['handheld_scene']['candidates']+=1
                    queue_v2_sample(sample, record)
                elif not args.dry_run and transport is not None:
                    upload_started = clock()
                    try:
                        body = transport.send(payload)
                    except Exception:
                        report['upload_errors'] += 1
                        record['error'] = 'cloud_upload_failed'
                        print('[edge] WARNING: cloud offline/unavailable; cloud alerts unavailable; '
                              'no local alarm is implemented', file=sys.stderr)
                    else:
                        report['uploaded'] += 1
                        record['status'] = 'uploaded'
                        record['response'] = body
                        if recorder is not None:
                            try:
                                association = recorder.cloud_response(body)
                                if 'evidence_error' not in record:
                                    record['evidence'] = association
                            except Exception as exc:
                                evidence_failure(exc, record)
                    record['upload_ms'] = (clock() - upload_started) * 1000.
                    upload_total += record['upload_ms']
                if recorder is not None:
                    try:
                        recorder.end_sample()
                        if 'evidence_error' not in record and (storage_failure_saved_frames is None or
                                recorder.saved_frames > storage_failure_saved_frames):
                            # A successful no-op end_sample is not recovery from
                            # a disk failure: require a newly archived JPEG/index.
                            storage_failure_saved_frames = None
                            health('storage')
                    except Exception as exc:
                        evidence_failure(exc, record)
                apply_v2_acks()
            record['total_ms'] = (clock() - sample_started) * 1000.
            report['records'].append(record)
            if len(report['records']) > report['records_limit']:
                report['records'].pop(0)
                report['records_dropped'] += 1
            if output:
                output.write(json.dumps(record, allow_nan=False) + '\n')
                output.flush()
    except Exception:
        health(active_stage, failed=True)
        # Never print backend exceptions: they can contain RTSP credentials/keys.
        report['errors'].append('source_model_or_output_failed')
        print('[edge] ERROR: source/model/output failed (sensitive details suppressed)', file=sys.stderr)
    finally:
        if live_capture is not None:
            try:
                stopped_capture = live_capture.stop(timeout=args.timeout + .25)
                capture_status = live_capture.snapshot()
                report['frames_read'] = max(report['frames_read'], capture_status['captured_frames'])
                report['capture_replacements'] = capture_status['replacements']
                report['capture_read_failures'] = capture_status['read_failures']
                if not stopped_capture:
                    if cap is not None:
                        cap.release()
                    stopped_capture = live_capture.stop(timeout=1.)
                    if not stopped_capture:
                        report['errors'].append('capture_thread_stop_timeout')
            except Exception:
                report['errors'].append('capture_thread_stop_failed')
        if uploader is not None:
            try:
                flush_timeout = min(10., max(2., args.timeout))
                upload_state = uploader.flush_and_stop(timeout=flush_timeout)
                apply_v2_acks()
                report['v2'].update({key:upload_state[key] for key in
                    ('pending_samples','pending_batches','transport_errors')})
                if upload_state['pending_samples'] or upload_state['pending_batches'] or not upload_state['stopped']:
                    report['upload_errors'] += 1
                    report['degraded'] = True
                    report['errors'].append('metadata_upload_pending')
            except Exception:
                report['upload_errors'] += 1
                report['degraded'] = True
                report['errors'].append('metadata_uploader_shutdown_failed')
        if evidence_uploader is not None:
            try:
                image_state=evidence_uploader.flush_and_stop(timeout=min(10.,max(2.,args.timeout)))
                report['evidence_packs_uploaded']+=len(evidence_uploader.drain_acks())
                report['evidence_pending_bytes']=image_state['pending_bytes']
                report['evidence_upload_errors']+=image_state['transport_errors']
                if image_state['pending_bytes'] or not image_state['stopped']:
                    report['evidence_upload_errors']+=1
                    report['degraded']=True
            except Exception:
                report['evidence_upload_errors']+=1
                report['degraded']=True
        if spool is not None:
            try:
                spool.close()
            except Exception:
                report['errors'].append('metadata_spool_close_failed')
        if recorder is not None:
            try:
                recorder.close()
            except Exception as exc:
                evidence_failure(exc)
            report['evidence']['saved_frames'] = recorder.saved_frames
            report['evidence']['incidents'] = list(recorder.incidents)
        if cap is not None:
            try:
                with quiet_capture():
                    cap.release()
            except Exception:
                report['errors'].append('capture_release_failed')
        if output is not None:
            try:
                output.close()
            except Exception:
                report['errors'].append('output_close_failed')
        if heartbeat is not None:
            try:
                heartbeat.stop()
            except Exception:
                pass
    if report['frames_sampled'] == 0:
        report['errors'].append('zero_sampled_frames')
    report['elapsed_ms'] = (clock() - started) * 1000.
    report['inference_ms'] = {'mean': inference_total / report['inferred'] if report['inferred'] else None,
                              'max': inference_max if report['inferred'] else None,
                              'total': inference_total}
    report['upload_ms_total'] = upload_total
    report['stopped'] = stopped
    code = int(bool(report['errors'] or report['inference_errors'] or report['upload_errors']
                    or report['evidence_errors'] or report['spool_overflows'] or
                    report['evidence_upload_errors'] or report['evidence_lane_overflows']))
    report['exit_code'] = code
    if args.report:
        try:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(report, indent=2, allow_nan=False) + '\n', encoding='utf-8')
        except Exception:
            report['errors'].append('report_write_failed')
            code = report['exit_code'] = 1
            print('[edge] ERROR: report write failed', file=sys.stderr)
    return code, report


def main(argv=None):
    import signal
    import sys
    import threading

    args = parse_args(argv)
    stop = threading.Event()
    previous = {}
    if threading.current_thread() is threading.main_thread():
        for sig in (signal.SIGINT, signal.SIGTERM):
            previous[sig] = signal.signal(sig, lambda *_: stop.set())
    try:
        code, report = run(args, should_stop=stop.is_set)
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    print(f"[edge] sampled={report['frames_sampled']} inferred={report['inferred']} "
          f"uploaded={report['uploaded']} inference_errors={report['inference_errors']} "
          f"upload_errors={report['upload_errors']} evidence_errors={report['evidence_errors']} "
          f"evidence_frames={report['evidence']['saved_frames']} exit={code}")
    return code


if __name__ == '__main__':
    import sys
    sys.exit(main())
