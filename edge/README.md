# Local YOLO edge agent

Advisory prototype, not a certified fire alarm. A Raspberry Pi model, memory size,
OS and sustained inference rate have **not** been validated. CPU is the default;
`--fps` is a requested sampling rate, not a throughput promise. No remote detector,
Modal service, local siren or relay is used. If cloud delivery fails, the process
warns explicitly; it does **not** supply an offline alarm.

## Install on the target machine

Use a 64-bit Raspberry Pi OS/Linux image with a Python version for which compatible
ARM64 CPU PyTorch/torchvision and OpenCV wheels are available. Start with Python
3.11 where supported. Check the official PyTorch installation guidance for your
actual OS/architecture; do not install CUDA builds on a CPU-only Pi. There is no
claim that every Pi can run this model at the default 3 FPS.

From the repository root, after choosing compatible CPU torch/torchvision wheels:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r edge/requirements.txt
```

Keep the existing `detector/fire_seg.pt` on the device. `--model` accepts an existing
local weights file only: a missing file fails rather than downloading a model.
The edge module is import-safe and loads YOLO only on first inference. The old
standalone detector/VLM servers and Modal adapters have been retired.

The automated checks here ran on Windows/Python 3.11 with OpenCV 5.0, Ultralytics
8.4, NumPy 2.4 and requests 2.34; this is not a Pi deployment verification.

## Draft a reviewed stationary-source reference

The optional local utility lets an operator draw one expected stationary flame
rectangle on the exact camera JPEG. It writes an unapproved bundle containing the
original JPEG bytes, dimensions, crop, zone and SHA-256 fingerprints:

```sh
.venv/bin/python scripts/annotate_reference.py \
  --image camera-reference.jpg --camera cam-01 --output camera-reference-cam-01 \
  --zone-id candle-1 --source-type candle --context-revision 1 --geometry-revision 1
```

The rectangle is a source-location hint, not proof that a flame inside it is safe.
Review the drawing and image yourself, then add matching revision, hash, dimensions,
crop, zone and an expiry no more than 30 days away to the trusted Worker
`CAMERA_CONTEXTS_JSON`. Keep the JPEG bundle on the edge machine. The loader checks
the image and configuration hashes; missing, changed or unreadable reference data
means unknown camera stability. The current camera agent does not automatically
load the bundle or send scene-continuity measurements. The stationary-source
reassessment path remains shadow-only.

## Experimental handheld lighter candidate

The edge CLI can optionally load a **separate** local model with
`--handheld-model PATH --handheld-model-sha256 LOWERCASE_SHA256`. It runs on CPU
only, never downloads weights, and requires `fire`, `smoke`, `lighter_flame`, and
`secondary_burning` classes. The existing `detector/fire_seg.pt` does not have the
latter two classes and cannot be used for this candidate. The local adapter needs
two chronological matching detections and reports uncertainty instead of guessing.
It does not decide that a scene is safe or set operator priority.

The current camera pipeline reports visibility as `unknown`; the candidate requires
`adequate` image quality, exactly one fire region, and no detected smoke or
secondary burning. Therefore the repository's current configuration/model cannot
produce an eligible candidate. Cloud priority also requires the default-off Worker
flag, the matching model hash, reviewed `expected_handheld_flame_use` camera context
and a valid Scout V3 scene assessment. Keep the feature disabled until separately
annotated held-out video and a sustained Pi CPU/memory/temperature/frame-drop
benchmark pass.

## Live camera

Supply `INGEST_API_KEY` and preferably `EDGE_RTSP_URL` through a protected process
environment or systemd EnvironmentFile. Do not place credentials in command lines
or shell history. `--rtsp` remains available for non-sensitive camera URLs.

```sh
.venv/bin/python -u edge/agent.py --camera cam-01 \
  --worker https://YOUR-WORKER.workers.dev \
  --device cpu --imgsz 640 --fps 1 --max-det 256 \
  --report edge-report.json
```

Exactly one input is needed: `--video PATH`, `--rtsp URL`, or `EDGE_RTSP_URL`.
For a USB webcam attached to this computer, use `--camera-index 0` (Windows
DirectShow or Linux V4L2; try indices `1` or `2` if another device uses index 0).
An explicit video or local camera overrides the environment RTSP source.
SIGINT/SIGTERM request
a graceful stop and a final report. Decoder open/read operations use FFmpeg timeout
properties (`--timeout`, default 10 seconds); unsupported FFmpeg capture fails
instead of falling back to an unbounded camera backend. Native capture stderr is
suppressed because FFmpeg/OpenCV may echo credential-bearing RTSP URLs. Agent
errors are sanitized codes, not backend exception strings. Suppression temporarily
redirects process stderr: use this as a single-camera CLI rather than embedding
multiple captures in one process. Its optional heartbeat thread never prints backend exceptions.

The interactive lighter test is available only in an isolated development Worker.
Set `VLM_EVALUATION_MODE=true`, `SCOUT_HANDHELD_PRIORITY_ENABLED=true`, and
`SCOUT_HANDHELD_LIVE_TEST_ENABLED=true` there, and configure a current reviewed
camera context with `expected_handheld_flame_use:true`. The Worker reports monitor
while Scout checks the attached frames; it keeps monitor only when Scout supports
the lighter-tip flame on at least three chronological frames spanning two seconds,
with no secondary burning, smoke, occlusion or contradictory evidence. Unclear or
failed review returns to urgent inspection. This is a supervised test behavior;
`monitor` does not establish that the scene is safe, and all normal/production
profiles keep this switch off.

On Windows, set those three variables and a current reviewed camera entry under
`CAMERA_CONTEXTS_JSON` in `worker/wrangler.ai-dev.jsonc`, then run `npm run dev:ai`
from the `worker` directory. Keep this local profile separate from production and
point the edge agent at its local URL:

```powershell
$env:INGEST_API_KEY = 'your-development-ingest-key'
.venv\Scripts\python.exe -u edge\agent.py --camera-index 0 --camera live-test `
  --worker http://127.0.0.1:8787 --allow-http --device cpu --imgsz 640 --fps 3 `
  --report live-test-report.json
```

Use `--camera-index 1` if Windows assigns the webcam another device index. Scout
receives only the sampled JPEG evidence required by an investigation, not a
continuous video stream.

The agent exits nonzero on a lost live stream; the service manager can restart it.
There is no persistent offline queue. Each upload gets at most `--attempts` attempts
(default 3, maximum 10) with bounded backoff and request timeout. 3xx redirects and
non-retryable client errors fail immediately; authentication is never forwarded
through a redirect. Production URLs must be HTTPS without userinfo/query/fragment.
`--allow-http` explicitly enables insecure development only. TLS verification stays
on. Network mode requires the key from `INGEST_API_KEY`; there is no `--api-key`
argument. requests does not inherit proxy or .netrc configuration.

## Live device heartbeat

Live RTSP network mode also sends outbound `/heartbeat/camera/:id` requests using
the existing ingest key and a dedicated, bounded requests session. No camera-inbound
port or operator credential is needed. Replay and dry-run do not send a live-device
heartbeat. Capture, inference and recorder progress are monitored independently;
an alive thread alone does not report a healthy pipeline. Stage failures report
`capture_error`, `inference_error` or `storage_error`; missing/old progress reports
`stalled`. Heartbeat delivery failure does not disable evidence recording.

`--heartbeat-interval` defaults to 15 seconds (range .05–30), and
`--heartbeat-stall-seconds` to 30 seconds (range .05–300). These are experimental,
not actual Pi throughput or latency measurements. Requests never follow redirects,
inherit proxies/.netrc, buffer response bodies or run concurrently. Owned-thread
shutdown is bounded; provider/inference work is monitored, not forcibly cancelled.
Cadence uses monotonic deadlines rather than adding network duration to every
interval. The 30-second maximum leaves transport margin before the server's
60-second expiry. A storage failure remains latched through negative/no-op samples
until a new JPEG and manifest entry are successfully archived; a no-op is not a
disk-recovery test. On terminal capture/model/storage failure, the same sender
makes at most one best-effort final attempt for a newly unreported failure before
closing. It never overlaps another request. Cloud failure or a bounded shutdown
timeout can still prevent delivery; the cloud then relies on receipt expiry.

Synchronize the Pi wall clock: the server rejects sent timestamps outside a
30-second window and old/reordered packets. Accepted freshness uses **server
receipt time**, not client time. `/health/camera/:id` and
`/health-events/camera/:id` expose deduplicated online/degraded/offline transitions;
the initial offline threshold is 60 seconds without a fresh accepted heartbeat.
Device online is not proof of current scene evidence, detector accuracy, successful
incident archival or safety. This does not implement SMS, a siren, a local fire
alarm or protection that works without cloud delivery. See
`docs/operator-workflows.md` for health retention and the separate operator API.

## Replay, dry run, and reports

A real file replay exits at EOF and runs as fast as decode/inference/network allow.
It samples from source presentation timestamps (`CAP_PROP_POS_MSEC`), falling back
to frame index / native FPS only when timestamps are unavailable/nonmonotonic.
Fallback use is counted. Missing timestamps **and** missing native FPS fail rather
than making up incident timing. The first decoded frame is source offset zero;
`--start-ts-ms` anchors it to a chosen epoch (default: replay start wall clock).
Processing latency is measured separately. `--realtime` optionally paces against
absolute source deadlines, not inference time plus a sleep. A one-microsecond
scheduling tolerance avoids double-precision boundary skips; event time is not
altered by that tolerance. Event milliseconds are kept strictly increasing.

```sh
# Inference only: no Worker/key/HTTP session needed.
.venv/bin/python -u edge/agent.py --video PATH/clip.mp4 --camera replay-01 \
  --dry-run --fps 3 --max-frames 12 --report replay.json --output replay.jsonl \
  --evidence-dir edge-data/evidence --evidence-max-bytes 268435456

# Local Worker integration (key still comes from the environment).
.venv/bin/python -u edge/agent.py --video PATH/clip.mp4 --camera replay-02 \
  --worker http://127.0.0.1:8791 --allow-http --fps 3 --report replay.json
```

On Windows, substitute `.venv/Scripts/python.exe` for `.venv/bin/python`.
`--max-frames` bounds sampled attempts, including failed inference, not decoded
source frames. EOF on an empty/unreadable input, any inference failure, any exhausted
upload, or a failed output/report write gives exit code 1. CLI validation errors
exit 2. A successful dry run exits 0 but proves no cloud delivery.
Evidence-storage failures also exit 1, even if every cloud upload succeeded.

`--report` writes a final JSON object with:

- `source.kind`, `source.input` (all RTSP URLs redacted), `source.fps`, and
  `source.timestamp_fallbacks`; `camera_id`, local `model`, `device`, `imgsz`,
  `sample_fps`, `start_ts_ms`, and `dry_run`.
- `frames_read`, `frames_sampled`, `inferred`, `uploaded`, `inference_errors`,
  `upload_errors`, `errors`, and `exit_code`.
- `elapsed_ms`, aggregate `inference_ms.{mean,max,total}`, and `upload_ms_total`.
- `records`: last **256** sampled attempts, with `records_dropped` for the rest.
  Successful inference records include `source_frame_index`, `source_offset_ms`,
  `ts_ms`, `frame_wh`, `detections`, `jpeg_bytes`, `encode_ms`, `inference_ms`,
  `total_ms`, and status. Network records also have `upload_ms` and the actual
  Worker `response` on success. Inference failure records have no detections.

`--output` streams **every** record as JSONL with a flush per sample and no JPEG
content; rotate or bound that file for long live runs. The summary report is final,
not a live health endpoint. First inference timing includes lazy model loading.
No model-accuracy or Pi-throughput claim follows from these adapter tests.

## Pi-local incident evidence (enabled by default)

Permanent incident JPEG evidence stays **on the Pi**, with no R2 dependency.
`--evidence-dir PATH` overrides `EDGE_EVIDENCE_DIR`; the default is
`edge-data/evidence` relative to the process working directory. Dry runs also
save candidate evidence: use a temporary/isolated evidence root for replays.
`--evidence-max-bytes` is a positive integer byte budget, default **268435456**
(256 MiB). This is not a retention/deletion policy.

The recorder keeps the most recent **24 successful JPEG observations** in memory,
including the current sample, with timestamps, source frame indices where available,
dimensions and fire/smoke detections. A first local fire or smoke candidate with
confidence **>= 0.08** opens a bundle and flushes that chronological ring **before
attempting the candidate's cloud upload**. It therefore works when uploads fail.
If no bundle is open, a cloud `watch` or `confirmed` response also opens one from
the ring. Every subsequent successful sample is retained while local candidates
or cloud watch/confirmation continue, plus **8** subsequent non-relevant samples.
The last tail sample is saved before closing; renewed relevance resets the tail.
Inference failures are not fabricated negative observations or tail JPEGs.

Bundles have deterministic safe paths, for example:

```text
edge-data/evidence/cam-cam-01/incident-0000001000000/
  manifest.json
  0000001000000.jpg
  0000001001000.jpg
```

Open `manifest.json` and the referenced `.jpg` files for human review. `frames`
lists the exact uploaded/inferred JPEG bytes without re-encoding, event `ts_ms`,
`source_frame_index` (null if unavailable), `frame_wh`, and detections. `trigger`
is `local_candidate`, `cloud_watch`, or `cloud_confirmed`; `cloud` retains confirmed
status/hits/time when returned, not an invented VLM cause. `state` is `recording`,
`tail_complete`, or `capture_ended`. Tail completion/capture ending means only that
recording stopped, **not** that fire is extinguished or the site is safe.
`human_review_required=true` and `local_alarm=false` are explicit. The oldest
retained image is merely recent context, not a claimed pre-ignition image.
Only whitelisted observation/cloud metadata enters manifests; no input URLs,
API keys, model paths, arbitrary backend error strings, or local risk/cause labels.

JPEG publication is atomic and exclusive; manifest updates for the currently
owned bundle use an fsynced temporary file and atomic replacement. Existing
bundles are never resumed or overwritten on restart: a timestamp collision gets
`-0001`, `-0002`, etc. Identical immediately repeated observations are idempotent;
conflicting/reversed timestamps fail explicitly. Camera IDs are validated and
symlinks/Windows junctions are rejected. Use a local filesystem supporting hard
links and atomic rename (normal Linux ext4/Windows NTFS); unsupported filesystems
fail explicitly rather than weakening publication guarantees. This is not a
claim of power-loss-proof storage or a tamper-proof archive.

The budget includes **all existing file bytes** under the configured root at
startup and before writes, including retained incidents, partial/interrupted
artifacts, and conservatively any unrelated files. Atomic manifest staging also
needs spare budget for the complete replacement before releasing the old file.
Directory/filesystem allocation overhead is not included. Use one recorder process
per evidence root (the systemd template isolates camera roots). No old evidence,
partial JPEG, or unrelated file is pruned. A storage failure may leave a partial
bundle or a complete JPEG not yet indexed by its manifest; preserve those for
manual review, do not assume the manifest is complete after a reported error.
When the budget fills, archive/move retained incidents manually under an approved
retention policy, or select a larger budget/new root. The agent never deletes
retained incidents to make room.

Storage failure **does not stop attempted cloud uploads**. Stderr and the report
include sanitized evidence errors and overall exit code 1. The report's
`evidence_errors`, `evidence.{enabled,saved_frames,incidents,errors,max_bytes}` and
per-record `evidence`/`evidence_error` expose local persistence separately from
cloud success. `saved_frames` counts JPEGs indexed by a successfully published
manifest, not failed saves. `incidents` retains the last 256 relative bundle paths.
These local associations never enter cloud observation payloads or D1 paths.
There is still no offline upload replay queue, siren, or local safety alarm.

## Observation contract and uncertainty

Every sampled frame is resized without upscaling, encoded once as JPEG, then that
same JPEG is decoded for local inference. POST goes to
`/observation/camera/{id}` with `x-api-key` and JSON:

```json
{
  "camera_id": "cam-01",
  "ts_ms": 1000000,
  "frame_wh": [640, 480],
  "detections": [{"cls": "fire", "conf": 0.12, "bbox_xyxy": [20, 30, 80, 100]}],
  "jpeg_b64": "...",
  "visibility": "unknown",
  "camera_motion": null
}
```

YOLO confidence floor is fixed at **0.05**, with at most **256** fire/smoke boxes;
`--max-det` can reduce that ceiling. Boxes are expressed in the exact decoded JPEG
coordinate space. Visibility is unknown unless the edge can identify an unusable
uniform frame or a candidate box touching the image boundary; camera motion stays
unknown. Empty
**successful** inference means not detected, not adequate visibility, safety or
extinction. Failed inference omits the observation instead of uploading fabricated
empty detections. This implementation sends **every sampled JPEG**. The cloud may
hold bounded temporary investigation context; the Pi is the incident archive.
There is no image-bandwidth reduction or local alarm claim.

The edge process computes local luminance and Laplacian-variance diagnostics from
the same decoded JPEG and records them in its per-frame run report. These numbers
are measurements, not image-quality labels. No reviewed quality profile or local
occlusion assessor is installed, so plausible frames remain `unknown`; clearly
uniform black/white frames and detector regions touching an image edge are marked
`degraded`. The quality payload sent to the Worker stays fail-closed (`unknown`
stability, blur score and occlusion), and these diagnostics cannot qualify a
handheld priority downgrade.

## Optional systemd template (not deployed/tested on a Pi here)

`edge/fire-guard-edge@.service` expects the checkout at `/opt/fire`, venv at
`/opt/fire/.venv`, a system account/group `fire-guard`, and one root-controlled
`/etc/fire-guard/cam-01.env` (mode 0600) per camera containing:

```ini
INGEST_API_KEY=YOUR_INGEST_KEY
EDGE_RTSP_URL=YOUR_RTSP_URL
EDGE_WORKER_URL=https://YOUR-WORKER.workers.dev
```

Create that protected file with an editor, not a command containing credentials.
Read systemd EnvironmentFile quoting rules for values with special characters.
Ensure the service account can read the checkout, venv and weights. Then install
and verify the template on the actual Linux device before enabling:

```sh
sudo install -m 0644 edge/fire-guard-edge@.service /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/fire-guard-edge@.service
sudo systemctl daemon-reload
sudo systemctl enable --now fire-guard-edge@cam-01
sudo systemctl status fire-guard-edge@cam-01
```

The template sets CPU/1 FPS as a starting request (not a benchmark), bounded cloud
retries, on-failure restart, a writable private StateDirectory for configuration
and the final report, and a read-only system filesystem. Its evidence root is
`/var/lib/fire-guard/evidence/%i`, inside writable `StateDirectory=fire-guard`,
not the protected `/opt/fire` checkout. `EDGE_EVIDENCE_DIR` in the protected env
file may override this only with another appropriately writable state location.
The default 256 MiB budget applies per instance root. Tune only after measuring
CPU temperature, memory, latency and sustained throughput on the real Pi. Do not
interpret service health as detection quality.

## Tests

```sh
.venv/bin/python -m unittest discover -s scripts/tests -p 'test_edge*.py' -v
```

Tests use synthetic images/video and an injected model boundary, not downloaded
weights. They exercise actual OpenCV JPEG/video processing and a loopback HTTP
server, including no redirect-following, source-time sampling and failure exits.
Evidence tests exercise real JPEG/manifest files, pre-trigger ring bounds, cloud
confirmation/tail handling, offline-first saves, storage-failure upload continuity,
restart collisions/idempotency, budget refusal, atomic failure preservation,
metadata redaction, and path/junction rejection. Tests isolate evidence in scratch
directories and do not download models, deploy a Pi, or certify detector accuracy.
