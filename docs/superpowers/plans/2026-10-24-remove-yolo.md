# Remove YOLO from the deployed product

User approved replacing YOLO's decisions with MiniCPM findings after the real lighting-transition replay showed persistent detector/model disagreement.

- [x] Replace deployed YOLO inference with bounded JPEG/video decoding and existing conservative pixel-quality checks. Remove CPU PyTorch/Ultralytics and weights from the Modal image.
- [x] Use a dedicated model-only coordinator for live native reports and recorded-video MiniCPM batches. No detector proposals, synthetic negative detections or YOLO-triggered model calls.
- [x] Preserve strict frame binding, ordered fresh multiframe lighter/negative evidence, reviewed lighter-camera policy, intervening contradiction checks and unresolved model-confirmed hazards. Missing/invalid/stale/dark evidence stays unknown; a validated hazard stays urgent through loss of view. Cause remains unverified.
- [x] Test the changed decisions first, run regression suites and obtain independent review. All97 JavaScript,108 Python script and3 frame-reader tests passed. Three review findings received red/green regressions; re-review found no remaining concrete blockers.
- [x] Deploy the idle existing app and run fresh public WSS user-video, fire and darkness controls. Actual user replay:80 valid reports,112 contained-lighter monitoring result messages and zero urgent results. Wood stayed urgent through darkness; separate black-only input stayed unknown with zero native inference.
- [x] Verify uploaded-video inference independently. The real HTTP crop completed with two fresh schema-valid MiniCPM batches and no flame/smoke; obscured-scene uncertainty remained review-required rather than being forced to monitoring. See the evidence/acceptance distinction in `docs/model-only-analysis.md`.
- [x] Keep historical edge/Worker experiments outside the deployed product; do not destroy the user's training checkpoint or test footage.
