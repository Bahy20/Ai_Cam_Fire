"""Image-quality gates stay fail-closed until a measured profile is reviewed."""
import sys
import unittest
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from edge.image_quality import assess_frame_quality


class ImageQualityTests(unittest.TestCase):
    def test_low_exposure_with_sensor_noise_and_small_bright_objects_is_not_usable(self):
        image=np.random.default_rng(28).integers(2,15,(80,100,3),dtype=np.uint8)
        image[5:8,5:8]=240
        result=assess_frame_quality(image,reject_clipped_candidates=False)
        self.assertEqual(result['visibility'],'degraded')
        self.assertIn('insufficient_scene_illumination',result['reasons'])

    def test_missing_profile_never_marks_a_clear_looking_image_adequate(self):
        image = np.random.default_rng(9).integers(20, 235, (96, 128, 3), dtype=np.uint8)

        result = assess_frame_quality(image, profile=None, scene_regions=[])

        self.assertEqual(result['visibility'], 'unknown')
        self.assertIsNone(result['camera_motion'])
        self.assertEqual(result['quality'], {
            'stability': 'unknown', 'blur_score': None, 'occlusion': 'unknown'})
        self.assertIn('quality_profile_missing', result['reasons'])
        self.assertGreater(result['metrics']['laplacian_variance'], 0)

    def test_extreme_uniform_frames_are_degraded(self):
        for image in (np.zeros((48, 64, 3), np.uint8),
                      np.full((48, 64, 3), 255, np.uint8)):
            with self.subTest(level=int(image[0, 0, 0])):
                result = assess_frame_quality(image, profile=None, scene_regions=[])
                self.assertEqual(result['visibility'], 'degraded')
                self.assertIn('uniform_extreme_luminance', result['reasons'])

    def test_global_view_remains_usable_when_only_a_detector_box_is_clipped(self):
        image = np.random.default_rng(12).integers(20, 235, (80, 100, 3), dtype=np.uint8)
        result = assess_frame_quality(image, scene_regions=[[0, 20, 30, 60]], reject_clipped_candidates=False)
        self.assertEqual(result['visibility'], 'unknown')
        self.assertIn('candidate_region_touches_frame_edge', result['reasons'])
        black = assess_frame_quality(np.zeros((80, 100, 3), np.uint8),
            scene_regions=[[0, 20, 30, 60]], reject_clipped_candidates=False)
        self.assertEqual(black['visibility'], 'degraded')

    def test_cropped_candidate_region_is_degraded_but_internal_occlusion_stays_unknown(self):
        image = np.random.default_rng(10).integers(20, 235, (80, 100, 3), dtype=np.uint8)

        cropped = assess_frame_quality(image, profile=None, scene_regions=[[0, 20, 30, 60]])
        self.assertEqual(cropped['visibility'], 'degraded')
        self.assertIn('candidate_region_touches_frame_edge', cropped['reasons'])

        internal = assess_frame_quality(image, profile=None, scene_regions=[[20, 20, 60, 60]])
        self.assertEqual(internal['visibility'], 'unknown')
        self.assertEqual(internal['quality']['occlusion'], 'unknown')
        self.assertIn('occlusion_unassessed', internal['reasons'])

    def test_blur_metric_distinguishes_sharp_and_blurred_pixels_without_claiming_adequacy(self):
        image = np.zeros((96, 128, 3), np.uint8)
        cv2.rectangle(image, (24, 18), (104, 78), (255, 255, 255), thickness=-1)
        blurred = cv2.GaussianBlur(image, (21, 21), 0)

        sharp = assess_frame_quality(image, profile=None, scene_regions=[])
        soft = assess_frame_quality(blurred, profile=None, scene_regions=[])

        self.assertGreater(sharp['metrics']['laplacian_variance'],
                           soft['metrics']['laplacian_variance'])
        self.assertEqual(sharp['visibility'], 'unknown')
        self.assertEqual(soft['visibility'], 'unknown')
        self.assertIn('blur_threshold_unvalidated', soft['reasons'])

    def test_unvalidated_or_mismatched_profile_cannot_authorize_adequate(self):
        image = np.random.default_rng(11).integers(20, 235, (64, 80, 3), dtype=np.uint8)
        unreviewed = {'schema_version': 1, 'reviewed': False, 'corpus_sha256': '0' * 64}
        wrong_corpus = {'schema_version': 1, 'reviewed': True, 'corpus_sha256': '0' * 64}

        for profile in (unreviewed, wrong_corpus):
            with self.subTest(profile=profile):
                result = assess_frame_quality(image, profile=profile, scene_regions=[])
                self.assertNotEqual(result['visibility'], 'adequate')
                self.assertIn('quality_profile_unvalidated', result['reasons'])

    def test_unreadable_or_too_small_images_remain_unknown(self):
        for image in (None, np.zeros((0, 0, 3), np.uint8), np.zeros((8, 8), np.uint8)):
            with self.subTest(image_type=type(image).__name__):
                result = assess_frame_quality(image, profile=None, scene_regions=[])
                self.assertEqual(result['visibility'], 'unknown')
                self.assertIn('image_quality_input_unavailable', result['reasons'])


if __name__ == '__main__':
    unittest.main()
