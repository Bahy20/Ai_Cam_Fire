import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

from edge.scene_continuity import (compare_background, evaluate_continuity,
                                   load_reference_bundle, write_reference_bundle)


def review_context(bundle):
    return {
        'camera_id': 'cam-1',
        'reviewed': True,
        'reviewed_by': 'operator',
        'reviewed_at_ms': 1_000,
        'review_expires_at_ms': 1_000 + 30 * 24 * 60 * 60 * 1000,
        'context_revision': bundle['context_revision'],
        'geometry_revision': bundle['geometry_revision'],
        'reviewed_reference_image_sha256': bundle['reference_image_sha256'],
        'reference_dimensions': bundle['dimensions'],
        'crop_rect': bundle['crop_rect'],
        'expected_flame_use': True,
        'occupied_area': False,
        'known_hazards': [],
        'critical_zones': [],
        'source_zones': bundle['source_zones'],
    }


class SceneContinuityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        rng = np.random.default_rng(12)
        self.image = rng.integers(20, 230, size=(240, 320, 3), dtype=np.uint8)
        ok, encoded = cv2.imencode('.jpg', self.image)
        self.assertTrue(ok)
        self.jpeg = encoded.tobytes()
        self.zones = [{'zone_id': 'candle-1', 'source_type': 'candle',
                       'bbox_normalized': [0.25, 0.2, 0.75, 0.8]}]

    def make_bundle(self):
        bundle = write_reference_bundle(self.jpeg, self.root / 'bundle', camera_id='cam-1',
                                        context_revision=1, geometry_revision=1,
                                        source_zones=self.zones)
        return bundle, load_reference_bundle(self.root / 'bundle' / 'reference-bundle.json',
                                              review_context(bundle), now_ms=2_000)

    def test_reference_bundle_is_hash_and_geometry_bound_to_operator_context(self):
        bundle, loaded = self.make_bundle()
        self.assertEqual(loaded['reference_image_sha256'], hashlib.sha256(self.jpeg).hexdigest())
        self.assertEqual(loaded['dimensions'], [320, 240])
        self.assertEqual(loaded['source_zones'], self.zones)
        wrong = review_context(bundle)
        wrong['geometry_revision'] += 1
        with self.assertRaisesRegex(ValueError, 'reference_bundle_context_mismatch'):
            load_reference_bundle(self.root / 'bundle' / 'reference-bundle.json', wrong, now_ms=2_000)
        with self.assertRaisesRegex(ValueError, 'reference_bundle_review_expired'):
            load_reference_bundle(self.root / 'bundle' / 'reference-bundle.json', review_context(bundle),
                                  now_ms=review_context(bundle)['review_expires_at_ms'] + 1)

    def test_reference_bundle_rejects_tampered_jpeg_and_path_traversal(self):
        bundle, _ = self.make_bundle()
        image_path = self.root / 'bundle' / 'reference.jpg'
        image_path.write_bytes(self.jpeg + b'changed')
        with self.assertRaisesRegex(ValueError, 'reference_bundle_hash_mismatch'):
            load_reference_bundle(self.root / 'bundle' / 'reference-bundle.json', review_context(bundle), now_ms=2_000)
        manifest_path = self.root / 'bundle' / 'reference-bundle.json'
        manifest = json.loads(manifest_path.read_text())
        manifest['jpeg_file'] = '..\\outside.jpg'
        manifest_path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, 'reference_bundle_invalid'):
            load_reference_bundle(manifest_path, review_context(bundle), now_ms=2_000)

    def test_background_stability_is_unknown_without_texture_and_stable_for_unchanged_reference(self):
        bundle, loaded = self.make_bundle()
        result = compare_background(loaded['image'], loaded['image'], loaded['source_zones'])
        self.assertEqual(result['status'], 'stable')
        flat = np.full_like(self.image, 100)
        low_texture = compare_background(flat, flat, self.zones)
        self.assertEqual(low_texture['status'], 'unknown')
        self.assertTrue({'image_blur_below_threshold', 'insufficient_background_features',
                         'insufficient_background_matches', 'background_transform_unreliable'} &
                        set(low_texture['reasons']))

    def test_background_stability_flags_a_camera_translation_as_unstable(self):
        _, loaded = self.make_bundle()
        transform = np.float32([[1, 0, 12], [0, 1, 0]])
        moved = cv2.warpAffine(loaded['image'], transform, (320, 240), borderMode=cv2.BORDER_REFLECT)
        result = compare_background(loaded['image'], moved, loaded['source_zones'])
        self.assertEqual(result['status'], 'unstable', result)
        self.assertIn('background_translation_exceeded', result['reasons'])

    def test_continuity_requires_complete_same_session_chain_and_single_in_zone_flame(self):
        bundle, loaded = self.make_bundle()
        context = review_context(bundle)
        chain = []
        for ts in (1_000, 2_000, 3_000):
            chain.append({'camera_id':'cam-1','source_ts_ms': ts, 'received_at_ms': ts,
                          'session_id': 'session-a', 'incident_id': 'incident-a',
                          'context_revision': 1, 'geometry_revision': 1,
                          'source_zone_id': 'candle-1', 'observation_valid': True,
                          'frame_wh': [320, 240], 'fire_detections': [[120, 80, 180, 160]],
                          'smoke_present': False, 'visual_activity': 'steady',
                          'camera_motion': False,
                          'image_quality': 'usable', 'background_stability': 'stable'})
        result = evaluate_continuity(chain, context, reference_bundle=loaded, source_zone_id='candle-1',
                                     session_id='session-a', incident_id='incident-a',
                                     supporting_frame_ids=['frame-1000', 'frame-2000'])
        self.assertTrue(result['eligible'], result)
        self.assertEqual(result['chain_end_ts_ms'], 3_000)

        gap = [chain[0], {**chain[1], 'source_ts_ms': 3_001}, {**chain[2], 'source_ts_ms': 4_001}]
        self.assertIn('source_gap_exceeded', evaluate_continuity(gap, context, reference_bundle=loaded, source_zone_id='candle-1',
            session_id='session-a', incident_id='incident-a', supporting_frame_ids=['frame-1000','frame-2000'])['reasons'])
        outside = [{**row, 'fire_detections': [[10, 10, 30, 30]]} for row in chain]
        self.assertIn('fire_candidate_outside_reviewed_zone', evaluate_continuity(outside, context, reference_bundle=loaded,
            source_zone_id='candle-1', session_id='session-a', incident_id='incident-a',
            supporting_frame_ids=['frame-1000','frame-2000'])['reasons'])
        changed = [{**row, 'session_id': 'session-b'} for row in chain]
        self.assertIn('session_or_incident_changed', evaluate_continuity(changed, context, reference_bundle=loaded,
            source_zone_id='candle-1', session_id='session-a', incident_id='incident-a',
            supporting_frame_ids=['frame-1000','frame-2000'])['reasons'])

    def test_unmatched_regions_smoke_growth_degraded_images_and_secondary_fire_veto_chain(self):
        bundle, loaded = self.make_bundle()
        context = review_context(bundle)
        base = [{'camera_id':'cam-1','source_ts_ms': ts, 'received_at_ms': ts, 'session_id': 's', 'incident_id': 'i',
                 'context_revision': 1, 'geometry_revision': 1, 'source_zone_id': 'candle-1',
                 'observation_valid': True, 'frame_wh': [320, 240],
                 'fire_detections': [[120, 80, 180, 160]], 'smoke_present': False,
                 'visual_activity': 'steady', 'camera_motion': False,
                 'image_quality': 'usable', 'background_stability': 'stable'}
                for ts in (1_000, 2_000, 3_000)]
        args = dict(source_zone_id='candle-1', session_id='s', incident_id='i',
                    supporting_frame_ids=['frame-1000','frame-2000'])
        variants = [
            {**base[1], 'fire_detections': [[120,80,180,160],[125,85,185,165]]},
            {**base[1], 'smoke_present': True}, {**base[1], 'visual_activity': 'growing'},
            {**base[1], 'camera_motion': True}, {**base[1], 'camera_motion': None},
            {**base[1], 'image_quality': 'degraded'}, {**base[1], 'background_stability': 'unknown'},
            {**base[1], 'observation_valid': False}, {**base[1], 'geometry_revision': 2},
        ]
        for variant in variants:
            rows = [base[0], variant, base[2]]
            self.assertFalse(evaluate_continuity(rows, context, reference_bundle=loaded, **args)['eligible'], variant)

    def test_adjacent_region_identity_requires_unique_overlap_and_bounded_motion(self):
        bundle, loaded = self.make_bundle()
        context = review_context(bundle)
        rows = [{'camera_id':'cam-1','source_ts_ms': ts, 'received_at_ms': ts, 'session_id': 's', 'incident_id': 'i',
                 'context_revision': 1, 'geometry_revision': 1, 'source_zone_id': 'candle-1',
                 'observation_valid': True, 'frame_wh': [320,240],
                 'fire_detections': [box], 'smoke_present': False, 'visual_activity': 'steady',
                 'camera_motion': False,
                 'image_quality': 'usable', 'background_stability': 'stable'}
                for ts, box in ((1_000,[120,80,180,160]), (2_000,[122,82,182,162]), (3_000,[124,84,184,164]))]
        args = dict(source_zone_id='candle-1', session_id='s', incident_id='i',
                    supporting_frame_ids=['frame-1000','frame-2000'])
        self.assertIn('reference_bundle_unavailable', evaluate_continuity(rows, context, **args)['reasons'])
        self.assertTrue(evaluate_continuity(rows, context, reference_bundle=loaded, **args)['eligible'])
        rows[1] = {**rows[1], 'fire_detections': [[220,80,280,160]]}
        self.assertIn('flame_region_identity_unmatched', evaluate_continuity(rows, context, reference_bundle=loaded, **args)['reasons'])


if __name__ == '__main__':
    unittest.main()
