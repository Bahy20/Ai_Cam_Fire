"""Pi-local JPEG evidence. Importing opens no files, models, or network clients."""
import base64
from collections import deque
import json
import math
import os
from pathlib import Path
import re
import stat
import tempfile

MAX_EDGE_EVIDENCE_IMAGE_BYTES = 512 * 1024


class EvidenceError(RuntimeError):
    """Sanitized local storage failure."""


class EvidenceRecorder:
    def __init__(self, directory, camera_id, *, max_bytes=256 * 1024 * 1024):
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', camera_id):
            raise EvidenceError('evidence_invalid_camera')
        self.root = Path(directory)
        self.camera_id = camera_id
        self.max_bytes = max_bytes
        self.recent = deque(maxlen=24)
        self.active = None
        self.saved_frames = 0
        self.incidents = deque(maxlen=256)
        self.archived_frames_by_ts = {}
        self._assert_safe(self.root)
        self.root.mkdir(parents=True, exist_ok=True)
        if self._disk_bytes() >= self.max_bytes:
            raise EvidenceError('evidence_budget_exceeded')
        self._load_archive_index()

    def _disk_bytes(self):
        # Conservatively count *all* files in the configured evidence root.
        # Retained JPEGs, manifests, interrupted writes and unrelated files count.
        total = 0
        def scan_error(_error):
            raise EvidenceError('evidence_scan_failed') from None

        for base, directories, files in os.walk(self.root, followlinks=False, onerror=scan_error):
            for name in directories + files:
                path = Path(base) / name
                self._assert_safe(path)
            total += sum((Path(base) / name).stat().st_size for name in files)
        return total

    @staticmethod
    def _assert_safe(path):
        # Python 3.11 is_symlink() does not identify Windows junctions.
        for part in (path.absolute(), *path.absolute().parents):
            try:
                status = part.lstat()
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(status.st_mode) or getattr(status, 'st_file_attributes', 0) & 0x400:
                raise EvidenceError('evidence_unsafe_path')

    def _atomic_write(self, path, data, *, replace=False):
        self._assert_safe(path)
        if self._disk_bytes() + len(data) > self.max_bytes:
            raise EvidenceError('evidence_budget_exceeded')
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.pending-', delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            if replace:
                os.replace(temporary, path)
                temporary = None
            else:
                # Link publishes complete bytes with exclusive-create semantics.
                # Unlike rename/replace this never overwrites a retained JPEG.
                os.link(temporary, path)
        except OSError:
            raise EvidenceError('evidence_write_failed') from None
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    def _validated_frame(self, payload, source_frame_index):
        try:
            ts_ms, dimensions = payload['ts_ms'], list(payload['frame_wh'])
            if (payload['camera_id'] != self.camera_id or type(ts_ms) is not int or ts_ms <= 0
                    or len(dimensions) != 2 or any(type(v) is not int or v <= 0 for v in dimensions)
                    or (source_frame_index is not None and
                        (type(source_frame_index) is not int or source_frame_index < 0))):
                raise ValueError
            detections = []
            if len(payload['detections']) > 256:
                raise ValueError
            for detection in payload['detections']:
                if detection['cls'] not in ('fire', 'smoke'):
                    continue
                confidence = detection['conf']
                bbox = list(detection['bbox_xyxy'])
                if (type(confidence) not in (int, float) or not math.isfinite(confidence)
                        or not 0 <= confidence <= 1 or len(bbox) != 4
                        or any(type(v) not in (int, float) or not math.isfinite(v) for v in bbox)):
                    raise ValueError
                detections.append({'cls': detection['cls'], 'conf': confidence, 'bbox_xyxy': bbox})
            jpeg = base64.b64decode(payload['jpeg_b64'], validate=True)
            if not jpeg.startswith(b'\xff\xd8') or not jpeg.endswith(b'\xff\xd9'):
                raise ValueError
            return {'ts_ms': ts_ms, 'source_frame_index': source_frame_index,
                    'frame_wh': dimensions, 'detections': detections, 'jpeg': jpeg}
        except (ValueError, TypeError, KeyError, OverflowError):
            raise EvidenceError('evidence_invalid_observation') from None

    def _load_archive_index(self):
        candidates=[]
        for base, directories, files in os.walk(self.root, followlinks=False):
            directories[:]=[name for name in directories if not (Path(base)/name).is_symlink()]
            if 'manifest.json' not in files: continue
            manifest_path=Path(base)/'manifest.json'
            try:
                manifest=json.loads(manifest_path.read_text(encoding='utf-8'))
                for frame in manifest.get('frames',[]):
                    ts=frame.get('ts_ms'); name=frame.get('file')
                    if (type(ts) is int and ts>0 and name==f'{ts:013d}.jpg'):
                        image=manifest_path.parent/name
                        if image.is_file() and not image.is_symlink(): candidates.append((ts,image))
            except Exception:
                continue
        for ts,path in sorted(candidates)[-10_000:]: self.archived_frames_by_ts[ts]=path

    def image_bytes(self, ts_ms):
        for frame in reversed(self.recent):
            if frame['ts_ms']==ts_ms: return frame['jpeg']
        path=self.archived_frames_by_ts.get(ts_ms)
        if path is None: return None
        try:
            self._assert_safe(path)
            return path.read_bytes() if path.is_file() else None
        except OSError:
            return None

    def build_evidence_pack(self, request):
        if (not isinstance(request,dict) or request.get('request_id') is None or
                not isinstance(request.get('frames'),list) or len(request['frames'])>6):
            raise EvidenceError('evidence_invalid_observation')
        frames=[]
        for reference in request['frames']:
            ts=reference.get('ts_ms')
            jpeg=self.image_bytes(ts)
            common={key:reference[key] for key in ('frame_id','ts_ms','attempt_sequence','jpeg_sha256')}
            if jpeg is None:
                frames.append({**common,'missing_reason':'not_in_local_archive'})
                continue
            import hashlib
            if hashlib.sha256(jpeg).hexdigest()!=reference['jpeg_sha256']:
                frames.append({**common,'missing_reason':'local_storage_error'})
                continue
            import base64
            encoded=base64.b64encode(jpeg).decode('ascii')
            if len(encoded)>MAX_EDGE_EVIDENCE_IMAGE_BYTES:
                frames.append({**common,'missing_reason':'image_exceeds_limit'})
                continue
            frames.append({**common,'image_b64':encoded})
        return {'protocol_version':2,'session_id':request['session_id'],'generation':request['generation'],
            'request_id':request['request_id'],'incident_id':request['incident_id'],
            'analysis_job_id':request['analysis_job_id'],'frames':frames}

    def observe(self, payload, *, source_frame_index=None):
        frame = self._validated_frame(payload, source_frame_index)
        if self.recent and frame['ts_ms'] <= self.recent[-1]['ts_ms']:
            if frame == self.recent[-1]:
                return self.association()
            raise EvidenceError('evidence_timestamp_conflict')
        self.recent.append(frame)
        candidate = any(d['cls'] in ('fire', 'smoke') and d['conf'] >= .08
                        for d in frame['detections'])
        if candidate and self.active is None:
            self._open(frame['ts_ms'], 'local_candidate')
            for recent in self.recent:
                self._save(recent)
        elif self.active is not None:
            self._save(frame)
        if self.active is not None:
            self.active['tail'] = 0 if candidate else self.active['tail'] + 1
        return self.association()

    def cloud_response(self, body, *, ts_ms=None):
        alert = body.get('alert')
        if alert not in ('watch', 'confirmed') or not self.recent:
            return self.association()
        frame = self.recent[-1] if ts_ms is None else next(
            (item for item in self.recent if item['ts_ms'] == ts_ms), None)
        # A delayed cloud ACK may describe a sample no longer in the bounded
        # ring. Never attach that decision to a newer, unrelated frame.
        if frame is None:
            return self.association()
        if self.active is None:
            self._open(frame['ts_ms'], 'cloud_' + alert)
            for frame in self.recent:
                self._save(frame)
        self.active['tail'] = 0
        metadata = {'alert': alert, 'ts_ms': ts_ms if ts_ms is not None else self.recent[-1]['ts_ms']}
        if isinstance(body.get('hits'), (int, float)):
            metadata['hits'] = body['hits']
        # Do not downgrade the retained confirmation when a later watch arrives.
        if self.active['manifest'].get('cloud', {}).get('alert') != 'confirmed' or alert == 'confirmed':
            self.active['manifest']['cloud'] = metadata
            self._manifest()
        return self.association()

    def _open(self, ts_ms, trigger):
        parent = self.root / ('cam-' + self.camera_id)
        self._assert_safe(parent)
        parent.mkdir(parents=True, exist_ok=True)
        serial = 0
        while True:
            suffix = '' if serial == 0 else f'-{serial:04d}'
            path = parent / f'incident-{ts_ms:013d}{suffix}'
            try:
                path.mkdir(exist_ok=False)
                break
            except FileExistsError:
                serial += 1
        self.active = {'path': path, 'tail': 0, 'manifest': {
            'schema_version': 1, 'camera_id': self.camera_id,
            'trigger_ts_ms': ts_ms, 'trigger': trigger, 'state': 'recording',
            'human_review_required': True, 'local_alarm': False, 'frames': []}}
        self._manifest()
        self.incidents.append(path.relative_to(self.root).as_posix())

    def _save(self, frame):
        entry = {k: v for k, v in frame.items() if k != 'jpeg'}
        entry['file'] = f"{frame['ts_ms']:013d}.jpg"
        self._atomic_write(self.active['path'] / entry['file'], frame['jpeg'])
        self.active['manifest']['frames'].append(entry)
        self.archived_frames_by_ts[frame['ts_ms']]=self.active['path']/entry['file']
        if len(self.archived_frames_by_ts)>10_000:
            for ts in sorted(self.archived_frames_by_ts)[:len(self.archived_frames_by_ts)-10_000]:
                self.archived_frames_by_ts.pop(ts,None)
        try:
            self._manifest()
        except Exception:
            self.active['manifest']['frames'].pop()
            raise
        self.saved_frames += 1

    def _manifest(self):
        self._atomic_write(self.active['path'] / 'manifest.json',
            (json.dumps(self.active['manifest'], indent=2, allow_nan=False) + '\n').encode('utf-8'),
            replace=True)

    def association(self):
        if self.active is None:
            return None
        return {'incident': self.active['path'].relative_to(self.root).as_posix()}

    def end_sample(self):
        if self.active is not None and self.active['tail'] >= 8:
            self.active['manifest']['state'] = 'tail_complete'
            self._manifest()
            self.active = None

    def close(self):
        if self.active is not None:
            self.active['manifest']['state'] = 'capture_ended'
            self._manifest()
            self.active = None
