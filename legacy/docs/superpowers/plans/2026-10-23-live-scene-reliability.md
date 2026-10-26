# Live Scene Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the deployed webcam distinguish ordinary scenes, supported lighter use, and actionable fire evidence, without confusing an AI failure with a fire finding.

**Architecture:** Keep browser/PC capture, Modal analysis and the existing local YOLO initially. Treat YOLO boxes as proposals and maintain separate detector, scene-assessment, incident and service-health state. Use a bounded visual contract and derive operator priority in code.

**Tech Stack:** Existing Node/Fastify, Python/Ultralytics, Modal, Cloudflare Scout, browser JPEG/WSS.

**Spec:** The requirements and evidence below are the implementation specification for this repair.

## Requirements and evidence

- Ordinary desk with no visible flame/smoke: monitoring after valid scene assessment, never a claim of physical safety.
- Supported contained lighter flame under the reviewed test-camera policy: monitoring after fresh visual evidence; secondary burning/smoke prevents this result.
- Other material burning: urgent review; verified ignition cause remains unknown unless separately established.
- Unconfirmed candidate awaiting analysis: pending. Failed analysis: explicit service/assessment failure; failure itself is not proof of fire.
- Previously supported fire/smoke must retain review status across missing frames and failed inference. A single negative frame cannot clear it.
- Current status and retained incident status must be distinguishable in the UI.
- Actual saved webcam session had 58 distinct source frames and at most two consecutive negatives. Intermittent fire proposals included confidence scores above .25. It is incorrect to diagnose that session as eight negatives failing to clear.
- The session's Scout call timed out at 30 seconds. A separate three-image structured request timed out at 60 seconds. A three-image unstructured request timed out at 45 seconds. Therefore schema complexity alone has not been established as the cause.
- Minimal text-only requests succeeded in about 3–4 seconds through both Node and Python. Credentials and general provider connectivity worked for those probes; vision reliability remains unresolved.
- Existing smoke and whole-frame quality fixes remain regression requirements.

## Global constraints

- Keep current account allowances/credits; no new subscription or unapproved paid provider.
- Keep Scout for the first diagnostic stage. A failing provider gate must be reported; do not silently switch providers.
- No hard-coded mouse/lighter labels as evidence of safety; no prompt selection based solely on getting a desired answer.
- Independent annotations precede scoring. Separate development and held-out clips.
- Remote probes must have explicit timeouts and record returned usage. No automatic inference retry loops. There is no reinstated six-call batch cap.
- This workspace has no Git metadata. Save verification artifacts locally; commit steps are inapplicable until a repository exists.

## Review focus

1. A red object or desk reflection repeatedly produces boxes: candidate state must not falsely become a verified scene finding.
2. AI reports uncertainty or times out: do not interpret this as a negative observation, lighter classification or automatic fire confirmation.
3. An old response arrives after scene change/disconnect: reject it for live priority while preserving diagnostic history.
4. A lighter starts another fire: burning-material evidence overrides contained-tool monitoring.
5. A frame has no detections while an earlier supported incident remains active: show both facts and the reason for retained priority.

## Task 1: Isolate and gate vision transport

**Files:** create `scripts/probe_scout_vision.py`; use `analysis/src/scout.js`; test `analysis/test/scout.test.js`.

**Interface:** write a private JSON report containing request variant, image count/dimensions, elapsed time, HTTP status, provider error/request ID when available, finish reason, validation result and returned usage. Never record credentials. Diagnostic natural-language responses must never enter priority decisions.

- [ ] Add tests proving timeout/error envelopes, partial output and missing usage are reported accurately, without retries or credential leakage; watch them fail before implementation.
- [ ] Reproduce the actual image request with one saved frame, then two, then three, holding image dimensions/prompt/output budget constant. Start with a small output budget. Compare native and documented OpenAI-compatible transport only if single-image vision fails, changing one variable at a time.
- [ ] Record whether failure occurs before HTTP headers, during image processing or while receiving output. Capture Cloudflare request identifiers for failed responses when returned.
- [ ] Preserve the original failing structured and unstructured probes as evidence. Do not claim JSON schema is the root cause without a controlled comparison.
- [ ] Run `node --test analysis/test/scout.test.js`. Review the measured image results before selecting the production request shape.
- [ ] Gate: select a request that repeatedly returns valid image analysis. Initial latency target: p95 <=5 seconds and no result >10 seconds across ten separately labeled evaluation windows. These are proposed product acceptance targets, not established provider guarantees.
- [ ] If this cannot be met, stop declaring live intelligence ready. Present measured alternatives using existing available credentials/credits; seek a provider choice only where authorization or credentials are missing.

## Task 2: Separate current visual assessment from ignition investigation

**Files:** modify `analysis/src/scout.js`, `analysis/src/coordinator.js`; create `analysis/src/live-scene.js` and `analysis/test/live-scene.test.js`.

**Interface:** `validateLiveScene(raw, frames)` returns `{valid, errors, frames, category}`. Each frame row has exactly `frame_id`, `flame`, `smoke`, `material_burning`, `tool`, `occlusion`; presence values are `present|not_observed|uncertain`, tool values `lighter|other|not_observed|uncertain`. All frame IDs must match the supplied images exactly once. Categories derived by code: `no_visible_fire`, `contained_lighter`, `material_burning`, `smoke`, `uncertain`. Risk/cause fields are not accepted in this live contract.

- [ ] Write failing tests for positive flame, clean desk, explicit uncertainty, missing/duplicate/foreign frame IDs, partial JSON, cropped/occluded scene, contradictory tool/material evidence and malformed enums.
- [ ] Request the smallest measured scene window that passed Task 1. Include usable negative/context frames rather than requiring three fire-positive frames to start scene assessment.
- [ ] Derive `no_visible_fire` only from valid rows explicitly reporting flame, smoke and burning material not observed, with no reported occlusion. An `unknown` observation is insufficient.
- [ ] Derive contained-lighter monitoring only with fresh multi-frame tool-tip flame evidence and reviewed expected-use policy. Preserve existing temporal/support constraints; do not let a lighter row erase burning material.
- [ ] In live mode, request current scene assessment first. Preserve ignition evidence separately and investigate cause when supported burning evidence warrants it. Recorded-video cause regressions remain supported.
- [ ] Reject responses for a prior incident/generation or outside the accepted freshness window. An already stale answer must not receive a new freshness timestamp.
- [ ] Run live-scene, Scout and engine tests. Then verify the real image-plus-contract request; retain validation, not just JSON parseability.

## Task 3: Make incident and priority state explicit

**Files:** modify `analysis/src/coordinator.js`, `analysis/src/priority.js`, `analysis/test/engine.test.js`, `analysis/test/smoke.test.js`.

**Interface:** expose separate `detector_status`, `scene_status` (`pending|valid|failed|stale`), and incident `basis` (`candidate|detector_confirmed|scene_supported`). Keep existing public fields during migration. Every priority result includes a reason and supporting source/frame timestamps.

- [ ] Write regressions using the saved session's score/timestamp sequence: intermittent proposals, no Scout answer, and a current negative after earlier positives. Include isolated proposals that never enter lifecycle watch.
- [ ] Preserve raw scores for diagnostics. Review existing weak persistent-fire confirmation and raw multiple-box urgency against annotated footage; multiple model boxes alone do not prove secondary material is burning.
- [ ] Keep unconfirmed proposal handling distinct from an independently supported incident. A fresh validated no-visible-fire assessment can dismiss an unconfirmed candidate; it cannot silently erase a previously supported material-burning incident.
- [ ] Keep confirmed detector evidence visible if a VLM disagrees; represent the disagreement explicitly and retain review where warranted. Do not downgrade a strong conflicting incident solely because one VLM answer says none.
- [ ] Make candidate termination independent of whether the legacy fire lifecycle ever reached watch. Preserve the eight-real-negative rule for clearing detection state, and test timestamp duplicates, gaps, degraded frames and late responses. Define any change to usable negative-frame criteria explicitly; never fabricate adequate visibility from a missing quality profile.
- [ ] Replace raw-box veto objects masquerading as `scene.failed` with a separate detector-warning state. Only actual inference/validation failures may produce an assessment-failure message.
- [ ] Run `node --test --test-concurrency=1 analysis/test/*.test.js`. Keep fire, smoke, lighter-to-material ignition, stale-result and persistence regressions passing.

## Task 4: Explain the live result accurately

**Files:** modify `analysis/src/public/testing.html`, `analysis/src/public/testing.js`; create `analysis/test/testing-ui.test.js`.

**Interface:** display current detector result, scene assessment state/age, and retained incident priority separately. Show assessment progress, failure reason and the source of a retained alert without requiring the raw JSON panel.

- [ ] Write a failing DOM regression for current no-detections plus retained earlier incident. It must say the incident is retained from earlier evidence, rather than imply that the current frame is burning.
- [ ] Add tests distinguishing waiting for Scout, Scout timeout, detector warning, invalid view and expired scene evidence.
- [ ] Implement using `textContent`; keep model text untrusted and service credentials out of the page.
- [ ] Validate syntax and run the UI tests; inspect both mobile and desktop views in the hosted browser after deployment.

## Task 5: Evaluate and deploy the complete behavior

**Files:** create `scripts/evaluate_live_scenes.py` and `docs/live-scene-verification.md`; update `docs/modal-deployment.md`.

- [ ] Have a human independently label the saved desk frames and separate held-out recordings: empty desk, hand/mouse, reflections, lighter off/on/off, other material burning, smoke and obscured scene. Keep the three existing videos as regressions.
- [ ] Score raw YOLO and scene/priority decisions separately. Report false urgent alerts per hour, missed actionable incidents, confirmation/clearing delay, schema failure, timeout, uncertainty, fresh/cached inference and returned usage.
- [ ] If detector calibration fails held-out negatives or loses real-fire recall, evaluate fine-tuning with labeled hard negatives and positive controls. Never hard-code a desktop location or red-object suppression rule. Training/provider work must use available hardware or existing credits and be measured before deployment.
- [ ] Require zero false urgent results on the agreed held-out normal/lighter acceptance cases and urgent results on labeled material-burning controls. State the clip count/duration; this is a bounded MVP gate, not a general safety-accuracy claim.
- [ ] Check the service is idle, deploy only `fireguard-analysis`, then repeat authenticated HTTP uploads and actual WSS image analysis on the deployed build. Preserve failed controls in the report.
- [ ] Run the user's physical webcam lighter-off/on/off test. Repeated still images and mocked Scout responses do not satisfy this final acceptance step.
- [ ] Publish the tested URL, exact measured results, usage, remaining limitations and rollback notes. Do not call the product ready while vision requests remain unreliable or the physical live acceptance test fails.
