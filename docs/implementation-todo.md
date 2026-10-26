# Analysis remediation checklist

This file is the implementation and evidence ledger for `docs/fireguard-root-cause-plan-2026-10-19.md`.

## Root-cause plan status (19 October 2026)

| Stage | Code status | Evidence status |
|---|---|---|
| A–B: immediate safety defects and truthful readiness | Implemented | Local regression and readiness tests; only local verification claimed. |
| C: structured scene/priority contract | Implemented with strict validation | Fresh Scout image-plus-schema output remains unverified; current video replay used no fresh AI. |
| D–E: reviewed zones and bounded live reassessment | Implemented fail-closed | Local contract tests pass; held-out and useful-latency evidence remain unavailable. |
| F–G: shared spend limits and provider diagnostics | Implemented | Fresh calls remain gated on a current account allowance/usage snapshot; none were made in this profile. |
| H–I: ordered observation batching and local evidence transport | Implemented | PC recorded-video replay, exact local image read-back, restart and transport regressions pass. |
| J: free-tier accounting | Local profile and multi-meter readiness gate implemented | 24-hour scenario passed: 46,575 Worker requests; 48,035 Durable Object requests including alarms; 48,797 local DO row/index/alarm-write estimate; 808 local D1 row/index-write estimate. Cloudflare runtime and account reconciliation remain blocked. |
| K–L: independent quality corpus and held-out measures | Tooling and report gates implemented | `C:\Users\moihammed\Desktop\test` contains the same three source hashes already assigned to development, so it supplies no independent held-out footage. |
| M: rollout and Pi validation | Migration/rollback controls implemented | No Pi hardware or approved production configuration is available; no deployment was performed. |

Keep code completion separate from PC pilot and Pi pilot acceptance. Missing provider, account, held-out and hardware evidence must remain blocked rather than inferred from passing local tests.

- [x] Audit actual callers, deployment profiles and verification gaps.
- [x] Separate accepted cause from unverified, frame-linked model hypotheses.
- [x] Integrate chronological context/onset/observed-peak/recent evidence into actual CameraDO inference.
- [x] Implement deterministic operator-response priority with independently reviewed site context; do not fabricate a physical-risk score.
- [x] Add annotated evaluation with unsupported-attribution, detection miss/false-alert and source-time-delay metrics; leave unavailable measurements explicitly null.
- [x] Remove obsolete Modal/local-VLM/HTTP-detector paths, duplicate simulators and unused duplicate state machine; preserve model weights, recordings, fixtures and evidence.
- [x] Run active unit/contract suites, production dry-run, real workerd/video replay, exact edge JPEG/manifest read-back on the PC, and full local D1 analysis persistence checks. Actual Pi hardware remains a separate gate.
- [x] Persist atomic SQLite lifecycle/source-watermark checkpoints and confirmation outbox intent before AI; verify cold restore, retries, lost acknowledgements, smoke/clear semantics, backlog bounds and stale-lifetime fencing. Native interruption remains explicit and cannot authorize another call.

## Acceptance status and remaining production/quality gates

- [x] Finish independent security review and parent actual-workerd acceptance of the implemented two-identity native recovery API, including durable audit/checkpoint read-back and idempotent retries. Cold restore is not cancellation; real provider evidence and approved operator provisioning remain production prerequisites.
- [x] Finish independent review and parent actual-workerd acceptance of the implemented Access-authenticated, immutable cause-review API. Model fields remain unknown; separately recorded human attestations are not machine-verified facts.
- [ ] Validate on independent annotated fire/negative footage with onset and causal evidence. The two positive clips are policy checks, not a forensic accuracy or false-alert benchmark.
- [ ] Install and benchmark on the actual Pi (capture freshness, RAM, thermals, systemd, sustained sampling); configure approved Access identities/camera scopes and verify approved remote migrations/secrets/deployment separately. Pi access/specifications and approved real operator configuration have not been supplied. No production deployment occurred here.
- [x] Finish parent actual-workerd/alarm acceptance of the implemented server-receipt health API, with unit/loopback acceptance of the Pi live progress heartbeat. Pollable/live health events are not guaranteed external notifications; actual Pi validation is separate.

## Operator/health continuation: implementation and local acceptance complete

- [x] Add independent RS256 Access validation, subject/email/permission/camera scopes, private principal branding, no ingest-key approval authority, JSON/same-origin mutation checks and noncached operator responses. Every default profile explicitly disables controls pending configuration.
- [x] Add immutable D1 review migration 0004, exact confirmation/analysis targeting, optimistic revisions, append-only history, idempotent read-back, and separate human-attestation provenance without changing model cause or safety advice.
- [x] Add two-identity native recovery proposals/approval, epoch/job and live-work guards, bounded immutable local audit plus atomic permit-checkpoint release. Exact retries cannot reset a newer gate; this is not provider cancellation or machine verification of a typed reference.
- [x] Add server-receipt health state, duplicate/replay/order gates, recent transition history and restart recovery even before an observation. Fix the reproduced single-alarm starvation defect: repeated ingress preserves earlier deadlines.
- [x] Integrate bounded outbound heartbeat/progress tracking in live RTSP network mode only; keep video/dry-run behavior, evidence retention and secret redaction intact.
- [x] Final reviewed full suites: 358 Node tests passed, zero failed/skipped/cancelled; 53 Python tests passed. Production offline preflight, generated-types check and deployment dry-run passed (not production deployment).
- [x] Complete independent reviews, inspect actual-workerd control/health artifacts and rerun final suites after fixes. Parent runtime exit 0: 15 contract assertions; all 15 JSON artifacts read; all 16 production source hashes and four migration hashes matched current files. Read-only SQLite/D1 comparison verified three incident events, two recovery audits, one separate human review and three health transitions. Both owned runtimes were disposed and a fresh OS listener check found neither port listening. No unrelated process was stopped or OS paging setting changed.

Independent review returned four defects, each reproduced before a fix: operator authority outliving token expiry; storage-error clearing after a no-op; a supported heartbeat interval colliding with expiry; and terminal failure status never reaching the sender. Verified RED→GREEN fixes revalidate/discard expired capabilities, require real archive progress for storage recovery, cap cadence at 30 seconds with monotonic deadlines, and attempt one serialized final failure report. Final unit and actual-runtime acceptance passed after these fixes.

Final current-source runtime result: `C:/Users/moihammed/AppData/Local/hermes/cache/scratch/operator-runtime-QQ0TAg/result.json` (62,950 ms). The real 60-second alarm durably wrote exactly one offline transition after 60,019 ms, before any post-deadline public GET; a new degraded heartbeat recorded one recovery transition. The harness uses synthetic detections and an explicitly empty synthetic native response, not actual model/provider/Pi acceptance. Its receipt-bracketing check allows 100 ms between independent Node/workerd clocks and deliberately sends a client timestamp 20 seconds older; the production alarm threshold was not reduced. A failed earlier clock-assumption fixture remains preserved.

The only open checklist gates require inputs outside this workspace: independent held-out annotated footage; actual Pi access/specifications; and approved real Access/deployment configuration. Do not relabel these blocked prerequisites as completed tests.

API, role configuration and external-provider review requirements: `docs/operator-workflows.md`.

## Verified local results

- 19 October root-cause continuation: **458/458 Worker tests passed** and **72/72 Python tests passed** in the project's `.venv`. The 24-hour local profile passed every invariant; it processed 259,200 observations in 43,200 batches, kept the lost-ACK retry idempotent across one restart, accepted the current sample after the 120-second outage, and estimated 48,797 local Durable Object row/index/alarm writes. Evidence: `.hermes/free-tier-profile-20261019.json`. `readiness.stages.free_tier_profile` remains blocked because local SQLite and request counters cannot substitute for Cloudflare runtime meters or an account allowance snapshot.

- The final controls suites/runtime are recorded above. The prior pre-controls durability checkpoint was 253 Node / 39 Python tests. Video replay evidence below is retained historical execution, not a fresh hardware or independent model-quality benchmark.
- Durability two-video run: 82/82 uploads, native Scout investigation and complete local D1 read-back; each incident has distinct unique-key confirmation/analysis rows. Both accepted causes remain unknown and both initial priorities are `inspect_urgently`.
- Four edge incident manifests, 112 JPEGs decoded, all 12 selected AI images matched to local evidence. A late investigation for a closed incident was persisted without reactivating detection.
- Model still proposed human-ignition hypotheses, both marked `insufficient_evidence`; hallucination/unsupported inference is contained, not eliminated.
- Existing detector fixture result remains 4/5 with `fire1.jpg` missed. Build/preflight passed; this is not production or Pi-hardware acceptance.
- Current real-video evidence: `.hermes/durability-video-replay-20261017/`; its before/after JSON verifies actual workerd restart preserved both cameras' lifecycle, watermark, qualified cause and selected manifest. Older `.hermes/analysis-remediation-final-20261017/` remains historical evidence.
- Parent-rerun offline restart contract: five actual workerd lifetimes, ten checkpoints, exactly two unique D1 records; normal exit 0. Intentional `--fail-after-watch` returned exit 1 and verified cleanup. This fixture uses synthetic detections and no VLM/images.
- Latest offline pass: `C:/Users/moihammed/AppData/Local/hermes/cache/scratch/coordinator-restart-VJV8MT/result.json`; intentional-failure cleanup: `.../coordinator-restart-BiJwZq/result.json`. Scratch artifacts may be pruned.
- Review regressions cover `_cam`, 81/128-character camera IDs through public ingestion/retry/restart and image-backed post-restart fallback without poisoning subsequent checkpoints. Producer/codec diagnostics now share one enum. All owned test ports 8796/9238/8797/9239 were verified stopped.

## Boundaries

- Pi performs capture, local YOLO and permanent JPEG/manifest retention. Cloudflare runs coordination and native Workers AI; no Modal/R2 or exposed Pi detector is needed.
- No production deployment, repository initialization, commits, credential deletion or unrelated app termination is part of this change.
- Passing a JSON parser or invoking a vision model is not validated cause or risk analysis. Accepted causal attribution requires independently supported/reviewed evidence; structural frame linkage alone does not prove truth.
- Missing causal/onset annotations and independent negative footage remain validation gaps, not invented benchmark results.
- Full-scene evidence is implemented first. Do not claim crops, physical scale, tracked spatial spread or certified suppression advice without implementation and validation.

## Cleanup recovery

Audited superseded files are backed up outside the active code tree at:
`C:/Users/moihammed/AppData/Local/hermes/cache/scratch/fire-retired-code-0nclvodw.zip`.

That scratch recovery copy may be pruned by cache policy. Existing incident/evidence directories are left unchanged.
