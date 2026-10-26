"""Optional local handheld classifier adapter; no network, GPU, or model download."""
import hashlib
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from edge.handheld_scene import HandheldSceneTracker, validate_candidate_wire


class Box:
    def __init__(self, cls, conf, xyxy):
        self.cls = [cls]
        self.conf = [conf]
        self.xyxy = [xyxy]


class FakeModel:
    names = {0:'fire', 1:'smoke', 2:'lighter_flame', 3:'secondary_burning'}

    def __init__(self, predictions):
        self.predictions = iter(predictions)
        self.calls = []

    def predict(self, image, **kwargs):
        self.calls.append(kwargs)
        boxes = next(self.predictions)
        return [SimpleNamespace(boxes=boxes, names=self.names)]


class HandheldSceneTests(unittest.TestCase):
    def test_no_optional_model_is_a_no_candidate_path(self):
        tracker = HandheldSceneTracker()
        self.assertFalse(tracker.enabled)
        self.assertIsNone(tracker.observe(object(), 'cam', '2cf1a098-15d8-45bc-96f1-87f776ec3611',
            1_000, 1, image_quality='adequate'))

    def test_only_two_same_track_chronological_frames_emit_a_bound_candidate(self):
        predictions = [
            [Box(0,.9,[20,20,40,40]), Box(2,.95,[20,15,40,35])],
            [Box(0,.9,[21,20,41,40]), Box(2,.94,[21,15,41,35])],
        ]
        tracker, model = self.make_tracker(predictions)
        session = '2cf1a098-15d8-45bc-96f1-87f776ec3611'
        self.assertIsNone(tracker.observe(object(), 'cam', session, 1_000, 1, image_quality='adequate'))
        candidate = tracker.observe(object(), 'cam', session, 1_333, 1, image_quality='adequate')
        self.assertEqual(candidate['frame_ids'], ['frame-1000','frame-1333'])
        self.assertEqual(candidate['source_ts_ms'], 1_333)
        self.assertEqual(candidate['flame_relation'], 'at_tool_tip')
        self.assertEqual(candidate['fire_region_count'], 1)
        self.assertEqual(candidate['model_sha256'], tracker.model_sha256)
        self.assertTrue(validate_candidate_wire(candidate, camera_id='cam', session_id=session,
            generation=1, ts_ms=1_333))
        self.assertEqual(model.calls[0]['device'], 'cpu')

    def test_unknown_quality_gap_smoke_extra_flame_and_secondary_burning_never_make_eligible_candidate(self):
        clean = lambda ts: [Box(0,.9,[20,20,40,40]), Box(2,.95,[20,15,40,35])]
        session='2cf1a098-15d8-45bc-96f1-87f776ec3611'
        for quality, second in [
            ('unknown',clean(1_333)), ('degraded',clean(1_333)), ('adequate',clean(1_333)+[Box(0,.8,[70,20,90,40])]),
            ('adequate',clean(1_333)+[Box(1,.8,[50,20,60,30])]),
            ('adequate',clean(1_333)+[Box(3,.8,[50,20,60,30])]),
        ]:
            tracker,_=self.make_tracker([clean(1_000),second])
            tracker.observe(object(),'cam',session,1_000,1,image_quality='adequate')
            candidate=tracker.observe(object(),'cam',session,1_333,1,image_quality=quality)
            self.assertIsNone(candidate)

    def test_fire_must_be_spatially_associated_with_the_lighter_flame_in_both_frames(self):
        linked = [Box(0,.9,[20,20,40,40]), Box(2,.95,[20,15,40,35])]
        separate = [Box(0,.9,[20,20,40,40]), Box(2,.95,[400,400,420,420])]
        session = '2cf1a098-15d8-45bc-96f1-87f776ec3611'
        for predictions in ([separate,separate], [linked,separate], [separate,linked]):
            with self.subTest(predictions=predictions):
                tracker,_ = self.make_tracker(predictions)
                self.assertIsNone(tracker.observe(object(),'cam',session,1000,1,image_quality='adequate'))
                self.assertIsNone(tracker.observe(object(),'cam',session,1333,1,image_quality='adequate'),
                    'independent temporal tracks do not establish that the fire is at the lighter')

    def test_model_hash_must_be_pinned_and_required_semantic_classes_must_exist(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'model.pt';path.write_bytes(b'weights')
            digest=hashlib.sha256(b'weights').hexdigest()
            with self.assertRaisesRegex(ValueError,'handheld_model_hash_mismatch'):
                HandheldSceneTracker(path, expected_sha256='0'*64, model_factory=lambda _:None)
            class Incomplete(FakeModel): names={0:'fire',1:'smoke'}
            with self.assertRaisesRegex(ValueError,'handheld_model_classes_missing'):
                HandheldSceneTracker(path,expected_sha256=digest,model_factory=lambda _:Incomplete([[]])).observe(
                    object(),'cam','2cf1a098-15d8-45bc-96f1-87f776ec3611',1_000,1,image_quality='adequate')

    def make_tracker(self, predictions):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'model.pt';path.write_bytes(b'weights')
            digest=hashlib.sha256(b'weights').hexdigest()
            model=FakeModel(predictions)
            # Keep the temporary model file alive for the lifetime of this tracker.
            tracker=HandheldSceneTracker(path, expected_sha256=digest, model_factory=lambda _:model)
            tracker._test_temp_directory=directory
            return tracker,model


if __name__ == '__main__': unittest.main()
