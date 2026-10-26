# PC video quality verification

FireGuard now requires eight consecutive actual no-detection samples before ending a confirmed incident. A source gap resets clearance support; duplicate or delayed samples cannot advance it. The event still means no longer detected, never a physical safety finding.

Scout uses a versioned response contract for the prompt and application validator, with a deterministic generation-schema projection for the provider. V3 adds descriptive handheld tool assertions and derives `contained_tool_flame` only from valid, chronological frame-linked evidence; it never changes accepted cause. The application still enforces bounds, uniqueness and source chronology. A six-image V3 `response_format` probe at 2026-10-19 11:13 UTC returned zero schema errors, using one fresh call and 10,404 provider tokens. It supplied no scene/tool assertions and remained uncertain; contract acceptance is not recognition accuracy. The saved capture also passes offline parser replay. Evidence: `.hermes/ship-review-20261019/v3-probe`.

Scene assessment remains separate from verified cause. Stationary candles/burners use `contained_flame`; handheld tools use `contained_tool_flame`; other categories are `material_burning`, `smoke_only`, and `uncertain`. A stationary-source downgrade still lacks its complete live geometry/continuity path. The experimental handheld fast path requires reviewed `expected_handheld_flame_use`, an authenticated two-frame local candidate from a separately trained SHA-pinned model, adequate image quality, a current five-second incident lease and no veto evidence. It may monitor at confirmation before Scout responds. Semantic uncertainty or contradiction restores urgency; hazardous Scout evidence latches the incident even after the local lease expires. Provider unavailability cannot create/renew a lease and does not alone revoke independent current local evidence. Smoke, other burning, extra regions, stale/gapped evidence, motion/degraded visibility and site hazards remain vetoes. `monitor` still requires operator review; physical severity and accepted cause remain unknown.

The checkpoint failure when smoke follows a restart/uncertainty qualification watermark was repaired and covered by a regression (Task R1 in `docs/superpowers/plans/2026-10-19-handheld-priority-release-completion.md`). The current Worker suite passes 506/506 tests and Python passes 85/85. Independent footage and Raspberry Pi performance remain separate release gates.

The handheld feature is **disabled by default** (`HANDHELD_PRIORITY_ENABLED=false`, empty `HANDHELD_MODEL_SHA256`). Current `detector/fire_seg.pt` only supplies the fire/smoke detector classes. No separately trained handheld model is installed, and the current camera image-quality field is `unknown`, which fails the candidate gate. As a result, current video replays cannot take the monitor path even though the lease/policy code is present. Turning on the Worker flag alone is insufficient.

The most recent local, no-remote-AI replay processed and persisted all three development videos (67/67, 15/15 and 34/34 sampled/uploaded frames) and a synthetic negative contract clip. Every video remained `inspect_urgently`; scene assessments were `uncertain`; fresh/cached Scout calls were 0. This checks the default policy and local event path, not V3 recognition or accuracy. The folder `C:\Users\moihammed\Desktop\test` contains byte-identical copies of the same development videos, so it contributes no held-out evidence.

## Run locally

From the project root, using the existing Python environment and Wrangler installation:

```powershell
node --test --test-concurrency=1 worker/test/*.test.js
.venv/Scripts/python.exe -m unittest discover -s scripts/tests -p 'test_*.py' -q
node scripts/verify_quality_runtime.mjs --out .hermes/NEW_LOCAL_RUN --attachments 'C:\Users\moihammed\Desktop\test'
```

The verification tool creates an isolated local Worker/DO/D1 profile, applies local migrations, generates its own local ingest credential, and runs all three real videos. It accepts the original Desktop filenames or their existing attachment aliases. A repeated known-negative image is also processed as an explicitly synthetic contract clip, excluded from independent accuracy claims. The tool preserves outputs, records code/weights hashes, and verifies that its owned runtime and ports stop. No deployed application/database is changed.

Optional real inference must be explicit:

```powershell
node scripts/verify_quality_runtime.mjs --remote-ai --out .hermes/NEW_AI_RUN --attachments 'C:\Users\moihammed\Desktop\test' --allowance-snapshot .hermes/FRESH_ACCOUNT_USAGE.json
```

Probe and replay use the same durable account-wide neuron ledger. The former six-call daily ceiling was removed on 2026-10-19 at the user's request. The tool stops before the batch if the probe fails. A three-positive/unknown-clip batch preflights two calls per clip; it can follow a probe when a fresh allowance snapshot and neuron reservations permit it. `--probe-only --probe-frames 2` isolates a two-image check. `--schema-transport guided_json` selects the alternative schema parameter; `prompt_only` is a development-only comparison, retaining validation but proving no constrained-generation support. There is no automatic transport/model fallback.

## Development budget and captures

Only an explicitly enabled evaluation profile (`APP_ENV=development`, `VLM_EVALUATION_MODE=true`) exposes authenticated `/dev/inference-batch` and `/dev/inference-probe`; a separate `REMOTE_EVALUATION_ENABLED=true` is required for the isolated HTTPS evaluation deployment. Production/default development profiles leave those APIs unavailable. One separately named Durable Object enforces the configured per-batch sanity bound and shared account-day neuron ledger across replay cameras. Spent reservations survive failures; unresolved underlying calls keep permits. A durable probe lane prevents concurrent probes or restart from bypassing the single-probe permit. Missing provider bindings never reserve fresh inference.

Use the replay CLI's `--inference-cache FILE --cache-mode read_write` to retain/reuse exact-request provider captures, or `read_only` for zero-fresh-call replay. Changed model, images, frame IDs, schema, prompt or inference options invalidate the key. Stable replay timestamps derive from video bytes; they are replay identifiers rather than original recording dates. Captures are limited to 12 entries, 32 KiB each and 512 KiB per file. Truncated/redacted responses cannot seed the cache. Image URLs, escaped image URLs and explicit image/base64 fields are redacted. Bounded provider diagnostics stay in local development artifacts, outside public cause records.

Per-investigation metadata distinguishes fresh, cached and skipped inference and retains provider-reported tokens when available. A fallback with an empty validation-error array is not a successful model-schema result. When no provider output was received, schema failure rate remains unmeasured. The most recent V2 account-wide analytics snapshot reported 654.568 neurons for three calls at 2026-10-19 09:28 UTC; analytics may lag and this is not a current remaining-balance reading. Do not infer remaining promotional credits from it. Refresh the account snapshot before any further fresh calls and compare with the dashboard.

The 2026-10-19 account-wide Cloudflare GraphQL reading before the deployed three-video replay reported six calls, 1,498.126 neurons used and 8,501 remaining in the free daily allowance. The provider reports tokens per request; the local token-based settlement is an estimate, while this account reading is the measured neuron total at that time. Refresh the account snapshot before each new fresh batch; neither reading establishes remaining promotional credits. Raw captures and budget records remain in the run directories.

## Evaluation boundary

See `scripts/evaluation/README.md` for annotation semantics and metrics. Live source priority, historical interval priority, flame detection and actionable-fire labels are evaluated separately. Initial live urgent alerts still count even if a later assessment downgrades them.

The Desktop test folder contains byte-identical copies of the three existing development videos. It adds no held-out controls. The corpus template explicitly lists missing independent normal-flame, secondary-burning, smoke, reflection and obscured-scene footage. Missing onset/hazard labels and exposure remain null; these replays do not establish independent accuracy or a false-urgent-alert rate.

For the 20 October delivery decision, including the deployed Cloudflare three-video replay and the latest single-video Scout rerun, see [delivery status](delivery-status-2026-10-20.md). The latest lighter replay has complete persistence but remains `uncertain` and `inspect_urgently`; this is a measured failure of the proposed monitoring-priority behavior, not a local-only test result.
