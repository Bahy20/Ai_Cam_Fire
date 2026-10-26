# Raspberry Pi + Cloudflare deployment

## Target and status

Pi: `edge/agent.py` runs capture and local YOLO. Worker/CameraDO: auth, validation, temporal confirmation and footprint trends. Workers AI: incident-time vision investigation. D1: incident summaries. Pi filesystem: incident JPEGs/manifests; no R2 binding or activation required. **No Modal apps, public detector endpoint, VLM on the Pi or warm GPU container are required.**

The actual Pi model/RAM/cooling/accelerator/camera count is unspecified; CPU compatibility is not a performance guarantee. This is an advisory prototype, not a certified alarm/suppression controller.

Read-only account audit during implementation: no fire-related Modal app; only unrelated `resumable-download-server`, left untouched. Wrangler reported `fire-guard-api` does not exist (10007). No obsolete fire app existed to terminate. Preserve shared secrets, unrelated apps and retained evidence.

D1 `fire-guard-db`, UUID `048371ca-9b5d-485d-b09b-e2426a859ade`, was previously provisioned with `0001_init.sql`. Migrations `0002_analysis.sql`, `0003_event_keys.sql` and `0004_operator_reviews.sql` must also be applied; their remote application is not established by local tests. R2 activation previously returned 10042, but R2 is no longer required by this Pi-storage profile. Recheck resources; these observations are not production acceptance for the new code.

## Local gates

Run from `E:/coding/fire` in Git Bash:

```bash
node --test --test-concurrency=1 worker/test/*.test.js
PYTHONPATH= .venv/Scripts/python.exe -m unittest discover -s scripts/tests -p 'test_*.py' -q
cd worker
node test/cloud-config.test.js --preflight production
node ../scripts/wrangler.mjs types --env production
node ../scripts/wrangler.mjs deploy --dry-run --env production
```

Preflight verifies explicit edge/Workers AI bindings and identifiers, not remote resources, secrets or model quality. Start local Wrangler with `wrangler.dev.jsonc` on an unused port, then run the Pi agent's video mode (see `edge/README.md`). Use `--allow-http` only for loopback development. Offline dev has no AI binding and intentionally exercises safe fallback.

Use `scripts/wrangler.mjs` (or the `worker/package.json` commands) for ad hoc Wrangler work in this workspace. It runs the pinned local CLI and writes diagnostic logs under `.hermes/wrangler-logs`, avoiding the protected AppData log path. `npm run auth:check` in `worker/` verifies the saved login without printing a token. Remote Wrangler commands require access to Cloudflare over HTTPS; a restricted agent sandbox can deny that connection and misreport it as an expired login or file permission error. In that environment, run the command with network-enabled execution. The saved OAuth login refreshes automatically when the connection is available; do not repeatedly run `wrangler login` to work around a network denial. See [Cloudflare's Wrangler environment variables](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/) and [authentication commands](https://developers.cloudflare.com/workers/wrangler/commands/general/).

For **real remote Workers AI** with local D1 and Pi-local evidence, use the explicit opt-in config (incurs inference usage):

```bash
# Run from worker/. Use the same isolated local directory for migrations and runtime.
node ../scripts/wrangler.mjs d1 migrations apply fire-guard-db --local --config wrangler.ai-dev.jsonc --persist-to .wrangler/analysis-test
# Use an interactive terminal/PTY if Wrangler needs one.
node ../scripts/wrangler.mjs dev --config wrangler.ai-dev.jsonc --ip 127.0.0.1 --port 8792 --persist-to .wrangler/analysis-test
```

For deterministic restart verification on this Windows development machine, run `node scripts/test_coordinator_restart.mjs` from the project root. It uses fresh local persistence, no AI/R2/remote services, and fixed unused loopback ports 8797/9239. `--fail-after-watch` must exit 1 while still cleaning only its owned process tree. Its printed `result.json` and `audit.json` include exact event read-backs; scratch results may be pruned. This is a coordinator contract check, not detector/VLM/Pi verification.

Apply local migrations to the same persistence directory before replay. Run `scripts/test_edge_runtime.mjs --help` from the repository root for the real-video capture harness. `--require-ai` rejects fallback as an AI integration pass. Default offline development remains separate; never claim a mock/fallback as successful model inference. The remote-AI dev config is not a production deployment and deliberately leaves D1 local; images are a bounded in-memory cloud inference buffer only.

## Production prerequisites and commands

1. Verify the intended Cloudflare account. Reuse existing D1, not duplicate resources.
2. Configure a writable Pi evidence directory and a disk budget (see `edge/README.md`). Do not enable R2 for this profile.
3. Verify Workers AI access/model availability and approve the inference budget. Measure image/output tokens and latency; do not assume a fixed incident allowance.
4. Root and `env.production` explicitly declare `DETECTOR_PROVIDER=edge`, `VLM_PROVIDER=workers_ai`, `VLM_MODEL=@cf/meta/llama-4-scout-17b-16e-instruct`, `EVIDENCE_STORAGE=pi`, and bindings `AI`, `CAMERA_DO`, `DB`. No R2 binding.
5. Set **only `INGEST_API_KEY`** for this profile using a masked provider prompt. Supply the matching key to the Pi environment. Never put secret values in chat, arguments, source or service templates.

From `worker/`, against the approved account:

```bash
node ../scripts/wrangler.mjs whoami
node ../scripts/wrangler.mjs d1 info fire-guard-db --env production
node ../scripts/wrangler.mjs secret put INGEST_API_KEY --env production
node ../scripts/wrangler.mjs d1 migrations apply fire-guard-db --remote --env production
node test/cloud-config.test.js --preflight production
node ../scripts/wrangler.mjs deploy --dry-run --env production
node ../scripts/wrangler.mjs deploy --env production
node ../scripts/wrangler.mjs deployments list --env production
```

Provisioning, migrations, secret writes, deployment and inference change external state or incur spend. Verify the exact account and read back exact targets. Record the actual returned URL; do not invent it.

**No `DETECTOR_URL`, `DETECTOR_API_KEY`, `VLM_URL`, `VLM_API_KEY` or Modal secret is required.** Superseded adapters, duplicate simulators and the old unused response-policy engine are removed, not merely disabled. For older installations, positively identify obsolete fire app IDs before stopping them after cutover; never stop unrelated services.

## Reviewed site context and response priority

`CAMERA_CONTEXTS_JSON` is an operator-managed JSON **string** variable, explicitly `{}` by default in every profile. A basic reviewed entry has `reviewed:true`, nonempty `reviewed_by`, `reviewed_at_ms`, `occupied_area` (boolean), `known_hazards` and `critical_zones` (fixed enum arrays). The separate `expected_handheld_flame_use:true` permission can be added only after review of the camera's expected use; it is camera-bound and expires no later than 30 days after review. It cannot lower priority alone: the initial local fast path also requires a fresh authenticated two-frame candidate, the pinned model, adequate image quality and no hazard veto. Scout V3 is a later second opinion; its hazard/uncertainty can restore urgency. Legacy `expected_flame_use:true` remains readable but cannot authorize a handheld downgrade. Keep the feature disabled until the release-completion plan passes.

The stationary-source review fields are all-or-nothing: `context_revision`, `geometry_revision`, `reviewed_reference_image_sha256`, `reference_dimensions`, normalized `crop_rect`, `source_zones`, and `review_expires_at_ms` (at most 30 days after review). Each source zone contains `zone_id`, `source_type` (`candle` or `stationary_burner`) and a normalized `bbox_normalized` rectangle. Create a local draft with `python scripts/annotate_reference.py --image CAMERA.jpg --camera cam-01 --output reference-cam-01 --zone-id candle-1 --source-type candle --context-revision 1 --geometry-revision 1`; inspect the image and rectangle, keep its JPEG bundle with local setup artifacts, and activate only after a human review through trusted Worker configuration. The utility never approves or deploys the draft. The current edge agent does not load bundles automatically.

The Worker uses only its privately validated camera-specific reference; frame uploads, VLM claims and raw `cameras.context_json` cannot mark context reviewed. Both source-time and current review expiry are checked. Stationary-source geometry/background continuity remains shadow-only. The separate handheld lease and priority path is experimental and default-off; the current weights and image-quality output do not produce an eligible local candidate, so confirmed incidents stay urgent.

`response_priority` / `operator_priority` are identical string enums: `monitor`, `inspect_urgently`, `escalate`. The initial confirmed-fire alert and live updates remain urgent unless a separately qualified live local-evidence lease applies. A valid Scout V3 lighter assessment may label only its captured, post-confirmation interval `monitor` when the opt-in flag, reviewed camera policy, fresh evidence, one current fire region, and every scene gate pass. That result does not change current live state, cause, severity, or hazard status; `operator_review_required` remains true. The event and persisted analysis JSON carry `priority_scope` (`live` for confirmation, `observed_interval` for Scout analysis) so dashboards can keep historical assessment separate from the current alert. The Scout path is experimental and default-off. Reviewed occupancy/hazards or quality-gated growing activity may escalate attention. Reasons, evidence-quality and limitations accompany the priority. Physical severity stays `unknown`, with no suppression authorization.

Both Worker profiles set `HANDHELD_PRIORITY_ENABLED=false` and `HANDHELD_MODEL_SHA256=""`. The edge's optional `--handheld-model` must be a separately evaluated local CPU model with the required `fire`, `smoke`, `lighter_flame`, and `secondary_burning` classes and a pinned SHA-256. The normal `detector/fire_seg.pt` lacks the latter two classes. The feature must remain disabled until independently labeled held-out results and a sustained Raspberry Pi benchmark pass; no deployment or enablement is implied by these instructions.

Accepted cause/source/tool/fuel/class stay `unknown` for all unreviewed AI outputs. Bounded observations and a separately labeled model hypothesis are retained for human review. Valid frame IDs and plausible action descriptions do not establish causal truth. The separately Access-authorized `/operator/cameras/:id/reviews` API stores append-only **human attestations** without changing original model aliases or authorizing suppression. Configure real identities independently; controls are disabled by default. See `docs/operator-workflows.md` for the full API, authorization boundary and review semantics.

## Pi setup / networking

Use `edge/requirements.txt` in a Pi virtualenv and the existing checkpoint at its configured local path. Follow `edge/README.md` for CLI/systemd. Benchmark CPU before choosing target sampling rate or accelerator-specific exports. The Pi opens outbound HTTPS only; do not expose RTSP or a detector to the Internet.

This version uploads each sampled JPEG with detections while storing incident evidence on the Pi. Local evidence can be recorded without cloud delivery; it is not a persistent upload queue or local alarm. Selected-frame-only bandwidth reduction, local alarms and offline incident coordination are not implemented. Cloud outages must be visible, not misrepresented as autonomous protection.

## Runtime safeguards and durable lifecycle

The cloud inference buffer accepts at most 512 KiB of base64 per image and 8 MiB total per camera (also at most 24 images); this is a storage-payload budget, not a whole-isolate memory guarantee. Oversized images are rejected with 413. If pinned evidence cannot fit, 503 reports the failure rather than deleting pinned images or Pi evidence; lower capture image size/quality and investigate the explicit failure. Cloud rejection does not undo local Pi retention.

Native binding timeouts do not cancel inference. A per-object permit remains held until the actual `AI.run` promise settles, blocking additional native calls while it is stalled. `GET /state/camera/:id` reports active, queued, follow-up and native-pending work. The replay harness waits for explicit idle state and exact persisted analyses, not only the first cause event; `--analysis-wait-ms` sets its bounded wait.

Source gaps over two seconds expire old confirmation support but do not clear an already confirmed incident. Snapshot assessment freshness uses server receipt time with a five-second experimental gate, independent of replay/source event time. These timings are uncalibrated for the unspecified Pi/camera hardware. Device-health heartbeats now use separate server-receipt state and the DO's shared durable alarm: `/health/camera/:id` and `/health-events/camera/:id` expose deduplicated online/degraded/offline transitions. This is not guaranteed external notification delivery or an offline fire alarm; the unsupported cron stays removed.

CameraDO uses its configured SQLite backend for a versioned metadata checkpoint and bounded event outbox. Every accepted observation checkpoints the source watermark, compact strong/any/any-detection flags, lifecycle and original receipt time. Confirmation, incident identity and delivery intent are stored before broadcasting the confirmation or invoking AI. D1 must acknowledge the confirmation before native investigation starts; a D1 outage can delay investigation without erasing confirmation. The outbox is limited to 64 records (analysis JSON at most 64 KiB); new observations return `503 incident_event_backlog` at 62 pending records, reserving slots for running/queued analysis. It does not evict incidents to make room.

A per-object retry alarm is armed before intent commits and re-arms while delivery/work remains. Delivery is at-least-once, with an idempotent D1 effect keyed by `event_key`; lost acknowledgements retry the same payload. `/events` contains separate `event_kind=confirmation` and `event_kind=analysis` rows for the same incident: do not count them as two incidents. Pending confirmation JSON has `analysis_status=pending`; a separate analysis row carries completion and its job ID. Local SQLite/outbox writes are not proof of remote production persistence.

The checkpoint contains no JPEG bytes or trusted-context authority. Cold restore has no transient images, promises, queues or byte pins; missing image bytes are omitted, not replaced. `durability_status` reports pending records and interrupted analysis. Native work is checkpointed before dispatch; a restored `native_inference_interrupted=true` means the previous backend outcome is unknown. New native calls stay blocked with `vlm_previous_lifetime_unresolved`; there is no automatic timeout/cancellation assumption. The guarded `/operator/cameras/:id/recovery` procedure requires externally established provider completion/cancellation and two independently configured operator identities; proposal/audit and local permit release are atomic. It cannot stop the provider or machine-verify a human's reference, and dispatches no replacement call itself. Keep the gate blocked when external evidence is unavailable; see `docs/operator-workflows.md`. Actual operator provisioning and organizational independence remain production gates. A storage/checkpoint failure returns 503 and fails that lifetime closed until restart; malformed durable metadata never becomes idle.

Generation fencing and incident/job guards prevent an old callback from changing the new lifetime. Superseded AI jobs are dropped rather than attached to a newer incident; every confirmed incident still has its confirmation record. The most recent closed incident can finish investigation without reactivating detection.

## Acceptance gates

- Auth: missing/wrong key fails before DO dispatch; missing production secret fails closed. Redirects do not forward the Pi key.
- Operator controls: configure a path-scoped Access application, exact issuer/audience and independently reviewed subject/email/permission/camera policy. Ingest authority is not review authority. Mutation requires JSON/same-origin browser requests; operator responses are not cached. Verify exact immutable review/audit read-backs and the two-identity recovery boundary separately from backend outcome truth.
- Contract: actual local YOLO detections and matching JPEG pass `/observation/camera/:id`; identity, dimensions, box bounds, body limit and timestamps reject invalid data before mutation. No HTTP detector call occurs.
- Runtime: replay both original videos through actual Pi-agent code and actual workerd with source timestamps. Capture complete WebSocket output before uploads, failures, frame indices, confirmation lane and trend limitations. PC replay is not a Pi performance result.
- Vision: verify the actual Workers AI model, chronological images, latency and normalized fields. Malformed JSON abstains. Unknown fuel/hazards do not produce water advice. HTTP success alone does not validate cause attribution.
- Persistence: read back exact D1 rows (cloud snapshot key must be null) and the Pi incident manifest/JPEGs. Check byte budget and write failures without disabling cloud upload. No cloud claim of successful Pi storage replaces actual disk verification. Migration `0002_analysis.sql` stores qualified analyses; `0003_event_keys.sql` separates confirmation/analysis records and adds retry identities. Verify full JSON and scalar fields agree, not just row existence.
- Hardware/quality: measure real Pi capture freshness, inference/sampling rate, thermals, memory and multiple cameras. Evaluate independent fire and long negative footage. Known positive fixture miss remains.

Unit tests, dry runs, old replay directories and successful configuration are not production acceptance. Report actual execution and blockers separately.

## Official references

- https://developers.cloudflare.com/workers-ai/configuration/bindings/
- https://developers.cloudflare.com/workers-ai/models/llama-4-scout-17b-16e-instruct/
- https://developers.cloudflare.com/workers/best-practices/workers-best-practices/

