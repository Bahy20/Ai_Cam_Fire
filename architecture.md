# FireGuard architecture (Modal, MiniCPM-only)

```
Live:   browser /testing or camera/ bridge --WSS /v1/live--> Analysis gateway (Modal CPU, Node)
          --> frame_reader.py: decode + pixel quality (analysis/shared/image_quality.py), up to 3 frames/s
          --> one authenticated WSS --> NativeLive (Modal H100, native MiniCPM-o 4.5 streaming)
          --> strict per-image report --> VlmCoordinator (policy minicpm-only-v5) --> result over the same WSS

Upload: POST /v1/videos --> frame_reader.py samples + checks frames --> Vision (Modal L40S, image batches)
          --> VlmCoordinator --> GET /v1/videos/:id
```

## Components

- **Gateway** (`analysis/src/server.js`, `modal-entry.js`): HTTP/WSS, bearer and tester-cookie auth (`tester-access.js`), SQLite store with snapshots to the Modal volume (`store.js`, `snapshot.js`, `persistence.js`), live UI at `/testing`. Public `/health` reports `detection_source: minicpm` and `yolo_enabled: false`.
- **Coordinator** (`analysis/src/vlm-coordinator.js`): validates model reports with `analysis/shared/investigation.js`, applies the policy, keeps incident history and operator reviews (false alarm / incident resolved).
- **Model services** (`deploy/modal_app.py`): `NativeLive` (H100, `analysis/native_server.py`) for live video and `Vision` (L40S) for uploads. Both scale to zero; the pinned model lives in the `fireguard-minicpm-model-cache` volume. The gateway image ships only `analysis/src`, `analysis/shared`, `frame_reader.py` and `minicpm_client.py`.
- **Camera bridge** (`camera/server.py`): capture-only, no model; started by `scripts/run_camera_modal.py` (deployed service) or `scripts/run_two_server.py` (local gateway).

## Policy

`minicpm-only-v5` reads only strict frame-bound model enums. Monitoring needs three distinct agreeing reports spanning at least 2 s within a bounded support pool. Smoke, burning material or a separate flame latch an urgent hazard on two reports within 20 s (three, pending up to 40 s, when a report comes from a blurry or grainy frame); the latch persists through darkness and reconnect until eight consecutive clear reports or an operator review. A field the report's own description negates counts as uncertain, and frames with whole-view camera motion are skipped. A contained lighter or match flame is low priority (`monitor`) on every camera and for testers; `EXPECTED_LIGHTER_CAMERAS` can restrict that to listed cameras, and `HAZARDOUS_CAMERAS` can escalate. Missing, stale, dark, occluded or invalid evidence is `unknown`. Cause is never established. Full rules and verification: `docs/model-only-analysis.md`.

## Storage and health

- SQLite (`node:sqlite`, WAL) keeps sessions, events, inferences, operator reviews and upload jobs. Live events are throttled to changes plus a 30 s heartbeat and pruned after 7 days; recorded timelines, reviews and jobs are kept.
- Selected JPEG evidence is a 256 MiB oldest-first ring buffer that never evicts sessions which latched a hazard or were reviewed. Uploaded videos are deleted after processing.
- On Modal, the store and evidence are snapshotted to the `fireguard-analysis-data` volume every 5 s (committed every 10 s); a hazard latch or review triggers an immediate snapshot and commit. Five consecutive snapshot failures stop the gateway.
- `/health` is public and reports `policy_version`, `build_id` (hash of the shipped gateway files), the VLM provider/model, `live_vlm_mode`, active live/upload work and frame-reader restarts/last failure.

## Secrets and deploy

`scripts/configure_modal.py` creates `fireguard-analysis-config` (gateway: service token, cookie secret, tester and camera policy) and `fireguard-native-config` (H100 bearer only); run it before deploying `deploy/modal_app.py`. See `docs/modal-deployment.md`.

## Legacy

The earlier Raspberry Pi + Cloudflare Worker + YOLO design is retired and its code removed from this repository. It remains in git history (commit `7cbeb2b`, directory `legacy/`).
