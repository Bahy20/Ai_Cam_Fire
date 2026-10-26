"""Bounded outbound device-health telemetry; never sends images or fire decisions."""


import threading
import math
import re
import time
import uuid

MAX_HEARTBEAT_INTERVAL_SECONDS = 30.

class ProgressHeartbeat:
    """Monotonic progress of *all* stages, not an inference or fire assessment."""
    STAGES = ('capture', 'inference', 'storage')

    def __init__(self, worker, api_key, camera_id, *, interval=15., stall_seconds=30.,
                 transport=None, clock=time.monotonic, wall_clock=time.time):
        if not isinstance(camera_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', camera_id):
            raise ValueError('invalid_heartbeat_camera')
        for value, maximum in ((interval, MAX_HEARTBEAT_INTERVAL_SECONDS), (stall_seconds, 300.)):
            if not isinstance(value, (int, float)) or not math.isfinite(value) or not .05 <= value <= maximum:
                raise ValueError('invalid_heartbeat_timing')
        self.camera_id = camera_id
        self.interval, self.stall_seconds = interval, stall_seconds
        self.transport = transport if transport is not None else HeartbeatTransport(worker, api_key)
        self.clock, self.wall_clock = clock, wall_clock
        self._lock = threading.Lock()
        self._progress = {stage: None for stage in self.STAGES}
        self._failures = {}
        self._serial = 0
        self._attempted_serial = 0
        self._stop = threading.Event()
        self._thread = None
        self.send_errors = 0

    def progress(self, stage):
        if stage not in self.STAGES: raise ValueError('invalid_heartbeat_stage')
        with self._lock:
            self._progress[stage] = self.clock()
            self._failures.pop(stage, None)

    def fail(self, stage):
        if stage not in self.STAGES: raise ValueError('invalid_heartbeat_stage')
        with self._lock:
            self._serial += 1
            self._failures[stage] = self._serial

    def status(self):
        with self._lock:
            if self._failures:
                return max(self._failures, key=self._failures.get) + '_error'
            now = self.clock()
            if any(value is None or now - value >= self.stall_seconds for value in self._progress.values()):
                return 'stalled'
            return 'ok'

    def payload(self):
        return {'camera_id': self.camera_id, 'heartbeat_id': str(uuid.uuid4()),
                'sent_at_ms': int(self.wall_clock() * 1000), 'status': self.status()}

    def start(self):
        with self._lock:
            if self._thread is not None or self._stop.is_set(): return
            self._thread = threading.Thread(target=self._run, name='edge-heartbeat', daemon=True)
            self._thread.start()

    def _run(self):
        deadline = self.clock()
        try:
            while not self._stop.is_set():
                with self._lock:
                    serial = self._serial
                try:
                    self.transport.send(self.payload())
                except Exception:
                    # Do not print/log backend errors: capture stderr redirection
                    # is process-global and exceptions may contain URLs or keys.
                    self.send_errors += 1
                finally:
                    self._attempted_serial = serial
                deadline += self.interval
                now = self.clock()
                if deadline <= now:
                    # Skip missed ticks; never overlap or burst after a stall.
                    deadline = now + self.interval
                if self._stop.wait(max(0., deadline - now)): break
        finally:
            # stop() wakes the SAME sender. Make at most one best-effort attempt
            # for a newly observed failure; never overlap an in-flight request
            # or hide a terminal failure behind the last healthy heartbeat.
            with self._lock:
                final_needed = self._serial > self._attempted_serial and bool(self._failures)
            if final_needed:
                try:
                    self.transport.send(self.payload())
                except Exception:
                    self.send_errors += 1
            if isinstance(self.transport, HeartbeatTransport):
                try: self.transport.session.close()
                except Exception: pass

    def stop(self, *, timeout=1.):
        self._stop.set()
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=max(0., min(float(timeout), 5.)))
        return thread is None or not thread.is_alive()


class HeartbeatError(RuntimeError):
    """Fixed, credential-free transport failure."""


class HeartbeatTransport:
    def __init__(self, worker, api_key, *, session=None, timeout=3.):
        if not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or not .05 <= timeout <= 10.:
            raise ValueError('invalid_heartbeat_timeout')
        if session is None:
            import requests
            session = requests.Session()
        session.trust_env = False
        self.session = session
        self.worker, self.api_key = worker.rstrip('/'), api_key
        self.timeout = timeout

    def send(self, payload):
        from urllib.parse import quote
        response = None
        try:
            response = self.session.post(
                self.worker + '/heartbeat/camera/' + quote(payload['camera_id'], safe=''),
                json=payload, headers={'x-api-key': self.api_key},
                timeout=(self.timeout, self.timeout), allow_redirects=False, stream=True)
            if not 200 <= response.status_code < 300:
                raise ValueError
            return True
        except Exception:
            raise HeartbeatError('heartbeat_send_failed') from None
        finally:
            if response is not None:
                try:
                    response.close()
                except Exception:
                    pass
