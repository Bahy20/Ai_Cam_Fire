# FireGuard

Advisory camera fire/smoke monitoring. A webcam or uploaded recording is analysed by self-hosted MiniCPM-o 4.5 on Modal; a Node gateway turns the per-image model reports into a priority (`monitor`, `unknown`, `inspect_urgently`, `escalate`). It is not a certified fire detector: cause is never established and scene findings are not measured physical severity.

## Components

- `analysis/`: CPU gateway (`src/server.js`, Fastify HTTP/WSS, SQLite store, tester page at `/testing`), the production coordinator `src/vlm-coordinator.js` (policy `minicpm-only-v5`), the frame-reader subprocess `frame_reader.py` (bounded decode and pixel quality only) and the Python model code: `native_server.py` (authenticated H100 WSS server), `visual_stream.py` (the active per-image native adapter), `minicpm_client.py` (gateway bridge to `Vision`) and `minicpm_contract.py` (pinned model, prompt and strict parser). `native_stream.py` is the earlier forced-speech duplex adapter, kept only for `deploy/native_probe.py` and its tests. `analysis/shared/` holds the investigation validator and image-quality gate. Details: [analysis/README.md](analysis/README.md).
- `deploy/modal_app.py`: the Modal app: `Analysis` (CPU gateway), `NativeLive` (H100, native MiniCPM streaming for live video) and `Vision` (L40S, image-batch endpoint for uploads), plus probes and the benchmark.
- `camera/`: local capture-only bridge (no model) that sends webcam JPEGs to the gateway over WSS.
- `scripts/`: Modal secrets (`configure_modal.py`), launchers (`run_camera_modal.py`, `run_two_server.py`), deployment checks (`check_modal.py`, `verify_*.py`) and the webcam test set (`evaluate_webcam_set.py`, `export_false_alarms.py`).

## Flows

- **Live:** browser or `camera/` bridge -> WSS `/v1/live` on the gateway -> quality-checked frames (up to 3/s) -> one authenticated WSS to `NativeLive` -> strict per-image report -> coordinator -> priority result back over the same socket.
- **Upload:** `POST /v1/videos` (MP4/MOV/AVI, up to 250 MiB / 10 min) -> frame reader samples and checks frames -> `Vision` image batches -> coordinator -> poll `GET /v1/videos/:id`.

Policy `minicpm-only-v5`: monitoring needs three agreeing reports spanning at least 2 s; smoke, burning material or a separate flame latch an urgent hazard (on two reports within 20 s) that survives darkness and reconnect until eight consecutive clear reports or an operator review; a contained lighter or match flame is low priority (`monitor`) on every camera and for testers unless `EXPECTED_LIGHTER_CAMERAS` restricts it to listed cameras; missing, stale or low-quality evidence is `unknown`. Full rules: [docs/model-only-analysis.md](docs/model-only-analysis.md).

## Run and deploy

Requires Node 24 and Python 3.11+.

```powershell
npm --prefix analysis ci
.venv/Scripts/python.exe scripts/configure_modal.py      # creates/updates both Modal secrets; run before every first deploy
.venv/Scripts/python.exe -m modal deploy deploy/modal_app.py
.venv/Scripts/python.exe scripts/run_camera_modal.py     # local camera bridge against the deployed service
.venv/Scripts/python.exe scripts/run_two_server.py       # or: local gateway + camera bridge on this PC
```

Secrets and settings: [docs/modal-deployment.md](docs/modal-deployment.md). Copy `analysis/.env.example` to `analysis/.env.local` for local settings; never commit it.

## Testing

```powershell
npm --prefix analysis test
.venv/Scripts/python.exe -m unittest camera.test_camera
.venv/Scripts/python.exe -m unittest discover -s scripts/tests
.venv/Scripts/python.exe -m unittest discover -s analysis/test -p '*_test.py'
```

Deployment checks (`scripts/verify_*.py`) make real GPU calls. False smoke reports are measured with the labelled webcam set: [docs/webcam-test-set.md](docs/webcam-test-set.md).

Architecture: [architecture.md](architecture.md).
