# FireGuard model-only analysis service

The active Modal product uses MiniCPM-o 4.5 for visual findings and a Node coordinator for evidence timing, incident history and operator priority. YOLO, its weights and its CPU PyTorch/Ultralytics dependencies are removed from this deployment. The private Python subprocess only decodes bounded images/videos and measures pixel quality.

The browser webcam keeps one WSS connection to the CPU gateway; the gateway keeps one authenticated native MiniCPM WSS connection to an H100. Uploaded recordings use the separate MiniCPM image-batch endpoint on L40S. Cloudflare/Scout and the historical edge detector do not participate in either product path.

## Run and deploy

Requires Node24 and Python3.11+. The CPU service needs OpenCV, NumPy, Pillow and the Modal client; GPU model dependencies are defined separately in `deploy/modal_app.py`.

```powershell
npm --prefix analysis ci
.venv/Scripts/python.exe scripts/configure_modal.py
.venv/Scripts/python.exe -m modal deploy deploy/modal_app.py
```

Deployment uses two Modal secrets, `fireguard-analysis-config` and `fireguard-native-config`, and the cached pinned MiniCPM model. `scripts/configure_modal.py` creates or updates both secrets; run it before deploying, or the deploy fails while `fireguard-native-config` is missing (see `docs/modal-deployment.md`, Secrets). Never put credentials in browser code. The hosted tester page is `/testing`; tester login issues a same-origin secure cookie. Service clients use `Authorization: Bearer <FIREGUARD_TOKEN>`. Public `/health` reports `yolo_enabled: false`, `detection_source: minicpm` and `live_vlm_mode: native_visual_stream`.

## Video interfaces

For live input connect to `/v1/live`, send `{"type":"start","camera_id":"test-camera","session_id":"unique-session-id"}` and wait for `ready`. Binary frames contain a four-byte big-endian metadata length, JSON with exactly `session_id`, increasing integer `sequence` and UTC `ts_ms`, followed by JPEG bytes. Client-supplied detections and priority are rejected. Limits are2MiB,1920 pixels on the longer edge and1920x1080 total pixels. `sequence` and `ts_ms` must increase within a session, but the client clock is only compared with itself: a frame arriving 5 s later than the session's least-delayed frame is refused as `stale_frame`, so a skewed tester clock still streams. The gateway stamps each accepted frame with its own receive time, which sampling, evidence ids and the native model use. It pings each live socket every 15 s and drops one that sent neither a pong nor a frame since the previous ping, so a vanished browser frees the single live slot within about 30 s. A failed frame check returns the frame reader's code (for example `invalid_jpeg_or_dimensions` or `frame_reader_timeout`), otherwise `frame_decode_failure`.

The browser requests30FPS preview and sends up to5JPEGs/sec. The gateway checks up to3frames/sec; only the exact quality-checked usable images reach the native model. Native visual prefill and text generation produce a strict report for each processed image, using a one-frame latest buffer and persistent KV context. Processing has a one-second minimum interval; actual visual inference can take several seconds. Context resets before2800cachedtokens to avoid a reproduced upstream text-only trim corruption. Dark/invalid images cannot become negative model evidence. Missing or stale reports mean unknown, never inferred absence.

Startup, unreadable camera and malformed reports have separate visible states. A rapid restart automatically retries an authenticated busy GPU connection for a bounded15.75second schedule, covering the server's15second inference-drain bound. Lost connections immediately revoke monitoring evidence while preserving already validated hazards. A cold H100 start (container scheduling, image load, then the class's 180 s `startup_timeout`) can take minutes, so the gateway keeps the session `connecting` for up to 300 s (`NativeStream` `connectTimeoutMs`) before reporting it unavailable. See `docs/native-streaming.md` for the adapter and deployment evidence.

`POST /v1/videos?camera_id=test-camera` accepts one multipart `video` file (MP4/MOV/AVI, up to250MiB and ten minutes). The body may take up to 15 minutes to arrive (Node's server-wide `requestTimeout`, sized for 250 MiB on a ~2.3 Mbit/s uplink); every other HTTP request must still arrive within 2 minutes. Refusals: `video_job_busy` (409), `invalid_camera_id`, `video_required` or `invalid_multipart` (400), `video_too_large` (413), `unsupported_video_format` (415), `upload_storage_limit` (507) and `video_store_failed` (500). Poll `GET /v1/videos/:id` for status, frame timeline and fresh-inference usage. Recorded results describe the observed interval. All usable videos are analyzed independently of detections, including short clips; short evidence cannot bypass the monitoring interval requirement. One upload job and one native live session may run concurrently on separate GPU pools.

## Priority

Policy `minicpm-only-v5` reads strict per-image MiniCPM enums, never old detector boxes or scores. Monitoring is unchanged: three distinct agreeing reports spanning at least 2 seconds, all intervening reports agreeing, within a bounded 8 second pool that expires by its oldest support at 10 seconds. Lighter monitoring applies to every camera and tester by default; `EXPECTED_LIGHTER_CAMERAS` can restrict it to listed cameras (testers share the policy id `tester`); lighter presence alone cannot suppress smoke, secondary burning, separate flames or occlusion. A hazard alert latches on 2 valid hazard reports (smoke, burning material or a separate flame) within 20 seconds; invalid or uncertain reports, gaps and reconnects between them do not discard the first, while 3 consecutive clear reports dismiss a pending single report. If any pending report comes from a low-detail (blurry or grainy) frame, latching needs 3 reports, and a low-detail report stays pending for 40 seconds. A field a report marks present while its own description explicitly negates it (for example smoke `present` with "no smoke visible") counts as uncertain. Frames showing confident whole-view camera motion are skipped. A lighter or match flame at its tip with nothing else burning gets low priority (`monitor`) on every camera and for testers unless `EXPECTED_LIGHTER_CAMERAS` lists specific cameras; vapor from a visible vape is not reported as smoke. A single live smoke/material report shows `hazard_unconfirmed` (a lone uncontained flame is still inspected but not latched); an upload that ends on an unconfirmed report is flagged `inspect_urgently` (`hazard_unconfirmed_recording`). The live model session resets its context after any hazard report, so confirmation is independent. While latched, every newer hazard report refreshes the alert, so a review of older evidence is rejected. A latched alert's current priority is restored after 8 consecutive valid clear reports, each at most 15 seconds apart, with the latest one current; a gap, invalid report or non-clear report, including a non-clear report rejected as stale or unusable, resets that streak. Release does not delete incident history or by itself authorize monitoring; operator review (below) resets the incident.

Validated smoke, burning material or a separate flame retain urgent inspection through darkness and reconnect. A reviewed hazardous camera (`HAZARDOUS_CAMERAS`, where testers are likewise `tester`) can escalate an observed flame. Missing/invalid/stale/occluded evidence is unknown unless a prior validated hazard remains unresolved. Invalid reports revoke a previous monitoring interval. Old YOLO-only historical incidents do not become model-confirmed hazards. Cause remains unknown; scene recognition is not verified ignition attribution or measured physical severity.

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

The deployment verification scripts use private local configuration without printing credentials. They make real public GPU calls. The retired detector/Worker code and its tests are archived under `legacy/` and are not part of this product. See `docs/model-only-analysis.md` for fresh deployment evidence and limitations.

## Webcam test set

To measure false smoke reports per policy version, record the labelled clips described in `docs/webcam-test-set.md` and run `scripts/evaluate_webcam_set.py`. `scripts/export_false_alarms.py` turns operator `false_alarm` reviews into clips for the same set.
