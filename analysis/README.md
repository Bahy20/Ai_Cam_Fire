# FireGuard model-only analysis service

The active Modal product uses MiniCPM-o 4.5 for visual findings and a Node coordinator for evidence timing, incident history and operator priority. YOLO, its weights and its CPU PyTorch/Ultralytics dependencies are removed from this deployment. The private Python subprocess only decodes bounded images/videos and measures pixel quality.

The browser webcam keeps one WSS connection to the CPU gateway; the gateway keeps one authenticated native MiniCPM WSS connection to an H100. Uploaded recordings use the separate MiniCPM image-batch endpoint on L40S. Cloudflare/Scout and the historical edge detector do not participate in either product path.

## Run and deploy

Requires Node24 and Python3.11+. The CPU service needs OpenCV, NumPy, Pillow and the Modal client; GPU model dependencies are defined separately in `deploy/modal_app.py`.

```powershell
npm --prefix analysis ci
.venv/Scripts/python.exe -m modal deploy deploy/modal_app.py
```

Deployment uses the existing `fireguard-analysis-config` Modal secret and cached pinned MiniCPM model. Never put credentials in browser code. The hosted tester page is `/testing`; tester login issues a same-origin secure cookie. Service clients use `Authorization: Bearer <FIREGUARD_TOKEN>`. Public `/health` reports `yolo_enabled: false`, `detection_source: minicpm` and `live_vlm_mode: native_visual_stream`.

## Video interfaces

For live input connect to `/v1/live`, send `{"type":"start","camera_id":"test-camera","session_id":"unique-session-id"}` and wait for `ready`. Binary frames contain a four-byte big-endian metadata length, JSON with exactly `session_id`, increasing integer `sequence` and UTC `ts_ms`, followed by JPEG bytes. Client-supplied detections and priority are rejected. Limits are2MiB,1920 pixels on the longer edge and1920x1080 total pixels. Source timestamps must be current and ordered.

The browser requests30FPS preview and sends up to5JPEGs/sec. The gateway checks up to3frames/sec; only the exact quality-checked usable images reach the native model. Native visual prefill and text generation produce a strict report for each processed image, using a one-frame latest buffer and persistent KV context. Processing has a one-second minimum interval; actual visual inference can take several seconds. Context resets before2800cachedtokens to avoid a reproduced upstream text-only trim corruption. Dark/invalid images cannot become negative model evidence. Missing or stale reports mean unknown, never inferred absence.

Startup, unreadable camera and malformed reports have separate visible states. A rapid restart automatically retries an authenticated busy GPU connection for a bounded15.75second schedule, covering the server's15second inference-drain bound. Lost connections immediately revoke monitoring evidence while preserving already validated hazards. See `docs/native-streaming.md` for the adapter and deployment evidence.

`POST /v1/videos?camera_id=test-camera` accepts one multipart `video` file (MP4/MOV/AVI, up to250MiB and ten minutes). Poll `GET /v1/videos/:id` for status, frame timeline and fresh-inference usage. Recorded results describe the observed interval. All usable videos are analyzed independently of detections, including short clips; short evidence cannot bypass the monitoring interval requirement. One upload job and one native live session may run concurrently on separate GPU pools.

## Priority

Policy `minicpm-only-v1` reads strict per-image MiniCPM enums, never old detector boxes or scores. Three distinct reports spanning at least2seconds can support lighter/no-hazard monitoring. All intervening reports must agree. Evidence remains within a bounded8second pool and expires by its oldest support at10seconds. Lighter monitoring also requires an explicitly reviewed camera policy (`EXPECTED_LIGHTER_CAMERAS`). Lighter presence alone cannot suppress smoke, secondary burning, separate flames or occlusion.

Validated smoke, burning material or a separate flame retain urgent inspection through darkness and reconnect. A reviewed hazardous camera can escalate an observed flame. Missing/invalid/stale/occluded evidence is unknown unless a prior validated hazard remains unresolved. Invalid reports revoke a previous monitoring interval. Old YOLO-only historical incidents do not become model-confirmed hazards. Cause remains unknown; scene recognition is not verified ignition attribution or measured physical severity.

An earlier alert is now labeled separately from a current positive finding. On the live page, **Review earlier alert** lets the operator explicitly record **False alarm** or **Incident resolved**. Review records an audit entry, clears old monitoring support, advances a source barrier and restarts native context. It returns unknown until fresh reports qualify; later hazards create a new incident. Darkness, a stopped camera or one negative report cannot resolve an incident.

Service clients may POST `/v1/live/:assessment_session_id/review` with exactly `incident_id`, `last_hazard_ts_ms` (from `incident_history.latest_hazard.ts_ms`, or null for a legacy alert), and `action` (`false_alarm` or `incident_resolved`). Tester cookies can review only their own active camera using the configured Origin. A changed incident/evidence timestamp returns409; the operator must review the new finding. Reviews remain in SQLite `alert_reviews` and the result's `incident_history.last_review`. The ignition-source label explicitly says it is not established; this action does not infer cause or certify safety.

SQLite snapshots, bounded diagnostic records and selected JPEG evidence remain. Uploaded videos are deleted after processing. Evidence storage is capped at256MiB and reports retention failure explicitly. Both GPU pools have zero minimum containers; inference still consumes Modal credits.

## Verification

```powershell
npm --prefix analysis test
.venv/Scripts/python.exe -m unittest discover -s analysis/test -p '*_test.py'
.venv/Scripts/python.exe -m unittest discover -s scripts/tests
.venv/Scripts/python.exe scripts/verify_darkness_deployment.py
.venv/Scripts/python.exe scripts/verify_model_only_upload.py
```

The deployment verification scripts use private local configuration without printing credentials. They make real public GPU calls. Historical detector/Worker tests are retained separately from the active model-only product. See `docs/model-only-analysis.md` for fresh deployment evidence and limitations.
