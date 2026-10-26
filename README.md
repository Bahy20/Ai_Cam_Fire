# Current deployed product

The active Modal webcam/upload product is MiniCPM-only. See [analysis/README.md](analysis/README.md) and [model-only analysis](docs/model-only-analysis.md). YOLO is excluded from its runtime, dependencies and image. The older Pi/Cloudflare experiments below are retained as historical development material.

# FireGuard

**Current deployment:** the PC/Raspberry Pi camera bridge sends video to a Modal-hosted analysis service. The default visual provider is now self-hosted MiniCPM-o 4.5 on a private Modal L40S service, with pinned weights and strict per-frame validation. Ignition cause remains unknown; keyboard LED false positives remain a known limitation. See [MiniCPM deployment](docs/minicpm-deployment.md) and [Modal deployment](docs/modal-deployment.md). The material below describes the earlier Pi + Cloudflare Worker architecture retained in this repository.

For the current PC video workflow, see [quality verification](docs/quality-verification.md): incident-clearing regressions, Scout contract/scene validation, neuron-budget accounting and annotation-aware replay. An isolated Cloudflare evaluation Worker has processed all three development videos with fresh Scout calls; the contained-lighter priority expectation has not yet passed. Local tests, deployed video replay, and actual Raspberry Pi performance are separate gates.

Advisory camera-fire prototype. **Pi:** local YOLO and incident JPEG/manifest archive. **Cloudflare:** authenticated observation ingress, temporal confirmation, image-footprint activity, operator-response priority, Workers AI investigation, and D1 event records. No Modal GPU app, R2 bucket, public detector server or Pi VLM is required.

## Active code

- `edge/agent.py`, `edge/evidence.py`: camera/video sampling, local JPEG-aligned YOLO, outbound authenticated upload, bounded context and local incident evidence.
- `detector/fire_seg.pt`: existing fire/smoke checkpoint. `detector/test_local.py` retains the labeled image baseline, including its known miss.
- `worker/src/`: actual CameraDO state, evidence selection, normalization, trends, investigation qualification and response policy.
- `worker/src/operator-auth.js`, `operator-review.js`, `native-recovery.js`: separately authorized human attestations and audited two-identity recovery of an interrupted native permit. Controls are disabled until Access identities are configured.
- `worker/src/camera-health.js`, `edge/heartbeat.py`: server-receipt device health, recent durable transitions and live RTSP progress heartbeats.
- `worker/test/`, `scripts/tests/`: deterministic implementation/contract tests.
- `scripts/test_edge_runtime.mjs`: real video -> actual Pi-agent code -> actual workerd, live events and persistence read-back.
- `scripts/test_coordinator_restart.mjs`: bounded Windows/offline contract smoke test across five actual workerd lifetimes; synthetic detections, no native AI. `--fail-after-watch` checks nonzero failure and owned-process cleanup.
- `scripts/evaluate_analysis.mjs`: annotated policy/metric evaluation; missing causal/onset/negative-footage labels remain explicitly unmeasured.

Old Modal/SmolVLM HTTP adapters, cloud-detector calls, duplicate Python state-machine simulation and unused duplicate lifecycle code have been retired. Weights, recordings, fixtures and prior evidence are retained.

## Install and verify

Use a Python virtualenv with compatible local CPU PyTorch/Ultralytics for the actual hardware. Development Windows commands from this directory:

```bash
.venv/Scripts/python.exe -m pip install -r requirements.txt
.venv/Scripts/python.exe -m unittest discover -s scripts/tests -p 'test_*.py' -q
node --test --test-concurrency=1 worker/test/*.test.js
```

For Raspberry Pi use `edge/requirements.txt` and follow **`edge/README.md`**. Choose sampling rate only after measuring hardware/capture freshness; this PC test environment is not a Pi benchmark.

## Run / deploy

The agent uses `INGEST_API_KEY` from its environment and `EDGE_RTSP_URL` for a credential-bearing camera URL. Never put keys/passwords in arguments or source. See the protected systemd EnvironmentFile instructions in `edge/README.md`. The service stores evidence under `/var/lib/fire-guard/evidence/<camera>/` with an explicit budget and no automatic incident deletion.

The Worker accepts `POST /observation/camera/:id` with detections and the matching JPEG. The retired `/frame` route returns a migration error, never calls a cloud detector. Workers AI uses the native `AI` binding, configured Scout model, and runs after the initial alert. Offline local dev intentionally has no AI binding; remote-AI dev is explicit opt-in and consumes inference usage.

See **`docs/cloud-deployment.md`** for local migrations, preflight, dry run and production commands. Reuse the configured D1; do not provision duplicates. Production still needs explicit account/secret/deployment verification. The Pi initiates outbound HTTPS only.

See **`docs/operator-workflows.md`** for the Access configuration, immutable cause-review API, external-provider-evidence recovery procedure and device-health routes. An ingest key never grants operator approval authority. Recovery attestations do not constitute application-verified provider cancellation.

## Meaning of the outputs

- Detection confirmation is not proof of danger, extinguishment or cause.
- Visual activity is normalized image footprint, not physical spread or real-world size.
- Operator-response priority is an experimental deterministic request for human attention, not a calibrated physical-risk score or suppression order.
- The optional handheld lighter `monitor` path is experimental and disabled by default. It requires separately evaluated local weights, adequate image quality, reviewed camera-use permission and matching Scout evidence; a lighter label alone never lowers priority.
- Accepted cause is separate from model hypotheses. Frame references link claims to supplied evidence but do not make model assertions true. Unreviewed attribution remains unknown; model confidence labels are not calibrated correctness probabilities.
- Unknown fuel/electrical hazards never become an automatic water recommendation.
- Local evidence recording works independently of upload success, but does not provide a siren, offline incident alarm or upload queue.

Independent false-alert evaluation, forensic attribution validation, physical-risk calibration, Pi hardware/systemd testing and production deployment are separate remaining gates. SQLite checkpoints preserve lifecycle/source ordering; a durable idempotent outbox records confirmation before AI. Interrupted native inference is unresolved and is never automatically replayed. The new guarded recovery API records two independently configured operators' external-provider attestations; it does not itself cancel or verify a backend operation. Device-health transitions use a shared durable alarm, not the retired cron, and are available for polling/live subscribersâ€”not guaranteed SMS, siren or emergency notification delivery. The known `fire1.jpg` fixture miss must stay visible in reports.
