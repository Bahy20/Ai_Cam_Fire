"""Disk-backed Pi evidence regressions. No network or model weights needed."""
import base64
import hashlib
import importlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
SCRATCH = Path(tempfile.gettempdir())


def observation(index, confidence=None):
    ok, encoded = cv2.imencode('.jpg', np.full((16, 24, 3), index % 256, np.uint8))
    assert ok
    return {'camera_id': 'cam-1', 'ts_ms': 1000000 + index * 1000,
            'frame_wh': [24, 16], 'jpeg_b64': base64.b64encode(encoded).decode(),
            'detections': [] if confidence is None else [
                {'cls': 'smoke', 'conf': confidence, 'bbox_xyxy': [1, 2, 10, 12]}]}


class EvidenceTests(unittest.TestCase):
    def recorder(self, directory, **kwargs):
        self.assertIsNotNone(importlib.util.find_spec('edge.evidence'),
                             'Pi-local evidence recorder is missing')
        return importlib.import_module('edge.evidence').EvidenceRecorder(directory, 'cam-1', **kwargs)

    def test_candidate_flushes_bounded_recent_jpegs_exactly_and_records_source_indices(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as tmp:
            recorder = self.recorder(tmp)
            samples = [observation(i, .08 if i == 30 else .079) for i in range(31)]
            for index, payload in enumerate(samples):
                association = recorder.observe(payload, source_frame_index=index * 3)
                recorder.end_sample()
            recorder.close()
            manifests = list(Path(tmp).rglob('manifest.json'))
            self.assertEqual(len(manifests), 1)
            manifest = json.loads(manifests[0].read_text())
            self.assertEqual(manifest['trigger'], 'local_candidate')
            self.assertEqual(manifest['camera_id'], 'cam-1')
            self.assertEqual([f['ts_ms'] for f in manifest['frames']],
                             [p['ts_ms'] for p in samples[-24:]])
            self.assertEqual(manifest['frames'][-1]['source_frame_index'], 90)
            self.assertEqual(manifest['frames'][-1]['detections'], samples[-1]['detections'])
            self.assertEqual(association['incident'], manifests[0].parent.relative_to(tmp).as_posix())
            for entry, payload in zip(manifest['frames'], samples[-24:]):
                jpeg = (manifests[0].parent / entry['file']).read_bytes()
                self.assertEqual(jpeg, base64.b64decode(payload['jpeg_b64']))
                self.assertIsNotNone(cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR))
            self.assertEqual(len(recorder.recent), 24)

    def test_cloud_watch_and_confirmed_extend_incident_then_eight_tail_samples_close(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as tmp:
            recorder = self.recorder(tmp)
            for i in range(3):
                recorder.observe(observation(i), source_frame_index=i)
                if i == 2:
                    recorder.cloud_response({'alert': 'watch', 'hits': 1, 'events': [],
                                             'secret': 'rtsp://user:password@camera'})
                recorder.end_sample()
            self.assertIsNotNone(recorder.active)
            for i in range(3, 13):
                recorder.observe(observation(i))
                if i == 4:
                    recorder.cloud_response({'alert': 'confirmed', 'hits': 2, 'events': [],
                                             'api_key': 'secret'})
                recorder.end_sample()
                self.assertEqual(recorder.active is None, i == 12)
            recorder.close()
            manifest = json.loads(next(Path(tmp).rglob('manifest.json')).read_text())
            self.assertEqual(manifest['trigger'], 'cloud_watch')
            self.assertEqual(manifest['state'], 'tail_complete')
            self.assertEqual(manifest['cloud']['alert'], 'confirmed')
            self.assertEqual(manifest['cloud']['ts_ms'], observation(4)['ts_ms'])
            self.assertFalse(manifest['local_alarm'])
            self.assertTrue(manifest['human_review_required'])
            self.assertEqual(len(manifest['frames']), 13)
            self.assertNotIn('secret', json.dumps(manifest))
            self.assertNotIn('password', json.dumps(manifest))

    def test_delayed_cloud_response_uses_exact_source_frame_or_abstains(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as tmp:
            recorder=self.recorder(tmp)
            for index in range(30):
                recorder.observe(observation(index))
            current=observation(29)['ts_ms']
            self.assertIsNone(recorder.cloud_response({'alert':'confirmed','hits':2},
                ts_ms=observation(0)['ts_ms']))
            self.assertIsNone(recorder.active)
            recorder.cloud_response({'alert':'confirmed','hits':2},ts_ms=current)
            self.assertEqual(recorder.active['manifest']['trigger_ts_ms'],current)
            self.assertEqual(recorder.active['manifest']['cloud']['ts_ms'],current)
            recorder.close()

    def test_evidence_pack_returns_only_the_exact_hash_bound_frame_and_declares_missing_images(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as tmp:
            recorder = self.recorder(tmp)
            payload = observation(4, .08)
            recorder.observe(payload)
            recorder.close()
            # Reopen from the manifest to cover archive lookup after the live ring is gone.
            recorder = self.recorder(tmp)
            jpeg = base64.b64decode(payload['jpeg_b64'])
            request = {'protocol_version': 2, 'session_id': 'session-1', 'generation': 1,
                'request_id': 'request-1', 'incident_id': 'cam-1:1004000:1', 'analysis_job_id': 1,
                'frames': [{'frame_id': 'frame-1004000', 'ts_ms': 1004000,
                    'attempt_sequence': 7, 'jpeg_sha256': hashlib.sha256(jpeg).hexdigest()}]}

            pack = recorder.build_evidence_pack(request)
            self.assertEqual(pack['frames'], [{**request['frames'][0], 'image_b64': payload['jpeg_b64']}])
            self.assertEqual((pack['session_id'], pack['generation'], pack['request_id']),
                ('session-1', 1, 'request-1'))

            recorder.archived_frames_by_ts.clear()
            missing = recorder.build_evidence_pack(request)
            self.assertEqual(missing['frames'][0]['missing_reason'], 'not_in_local_archive')

            recorder.archived_frames_by_ts[1004000] = next(Path(tmp).rglob('*.jpg'))
            request['frames'][0]['jpeg_sha256'] = '0' * 64
            corrupt = recorder.build_evidence_pack(request)
            self.assertEqual(corrupt['frames'][0]['missing_reason'], 'local_storage_error')

    def test_evidence_pack_declares_oversized_image_instead_of_retrying_it_forever(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as tmp:
            recorder = self.recorder(tmp)
            rng = np.random.default_rng(17)
            ok, encoded = cv2.imencode('.jpg', rng.integers(0, 256, (1024, 1024, 3), dtype=np.uint8),
                [cv2.IMWRITE_JPEG_QUALITY, 100])
            self.assertTrue(ok)
            jpeg = encoded.tobytes()
            self.assertGreater(len(base64.b64encode(jpeg)), 512 * 1024)
            payload = {'camera_id': 'cam-1', 'ts_ms': 2000000, 'frame_wh': [1024, 1024],
                'jpeg_b64': base64.b64encode(jpeg).decode(), 'detections': []}
            recorder.observe(payload)
            request = {'request_id': 'request-oversize', 'session_id': 'session-1', 'generation': 1,
                'incident_id': 'cam-1:2000000:1', 'analysis_job_id': 2,
                'frames': [{'frame_id': 'frame-2000000', 'ts_ms': 2000000,
                    'attempt_sequence': 8, 'jpeg_sha256': hashlib.sha256(jpeg).hexdigest()}]}
            pack = recorder.build_evidence_pack(request)
            self.assertEqual(pack['frames'][0]['missing_reason'], 'image_exceeds_limit')

    def test_budget_counts_retained_files_on_restart_and_never_prunes_unrelated_files(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as tmp:
            recorder = self.recorder(tmp)
            recorder.observe(observation(0, .8))
            recorder.close()
            before = {p.relative_to(tmp): p.read_bytes() for p in Path(tmp).rglob('*') if p.is_file()}
            unrelated = Path(tmp) / 'keep.txt'
            unrelated.write_bytes(b'unrelated-user-file')
            used = sum(len(v) for v in before.values()) + unrelated.stat().st_size
            with self.assertRaisesRegex(Exception, 'evidence_budget_exceeded'):
                recorder = self.recorder(tmp, max_bytes=used + 1)
                recorder.observe(observation(100, .8))
            for name, value in before.items():
                self.assertEqual((Path(tmp) / name).read_bytes(), value)
            self.assertEqual(unrelated.read_bytes(), b'unrelated-user-file')
            self.assertLessEqual(sum(p.stat().st_size for p in Path(tmp).rglob('*') if p.is_file()), used + 1)

    def test_restart_collision_keeps_original_bytes_and_duplicates_are_idempotent(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as tmp:
            recorder = self.recorder(tmp)
            payload = observation(0, .8)
            recorder.observe(payload)
            recorder.observe(payload)
            recorder.end_sample()
            recorder.close()
            original = {p.relative_to(tmp): p.read_bytes() for p in Path(tmp).rglob('*') if p.is_file()}
            self.assertEqual(len(list(Path(tmp).rglob('*.jpg'))), 1)
            restarted = self.recorder(tmp)
            restarted.observe(payload)
            restarted.close()
            self.assertEqual(len(list(Path(tmp).rglob('manifest.json'))), 2)
            for name, data in original.items():
                self.assertEqual((Path(tmp) / name).read_bytes(), data)
            manifests = sorted(Path(tmp).rglob('manifest.json'))
            self.assertTrue(any('-0001' in p.parent.name for p in manifests))

    def test_atomic_manifest_failure_preserves_published_manifest_and_exact_new_jpeg(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory(dir=SCRATCH) as tmp:
            recorder = self.recorder(tmp)
            recorder.observe(observation(0, .8))
            manifest = next(Path(tmp).rglob('manifest.json'))
            before = manifest.read_bytes()
            with patch('edge.evidence.os.replace', side_effect=OSError('sensitive backend URL')):
                with self.assertRaisesRegex(Exception, 'evidence_write_failed'):
                    recorder.observe(observation(1, .8))
            self.assertEqual(manifest.read_bytes(), before)
            self.assertEqual(recorder.saved_frames, 1, 'failed manifest must not count a successful save')
            self.assertEqual(list(Path(tmp).rglob('.pending-*')), [])
            jpeg = manifest.parent / f"{observation(1)['ts_ms']:013d}.jpg"
            self.assertEqual(jpeg.read_bytes(), base64.b64decode(observation(1)['jpeg_b64']))
            recorder.close()

    def test_manifest_whitelists_metadata_and_freezes_ring_against_caller_mutation(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as tmp:
            recorder = self.recorder(tmp)
            payload = observation(0)
            payload['detections'] = [{'cls': 'fire', 'conf': .05, 'bbox_xyxy': [1, 2, 10, 12],
                                      'debug': 'rtsp://user:password@cam'}]
            payload['api_key'] = 'secret-key'
            recorder.observe(payload)
            payload['detections'][0]['conf'] = .99
            payload['detections'][0]['bbox_xyxy'][0] = 999
            recorder.observe(observation(1, .08))
            recorder.close()
            manifest_text = next(Path(tmp).rglob('manifest.json')).read_text()
            self.assertNotIn('password', manifest_text)
            self.assertNotIn('secret-key', manifest_text)
            self.assertNotIn('rtsp://', manifest_text)
            first = json.loads(manifest_text)['frames'][0]['detections'][0]
            self.assertEqual(first, {'cls': 'fire', 'conf': .05, 'bbox_xyxy': [1, 2, 10, 12]})

    def test_invalid_numeric_metadata_or_camera_mismatch_is_rejected_before_writing(self):
        import copy
        cases = []
        for key, value in [('ts_ms', '../escape'), ('ts_ms', -1), ('camera_id', 'other'),
                           ('frame_wh', [24, 'rtsp://password'])]:
            payload = observation(0, .8)
            payload[key] = value
            cases.append(payload)
        for key, value in [('conf', float('nan')), ('conf', 'secret-key'),
                           ('bbox_xyxy', [1, 2, 10, 'rtsp://password'])]:
            payload = observation(0, .8)
            payload['detections'][0][key] = value
            cases.append(payload)
        with tempfile.TemporaryDirectory(dir=SCRATCH) as tmp:
            recorder = self.recorder(tmp)
            for index, payload in enumerate(cases):
                with self.subTest(index=index), self.assertRaisesRegex(Exception, 'evidence_invalid_observation'):
                    recorder.observe(copy.deepcopy(payload))
            self.assertEqual(list(Path(tmp).rglob('*.jpg')), [])
            self.assertEqual(list(Path(tmp).rglob('manifest.json')), [])
            recorder.close()

    def test_camera_directory_link_is_rejected_without_writing_outside_evidence_root(self):
        import subprocess
        with tempfile.TemporaryDirectory(dir=SCRATCH) as tmp:
            root, outside = Path(tmp) / 'evidence', Path(tmp) / 'outside'
            root.mkdir()
            outside.mkdir()
            link = root / 'cam-cam-1'
            try:
                if os.name == 'nt':
                    result = subprocess.run(['cmd', '/c', 'mklink', '/J', str(link), str(outside)],
                                            capture_output=True, text=True)
                    if result.returncode:
                        self.skipTest('cannot create Windows junction in this session')
                else:
                    link.symlink_to(outside, target_is_directory=True)
                with self.assertRaisesRegex(Exception, 'evidence_unsafe_path'):
                    recorder = self.recorder(root)
                    recorder.observe(observation(0, .8))
                self.assertEqual(list(outside.iterdir()), [])
            finally:
                if link.exists():
                    if os.name == 'nt': os.rmdir(link)
                    else: link.unlink()

    def test_budget_failure_leaves_readable_partial_bundle_without_claiming_unsaved_frames(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as tmp:
            payload = observation(0, .8)
            recorder = self.recorder(tmp, max_bytes=len(base64.b64decode(payload['jpeg_b64'])) + 1)
            with self.assertRaisesRegex(Exception, 'evidence_budget_exceeded'):
                recorder.observe(payload)
            manifests = list(Path(tmp).rglob('manifest.json'))
            self.assertEqual(len(manifests), 1, 'partial bundle must remain discoverable for review')
            self.assertEqual(json.loads(manifests[0].read_text())['frames'], [])
            self.assertEqual(recorder.saved_frames, 0)
            recorder.close()

    def test_unreadable_retained_directory_fails_budget_scan_instead_of_counting_zero(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory(dir=SCRATCH) as tmp:
            (Path(tmp) / 'retained.jpg').write_bytes(base64.b64decode(observation(0)['jpeg_b64']))
            with patch('edge.evidence.os.scandir', side_effect=PermissionError('sensitive location')):
                with self.assertRaisesRegex(Exception, 'evidence_scan_failed'):
                    self.recorder(tmp)


class AgentEvidenceTests(unittest.TestCase):
    def test_cli_defaults_env_and_positive_budget(self):
        from edge import agent
        import contextlib
        import io
        base = ['--video', 'ignored', '--camera', 'test', '--dry-run']
        args = agent.parse_args(base, environ={})
        self.assertEqual(getattr(args, 'evidence_dir', None), Path('edge-data/evidence'))
        self.assertEqual(args.evidence_max_bytes, 256 * 1024 * 1024)
        args = agent.parse_args(base, environ={'EDGE_EVIDENCE_DIR': 'custom-evidence'})
        self.assertEqual(args.evidence_dir, Path('custom-evidence'))
        args = agent.parse_args(base + ['--evidence-dir', 'explicit', '--evidence-max-bytes', '123'],
                                environ={'EDGE_EVIDENCE_DIR': 'custom-evidence'})
        self.assertEqual(args.evidence_dir, Path('explicit'))
        self.assertEqual(args.evidence_max_bytes, 123)
        for value in ('0', '-1', 'nan', '1.5'):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                agent.parse_args(base + ['--evidence-max-bytes', value], environ={})

    def test_candidate_is_on_disk_before_offline_upload_and_report_associates_exact_jpeg(self):
        from edge import agent
        import contextlib
        import io
        class Capture:
            def __init__(self, _): self.index = -1
            def isOpened(self): return True
            def read(self):
                self.index += 1
                return (True, np.full((16, 24, 3), self.index, np.uint8)) if self.index < 3 else (False, None)
            def get(self, prop): return 1. if prop == cv2.CAP_PROP_FPS else self.index * 1000.
            def release(self): pass
        with tempfile.TemporaryDirectory(dir=SCRATCH) as tmp:
            args = agent.parse_args(['--video', 'ignored', '--camera', 'cam-1', '--fps', '1',
                '--worker', 'https://example.com', '--evidence-dir', tmp],
                environ={'INGEST_API_KEY': 'secret-key', 'EDGE_RTSP_URL': 'rtsp://user:password@cam'})
            sent, before_send = [], []
            class Offline:
                def send(inner, payload):
                    sent.append(payload)
                    if len(sent) == 3:
                        manifests = list(Path(tmp).rglob('manifest.json'))
                        data = json.loads(manifests[0].read_text()) if manifests else {'frames': []}
                        frames = data['frames']
                        exact_jpeg = bool(frames) and (manifests[0].parent / frames[-1]['file']).read_bytes() == \
                            base64.b64decode(payload['jpeg_b64'])
                        # Assert outside send: run intentionally sanitizes *all*
                        # transport exceptions, including AssertionError.
                        before_send.append((len(manifests), len(frames), exact_jpeg))
                    raise agent.UploadError('cloud offline')
            calls = []
            def detector(_):
                calls.append(1)
                return [] if len(calls) < 3 else [{'cls': 'fire', 'conf': .08, 'bbox_xyxy': [1, 2, 10, 12]}]
            with contextlib.redirect_stderr(io.StringIO()):
                code, report = agent.run(args, detector=detector, capture_factory=Capture, transport=Offline())
            self.assertEqual(len(sent), 3)
            self.assertEqual(before_send, [(1, 3, True)], 'candidate must be saved BEFORE send')
            self.assertEqual(code, 1)
            self.assertEqual(report['upload_errors'], 3)
            self.assertEqual(report.get('evidence_errors'), 0)
            self.assertEqual(report['evidence']['saved_frames'], 3)
            self.assertIsNotNone(report['records'][-1]['evidence'])
            serialized = next(Path(tmp).rglob('manifest.json')).read_text()
            for secret in ('secret-key', 'password', 'rtsp://', 'https://example.com'):
                self.assertNotIn(secret, serialized)
            self.assertNotIn('evidence', sent[-1], 'local paths must never enter cloud payloads')

    def test_storage_failure_still_uploads_and_exits_nonzero_without_claiming_save_success(self):
        from edge import agent
        import contextlib
        import io
        class Capture:
            def __init__(self, _): self.done = False
            def isOpened(self): return True
            def read(self):
                if self.done: return False, None
                self.done = True
                return True, np.zeros((16, 24, 3), np.uint8)
            def get(self, prop): return 1. if prop == cv2.CAP_PROP_FPS else 0.
            def release(self): pass
        with tempfile.TemporaryDirectory(dir=SCRATCH) as tmp:
            file_root = Path(tmp) / 'file-not-directory'
            file_root.write_text('do not touch')
            for root, budget in [(file_root, 10000), (Path(tmp) / 'small', 1)]:
                with self.subTest(root=root):
                    args = agent.parse_args(['--video', 'ignored', '--camera', 'cam-1',
                        '--worker', 'https://example.com', '--evidence-dir', str(root),
                        '--evidence-max-bytes', str(budget)], environ={'INGEST_API_KEY': 'secret'})
                    sent = []
                    class Transport:
                        def send(inner, payload):
                            sent.append(payload)
                            return {'camera_id': 'cam-1', 'alert': 'idle', 'hits': 0, 'events': []}
                    with contextlib.redirect_stderr(io.StringIO()):
                        code, report = agent.run(args, detector=lambda _: [
                            {'cls': 'fire', 'conf': .8, 'bbox_xyxy': [1, 2, 10, 12]}],
                            capture_factory=Capture, transport=Transport())
                    self.assertEqual(code, 1)
                    self.assertEqual(report['uploaded'], 1)
                    self.assertEqual(len(sent), 1)
                    self.assertGreater(report['evidence_errors'], 0)
                    self.assertEqual(report['evidence']['saved_frames'], 0)
                    self.assertIsNone(report['records'][0].get('evidence'))
                    self.assertEqual(report['records'][0]['status'], 'uploaded')
                    self.assertNotIn('secret', json.dumps(report))
            self.assertEqual(file_root.read_text(), 'do not touch')

    def test_systemd_stores_evidence_in_writable_per_camera_state_directory(self):
        service = (ROOT / 'edge/fire-guard-edge@.service').read_text()
        self.assertIn('StateDirectory=fire-guard', service)
        self.assertIn('Environment=EDGE_EVIDENCE_DIR=/var/lib/fire-guard/evidence/%i', service)
        self.assertIn('ProtectSystem=strict', service)
        self.assertNotIn('ReadWritePaths=/opt/fire', service)

    def test_cloud_confirmed_without_local_candidate_opens_bundle_in_default_run_flow(self):
        from edge import agent
        class Capture:
            def __init__(self, _): self.done = False
            def isOpened(self): return True
            def read(self):
                if self.done: return False, None
                self.done = True
                return True, np.zeros((16, 24, 3), np.uint8)
            def get(self, prop): return 1. if prop == cv2.CAP_PROP_FPS else 0.
            def release(self): pass
        class Transport:
            def send(self, payload):
                return {'camera_id': 'cam-1', 'alert': 'confirmed', 'hits': 2, 'events': ['fire_confirmed']}
        with tempfile.TemporaryDirectory(dir=SCRATCH) as tmp:
            args = agent.parse_args(['--video', 'ignored', '--camera', 'cam-1',
                '--worker', 'https://example.com', '--evidence-dir', tmp], environ={'INGEST_API_KEY': 'secret'})
            code, report = agent.run(args, detector=lambda _: [], capture_factory=Capture, transport=Transport())
            self.assertEqual(code, 0)
            manifest = json.loads(next(Path(tmp).rglob('manifest.json')).read_text())
            self.assertEqual(manifest['trigger'], 'cloud_confirmed')
            self.assertEqual(manifest['cloud']['alert'], 'confirmed')
            self.assertEqual(manifest['frames'][0]['detections'], [])
            self.assertEqual(report['evidence']['saved_frames'], 1)
            self.assertFalse(manifest['local_alarm'])


if __name__ == '__main__':
    unittest.main()
