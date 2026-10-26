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

`minicpm-only-v5` reads only strict frame-bound model enums. Monitoring needs three distinct agreeing reports spanning at least 2 s within a bounded support pool. Smoke, burning material or a separate flame latch an urgent hazard that persists through darkness and reconnect until enough consecutive clear reports or an operator review. Lighter monitoring is allowed only for reviewed cameras (`EXPECTED_LIGHTER_CAMERAS`); `HAZARDOUS_CAMERAS` can escalate. Missing, stale, dark, occluded or invalid evidence is `unknown`. Cause is never established. Full rules and verification: `docs/model-only-analysis.md`.

## Secrets and deploy

`scripts/configure_modal.py` creates `fireguard-analysis-config` (gateway: service token, cookie secret, tester and camera policy) and `fireguard-native-config` (H100 bearer only); run it before deploying `deploy/modal_app.py`. See `docs/modal-deployment.md`.

## Legacy

The earlier Raspberry Pi + Cloudflare Worker + YOLO design is retired and archived under `legacy/`; nothing in the product imports it.
