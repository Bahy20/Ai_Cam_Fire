"""Background uploader tests use a local fake transport and SQLite only."""
import tempfile
import time
import unittest
from pathlib import Path

from edge.agent import observation_batch_hash
from edge.observation_spool import ObservationSpool
from edge.observation_uploader import ObservationUploader


SESSION = '2cf1a098-15d8-45bc-96f1-87f776ec3611'


def item(ts):
    return {'ts_ms':ts,'status':'gap','frame_wh':None,'detections':None,'jpeg_sha256':None,
        'local_image_available':False,'visibility':'unknown','camera_motion':None,
        'quality':{'stability':'unknown','blur_score':None,'occlusion':'unknown'},
        'reason':'inference_failed'}


class FakeTransport:
    def __init__(self, fail_once=False):
        self.fail_once = fail_once
        self.bodies = []
        self.activations = 0

    def activate(self, camera_id, state_path):
        self.activations += 1
        return {'session_id':SESSION,'generation':1}

    def send_batch(self, body):
        self.bodies.append(body)
        if self.fail_once:
            self.fail_once = False
            raise RuntimeError('offline')
        return {'protocol_version':2,'session_id':SESSION,'generation':1,
            'batch_sequence':body['batch_sequence'],'payload_hash':body['payload_hash'],
            'accepted_through':body['samples'][-1]['attempt_sequence'],
            'dispositions':[{'attempt_sequence':sample['attempt_sequence'],'status':'gap'}
                for sample in body['samples']],
            'final_state':{'alert':'idle','incident_id':None,'last_observation_ts':None,'hits':0},
            'event_watermark':0,'events':[],'pending_evidence_requests':[]}


class ObservationUploaderTests(unittest.TestCase):
    def test_retries_exact_frozen_body_and_persists_ack(self):
        with tempfile.TemporaryDirectory() as directory:
            spool=ObservationSpool(Path(directory)/'metadata.sqlite3')
            spool.start_session(SESSION,1)
            for seq in range(1,7): spool.enqueue(item(seq*100))
            transport=FakeTransport(fail_once=True)
            uploader=ObservationUploader(spool,transport,'cam',Path(directory)/'state.json',
                clock_mode='replay',retry_delay=.01,max_retry_delay=.02)
            try:
                result=uploader.flush_and_stop(timeout=1.)
                self.assertTrue(result['stopped'])
                self.assertEqual(len(transport.bodies),2)
                self.assertEqual(transport.bodies[0],transport.bodies[1])
                self.assertEqual(spool.snapshot()['pending_samples'],0)
                self.assertEqual(len(uploader.drain_acks()),1)
            finally:
                if uploader.thread.is_alive(): uploader.flush_and_stop(timeout=1.)
                spool.close()

    def test_waits_for_full_batch_until_explicit_final_flush(self):
        with tempfile.TemporaryDirectory() as directory:
            spool=ObservationSpool(Path(directory)/'metadata.sqlite3')
            spool.start_session(SESSION,1)
            spool.enqueue(item(100))
            transport=FakeTransport()
            uploader=ObservationUploader(spool,transport,'cam',Path(directory)/'state.json',
                clock_mode='replay',retry_delay=.01)
            try:
                time.sleep(.05)
                self.assertEqual(transport.bodies,[])
                result=uploader.flush_and_stop(timeout=1.)
                self.assertTrue(result['stopped'])
                self.assertEqual(len(transport.bodies),1)
                self.assertEqual(len(transport.bodies[0]['samples']),1)
            finally:
                if uploader.thread.is_alive(): uploader.flush_and_stop(timeout=1.)
                spool.close()


if __name__=='__main__': unittest.main()
