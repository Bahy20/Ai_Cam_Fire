"""The live capture handoff is bounded and never blocks on inference/upload."""
import contextlib
import time
import unittest

from edge.live_capture import LatestFrameCapture


class RepeatingCapture:
    def __init__(self): self.value = 0
    def read(self):
        self.value += 1
        return True, self.value


class FailedCapture:
    def read(self): return False, None


class LiveCaptureTests(unittest.TestCase):
    def test_fast_producer_keeps_only_latest_frame_and_reports_replacements(self):
        capture=LatestFrameCapture(RepeatingCapture(),quiet_read=contextlib.nullcontext,
            retry_delay=.001)
        capture.start()
        try:
            time.sleep(.02)
            latest=capture.next_after(0,.1)
            stats=capture.snapshot()
            self.assertIsNotNone(latest)
            self.assertLessEqual(latest[0],stats['captured_frames'])
            self.assertGreater(stats['replacements'],0)
            self.assertEqual(stats['replacements'],stats['captured_frames']-1)
            self.assertEqual(latest[2],latest[0])
        finally:
            self.assertTrue(capture.stop(timeout=1.))

    def test_failed_source_wait_is_bounded_and_counted(self):
        capture=LatestFrameCapture(FailedCapture(),quiet_read=contextlib.nullcontext,
            retry_delay=.005)
        capture.start()
        try:
            self.assertIsNone(capture.next_after(0,.04))
            self.assertGreater(capture.snapshot()['read_failures'],0)
        finally:
            self.assertTrue(capture.stop(timeout=1.))


if __name__=='__main__': unittest.main()
