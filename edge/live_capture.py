"""One-slot latest-frame handoff for live camera capture."""
import threading
import time


class LatestFrameCapture:
    """Drain a live source continuously while retaining only its newest frame."""

    def __init__(self, capture, *, quiet_read, wall_clock=time.time, retry_delay=.05):
        self.capture = capture
        self.quiet_read = quiet_read
        self.wall_clock = wall_clock
        self.retry_delay = retry_delay
        self._condition = threading.Condition()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name='fireguard-live-capture', daemon=True)
        self._latest = None
        self._sequence = 0
        self._replacements = 0
        self._read_failures = 0
        self._started = False

    def start(self):
        if self._started:
            raise RuntimeError('capture_already_started')
        self._started = True
        self._thread.start()

    def _run(self):
        while not self._stop.is_set():
            try:
                with self.quiet_read():
                    ok, frame = self.capture.read()
            except Exception:
                ok, frame = False, None
            if not ok or frame is None:
                with self._condition:
                    self._read_failures += 1
                    self._condition.notify_all()
                self._stop.wait(self.retry_delay)
                continue
            ts_ms = int(self.wall_clock() * 1000)
            with self._condition:
                self._sequence += 1
                if self._latest is not None:
                    self._replacements += 1
                self._latest = (self._sequence, ts_ms, frame)
                self._condition.notify_all()

    def next_after(self, sequence, timeout):
        deadline = time.monotonic() + max(0., timeout)
        with self._condition:
            while not self._stop.is_set():
                if self._latest is not None and self._latest[0] > sequence:
                    return self._latest
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                self._condition.wait(remaining)
            return None

    def snapshot(self):
        with self._condition:
            return {'captured_frames': self._sequence, 'replacements': self._replacements,
                    'read_failures': self._read_failures, 'running': self._thread.is_alive()}

    def stop(self, timeout=10.):
        self._stop.set()
        with self._condition:
            self._condition.notify_all()
        if self._started:
            self._thread.join(max(0., timeout))
        return not self._thread.is_alive()

