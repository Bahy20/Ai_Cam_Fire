# Handheld-priority release completion plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this continuation task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Preserve already completed work in the original plan.

**Goal:** Expected, independently verified lighter-only use receives `monitor` from confirmation; burning other material, smoke and unclear evidence retain urgent review.

**Architecture:** Keep local YOLO, Cloudflare coordination and bounded Scout calls. The local qualified two-frame tool/flame relation plus reviewed camera policy controls initial priority; Scout supplies a later second opinion. Physical risk, accepted ignition cause and operator priority remain separate fields.

**Tech Stack:** Python/OpenCV/Ultralytics, JavaScript Workers/Durable Objects, SQLite/D1, Node/Python tests and recorded-video replay.

**Spec:** [Handheld-lighter design](../specs/2026-10-19-handheld-lighter-priority-design.md). This continues [the original implementation plan](2026-10-19-handheld-lighter-priority.md).

## Verified starting point

- Current suites: 513 JavaScript and 85 Python tests passed. The package-level JavaScript run was `npm test` from `worker`; continuation evidence is recorded in the delivery-status document. The readiness evaluator now requires a frozen, licensed and locally measured edge-model bundle, zero unsafe development outcomes, and the identical bundle hash on held-out results.
- The 20 October continuation now selects a separate post-confirmation Scout pack only after three available frames span at least two seconds and the newest image is fresh. The pack contains at most six time-spread, exact Pi image references, preserves both exact local-track frames when available, and stays limited to one follow-up per incident. Worker tests cover the selection, stale/sparse abstention, lifecycle, and V2 Pi request.
- A Wrangler dry run builds the isolated evaluation Worker, but remote validation is paused because the current CLI session is not logged in. Today’s Workers AI allowance could not be refreshed, and no updated cloud replay has run. The user-selected release gate remains a successful, independently evaluated local edge model; the improved Scout pack is supporting evidence only.
- DetectiumFire is a possible research data source, not an approved product-training source. Its paper reports many lighter-flame images, but its web-collected data is CC BY-NC-SA 4.0 / academic use, and it does not establish held-out transition-video coverage for this product. Resolve subset and model rights before product use.
- This follow-up fixed disjoint fire/tool association, delayed Scout hazards after lease expiry, provider-outage handling, same-split duplicate corpus entries, missing evaluation error counts, and the qualification-watermark/hazard-latch checkpoint conflict. Each behavior had an observed failing regression before its fix.
- The original six-image Scout V3 `response_format` probe returned no scene/tool assertions. After the frame-by-frame prompt change, a second bounded probe returned four frame-linked lighter/flame assertions with zero schema errors (10,477 input + 455 output tokens). Its scene support remains `insufficient_evidence`, cause stays unknown, and it was a contract probe rather than a full priority replay.
- The follow-up reproduced the checkpoint failure after a restored/uncertain incident receives smoke and repaired the transition. The priority-disabled SQLite restart regression now passes; reproduction evidence remains `.hermes/ship-review-20261019/checkpoint-transition-review.json`.
- The existing local weights detect fire/smoke only. No eligible handheld model is installed; edge visibility remains `unknown`; no independent held-out labels or Pi measurements exist.
- The captured Scout V3 lighter result now passes through an offline CameraDO integration replay and produces `monitor` only for its observed interval; confirmation/live snapshot stay urgent and D1 preserves the interval scope. No fresh provider call occurred, so this does not count as a video replay or release gate.
- The attempted independent reviewer could not run because of model usage limits. Do not record a specialist review as passed.

## Global constraints

- Keep `HANDHELD_PRIORITY_ENABLED=false` until all release gates pass. Do not deploy as part of this plan.
- Keep `SCOUT_HANDHELD_PRIORITY_ENABLED=false` in every default profile. Its experimental post-confirmation path can label only a validated `observed_interval` as `monitor`; it cannot change confirmation/live priority or substitute for the qualified local candidate required by the live-release plan.
- Keep `severity`, `hazard_level` and accepted cause unknown without independent evidence. Do not invent a numeric physical risk score.
- A lighter word, small flame, single frame or missing smoke detection cannot authorize monitoring. `monitor` still requires operator review.
- Preserve two distinct frames, maximum 2,000 ms track gap, five-second lease, authenticated session/camera binding, pinned weights and expiring reviewed camera permission.
- Secondary burning, smoke, another fire region, supported growth and reviewed site hazards veto monitoring. Actual hazards remain latched for the incident; uncertainty requires wholly newer qualification frames.
- Keep local inference and the current Scout provider, no new subscription or Roboflow. Maximum two investigations per incident. The user removed the six-call daily cap on 2026-10-19; fresh calls remain subject to a verified account-wide neuron allowance, durable reservations, a 20% headroom policy and a configurable per-batch sanity bound. Never reset state to evade the neuron ledger.
- Missing labels, measurements or provider output stay unmeasured. An abstention is permitted; it cannot be counted as correct recognition.

## Review focus

1. Uncertainty/restart followed by smoke or a second flame must remain checkpointable and urgent (R1).
2. Fire beside a lighter, or other material burning inside the same detection box, must never qualify through box size/overlap alone (R4).
3. A sharp but obscured/dark/cropped image must not become `adequate` merely because one image metric looks good (R3).
4. Accelerated video timestamps must not make the lease test invalid, or encourage bypassing its production freshness checks (R5).
5. A late model message, duplicate clip or incomplete event stream must not hide an earlier urgent alert or inflate quality results (R2/R5/R6).

## Ordered remaining tasks

### R1 — Repair the saved-state hazard transition first

**Files:** `worker/src/camera-do.js`, `worker/test/coordinator-state.test.js`, `worker/test/camera-durability.test.js`, `worker/test/edge-ingress.test.js`.

**Interface:** Add `CameraDO.latchHandheldHazard()` to atomically clear the ephemeral lease and `handheldQualificationRequiredAfterTs`, then set `handheldHazardLatchIncidentId` for the current confirmed incident. Call it from local-observation and Scout hazard branches. Keep current-incident/job checks before accepting Scout results; do not weaken checkpoint validation.

- [x] Add regression `smoke after a qualification watermark remains checkpointable`: confirm five frames, set the valid post-uncertainty watermark, ingest smoke, assert the watermark is null and the hazard latch equals the incident.
- [x] Repeat with a secondary-burning candidate. Add a real SQLite restart test in explicit priority-disabled mode: ingest smoke, persist, restart again, and assert confirmed/urgent state plus the hazard latch survive.
- [x] Run `node --test worker/test/coordinator-state.test.js worker/test/camera-durability.test.js worker/test/edge-ingress.test.js`. The new SQLite and V2 regressions failed before repair and passed after it.
- [x] Implement the single hazard transition and check every assignment of `handheldHazardLatchIncidentId` for the same invariant. Existing tests confirm an ordinary new candidate cannot remove the latch.

**Done when:** No checkpoint error/503 for these sequences, including default-off mode; existing event ordering, uncertainty recovery and obsolete-job fences still pass.

### R2 — Freeze labels and establish a usable comparison baseline

**Files:** `scripts/evaluation/handheld-priority-corpus.json`, `scripts/evaluation/handheld-corpus.mjs`, `worker/test/handheld-labels.test.js`, `scripts/evaluation/README.md`.

**Inputs:** Actual independent recordings and named human interval reviews. The supplied Desktop test folder is duplicate development footage, not this input.

**Outputs:** A frozen manifest with source hashes/identities, development or held-out split, lighter-only/actionable intervals, onset bounds, visibility and reviewed-use policy. Preserve the existing field names; `null` means unmeasured.

- [ ] Independently label the existing videos, especially video 3, without using Scout output as truth. Keep cause/actionable fields null whenever the footage cannot establish them.
- [ ] Collect at least three independent development and three held-out recordings in each of six categories: controlled lighter, lighter-to-material, uncontrolled burning, smoke, reflection and obscured scene. Record controlled-use exposure separately; count unique recordings, not crops or re-encodings.
- [x] Extend label tests: hazardous-transition coverage requires a nonempty actionable interval and onset bounds; non-null onset/interval labels require a named reviewer; empty intervals cannot stand in for a positive transition. Require development coverage as well as held-out coverage before model selection is complete.
- [x] Run `node --test worker/test/handheld-labels.test.js`; the new transition and split-coverage regressions failed before the validator change and now pass.
- [x] After R1, freeze a flag-off reference with code/model/corpus hashes and complete events. `.hermes/quality-baseline-final-20261019-1630/result.json` records the Worker/config/model/corpus/annotation hashes, disabled feature state, and the replay folder contains full captured and persisted timelines. This is a prospective default-off baseline, not a historical comparison or accuracy result. The checkout has no historical Git baseline.

**Done when:** The frozen manifest has complete, independently reviewed coverage and no repeated source identities. Missing data explicitly blocks R4/release.

### R3 — Measure image usability instead of hardcoding `adequate`

**Files:** create `edge/image_quality.py`, `scripts/tests/test_image_quality.py`; modify `edge/agent.py`, `scripts/tests/test_edge_agent.py`, `edge/README.md`.

**Interface:** `assess_frame_quality(image, *, profile, scene_regions) -> {visibility, camera_motion, quality, reasons}`. `quality` keeps the transport's `stability`, `blur_score`, and `occlusion` fields. Evaluate the exact retained JPEG pixels and both full-frame and candidate-region usability. No configured/evaluated profile returns unknown, never adequate.

- [ ] Define a frozen quality profile tied to the development-corpus hash, image size, algorithm/model versions and measured thresholds. Include tested occlusion evidence; brightness or sharpness alone cannot certify visibility.
- [ ] Add failing tests for missing/mismatched profile, unreadable/blank/dark/overexposed frame, blur, sharp occlusion, cropped tool/flame and good labeled reference frames. Known unusable cases return degraded; missing capability or ambiguous cases return unknown; only the validated profile can return adequate.
- [ ] Implement the quality assessment, populate the observation from it, and pass that same result into `HandheldSceneTracker.observe`. Never substitute a CLI `--assume-clear` flag or the success of JPEG decoding.
- [ ] Run the new quality tests and the existing edge-agent/transport tests. Compare per-frame outputs against frozen human quality labels before allowing any profile to qualify monitoring.

Incremental R3 work, 2026-10-19: `edge/image_quality.py` now records local luminance and Laplacian-variance diagnostics from the exact JPEG passed to YOLO. Uniform extreme-luminance frames and candidate boxes touching the frame edge become `degraded`; otherwise the missing profile, blur threshold, camera motion and occlusion stay `unknown`. The edge run report keeps raw metrics local and separates quality-analysis latency from detector inference, while the V2 transport remains fail-closed. Targeted tests pass 24/24, the full Python suite passes 85/85, and Worker batch/edge contract tests pass 21/21. This does not complete R3: no human-labeled profile or occlusion assessor exists, so the function cannot return `adequate` and the feature remains unable to qualify a real candidate.

**Done when:** The normal edge path can produce measured, reproducible quality states; unknown remains the fallback. If occlusion cannot be evaluated with the available local component, this task stays blocked rather than loosening the gate.

### R4 — Supply and qualify the actual local lighter model

**Files:** `edge/handheld_scene.py`, `scripts/tests/test_handheld_scene.py`; create `scripts/evaluation/handheld-model-profile.json`; add evaluation/training commands and provenance to `edge/README.md`.

**Inputs:** R2 frozen development data and R3 quality results. **Outputs:** local weights plus SHA-256, class mapping, confidence/association settings, source/license, training recipe, code hash and an immutable evaluation report.

- [ ] Select/train the optional CPU-compatible model locally, preserving the existing fire/smoke detector. Require `fire`, `smoke`, `lighter_flame`, `secondary_burning` semantics; a generic lighter-object detector is insufficient.
- [ ] Calibrate confidence, hazard vetoes and association only on development recordings. The current .60 confidence/.50 spatial-IoU rules are provisional; do not call them validated merely because unit tests pass.
- [ ] Add regressions for disjoint persistent tracks, flame contact/ignition of other material inside one box, weak secondary-burning evidence, two flame regions, occlusion and identity switches. Semantic secondary-burning evidence must override geometric overlap.
- [ ] Run `.venv/Scripts/python.exe -m unittest scripts.tests.test_handheld_scene -q`, then the actual frozen development corpus. Record rejected/uncertain candidates as well as accepted ones and per-frame processing time.
- [ ] Freeze the model/threshold/quality bundle before opening held-out results. If no model meets the gates, keep monitoring disabled and report the failing examples; do not compensate by suppressing hazards.

**Done when:** Real image inference produces reproducible qualified candidates and rejects all labeled hazardous development transitions. Tests with fake predictions do not complete this task.

### R5 — Replay the real candidate path with valid time and reviewed context

**Files:** `scripts/test_edge_runtime.mjs`, `scripts/verify_quality_runtime.mjs`, `scripts/evaluation/replay-policy.mjs`, `worker/test/annotated-replay.test.js`, relevant edge CLI tests.

**Interface:** Add an explicit local-only `--handheld-profile FILE` to the verifier. It supplies the frozen model/quality bundle and separately reviewed camera-use policy to an isolated development Worker and the actual edge agent; the default remains off. Record all profile hashes and camera bindings in the report.

- [ ] Test missing/unreviewed/stale policy, wrong model hash and non-loopback targets: reject the handheld evaluation mode before any downgrade or remote call. Use synthetic candidate inputs only in labeled unit/integration tests.
- [ ] Run the actual handheld candidate path at real time with a recorded current epoch, independently measured quality/model output and a reviewed policy. Preserve clip-relative offsets; do not relax `source_ts <= now` or lease-age checks to make a stale candidate pass.
- [x] Add and test an explicit `--realtime` replay clock: it records the current epoch, passes the existing edge-agent pacing flag, preserves deterministic accelerated replay by default, and is enabled by the quality verifier. The supplied default-off clips completed in this mode with complete persisted events and no fresh inference; this does not complete an actual candidate/Scout priority replay.
- [ ] Feed the actual classifier/quality result over authenticated V2 batches with retained JPEG references. Test local-model failure, capture gaps, delayed results, restart, five-second expiry and requalification through the real Worker/SQLite path.
- [ ] Compare matched flag-off/flag-on runs on the same clips and frozen bundle. Score relative source times; retain first confirmation, every urgent notification, full priority duration, evidence times and persisted sequence. A historical `cause_update` cannot erase a live urgent event.
- [ ] Run `node --test worker/test/annotated-replay.test.js worker/test/edge-ingress.test.js` and the updated verifier on the labeled development clips. Require complete event coverage and persistence agreement.

**Done when:** A real lighter-only replay can reach monitor under reviewed policy, and a real hazardous transition promptly restores urgency. Old default-off replay success cannot substitute for this test.

### R6 — Verify Scout semantics and the full held-out quality gate

**Files:** `worker/src/investigation.js`, `worker/test/investigation-v3-tool.test.js`, `scripts/evaluation/analysis-metrics.mjs`, `scripts/evaluation/readiness.mjs`, evaluation reports.

- [x] Verify the exact six-image V3 schema request once and save a reusable capture; replay its parser locally with zero further calls. Evidence is in `.hermes/ship-review-20261019/v3-probe`.
- [x] Inspect the probe frames and freeze Scout's exact V3 response as a regression. Frames 0–1 are nearly black and frames 2–5 show a lighter with flame at its tip; Scout called frame 0 “no visible flame or smoke” and returned no scene/tool assertions. This is a real recognition miss, not a schema error. Evidence is under `.hermes/ship-review-20261019/v3-probe/frames-inspected` and `test_fixtures/scout-v3-lighter-flame-miss.json`.
- [x] Strengthen the V3 prompt to inspect every attached frame independently and report each visible flame/tool with its exact frame ID. Preserve frame-local uncertainty for dark/obscured images.
- [x] Re-run that exact six-image V3 prompt once with a current account snapshot. Scout returned four `flame_at_tool` observations and four matching lighter assertions for frames 2–5; the two dark early frames stayed `unknown`. Validation errors: 0; cause: unknown; scene category: `contained_tool_flame`; support: `insufficient_evidence`. Freeze the raw response and exercise the parser offline in `test_fixtures/scout-v3-lighter-frame-by-frame-response.json`.
- [x] Add a development-only `--scout-handheld-evaluation` mode to the local verifier. It requires the full remote clip set with the probe skipped, enables only the Scout observed-interval path in its generated local config, supplies a current expiring `expected_handheld_flame_use` fixture for the single contained clip, and checks interval `monitor` separately from live `inspect_urgently`. Default profiles remain off; this does not pass R6's fresh-video replay.
- [x] Make the opt-in preflight require exactly three complete, unique development labels and match each attached clip to its annotated SHA-256 before creating output or starting Wrangler. Route Wrangler logs into the run output while preserving remote auth. Profile and invalid-input regressions pass; `wrangler whoami` and a full local three-video/no-AI verifier run both completed successfully.
- [ ] Obtain an independent human label for the probe and current clips; do not use Scout's output as truth. The supplied Desktop videos are the same development sources, not held-out data.
- [x] Refresh account-wide usage before the prompt probe. The current snapshot at 2026-10-19 16:35 UTC reported 913.946 neurons used and 9,086 remaining; the durable daily ledger was 4/6 before the probe and 5/6 after its one fresh call.
- [x] Run the full three-video V3 batch against the isolated deployed Cloudflare Worker with fresh Scout and a current account-wide allowance snapshot. All three clips completed real edge uploads and one fresh model call each; the lighter clip failed the scene/interval expectation and its follow-up exposed a pending-evidence durability defect. This is failure evidence, not a release pass. The durability defect has a red/green SQLite regression and has been redeployed for the next live replay; no silent retries or budget bypass.
- [x] Record the bounded prompt-probe response and returned token usage (10,477 input + 455 output), schema errors (0), and fresh calls (1). The ledger's 322-neuron settlement is a local token-based estimate, not a Cloudflare-reported charge. The raw response is captured and parser replay is offline.
- [x] Replay the captured real Scout V3 response through the CameraDO event and persistence path without inference. Confirmation remained `inspect_urgently`, the observed interval became `monitor`, the live snapshot stayed urgent, and `priority_scope` persisted as `observed_interval`; cause, severity and hazard absence remained unknown. This is an offline integration proof only, recorded in `.hermes/handheld-priority-release-completion/captured-scout-priority-replay.json`.
- [x] Add a required `edge_handheld_model` readiness stage: pin weights, quality profile and frozen bundle hashes; require all four semantic classes, cleared data rights, complete development coverage, real candidate-path replay and CPU measurements; fail on any hazardous development downgrade or missed actionable transition. Held-out metrics must identify the exact same frozen bundle. Regression tests prove missing, mismatched, unlicensed and unsafe evidence cannot pass. This validates the gate logic, not a real model.
- [ ] Record full-replay cached/fresh/skipped modes, persisted event agreement and post-batch account reconciliation with the later three-video run.
- [ ] Freeze an engineering acceptance target of urgent review within 2 seconds of annotated lighter-to-material onset before held-out testing. Treat that as a project test target, not a fire-safety standard; do not relax it after seeing failures.
- [ ] Run the held-out corpus once against the frozen bundle. Require zero hazardous monitor intervals, zero missed actionable transitions, the declared delay bound, and zero urgent notifications during qualifying labeled lighter-only intervals. Report uncertainty rate, denominators/exposure, false urgent alerts per hour, detection delay and schema failure rate separately.

**Done when:** Both ordinary lighter use and hazardous transitions pass, with complete timelines. An empty-but-valid V3 response or three development videos cannot satisfy the quality gate.

### R7 — Measure Pi performance and free-tier operation, then review release

**Files:** `edge/README.md`, `docs/quality-verification.md`, `docs/cloud-deployment.md`, `scripts/evaluation/readiness.mjs`, a local benchmark report.

**Inputs:** The actual target Pi/camera and frozen bundle, not a PC timing substitute.

- [ ] Run the configured 3 FPS path on the Pi for 24 hours; record CPU, memory, temperature, inference/encode/upload latency, frame-drop and sample-gap distributions. Require no unexplained source gaps above the two-second qualification bound, no memory growth failure, and sustained processing at the configured rate.
- [ ] Exercise restart, thermal/load pressure, camera loss and network loss/reconnect. Confirm expired/invalid local evidence restores urgency and events persist without duplicates or gaps.
- [ ] Measure requests, CPU, DO/D1 row operations/storage and Workers AI usage; reconcile all meters against the account dashboard and current limits. Keep the existing 20% headroom/readiness checks. Forecasts alone cannot pass the free-tier gate.
- [ ] Rerun the full JS/Python suites and actual candidate replays. Obtain an independent review when a reviewer is available; the earlier quota failure is not approval.
- [ ] Only after R1–R7 evidence passes, enable the flag in the isolated acceptance profile and rerun the unchanged held-out suite. Any violation returns it to disabled. Production deployment remains a separate user-authorized operation.

**Done when:** The readiness report has measured passing evidence for PC, exact cloud contract, actual cloud replay, held-out quality, free-tier operation and Pi operation. Otherwise the release verdict remains **not ready**.

## Execution order and inputs that code cannot supply

R1 is the next code change. R2 and the Pi access arrangements can proceed independently. R3/R4 depend on frozen labeled data; R5 consumes their real outputs; R6 evaluates the frozen end-to-end behavior; R7 completes hardware/operational acceptance.

Required external inputs are independent recordings with human reviews, an eligible local model/training dataset, and access to the target Pi. Do not substitute the existing duplicate clips, fabricated adequate visibility, synthetic candidates or guessed hardware results. Continue code/tests that do not depend on those inputs; keep dependent gates open.

The original before-implementation comparison cannot be recovered from this non-Git checkout. Use the documented prospective baseline instead. Current code/test artifacts remain saved locally; no source history or release snapshot is claimed.
