"""Dependency boundaries for the Pi-first deployment (no package installs)."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]


class DependencyProfilesTests(unittest.TestCase):
    def test_default_install_does_not_require_modal(self):
        requirements = (ROOT / "requirements.txt").read_text(encoding="utf-8")
        self.assertNotIn("modal", requirements.lower())

    def test_retired_cloud_inference_and_duplicate_runners_are_removed(self):
        retired = [
            'detector/service.py', 'detector/vlm_service.py', 'detector/requirements-modal.txt',
            'scripts/detector_server.py', 'scripts/vlm_server.py', 'scripts/investigation_contract.py',
            'scripts/stream_sim.py', 'scripts/test_deployed.py', 'scripts/test_e2e.py',
            'scripts/test_pipeline.py', 'worker/src/incident.js', 'worker/src/priority.js',
        ]
        for relative in retired:
            self.assertFalse((ROOT / relative).exists(), f'retired implementation still present: {relative}')
        self.assertTrue((ROOT / 'detector/fire_seg.pt').is_file(), 'preserve the actual local model')
        self.assertTrue((ROOT / 'edge/agent.py').is_file())
        self.assertTrue((ROOT / 'scripts/test_edge_runtime.mjs').is_file())


if __name__ == "__main__":
    unittest.main()
