"""Labeled local baseline for the D-Fire YOLOv8n checkpoint.

Tests: model loads, classes are {0: smoke, 1: fire}, fire images trigger
detections, background images stay clean, and inference timing on GPU/CPU.
"""
import json
import time
from pathlib import Path


MODEL = Path(__file__).resolve().parent / "fire_seg.pt"
ROOT = Path(__file__).resolve().parents[1]


IMAGES = [
    (f"{ROOT}/test_images/fire1.jpg", True),
    (f"{ROOT}/test_images/fire2.jpg", True),
    (f"{ROOT}/test_images/fire3.jpg", True),
    (f"{ROOT}/test_images/neg1.jpg", False),
    (f"{ROOT}/test_images/neg2.jpg", False),
]

def main(*, model_factory=None, images=None, model_path=MODEL):
    images = list(IMAGES if images is None else images)
    if not images:
        print("FATAL: no labeled fixtures")
        return 1
    missing = [str(path) for path, _ in images if not Path(path).is_file()]
    if missing:
        print(f"FATAL: missing labeled fixtures: {missing}")
        return 1
    if not Path(model_path).is_file():
        print(f"FATAL: missing local checkpoint: {model_path}; refusing automatic download")
        return 1
    if model_factory is None:
        from ultralytics import YOLO
        model_factory = YOLO
    model = model_factory(model_path)
    print("classes:", model.names)
    assert model.names == {0: "smoke", 1: "fire"}, f"unexpected classes: {model.names}"
    results = []
    for path, expect_hit in images:
        t0 = time.perf_counter()
        r = model(path, conf=0.25, verbose=False)[0]
        dt_ms = (time.perf_counter() - t0) * 1000
        dets = []
        for box in r.boxes:
            x1, y1, x2, y2 = [round(v, 1) for v in box.xyxy[0].tolist()]
            dets.append(
                {
                    "cls": model.names[int(box.cls)],
                    "conf": round(float(box.conf), 3),
                    "bbox": [x1, y1, x2, y2],
                }
            )
        hit = len(dets) > 0
        status = "OK" if hit == expect_hit else "MISS"
        print(f"{status} {path}: {len(dets)} det ({dt_ms:.0f} ms) -> {json.dumps(dets)}")
        results.append((status, path))

    hits = sum(1 for s, p in results if s == "OK")
    misses = [p for s, p in results if s == "MISS"]
    print(f"\nRESULT: {hits}/{len(results)} pass; misses: {misses if misses else 'none'}")
    return int(bool(misses))

if __name__ == "__main__":
    raise SystemExit(main())
