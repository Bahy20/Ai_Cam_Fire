"""Crash-safe bounded metadata spool tests; no network or camera access."""
import json
import tempfile
import unittest
from pathlib import Path

from edge.observation_spool import ObservationSpool, ObservationSpoolError, ObservationSpoolFull


SESSION = '2cf1a098-15d8-45bc-96f1-87f776ec3611'


def item(ts, **patch):
    return {'ts_ms':ts,'status':'gap','frame_wh':None,'detections':None,'jpeg_sha256':None,
        'local_image_available':False,'visibility':'unknown','camera_motion':None,
        'quality':{'stability':'unknown','blur_score':None,'occlusion':'unknown'},
        'reason':'capture_failed',**patch}


def digest(body):
    import hashlib
    raw=json.dumps({key:value for key,value in body.items() if key!='payload_hash'},sort_keys=True,
        separators=(',',':'),ensure_ascii=False).encode()
    return hashlib.sha256(raw).hexdigest()


class ObservationSpoolTests(unittest.TestCase):
    def test_batches_are_ordered_frozen_and_acknowledged_atomically(self):
        with tempfile.TemporaryDirectory() as directory:
            spool=ObservationSpool(Path(directory)/'metadata.sqlite3',max_samples=20,max_bytes=100_000)
            try:
                spool.start_session(SESSION,1)
                for seq in range(1,7): self.assertEqual(spool.enqueue(item(1000+seq*100)),seq)
                batch=spool.seal_batch('replay',digest,max_samples=6)
                self.assertEqual(batch['batch_sequence'],1)
                self.assertEqual([value['attempt_sequence'] for value in batch['samples']],list(range(1,7)))
                self.assertEqual(spool.seal_batch('replay',digest,max_samples=6),batch,'retry body must be byte-stable')
                ack={'protocol_version':2,'session_id':SESSION,'generation':1,'batch_sequence':1,
                    'payload_hash':batch['payload_hash'],'accepted_through':6,
                    'dispositions':[{'attempt_sequence':n,'status':'gap'} for n in range(1,7)],
                    'final_state':{'alert':'idle','incident_id':None,'last_observation_ts':None,'hits':0},
                    'event_watermark':0,'events':[],'pending_evidence_requests':[]}
                spool.acknowledge(ack)
                state=spool.snapshot()
                self.assertEqual(state['pending_samples'],0)
                self.assertEqual(state['acknowledged_through'],6)
            finally: spool.close()

    def test_partial_batch_waits_until_flush_and_old_session_rows_stay_historical(self):
        with tempfile.TemporaryDirectory() as directory:
            spool=ObservationSpool(Path(directory)/'metadata.sqlite3',max_samples=20,max_bytes=100_000)
            try:
                spool.start_session(SESSION,1)
                spool.enqueue(item(10));spool.enqueue(item(20))
                self.assertIsNone(spool.seal_batch('replay',digest,max_samples=6))
                batch=spool.seal_batch('replay',digest,max_samples=6,force=True)
                self.assertEqual(len(batch['samples']),2)
                spool.start_session('34978c0a-95a4-422e-a8da-fb38cfe9f3b2',2)
                state=spool.snapshot()
                self.assertEqual(state['pending_samples'],0)
                self.assertEqual(state['historical_samples'],2)
                self.assertEqual(state['active_session_id'],'34978c0a-95a4-422e-a8da-fb38cfe9f3b2')
            finally: spool.close()

    def test_spool_limits_fail_explicitly_without_mutating_existing_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            spool=ObservationSpool(Path(directory)/'metadata.sqlite3',max_samples=1,max_bytes=100_000)
            try:
                spool.start_session(SESSION,1)
                self.assertEqual(spool.enqueue(item(1)),1)
                with self.assertRaises(ObservationSpoolFull): spool.enqueue(item(2))
                self.assertEqual(spool.snapshot()['pending_samples'],1)
                with self.assertRaises(ObservationSpoolError): spool.start_session(SESSION,2)
            finally: spool.close()

    def test_candidate_metadata_survives_the_authenticated_batch_hash_without_entering_gap_samples(self):
        with tempfile.TemporaryDirectory() as directory:
            spool=ObservationSpool(Path(directory)/'metadata.sqlite3',camera_id='cam',max_samples=5,max_bytes=100_000)
            try:
                spool.start_session(SESSION,1)
                candidate={'version':1,'camera_id':'cam','session_id':SESSION,'generation':1,
                    'candidate_id':'lighter-track-1','model_sha256':'a'*64,'source_ts_ms':2_000,
                    'frame_ids':['frame-1500','frame-2000'],'tool_type':'lighter','flame_relation':'at_tool_tip',
                    'image_quality':'adequate','fire_region_count':1,'smoke_evidence':'not_detected',
                    'secondary_burning_evidence':'not_detected'}
                sample=item(2_000,status='ok',frame_wh=[100,80],detections=[],jpeg_sha256='b'*64,
                    local_image_available=True,reason=None,handheld_candidate=candidate)
                spool.enqueue(sample)
                body=spool.seal_batch('replay',digest,max_samples=1)
                self.assertEqual(body['samples'][0]['handheld_candidate'],candidate)
                self.assertEqual(spool.enqueue(item(2_500,handheld_candidate=None)),2)
                candidate['camera_id']='other'
                with self.assertRaises(ObservationSpoolError): spool.enqueue(item(3_000,status='ok',
                    frame_wh=[100,80],detections=[],jpeg_sha256='c'*64,local_image_available=True,
                    reason=None,handheld_candidate=candidate))
            finally: spool.close()

    def test_overflow_persists_one_explicit_gap_after_capacity_returns(self):
        with tempfile.TemporaryDirectory() as directory:
            spool=ObservationSpool(Path(directory)/'metadata.sqlite3',max_samples=1,max_bytes=100_000)
            try:
                spool.start_session(SESSION,1)
                spool.enqueue(item(100))
                with self.assertRaises(ObservationSpoolFull): spool.enqueue(item(200))
                self.assertTrue(spool.snapshot()['overflow_gap_pending'])
                batch=spool.seal_batch('replay',digest,max_samples=1)
                ack={'protocol_version':2,'session_id':SESSION,'generation':1,'batch_sequence':1,
                    'payload_hash':batch['payload_hash'],'accepted_through':1,
                    'dispositions':[{'attempt_sequence':1,'status':'gap'}],
                    'final_state':{'alert':'idle','incident_id':None,'last_observation_ts':None,'hits':0},
                    'event_watermark':0,'events':[],'pending_evidence_requests':[]}
                spool.acknowledge(ack)
                pending=spool.seal_batch('replay',digest,max_samples=1,force=True)
                self.assertEqual(pending['samples'][0]['attempt_sequence'],2)
                self.assertEqual(pending['samples'][0]['ts_ms'],200)
                self.assertEqual(pending['samples'][0]['reason'],'queue_overflow')
                self.assertFalse(spool.snapshot()['overflow_gap_pending'])
            finally: spool.close()


if __name__=='__main__': unittest.main()
