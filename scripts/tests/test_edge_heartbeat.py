"""PC-only heartbeat contracts; no Pi camera/model or external network."""
import importlib
import importlib.util
from pathlib import Path
import sys
import unittest
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))


def heartbeat_module(case):
    case.assertIsNotNone(importlib.util.find_spec('edge.heartbeat'), 'outbound heartbeat component must exist')
    return importlib.import_module('edge.heartbeat')


class HeartbeatTransportTests(unittest.TestCase):
    def test_exact_imagefree_payload_timeout_no_proxy_or_redirect_and_sanitized_failure(self):
        module = heartbeat_module(self)
        class Session:
            trust_env = True
            def __init__(self): self.calls = []; self.status = 204
            def post(self, url, **kwargs):
                self.calls.append((url, kwargs))
                if self.status == 'error': raise RuntimeError('rtsp://secret password key')
                return SimpleNamespace(status_code=self.status, close=lambda: None)
        session = Session()
        sender = module.HeartbeatTransport('https://example.com/', 'secret', session=session, timeout=2)
        body = {'camera_id': 'Cam_1', 'heartbeat_id': '00000000-0000-4000-8000-000000000001',
                'sent_at_ms': 100000, 'status': 'stalled'}
        self.assertTrue(sender.send(body))
        self.assertFalse(session.trust_env)
        url, kwargs = session.calls[0]
        self.assertEqual(url, 'https://example.com/heartbeat/camera/Cam_1')
        self.assertEqual(kwargs, {'json': body, 'headers': {'x-api-key': 'secret'},
                                  'timeout': (2, 2), 'allow_redirects': False, 'stream': True})
        for status in (302, 401, 503, 'error'):
            session.status = status
            with self.assertRaisesRegex(module.HeartbeatError, '^heartbeat_send_failed$'):
                sender.send(body)
        self.assertEqual(len(session.calls), 5, 'one attempt per beat; no retry queue')


    def test_real_http_uses_key_rejects_redirect_and_times_out_without_body_buffering(self):
        module = heartbeat_module(self)
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        import threading
        import json
        import time
        received = []
        class Handler(BaseHTTPRequestHandler):
            status = 204
            delay = 0
            def log_message(self, *_): pass
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                received.append((self.path, self.headers.get('x-api-key'), body))
                time.sleep(self.delay)
                self.send_response(self.status)
                self.send_header('Location', '/credential-sink')
                self.end_headers()
            def do_GET(self):
                received.append(('redirect-followed', None, None))
                self.send_response(500)
                self.end_headers()
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        transport = module.HeartbeatTransport(f'http://127.0.0.1:{server.server_port}', 'synthetic-key', timeout=.05)
        beat = module.ProgressHeartbeat('https://unused.example', 'unused', 'Cam_1', transport=transport)
        body = beat.payload()
        try:
            self.assertTrue(transport.send(body))
            self.assertEqual(received, [('/heartbeat/camera/Cam_1', 'synthetic-key', body)])
            Handler.status = 302
            with self.assertRaises(module.HeartbeatError): transport.send(body)
            self.assertEqual(len(received), 2)
            Handler.status, Handler.delay = 204, .2
            started = time.monotonic()
            with self.assertRaises(module.HeartbeatError): transport.send(body)
            self.assertLess(time.monotonic() - started, 1.)
            self.assertEqual(len(received), 3)
        finally:
            transport.session.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


class ProgressTests(unittest.TestCase):
    def test_largest_supported_interval_has_transport_margin_before_server_expiry(self):
        from edge import agent
        import contextlib
        import io
        import re
        source=(ROOT/'worker/src/camera-health.js').read_text(encoding='utf-8')
        offline_ms=int(re.search(r'offlineMs:\s*(\d+)',source).group(1))
        args=agent.parse_args(['--video','unused','--camera','cam','--dry-run','--heartbeat-interval','30'],environ={})
        self.assertLess(args.heartbeat_interval*1000+20000,offline_ms)
        for interval in ('30.01','60'):
            with contextlib.redirect_stderr(io.StringIO()),self.assertRaises(SystemExit):
                agent.parse_args(['--video','unused','--camera','cam','--dry-run','--heartbeat-interval',interval],environ={})
            with self.assertRaises(ValueError):
                heartbeat_module(self).ProgressHeartbeat('https://unused.example','key','cam',interval=float(interval))

    def test_send_duration_does_not_accumulate_into_heartbeat_cadence(self):
        module=heartbeat_module(self);now=[100.];starts=[]
        class Stop:
            def is_set(self): return False
            def wait(self,delay): now[0]+=delay;return len(starts)>=3
        class Sender:
            def send(self,_): starts.append(now[0]);now[0]+=.25
        beats=module.ProgressHeartbeat('https://unused.example','key','cam',interval=1.,transport=Sender(),clock=lambda:now[0])
        beats._stop=Stop();beats._run()
        self.assertEqual(starts,[100.,101.,102.])

    def test_direct_configuration_cannot_create_unbounded_or_invalid_producer(self):
        module = heartbeat_module(self)
        for kwargs in ({'interval': 0}, {'interval': float('nan')}, {'interval': 61},
                       {'stall_seconds': float('inf')}, {'stall_seconds': 301}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                module.ProgressHeartbeat('https://example.com', 'key', 'Cam_1', **kwargs)
        for camera in ('', ' bad', 'cam/1', 'x' * 129, 'cam\n'):
            with self.subTest(camera=camera), self.assertRaises(ValueError):
                module.ProgressHeartbeat('https://example.com', 'key', camera)
        for timeout in (0, float('nan'), 11):
            with self.subTest(timeout=timeout), self.assertRaises(ValueError):
                module.HeartbeatTransport('https://example.com', 'key', timeout=timeout)

    def test_progress_is_required_and_latest_stage_failure_only_clears_on_that_stage_success(self):
        module = heartbeat_module(self)
        now = [100.]
        beats = module.ProgressHeartbeat('https://example.com', 'key', 'Cam_1',
                    clock=lambda: now[0], wall_clock=lambda: 1000., transport=SimpleNamespace(send=lambda _: True))
        self.assertEqual(beats.status(), 'stalled')
        for stage in ('capture', 'inference', 'storage'): beats.progress(stage)
        self.assertEqual(beats.status(), 'ok')
        beats.fail('storage')
        beats.progress('capture')
        beats.progress('inference')
        self.assertEqual(beats.status(), 'storage_error')
        beats.fail('inference')
        self.assertEqual(beats.status(), 'inference_error')
        beats.progress('inference')
        self.assertEqual(beats.status(), 'storage_error')
        beats.progress('storage')
        self.assertEqual(beats.status(), 'ok')
        now[0] += 30
        self.assertEqual(beats.status(), 'stalled', 'alive process is not pipeline progress')
        body = beats.payload()
        self.assertEqual(set(body), {'camera_id', 'heartbeat_id', 'sent_at_ms', 'status'})
        import uuid
        self.assertEqual(uuid.UUID(body['heartbeat_id']).version, 4)
        self.assertEqual(body['sent_at_ms'], 1000000)
        self.assertEqual(body['status'], 'stalled')
        self.assertNotEqual(beats.payload()['heartbeat_id'], body['heartbeat_id'])


    def test_owned_thread_never_overlaps_requests_and_stop_is_bounded_and_idempotent(self):
        module = heartbeat_module(self)
        import threading
        import time
        entered, release = threading.Event(), threading.Event()
        calls = []
        class Transport:
            def send(self, payload):
                calls.append(payload)
                entered.set()
                release.wait(2)
                raise RuntimeError('rtsp://password secret-key')
        beats = module.ProgressHeartbeat('https://example.com', 'key', 'Cam_1',
                    interval=.05, stall_seconds=.05, transport=Transport())
        beats.start()
        beats.start()
        self.assertTrue(entered.wait(1))
        beats.fail('storage')
        time.sleep(.12)
        self.assertEqual(len(calls), 1)
        started = time.monotonic()
        self.assertFalse(beats.stop(timeout=.05))
        self.assertLess(time.monotonic() - started, .5)
        release.set()
        self.assertTrue(beats.stop(timeout=1))
        self.assertTrue(beats.stop(timeout=1))
        self.assertEqual(len(calls), 2, 'one original attempt followed by one serialized final-failure attempt')
        self.assertEqual(calls[-1]['status'], 'storage_error')
        self.assertEqual(beats.send_errors, 2)
        self.assertEqual(beats.status(), 'storage_error')


    def test_background_reports_stalled_pipeline_even_while_process_thread_is_alive(self):
        module = heartbeat_module(self)
        import threading
        condition = threading.Condition()
        statuses = []
        now = [100.]
        class Transport:
            def send(self, payload):
                with condition:
                    statuses.append(payload['status'])
                    condition.notify_all()
        beats = module.ProgressHeartbeat('https://unused.example', 'key', 'Cam_1',
                    interval=.05, clock=lambda: now[0], transport=Transport())
        for stage in beats.STAGES: beats.progress(stage)
        try:
            beats.start()
            with condition: self.assertTrue(condition.wait_for(lambda: 'ok' in statuses, timeout=1))
            now[0] += 30
            with condition: self.assertTrue(condition.wait_for(lambda: 'stalled' in statuses, timeout=1))
            beats.fail('inference')
            with condition: self.assertTrue(condition.wait_for(lambda: 'inference_error' in statuses, timeout=1))
            self.assertTrue(beats._thread.is_alive())
        finally: self.assertTrue(beats.stop())


class AgentHeartbeatTests(unittest.TestCase):
    def test_terminal_capture_failure_is_attempted_on_the_owned_sender_before_shutdown(self):
        from edge import agent
        from edge.heartbeat import ProgressHeartbeat
        import tempfile
        import numpy as np
        import threading
        import contextlib
        import io
        healthy=threading.Event();payloads=[];made=[]
        class Sender:
            def send(self,payload):
                payloads.append(payload)
                if payload['status']=='ok': healthy.set()
        def factory(*args,**kwargs):
            beat=ProgressHeartbeat(*args,**kwargs,transport=Sender());made.append(beat);return beat
        class Capture:
            def __init__(self,_): self.frames=0
            def isOpened(self): return True
            def get(self,_): return 1.
            def read(self):
                self.frames+=1
                if self.frames==1:return True,np.zeros((16,24,3),np.uint8)
                healthy.wait(1)
                return False,None
            def release(self):pass
        with tempfile.TemporaryDirectory(dir=tempfile.gettempdir()) as tmp:
            args=agent.parse_args(['--rtsp','rtsp://camera/live','--camera','Cam_1','--worker','https://example.com',
                '--heartbeat-interval','.05','--evidence-dir',tmp],environ={'INGEST_API_KEY':'test-key'})
            with contextlib.redirect_stderr(io.StringIO()):
                code,_=agent.run(args,detector=lambda _:[],capture_factory=Capture,heartbeat_factory=factory,
                    transport=SimpleNamespace(send=lambda _:{'alert':'idle','hits':0,'events':[]}))
            self.assertTrue(healthy.is_set());self.assertEqual(code,1)
            self.assertEqual(payloads[-1]['status'],'capture_error')
            self.assertFalse(made[0]._thread.is_alive())

    def test_cli_timing_defaults_and_finite_bounds(self):
        from edge import agent
        import contextlib
        import io
        base = ['--video', 'unused', '--camera', 'cam', '--dry-run']
        args = agent.parse_args(base, environ={})
        self.assertEqual(getattr(args, 'heartbeat_interval', None), 15.)
        self.assertEqual(getattr(args, 'heartbeat_stall_seconds', None), 30.)
        for flag, maximum in [('--heartbeat-interval', '61'), ('--heartbeat-stall-seconds', '301')]:
            for value in ('0', '-1', 'nan', 'inf', maximum):
                with self.subTest(flag=flag, value=value), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                    agent.parse_args(base + [flag, value], environ={})


    def test_run_only_starts_owned_heartbeat_in_live_network_mode_and_reports_real_stage_progress(self):
        from edge import agent
        import tempfile
        import numpy as np
        import contextlib
        import io
        module = heartbeat_module(self)
        scratch = Path(tempfile.gettempdir())
        made = []
        class Beats(module.ProgressHeartbeat):
            def start(self): self.started = True
            def stop(self): self.stopped = True; return True
        def factory(*args, **kwargs):
            kwargs['transport'] = SimpleNamespace(send=lambda _: True)
            beat = Beats(*args, **kwargs)
            made.append(beat)
            return beat
        class Capture:
            def __init__(self, _): self.done = False
            def isOpened(self): return True
            def get(self, _): return 1.
            def read(self):
                if self.done: return False, None
                self.done = True
                return True, np.zeros((16, 24, 3), np.uint8)
            def release(self): pass
        statuses = []
        class Transport:
            def send(self, payload):
                statuses.append(made[-1].status() if made else None)
                return {'camera_id': 'Cam_1', 'alert': 'idle', 'hits': 0, 'events': []}
        with tempfile.TemporaryDirectory(dir=scratch) as tmp:
            for mode in ('live', 'dry', 'video'):
                made.clear()
                argv = ['--camera', 'Cam_1', '--worker', 'https://example.com', '--evidence-dir', tmp, '--max-frames', '1']
                argv += ['--video', 'ignored'] if mode == 'video' else ['--rtsp', 'rtsp://user:password@camera/live']
                if mode == 'dry': argv.append('--dry-run')
                args = agent.parse_args(argv, environ={'INGEST_API_KEY': 'secret-key'})
                with contextlib.redirect_stderr(io.StringIO()):
                    code, report = agent.run(args, detector=lambda _: [], capture_factory=Capture,
                                transport=Transport(), heartbeat_factory=factory)
                self.assertEqual(code, 0)
                self.assertNotIn('secret-key', str(report))
                self.assertEqual(len(made), 1 if mode == 'live' else 0)
                if made:
                    self.assertTrue(made[0].started)
                    self.assertTrue(made[0].stopped)
                    self.assertEqual(made[0].status(), 'ok')
                    self.assertEqual(statuses[-1], 'stalled', 'storage end_sample not yet complete at upload')


    def test_run_capture_inference_and_storage_failures_remain_visible_despite_upload_success(self):
        from edge import agent
        from edge.evidence import EvidenceRecorder
        import tempfile
        import numpy as np
        import contextlib
        import io
        from unittest.mock import patch
        module = heartbeat_module(self)
        made = []
        class Beats(module.ProgressHeartbeat):
            def start(self): pass
            def stop(self): return True
        def factory(*args, **kwargs):
            kwargs['transport'] = SimpleNamespace(send=lambda _: True)
            beat = Beats(*args, **kwargs)
            made.append(beat)
            return beat
        case = ['']
        class Capture:
            def __init__(self, _): pass
            def isOpened(self): return case[0] != 'open'
            def get(self, _): return 1.
            def read(self): return (False, None) if case[0] == 'read' else (True, np.zeros((16, 24, 3), np.uint8))
            def release(self): pass
        upload_statuses = []
        class Transport:
            def send(self, payload):
                upload_statuses.append(made[-1].status())
                return {'camera_id': 'Cam_1', 'alert': 'idle', 'hits': 0, 'events': []}
        def detector(_):
            if case[0] == 'inference': raise RuntimeError('rtsp://user:password secret-key')
            return []
        with tempfile.TemporaryDirectory(dir=tempfile.gettempdir()) as tmp:
            for failure in ('open', 'read', 'inference', 'storage_init', 'storage_write'):
                case[0] = failure
                root = Path(tmp) / failure
                if failure == 'storage_init': root.write_text('preserve')
                args = agent.parse_args(['--rtsp', 'rtsp://user:password@camera/live', '--camera', 'Cam_1',
                    '--worker', 'https://example.com', '--evidence-dir', str(root), '--max-frames', '1'],
                    environ={'INGEST_API_KEY': 'secret-key'})
                with contextlib.ExitStack() as stack:
                    if failure == 'storage_write':
                        stack.enter_context(patch.object(EvidenceRecorder, 'observe', side_effect=OSError('password secret-key')))
                    stderr = stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
                    code, report = agent.run(args, detector=detector, capture_factory=Capture,
                        transport=Transport(), heartbeat_factory=factory)
                expected = 'storage_error' if failure.startswith('storage') else 'inference_error' if failure == 'inference' else 'capture_error'
                self.assertEqual(made[-1].status(), expected, failure)
                self.assertEqual(code, 1)
                self.assertNotIn('password', stderr.getvalue())
                self.assertNotIn('secret-key', str(report))
                if failure.startswith('storage'):
                    self.assertEqual(report['uploaded'], 1)
                    self.assertEqual(upload_statuses[-1], 'storage_error')

    def test_failed_background_heartbeat_never_blocks_or_corrupts_local_evidence(self):
        from edge import agent
        import tempfile
        import numpy as np
        import threading
        import json
        import contextlib
        import io
        module = heartbeat_module(self)
        attempted = threading.Event()
        made = []
        class Offline:
            def send(self, payload):
                attempted.set()
                raise RuntimeError('rtsp://user:password secret-key')
        def factory(*args, **kwargs):
            beat = module.ProgressHeartbeat(*args, **kwargs, transport=Offline())
            made.append(beat)
            return beat
        class Capture:
            def __init__(self, _): pass
            def isOpened(self): return True
            def get(self, _): return 1.
            def read(self): return True, np.zeros((16, 24, 3), np.uint8)
            def release(self): pass
        def detector(_):
            attempted.wait(1)
            return [{'cls': 'fire', 'conf': .8, 'bbox_xyxy': [1, 2, 10, 12]}]
        with tempfile.TemporaryDirectory(dir=tempfile.gettempdir()) as tmp:
            args = agent.parse_args(['--rtsp', 'rtsp://user:password@camera/live', '--camera', 'Cam_1',
                '--worker', 'https://example.com', '--evidence-dir', tmp, '--max-frames', '1'],
                environ={'INGEST_API_KEY': 'secret-key'})
            transport = SimpleNamespace(send=lambda _: {'camera_id': 'Cam_1', 'alert': 'idle', 'hits': 0, 'events': []})
            with contextlib.redirect_stderr(io.StringIO()) as stderr:
                code, report = agent.run(args, detector=detector, capture_factory=Capture,
                        transport=transport, heartbeat_factory=factory)
            self.assertEqual(code, 0)
            self.assertTrue(attempted.is_set())
            self.assertEqual(made[0].send_errors, 1)
            self.assertFalse(made[0]._thread.is_alive())
            self.assertEqual(report['evidence']['saved_frames'], 1)
            manifest = next(Path(tmp).rglob('manifest.json'))
            frame = json.loads(manifest.read_text())['frames'][0]
            self.assertTrue((manifest.parent / frame['file']).read_bytes().startswith(b'\xff\xd8'))
            self.assertNotIn('password', stderr.getvalue())
            self.assertNotIn('secret-key', stderr.getvalue())


class StorageRecoveryTests(unittest.TestCase):
    def test_failed_incident_open_cannot_clear_on_negative_noop_but_real_archive_success_recovers(self):
        from edge import agent
        from edge.evidence import EvidenceRecorder
        from edge.heartbeat import ProgressHeartbeat
        from unittest.mock import patch
        import tempfile
        import numpy as np
        import itertools
        import contextlib
        import io
        class Beat(ProgressHeartbeat):
            def start(self): pass
            def stop(self): return True
        class Capture:
            def __init__(self, _): pass
            def isOpened(self): return True
            def get(self, _): return 1.
            def read(self): return True, np.zeros((16,24,3),np.uint8)
            def release(self): pass
        fire=[{'cls':'fire','conf':.8,'bbox_xyxy':[1,2,10,12]}]
        original=EvidenceRecorder._open
        for frames,expected in [(2,'storage_error'),(3,'ok')]:
            made=[];opens=[];samples=iter([fire,[],fire]);clock=itertools.count(1.,1.)
            def factory(*args,**kwargs):
                beat=Beat(*args,**kwargs,transport=SimpleNamespace(send=lambda _:True));made.append(beat);return beat
            def transient_open(recorder,*args,**kwargs):
                opens.append(True)
                if len(opens)==1: raise OSError('simulated full disk')
                return original(recorder,*args,**kwargs)
            with self.subTest(frames=frames),tempfile.TemporaryDirectory(dir=tempfile.gettempdir()) as tmp:
                args=agent.parse_args(['--rtsp','rtsp://camera/live','--camera','Cam_1','--worker','https://example.com',
                    '--evidence-dir',tmp,'--max-frames',str(frames)],environ={'INGEST_API_KEY':'test-key'})
                with patch.object(EvidenceRecorder,'_open',transient_open),contextlib.redirect_stderr(io.StringIO()):
                    code,report=agent.run(args,detector=lambda _:next(samples),capture_factory=Capture,
                        transport=SimpleNamespace(send=lambda _:{'alert':'idle','hits':0,'events':[]}),
                        heartbeat_factory=factory,clock=lambda:next(clock),wall_clock=lambda:1000.)
                self.assertEqual(made[0].status(),expected)
                self.assertEqual(code,1,'historical evidence failure stays visible even after recovery')
                self.assertEqual(report['evidence_errors'],1)
                self.assertEqual(report['evidence']['saved_frames'],0 if frames==2 else 3)


if __name__ == '__main__': unittest.main()
