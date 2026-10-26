"""Offline tests of the actual detector regression entry point."""
import contextlib
import io
from pathlib import Path
import runpy
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch


DETECTOR_SCRIPT = Path(__file__).resolve().parents[2] / "detector" / "test_local.py"


class FixtureModel:
    names = {0: "smoke", 1: "fire"}

    def __init__(self, model_path, *, miss_fire1=True):
        self.miss_fire1 = miss_fire1

    def __call__(self, path, **kwargs):
        name = Path(path).name
        hit = name.startswith("fire") and not (name == "fire1.jpg" and self.miss_fire1)
        box = SimpleNamespace(cls=1, conf=0.8,
                              xyxy=[SimpleNamespace(tolist=lambda: [0, 0, 10, 10])])
        return [SimpleNamespace(boxes=[box] if hit else [])]


class DetectorExitTests(unittest.TestCase):
    def test_cli_exits_zero_only_when_all_labeled_fixtures_match(self):
        stdout = io.StringIO()
        fake_ultralytics = SimpleNamespace(YOLO=lambda path: FixtureModel(path, miss_fire1=False))
        with patch.dict(sys.modules, {"ultralytics": fake_ultralytics}), \
             patch.object(Path, "is_file", return_value=True), contextlib.redirect_stdout(stdout):
            with self.assertRaises(SystemExit) as error:
                runpy.run_path(str(DETECTOR_SCRIPT), run_name="__main__")
        self.assertEqual(error.exception.code, 0)
        self.assertIn("5/5 pass", stdout.getvalue())

    def test_missing_positive_fixture_and_empty_suite_fail_before_model_load(self):
        main = runpy.run_path(str(DETECTOR_SCRIPT))["main"]
        for images in [[("not-a-real-positive-fixture.jpg", True)], []]:
            with self.subTest(images=images), contextlib.redirect_stdout(io.StringIO()):
                status = main(images=images, model_factory=lambda _: self.fail("no model should load"))
                self.assertEqual(status, 1)

    def test_default_artifact_paths_are_not_relative_to_working_directory(self):
        namespace = runpy.run_path(str(DETECTOR_SCRIPT))
        self.assertTrue(Path(namespace["MODEL"]).is_absolute())
        self.assertTrue(all(Path(path).is_absolute() for path, _ in namespace["IMAGES"]))

    def test_missing_checkpoint_fails_without_attempting_model_download(self):
        main = runpy.run_path(str(DETECTOR_SCRIPT))["main"]
        with contextlib.redirect_stdout(io.StringIO()):
            status = main(model_path="no-such-checkpoint.pt", images=[(str(DETECTOR_SCRIPT), True)],
                          model_factory=lambda _: self.fail("must not download missing weights"))
        self.assertEqual(status, 1)

    def test_import_is_safe_without_ultralytics_or_model_loading(self):
        with patch.dict(sys.modules, {"ultralytics": None}), contextlib.redirect_stdout(io.StringIO()):
            namespace = runpy.run_path(str(DETECTOR_SCRIPT))
        self.assertTrue(callable(namespace["main"]))

    def test_cli_exits_nonzero_for_labeled_fire1_miss(self):
        stdout = io.StringIO()
        fake_ultralytics = SimpleNamespace(YOLO=FixtureModel)
        with patch.dict(sys.modules, {"ultralytics": fake_ultralytics}), \
             patch.object(Path, "is_file", return_value=True), contextlib.redirect_stdout(stdout):
            with self.assertRaises(SystemExit) as error:
                runpy.run_path(str(DETECTOR_SCRIPT), run_name="__main__")
        self.assertEqual(error.exception.code, 1)
        self.assertIn("4/5 pass", stdout.getvalue())
        self.assertIn("fire1.jpg", stdout.getvalue())


if __name__ == "__main__":
    unittest.main()
