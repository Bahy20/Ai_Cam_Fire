"""Deterministic edge contract tests; never load weights or contact a camera."""
import base64
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
SCRATCH = Path(tempfile.gettempdir())
sys.path.insert(0, str(ROOT))
from edge import agent


class EdgeTestCase(unittest.TestCase):
    def setUp(self):
        import tempfile
        directory = tempfile.TemporaryDirectory(dir=SCRATCH)
        self.addCleanup(directory.cleanup)
        self.evidence_dir = Path(directory.name) / 'evidence'

    def parse_args(self, argv, **kwargs):
        return agent.parse_args(argv + ['--evidence-dir', str(self.evidence_dir)], **kwargs)


class ObservationTests(EdgeTestCase):
    def test_jpeg_pixels_are_the_inference_pixels_and_unknowns_stay_unknown(self):
        self.assertTrue(callable(getattr(agent, 'build_observation', None)),
                        'local JPEG observation builder is missing')
        frame = np.random.default_rng(17).integers(0, 256, (32, 48, 3), dtype=np.uint8)
        seen = []
        def detector(image):
            seen.append(image.copy())
            return [{'cls': 'fire', 'conf': .5, 'bbox_xyxy': [1, 2, 12, 20]}]
        payload, timing = agent.build_observation(frame, detector, 'cam-1', 1234, width=24)
        jpeg = base64.b64decode(payload['jpeg_b64'])
        decoded = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
        np.testing.assert_array_equal(seen[0], decoded)
        self.assertEqual(payload['frame_wh'], [24, 16])
        self.assertEqual(payload['camera_id'], 'cam-1')
        self.assertEqual(payload['ts_ms'], 1234)
        self.assertEqual(payload['detections'][0]['cls'], 'fire')
        self.assertNotEqual(payload.get('visibility'), 'adequate')
        self.assertIsNone(payload.get('camera_motion'))
        self.assertEqual(timing['quality'], {
            'stability': 'unknown', 'blur_score': None, 'occlusion': 'unknown'})
        self.assertIn('quality_profile_missing', timing['quality_reasons'])
        self.assertIn('laplacian_variance', timing['quality_metrics'])
        self.assertGreaterEqual(timing['inference_ms'], 0)
        self.assertGreaterEqual(timing['quality_ms'], 0)

    def test_unusable_edge_frame_is_degraded_and_quality_metadata_stays_local(self):
        frame = np.zeros((32, 48, 3), np.uint8)
        payload, timing = agent.build_observation(
            frame, lambda _: [{'cls':'fire','conf':.5,'bbox_xyxy':[1,2,12,20]}], 'cam-1', 1234)
        self.assertEqual(payload['visibility'], 'degraded')
        self.assertIn('uniform_extreme_luminance', timing['quality_reasons'])
        self.assertNotIn('quality_metrics', payload)
        self.assertNotIn('quality_reasons', payload)

    def test_v2_batch_transport_hash_and_activation_retry_reuse_durable_session_identity(self):
        import json
        from types import SimpleNamespace
        self.assertEqual(agent.observation_batch_hash({
            'protocol_version':2,'session_id':'2cf1a098-15d8-45bc-96f1-87f776ec3611','generation':1,
            'batch_sequence':1,'clock_mode':'live','payload_hash':'0'*64,'samples':[{
                'attempt_sequence':1,'ts_ms':1700000000123,'status':'ok','frame_wh':[100,80],
                'detections':[{'cls':'fire','conf':.8,'bbox_xyxy':[10.25,10,30,30]}],
                'jpeg_sha256':'a'*64,'local_image_available':True,'visibility':'adequate','camera_motion':False,
                'quality':{'stability':'stable','blur_score':.1,'occlusion':'none'},'reason':None}]}),
            'bbc1ec322d455f242a9c7d3e9a5edfb846b1be0bd9f8d72f465eb5f793530383')
        class Session:
            def __init__(self,responses): self.responses=iter(responses); self.calls=[]
            def post(self,url,**kwargs):
                self.calls.append((url,kwargs))
                value=next(self.responses)
                if isinstance(value,Exception): raise value
                return SimpleNamespace(status_code=200,json=lambda:value)
        session_id='2cf1a098-15d8-45bc-96f1-87f776ec3611'
        path=self.evidence_dir.parent/'session.json'
        first=agent.V2ObservationTransport('https://worker.example','secret',session=Session([
            RuntimeError('lost response')]),attempts=1,sleep=lambda _:None)
        with self.assertRaises(agent.UploadError): first.activate('cam',path)
        pending=json.loads(path.read_text())
        self.assertEqual(pending['pending_expected_generation'],0)
        retry_session=Session([{'protocol_version':2,'session_id':pending['pending_session_id'],
            'generation':1,'idempotent':True}])
        transport=agent.V2ObservationTransport('https://worker.example','secret',session=retry_session,attempts=1)
        active=transport.activate('cam',path)
        self.assertEqual(active['generation'],1)
        self.assertEqual(active['session_id'],pending['pending_session_id'])
        self.assertEqual(json.loads(path.read_text())['generation'],1)
        sample={'attempt_sequence':1,'ts_ms':1700000000123,'status':'gap','frame_wh':None,'detections':None,
            'jpeg_sha256':None,'local_image_available':False,'visibility':'unknown','camera_motion':None,
            'quality':{'stability':'unknown','blur_score':None,'occlusion':'unknown'},'reason':'capture_failed'}
        body={'protocol_version':2,'session_id':active['session_id'],'generation':1,'batch_sequence':1,
            'clock_mode':'live','payload_hash':'0'*64,'samples':[sample]}
        retry_session.responses=iter([{'protocol_version':2,'session_id':active['session_id'],'generation':1,
            'batch_sequence':1,'payload_hash':agent.observation_batch_hash(body),'accepted_through':1,
            'dispositions':[{'attempt_sequence':1,'status':'gap'}],
            'final_state':{'alert':'idle','incident_id':None,'last_observation_ts':None,'hits':0},
            'event_watermark':0,'events':[],'pending_evidence_requests':[]}])
        ack=transport.send_batch(body)
        self.assertEqual(ack['accepted_through'],1)
        self.assertTrue(retry_session.calls[-1][0].endswith('/v2/observations/camera/cam'))
        self.assertEqual(retry_session.calls[-1][1]['json']['payload_hash'],agent.observation_batch_hash(body))

    def test_import_has_no_signal_registration_or_heavy_model_import(self):
        result = subprocess.run([sys.executable, '-c',
            "import signal; before=signal.getsignal(signal.SIGTERM); import edge.agent; "
            "assert signal.getsignal(signal.SIGTERM)==before; import sys; "
            "assert 'ultralytics' not in sys.modules; assert 'torch' not in sys.modules"],
            cwd=ROOT, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)


class YoloTests(EdgeTestCase):
    def test_local_cpu_model_keeps_low_confidence_and_bounded_wire_boxes(self):
        self.assertTrue(callable(getattr(agent, 'YoloDetector', None)), 'local adapter missing')
        from types import SimpleNamespace
        calls = []
        def box(cls, conf, xyxy):
            return SimpleNamespace(cls=np.array([cls]), conf=np.array([conf]), xyxy=np.array([xyxy]))
        boxes = [box(0, .05, [-5, 1, 99, 12]), box(1, .8, [1, 2, 10, 12]),
                 box(0, .049, [1, 2, 10, 12]), box(2, .9, [1, 2, 10, 12]),
                 box(0, float('nan'), [1, 2, 10, 12]), box(0, .8, [5, 5, 1, 1])]
        class Model:
            names = {0: 'fire', 1: 'smoke', 2: 'person'}
            def predict(self, image, **kwargs):
                calls.append(kwargs)
                return [SimpleNamespace(boxes=boxes, names=self.names)]
        loaded = []
        def factory(path):
            loaded.append(path)
            return Model()
        detector = agent.YoloDetector(ROOT / 'detector/fire_seg.pt', model_factory=factory,
                                      device='cpu', imgsz=320, max_det=2)
        detections = detector(np.zeros((20, 30, 3), np.uint8))
        self.assertEqual(len(loaded), 1)
        self.assertEqual(calls[0]['conf'], .05)
        self.assertEqual(calls[0]['max_det'], 2)
        self.assertEqual(calls[0]['device'], 'cpu')
        self.assertEqual(calls[0]['imgsz'], 320)
        self.assertEqual(detections, [
            {'cls': 'fire', 'conf': .05, 'bbox_xyxy': [0.0, 1.0, 30.0, 12.0]},
            {'cls': 'smoke', 'conf': .8, 'bbox_xyxy': [1.0, 2.0, 10.0, 12.0]}])


class ConfigurationTransportTests(EdgeTestCase):
    def test_cli_defaults_cpu_env_key_and_validates_finite_ranges_and_https(self):
        self.assertTrue(callable(getattr(agent, 'parse_args', None)), 'validated CLI missing')
        import contextlib
        import io
        base = ['--video', 'example.mp4', '--camera', 'cam-1', '--dry-run']
        args = self.parse_args(base, environ={})
        self.assertEqual(args.device, 'cpu')
        self.assertEqual(args.model, ROOT / 'detector/fire_seg.pt')
        self.assertIsNone(args.handheld_model)
        self.assertIsNone(args.handheld_model_sha256)
        self.assertEqual(args.max_det, 256)
        self.assertFalse(args.realtime)
        camera = self.parse_args(['--camera-index','0','--camera','live-test','--dry-run'],environ={})
        self.assertEqual(camera.camera_index,0)
        self.assertIsNone(camera.video)
        self.assertIsNone(camera.rtsp)
        network = ['--video', 'example.mp4', '--camera', 'cam-1', '--worker', 'https://example.com']
        args = self.parse_args(network, environ={'INGEST_API_KEY': 'not-a-real-key'})
        self.assertEqual(args.api_key, 'not-a-real-key')
        pinned = self.parse_args(base + ['--handheld-model','lighter.pt','--handheld-model-sha256','a'*64],
                                 environ={})
        self.assertEqual(pinned.handheld_model, Path('lighter.pt'))
        self.assertEqual(pinned.handheld_model_sha256, 'a'*64)
        for invalid in [['--fps', 'nan'], ['--fps', 'inf'], ['--fps', '0'],
                        ['--width', '-1'], ['--imgsz', '0'], ['--max-det', '257'],
                        ['--jpeg-quality', '101'], ['--max-frames', '0'],
                        ['--timeout', '-1'], ['--attempts', '0'], ['--attempts', '11']]:
            with self.subTest(invalid=invalid), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    self.parse_args(base + invalid, environ={})
        for invalid in [['--handheld-model','lighter.pt'],
                        ['--handheld-model-sha256','a'*64],
                        ['--handheld-model','lighter.pt','--handheld-model-sha256','A'*64],
                        ['--handheld-model','lighter.pt','--handheld-model-sha256','a'*64,'--device','cuda']]:
            with self.subTest(invalid=invalid), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    self.parse_args(base + invalid, environ={})
        for worker in ['http://example.com', 'https://user:pass@example.com',
                       'https://example.com?key=secret', 'file:///tmp/data']:
            with self.subTest(worker=worker), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    self.parse_args(network[:-1] + [worker], environ={'INGEST_API_KEY': 'x'})
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            self.parse_args(network, environ={})
        local = self.parse_args(network[:-1] + ['http://127.0.0.1:8791', '--allow-http'],
                                 environ={'INGEST_API_KEY': 'x'})
        self.assertTrue(local.allow_http)

    def test_post_retries_are_bounded_redirects_never_follow_and_errors_are_sanitized(self):
        self.assertTrue(callable(getattr(agent, 'ObservationTransport', None)), 'transport missing')
        from types import SimpleNamespace
        class Session:
            def __init__(self, statuses):
                self.statuses = iter(statuses)
                self.calls = []
            def post(self, url, **kwargs):
                self.calls.append((url, kwargs))
                status = next(self.statuses)
                if isinstance(status, Exception):
                    raise status
                return SimpleNamespace(status_code=status, json=lambda: {
                    'camera_id': 'cam/1', 'alert': 'idle', 'hits': 0, 'events': []})
        session = Session([503, 200])
        transport = agent.ObservationTransport('https://example.com', 'secret',
                    session=session, attempts=2, sleep=lambda _: None)
        response = transport.send({'camera_id': 'cam/1'})
        self.assertEqual(response['alert'], 'idle')
        self.assertEqual(len(session.calls), 2)
        url, kwargs = session.calls[-1]
        self.assertEqual(url, 'https://example.com/observation/camera/cam%2F1')
        self.assertFalse(kwargs['allow_redirects'])
        self.assertEqual(kwargs['headers'], {'x-api-key': 'secret'})
        for statuses, count in [([302], 1), ([401], 1), ([503, 503], 2),
                                ([RuntimeError('secret rtsp://user:pass@cam/live')] * 2, 2)]:
            with self.subTest(statuses=statuses):
                session = Session(statuses)
                transport = agent.ObservationTransport('https://example.com', 'secret',
                            session=session, attempts=2, sleep=lambda _: None)
                with self.assertRaises(agent.UploadError) as exc:
                    transport.send({'camera_id': 'cam/1'})
                self.assertNotIn('secret', str(exc.exception))
                self.assertNotIn('rtsp://', str(exc.exception))
                self.assertEqual(len(session.calls), count)


class ReplayTests(EdgeTestCase):
    def test_actual_video_samples_source_time_exits_eof_and_writes_json_report(self):
        self.assertTrue(callable(getattr(agent, 'run', None)), 'replay runner missing')
        import tempfile
        import json
        with tempfile.TemporaryDirectory(dir=SCRATCH) as directory:
            directory = Path(directory)
            video = directory / 'source.avi'
            writer = cv2.VideoWriter(str(video), cv2.VideoWriter_fourcc(*'MJPG'), 10., (32, 24))
            self.assertTrue(writer.isOpened())
            for index in range(10):
                writer.write(np.full((24, 32, 3), index * 20, dtype=np.uint8))
            writer.release()
            report_path, output_path = directory / 'report.json', directory / 'frames.jsonl'
            args = self.parse_args(['--video', str(video), '--camera', 'replay', '--dry-run',
                                    '--fps', '3', '--start-ts-ms', '1000000',
                                    '--report', str(report_path), '--output', str(output_path)], environ={})
            seen = []
            def detector(frame):
                seen.append(frame.shape)
                return []
            def no_sleep(_):
                self.fail('file replay must not pace unless --realtime')
            code, report = agent.run(args, detector=detector, sleep=no_sleep)
            self.assertEqual(code, 0)
            self.assertEqual(report['frames_read'], 10)
            self.assertEqual(report['frames_sampled'], 3)
            self.assertEqual(report['inferred'], 3)
            self.assertEqual(report['uploaded'], 0)
            self.assertEqual(report['source']['kind'], 'video')
            self.assertEqual(report['source']['input'], str(video))
            self.assertEqual(report['device'], 'cpu')
            self.assertEqual([r['source_frame_index'] for r in report['records']], [0, 4, 7])
            self.assertEqual([r['ts_ms'] for r in report['records']], [1000000, 1000400, 1000700])
            self.assertEqual(json.loads(report_path.read_text())['frames_read'], 10)
            self.assertEqual(len(output_path.read_text().splitlines()), 3)
            self.assertTrue(all(r['inference_ms'] >= 0 for r in report['records']))
            self.assertEqual(len(seen), 3)
            args.max_frames = 2
            code, report = agent.run(args, detector=detector, sleep=no_sleep)
            self.assertEqual(code, 0)
            self.assertEqual(report['frames_sampled'], 2)
            self.assertEqual(report['frames_read'], 5)

    def test_inference_failure_never_uploads_negative_and_cloud_failure_is_nonzero(self):
        self.assertTrue(callable(getattr(agent, 'run', None)), 'runner missing')
        import contextlib
        import io
        class Capture:
            def __init__(self, source):
                self.index = 0
                self.released = False
            def isOpened(self):
                return True
            def read(self):
                self.index += 1
                return (True, np.zeros((24, 32, 3), np.uint8)) if self.index == 1 else (False, None)
            def get(self, prop):
                return 10. if prop == cv2.CAP_PROP_FPS else 0.
            def release(self):
                self.released = True
        class Transport:
            def __init__(self):
                self.sent = []
            def send(self, payload):
                self.sent.append(payload)
                raise agent.UploadError('cloud_network_error')
        args = self.parse_args(['--video', 'ignored.avi', '--camera', 'test', '--worker',
                                 'https://example.com'], environ={'INGEST_API_KEY': 'secret'})
        transport = Transport()
        def broken_detector(_):
            raise RuntimeError('rtsp://user:password@camera secret')
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            code, report = agent.run(args, detector=broken_detector,
                                     capture_factory=Capture, transport=transport)
        self.assertEqual(code, 1)
        self.assertEqual(report['inference_errors'], 1)
        self.assertEqual(transport.sent, [])
        self.assertNotIn('detections', report['records'][0])
        self.assertNotIn('password', stderr.getvalue())
        self.assertNotIn('secret', str(report))
        with contextlib.redirect_stderr(stderr):
            code, report = agent.run(args, detector=lambda _: [],
                                     capture_factory=Capture, transport=transport)
        self.assertEqual(code, 1)
        self.assertEqual(report['upload_errors'], 1)
        self.assertEqual(len(transport.sent), 1)
        self.assertIn('cloud offline', stderr.getvalue().lower())
        self.assertIn('no local alarm', stderr.getvalue().lower())


class EdgeLifecycleTests(EdgeTestCase):
    def test_cli_help_and_failed_source_exit_nonzero_with_report(self):
        import tempfile
        import json
        help_result = subprocess.run([sys.executable, 'edge/agent.py', '--help'], cwd=ROOT,
                                      capture_output=True, text=True)
        self.assertIn('--dry-run', help_result.stdout)
        with tempfile.TemporaryDirectory(dir=SCRATCH) as directory:
            report = Path(directory) / 'report.json'
            result = subprocess.run([sys.executable, 'edge/agent.py', '--video',
                    str(Path(directory) / 'nonexistent.avi'), '--camera', 'empty',
                    '--dry-run', '--report', str(report), '--evidence-dir', str(self.evidence_dir)],
                    cwd=ROOT, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            body = json.loads(report.read_text())
            self.assertEqual(body['frames_sampled'], 0)
            self.assertIn('zero_sampled_frames', body['errors'])

    def test_rtsp_from_environment_and_native_capture_logs_are_not_leaked(self):
        import contextlib
        import io
        secret_url = 'rtsp://username:password@camera/live'
        with contextlib.redirect_stderr(io.StringIO()):
            try:
                args = self.parse_args(['--camera', 'cam', '--dry-run', '--max-frames', '1'],
                                        environ={'EDGE_RTSP_URL': secret_url})
            except SystemExit:
                self.fail('environment RTSP source must support systemd without credential argv')
        stderr = io.StringIO()
        def noisy_capture(source):
            print(source, file=sys.stderr)
            raise RuntimeError(source)
        with contextlib.redirect_stderr(stderr):
            code, report = agent.run(args, detector=lambda _: [], capture_factory=noisy_capture)
        self.assertEqual(code, 1)
        self.assertNotIn('password', stderr.getvalue())
        self.assertNotIn('username', str(report))

    def test_inference_adapter_does_not_convert_missing_result_to_empty_success(self):
        from types import SimpleNamespace
        for result in [[], [SimpleNamespace(boxes=None, names={0: 'fire'})]]:
            class Model:
                def predict(self, *_args, **_kwargs):
                    return result
            detector = agent.YoloDetector(ROOT / 'detector/fire_seg.pt', model_factory=lambda _: Model())
            with self.subTest(result=result), self.assertRaises(Exception):
                detector(np.zeros((24, 32, 3), np.uint8))


class TimingAndProtocolRegressionTests(EdgeTestCase):
    def test_invalid_model_schema_or_nonfinite_prediction_is_not_a_negative(self):
        from types import SimpleNamespace
        for names, boxes in [({0: 'person'}, []), ({0: 'fire', 1: 'smoke'}, [
                SimpleNamespace(cls=np.array([0]), conf=np.array([float('nan')]),
                                xyxy=np.array([[1, 2, 10, 12]]))])]:
            class Model:
                def predict(self, *_args, **_kwargs):
                    return [SimpleNamespace(names=names, boxes=boxes)]
            detector = agent.YoloDetector(ROOT / 'detector/fire_seg.pt', model_factory=lambda _: Model())
            with self.subTest(names=names), self.assertRaises(ValueError):
                detector(np.zeros((24, 32, 3), np.uint8))

    def test_cleanup_failure_still_produces_nonzero_structured_report(self):
        import contextlib
        import io
        class Capture:
            def __init__(self, _):
                pass
            def isOpened(self):
                return True
            def get(self, _):
                return 30.
            def read(self):
                return False, None
            def release(self):
                raise RuntimeError('rtsp://user:password@camera/live')
        args = self.parse_args(['--video', 'ignored', '--camera', 'test', '--dry-run'], environ={})
        with contextlib.redirect_stderr(io.StringIO()):
            try:
                code, report = agent.run(args, detector=lambda _: [], capture_factory=Capture)
            except RuntimeError:
                self.fail('cleanup exception escaped instead of producing a structured failure report')
        self.assertEqual(code, 1)
        self.assertIn('capture_release_failed', report['errors'])
        self.assertNotIn('password', str(report))

    def test_fractional_deadlines_keep_boundary_frames_and_report_latency(self):
        class Capture:
            def __init__(self, _):
                self.index = -1
            def isOpened(self):
                return True
            def get(self, prop):
                return 3. if prop == cv2.CAP_PROP_FPS else self.index * 1000 / 3
            def read(self):
                self.index += 1
                return (True, np.zeros((16, 24, 3), np.uint8)) if self.index < 9 else (False, None)
            def release(self):
                pass
        args = self.parse_args(['--video', 'ignored', '--camera', 'test', '--dry-run', '--fps', '3'], environ={})
        code, report = agent.run(args, detector=lambda _: [], capture_factory=Capture)
        self.assertEqual(code, 0)
        self.assertEqual([r['source_frame_index'] for r in report['records']], list(range(9)))
        self.assertTrue(all(r['total_ms'] >= r['inference_ms'] for r in report['records']))

    def test_invalid_cloud_success_body_is_not_success(self):
        from types import SimpleNamespace
        class Session:
            def post(self, *_args, **_kwargs):
                return SimpleNamespace(status_code=200, json=lambda: {'error': 'not_ingested'})
        transport = agent.ObservationTransport('https://example.com', 'key', session=Session(),
                                               attempts=1)
        with self.assertRaises(agent.UploadError):
            transport.send({'camera_id': 'test'})

    def test_capture_has_bounded_open_and_read_timeout(self):
        self.assertTrue(callable(getattr(agent, 'open_capture', None)), 'bounded native capture missing')
        calls = []
        class CV:
            CAP_FFMPEG = 1
            CAP_PROP_OPEN_TIMEOUT_MSEC = 2
            CAP_PROP_READ_TIMEOUT_MSEC = 3
            def VideoCapture(self, *args):
                calls.append(args)
                return object()
        agent.open_capture('rtsp://camera/live', timeout=2., cv=CV())
        self.assertEqual(calls, [('rtsp://camera/live', 1, [2, 2000, 3, 2000])])

    def test_local_camera_uses_platform_camera_backend(self):
        calls=[]
        class CV:
            CAP_DSHOW=700
            CAP_V4L2=800
            CAP_ANY=0
            def VideoCapture(self,*args): calls.append(args); return object()
        agent.open_capture(0,timeout=2.,cv=CV())
        expected_backend=700 if sys.platform=='win32' else 800
        self.assertEqual(calls,[(0,expected_backend)])


class ProtocolIntegrationTests(EdgeTestCase):
    def test_real_http_posts_jpeg_aligned_observation_and_does_not_follow_redirect(self):
        import json
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        received = []
        class Handler(BaseHTTPRequestHandler):
            redirect = False
            def log_message(self, *_):
                pass
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['content-length'])))
                received.append((self.path, self.headers.get('x-api-key'), body))
                if self.redirect:
                    self.send_response(302)
                    self.send_header('Location', '/credential-sink')
                    self.end_headers()
                    return
                response = json.dumps({'camera_id': 'contract', 'alert': 'idle',
                                       'hits': 0, 'events': []}).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(response)))
                self.end_headers()
                self.wfile.write(response)
            def do_GET(self):
                received.append(('unexpected-followed-get', None, None))
                self.send_response(500)
                self.end_headers()
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            detector_pixels = []
            def detector(image):
                detector_pixels.append(image.copy())
                return [{'cls': 'smoke', 'conf': .06, 'bbox_xyxy': [1, 2, 10, 12]}]
            payload, _ = agent.build_observation(np.full((24, 32, 3), 180, np.uint8),
                                                 detector, 'contract', 1000)
            transport = agent.ObservationTransport(f'http://127.0.0.1:{server.server_port}',
                                                   'synthetic-key', attempts=1)
            self.assertEqual(transport.send(payload)['events'], [])
            self.assertEqual(received[0][0], '/observation/camera/contract')
            self.assertEqual(received[0][1], 'synthetic-key')
            sent = received[0][2]
            decoded = cv2.imdecode(np.frombuffer(base64.b64decode(sent['jpeg_b64']), np.uint8),
                                    cv2.IMREAD_COLOR)
            self.assertEqual(sent['frame_wh'], [decoded.shape[1], decoded.shape[0]])
            np.testing.assert_array_equal(decoded, detector_pixels[0])
            self.assertEqual(sent['visibility'], 'unknown')
            self.assertIsNone(sent['camera_motion'])
            Handler.redirect = True
            with self.assertRaises(agent.UploadError):
                transport.send(payload)
            self.assertEqual(len(received), 2)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == '__main__':
    unittest.main()
