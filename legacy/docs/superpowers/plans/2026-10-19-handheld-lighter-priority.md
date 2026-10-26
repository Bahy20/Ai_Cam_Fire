# Handheld-lighter operator priority implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A verified lighter-only flame gets `monitor` at the live confirmation event, while lighter-to-material ignition and uncertain scenes retain immediate urgent review.

**Architecture:** Keep YOLO fire/smoke confirmation, Cloudflare coordination and bounded Scout calls. Add descriptive handheld-tool assertions to Scout, but let only a reviewed camera policy plus a validated local two-frame tool/flame track authorize immediate low-priority monitoring. Keep the existing fixed-source lease separate, and evaluate the entire live alert history so a later downgrade cannot hide an initial urgent notification.

**Tech Stack:** Python/Ultralytics/OpenCV edge, JavaScript Cloudflare Worker/Durable Object, SQLite/D1, Node tests and recorded-video replay.

**Spec:** [Handheld-lighter operator priority design](../specs/2026-10-19-handheld-lighter-priority-design.md).

**Continuation:** Use [the release-completion plan](2026-10-19-handheld-priority-release-completion.md) for remaining work after the 2026-10-19 review. It starts with a newly reproduced checkpoint failure and preserves the completed work below.

## Global Constraints

- Physical `severity` and `hazard_level` stay `unknown`; accepted ignition cause stays `unknown` without independent proof.
- A “lighter” word, small box, one frame, missing smoke detection, or Scout confidence label alone never authorizes `monitor`.
- Existing `inspect_urgently` and `escalate` behavior remains active until the complete shadow/release gate passes. Known hazards, occupancy, critical zones, secondary burning, smoke, extra flame regions and supported growth override lighter monitoring.
- `monitor` retains `operator_review_required: true`; it is not clearance or alarm suppression.
- No new paid provider, Roboflow, production deployment or model change during the contract/policy tasks. Keep ≤2 investigations per incident and ≤6 fresh development Scout calls per UTC day/batch, with cached parser replays.
- The three Desktop videos are development regressions. Independent held-out footage and a real Pi benchmark are required before a deployed automatic downgrade claim.

## Review Focus

1. A lighter ignites nearby material inside the same fire box: Task 4/6 tests must veto `monitor` and count urgent delay.
2. Scout says “lighter only” but the edge reports another flame, smoke, or unusable frame: Task 2/4 tests must keep urgency.
3. The last good tool frame becomes stale while the stream stops: Task 4 tests must expire the lease and emit a live urgent event with the old evidence timestamp and current effective time.
4. A client forges a reviewed permission or tool candidate through the legacy ingest path: Task 3/4 tests must reject its authority.
5. A later historical `cause_update` says `monitor` after an initial urgent notification: Task 5 tests must still count the urgent notification and not overwrite the live state.

## File responsibilities

- `worker/src/investigation.js`: Scout V3 handheld assertion contract, prompt, validation and descriptive scene derivation; V1/V2 decoding remains.
- `worker/src/evidence.js`: retain bounded selected-frame detection/candidate references so prompt claims can be checked against the actual images.
- `worker/src/site-context.js`: reviewed camera permission for expected handheld lighter use, separate from fixed source rectangles.
- `edge/handheld_scene.py` (new): optional local classifier/tracker adapter and bounded two-frame candidate evidence; no cloud calls.
- `edge/agent.py`, `edge/observation_spool.py`, `worker/src/observations.js`: carry versioned candidate evidence on the authenticated observation path.
- `worker/src/handheld-lease.js` (new): validate/renew/expire an incident-bound short local-evidence lease.
- `worker/src/rules.js`, `worker/src/camera-do.js`: decide and persist live priority; cancel or upgrade on contradictions.
- `scripts/evaluation/*`: frozen labels, full live-timeline scoring and separate development/held-out results.

---

### Task 1: Freeze the baseline and labels

**Files:** Modify `scripts/evaluation/analysis-policy-labels.json`, `scripts/evaluation/README.md`; create `scripts/evaluation/handheld-priority-corpus.json` and `worker/test/handheld-labels.test.js`.

**Interface:** The corpus records recording SHA-256, split, independently reviewed `lighter_only_intervals_ms` and `actionable_intervals_ms`, onset bounds, visibility, reviewer and whether a reviewed camera permission was supplied. `null` means unmeasured, never negative.

- [x] Write a test rejecting a copied/re-encoded source in both development and held-out, missing reviewer for a non-null actionable label, and overlapping contradictory intervals. Run `node --test worker/test/handheld-labels.test.js` and confirm it fails.
- [x] Implement the corpus validator and record the current three clips as development only. Their interval labels, onset bounds, visibility review and reviewer remain null where unmeasured.
- [ ] Have a human review video 3 frame-by-frame before changing its `actionable_fire_present: null`; retain `null` if evidence is insufficient. Collect at least three independent development and three held-out recordings per required category, including three held-out lighter-to-material transitions, plus separately measured expected-use exposure. The Desktop folder is byte-identical development footage. The release gate remains blocked.
- [x] Run a current-policy three-video replay and save code/weights hashes, first live priority, event captures, Scout mode and usage. The report records this as a default-off reference run, not a before/after accuracy benchmark.
- [ ] Capture a prospective, matched flag-off/flag-on comparison after the checkpoint repair in the continuation plan. A historical pre-implementation baseline was not saved and cannot be reconstructed from this checkout; do not label a new run as historical.

### Task 2: Make Scout describe a handheld tool without granting priority

**Files:** Modify `worker/src/investigation.js`, `worker/src/evidence.js`, `worker/src/camera-do.js`; add `worker/test/investigation-v3-tool.test.js`, extend `worker/test/scout-runtime-integration.test.js` and `worker/test/evidence.test.js`.

**Interfaces:** V3 response is `{contract_version:3, observations, hypothesis, scene_assertions, tool_assertions}`. Each `tool_assertions` row has exactly `{frame_id,candidate_id,tool_type,flame_relation,secondary_burning,smoke,occlusion}`; `candidate_id` is a validated ID or `null`; `tool_type` is `lighter | other | uncertain`; `flame_relation` is `at_tool_tip | separate | uncertain`; the three evidence fields are `present | not_observed | uncertain`. Derive `contained_tool_flame` only from two chronological full-frame lighter/`at_tool_tip` rows with no contradictory hazard/occlusion row. Without a local candidate, this is descriptive and unverified.

- [x] Write failing tests for video-3-like input with no fixed zone yielding two valid tool assertions and `contained_tool_flame`; a missing/foreign frame ID, duplicated row, unknown candidate ID or positive secondary burning yields `uncertain`/`material_burning` with indexed errors. Confirm V1/V2 stored responses still decode. The focused V3/V2 tests pass.
- [x] Implement one canonical V3 schema/prompt/validator projection. Keep `scene_assertions` for fixed sources and allow `tool_assertions` even when fixed-source context is absent. Preserve valid observations when one tool row is malformed. Never copy a model-supplied priority into the result.
- [x] Retain bounded detector/candidate references with selected evidence frames. The private reviewed context and authenticated candidate references flow through prompt/schema/qualification; candidate IDs come from selected-frame metadata. Focused tests cover fixed-source and no-zone handheld cases.
- [x] Run one fresh bounded image-plus-V3-schema probe after refreshing account usage. The six-image `response_format` probe at 2026-10-19 11:13 UTC returned V3 with zero validation errors, using 10,404 tokens and one fresh call. Scene/tool assertions were empty and the derived scene was uncertain. Raw response, budget and captured parser replay are in `.hermes/ship-review-20261019/v3-probe`; this proves contract acceptance for that request, not recognition quality. Post-call account reconciliation returned an authentication error.

### Task 3: Trusted policy and local evidence contract

**Files:** Modify `worker/src/site-context.js`, `worker/src/observations.js`, `worker/src/index.js`, `edge/agent.py`, `edge/observation_spool.py`; create `edge/handheld_scene.py`, `scripts/tests/test_handheld_scene.py`; extend `worker/test/response-priority.test.js`, `worker/test/observations.test.js`.

**Interfaces:** Add `expected_handheld_flame_use: boolean` to the operator-managed reviewed camera context. The edge candidate is versioned and bounded: camera/session identity, source timestamp, two chronological frame IDs, one stable candidate ID, local model SHA-256, lighter/tool relation result, image-quality result, fire-region count and smoke/secondary-burning veto signals. `handheld_scene.py` returns `None` on uncertainty. Raw model output cannot mark a site reviewed.

- [x] Write eligibility tests for missing/expired/mismatched reviewed permission, client-supplied policy, unauthenticated or legacy direct-ingest candidate, duplicate timestamp, changed session/model, second flame region, smoke, unknown image quality and source gap. Focused tests and the full suites pass.
- [x] Implement strict policy parsing and versioned candidate transport only through the authenticated batch path; the server revalidates references and bounds evidence. Without configured extra weights, the edge emits no candidate and priority remains urgent.
- [x] Add the optional CPU classifier/tracker adapter with required class checks and pinned SHA-256. No weights are bundled or downloaded.
- [ ] Train/select and freeze eligible weights/thresholds from independently labeled development footage, then measure them on held-out clips. Suitable footage/model is not available.
- [x] Run the JavaScript/Python policy and transport tests; full suites pass.
- [ ] Record edge CPU time per sampled frame on a suitable model and benchmark on the actual Raspberry Pi; neither is available.

### Task 4: Live handheld lease and deterministic priority

**Files:** Create `worker/src/handheld-lease.js`, `worker/test/handheld-lease.test.js`; modify `worker/src/rules.js`, `worker/src/camera-do.js`, `worker/src/incident-store.js`; extend `worker/test/camera-priority-integration.test.js`, `worker/test/coordinator-journal.test.js`.

**Interfaces:** `createHandheldLease(candidate, reviewedContext, nowMs) -> lease|null`; `advanceHandheldLease(lease, observation, nowMs) -> {lease,cancelled,reason}`; `isHandheldLeaseCurrent(lease, {cameraId,incidentId,sessionId,sourceTsMs,nowMs}) -> boolean`. Bind lease to camera, incident, session, candidate, model hash and reviewed-policy expiry. Start from two distinct qualified frames, expire after five seconds without a renewed qualified local relation, and never renew from a fire box alone.

- [x] Write the pure-policy regressions: a current reviewed lighter-only lease gives `monitor` with severity `unknown`; no lease, one frame, forged context, stale evidence, Scout-only “lighter”, smoke, second flame, material burning, supported growth and known site hazards never give `monitor`.
- [x] Implement lease validation, serialization, renewal and cancellation. Hazardous secondary-burning evidence latches urgent for the incident; uncertainty cancels monitoring until a new two-frame qualification. Moving tools do not reuse stationary-zone rectangles.
- [x] Integrate with `CameraDO`: a qualifying sample can carry a current lease into confirmation; contradictory/uncertain Scout results emit a sequenced live urgent `fire_update`; historical `cause_update` remains observed-interval scoped; expiry and invalidation restore urgency with source/effective times.
- [ ] Close the newly found smoke-after-restart/uncertainty checkpoint regression, then rerun DO/persistence, restart and delayed-result tests. Existing tests pass, but the targeted review reproduction fails `invalid handheld qualification watermark`. See continuation Task R1. Monitor retains `operator_review_required:true`; the feature remains default-off.

### Task 5: Score what the operator actually saw

**Files:** Modify `scripts/evaluation/replay-policy.mjs`, `scripts/evaluation/analysis-metrics.mjs`, `scripts/evaluate_analysis.mjs`, `scripts/verify_quality_runtime.mjs`, `scripts/evaluation/README.md`; extend `worker/test/annotated-replay.test.js`, `worker/test/analysis-evaluation.test.js`.

**Interfaces:** Report first confirmation priority, every live priority interval, interval-only Scout priority, distinct urgent notifications, urgent duration on labeled lighter-only exposure, actionable recall/delay, and explicit exclusions. A historical monitor result cannot erase a prior live urgent event. Preserve fresh/cached/skipped inference and usage accounting.

- [x] Write synthetic-timeline tests for initial urgent then later monitor (still one false urgent), direct monitored confirmation, urgent transition after secondary burning, stale lease expiry, incomplete event watermark and unknown actionable label (metric remains null).
- [x] Implement event-timeline scoring from source/effective timestamps and persisted sequence. Historical interval assessments cannot hide an earlier live urgent notification.
- [ ] Extend local replay to inject a separately recorded reviewed handheld-use policy and a qualified candidate without treating the user video as production policy. The current local model/visibility gates cannot supply these inputs.
- [x] Run evaluation tests and a three-video default-off reference replay. Output has separate current priority and observed scene records; model output was skipped so every scene remains uncertain. The actionable label is still null. The subsequent V3 probe capture now passes an offline parser replay with zero fresh calls; it is not an exact-request capture of the three-video replay.

### Task 6: Shadow evaluation, enable gate and final verification

**Files:** Modify `edge/README.md`, `architecture.md`, `docs/quality-verification.md`, `docs/cloud-deployment.md`; add the frozen corpus/replay evidence to an ignored local report directory. Product code changes only if Task 1–5 failures identify a specific fix.

- [x] Run the whole JS/Python suites and complete development replay with the feature still disabled. Both pass; code hashes and replay result are saved.
- [ ] Compare the matched prospective baseline and candidate from continuation Task R5. Record explicitly that the historical pre-implementation baseline is unavailable.
- [ ] Shadow-run the local candidate and Scout V3 on independently labeled controlled and hazardous clips. Require no held-out hazardous interval to receive a simulated monitor decision, no missed urgent lighter-to-material transition, and no unexplained negative/urgent event capture gaps. Report sample counts and confidence limits; three development videos alone cannot pass.
- [ ] Benchmark the edge classifier at the configured 3 FPS on the actual Pi, including sustained CPU/memory/temperature and frame-drop rate. Freeze threshold, model hash, reviewed-policy format and an acceptable urgent-delay bound before any live enablement. Missing Pi or held-out footage means the automatic downgrade remains disabled.
- [ ] Use the saved V3 probe capture for parser iteration and perform the final changed-prompt video batch after a fresh allowance read. The UTC-day ledger has four of six calls used after the probe; the full three-clip batch preflights two calls per positive/unknown clip, so it needs a later day with six available calls. Do not reset the ledger, loosen validation, deploy, or change paid services to bypass this.
- [ ] Enable the default-off flag only after every gate passes; rerun the same held-out corpus with live priority enabled. Acceptance is: independently labeled lighter-only current intervals produce `monitor` from confirmation with zero urgent notifications, while every labeled lighter-to-material transition produces urgent review within the frozen delay bound. If either fails, restore the default-off flag and report the exact counterexample.

## Completion boundary

Passing unit tests implements the mechanism. A successful three-video development replay shows a regression improvement only. The feature is ready for live use only after independent scene labels, sufficient held-out negative and hazardous transitions, measured Pi performance and complete live-event timelines pass Task 6. Until then, `inspect_urgently` remains the production fallback.
