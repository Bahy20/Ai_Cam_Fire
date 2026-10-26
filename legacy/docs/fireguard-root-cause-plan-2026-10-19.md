# FireGuard root-cause improvement plan

Date: 19 October 2026. Status: stages A–J are implemented and locally verified; fresh provider, independent footage, account billing and Pi pilot evidence remain blocked.

**20 October update:** The older six-call/day proposal in this planning record is superseded by the user's decision to use the available neuron allowance. The implementation now gates fresh calls with a reconciled account-wide neuron ledger instead of a fixed daily call count. Fresh Scout calls and D1 persistence were verified on an isolated deployed Cloudflare Worker, but the controlled-lighter priority expectation still failed. See [delivery status](delivery-status-2026-10-20.md) for current evidence and release gates.

**Goal:** Make FireGuard's decisions, measurements and operating costs dependable enough for a measured one-camera pilot, using PC verification first and a Raspberry Pi when hardware becomes available.

**Architecture:** Keep local YOLO, the Pi evidence archive, Cloudflare incident coordination and bounded optional vision inference. Replace prose-dependent priority decisions with structured assertions, use short-lived scene evidence with explicit continuity checks, and replace per-frame network/storage work with ordered observation batches. Keep detection, interpretation, operator priority and verified cause separate.

**Execution:** Implement the stages below with failing regressions before behavioral changes and independent review at each integration boundary. Independent evaluation work and provider diagnostics can run in parallel after their shared contracts are agreed; the ingestion and scene integrations must follow their dependency order.

## 1. Decisions and boundaries

User choices already established:

- Target PC recorded-video testing and a future single-camera Pi installation. No Pi is currently available.
- Publish urgent review immediately when the cloud confirms flame; never wait for the VLM to decide whether to publish that confirmation.
- Permit later automatic monitoring only with reviewed expected-flame zones and adequate current evidence.
- Keep Scout first. If bounded diagnostics establish a meaningful incompatibility or failure, compare one compatible model within existing free allowances. No paid upgrade or automatic provider switching.
- Use legally reusable public footage plus separate user footage. The three Desktop files remain development regressions; renaming or copying them does not create a held-out set.

Defaults fixed by this plan:

- Keep current detector weights and detection thresholds through the initial comparison. Change one model/prompt/policy variable at a time, only on development footage.
- Keep eight real consecutive negative observations for clearing, the two-second source-gap reset, at most two dispatched investigations per incident and one underlying inference per camera.
- Impose six fresh provider calls across an entire development invocation, including probes and follow-ups, and at most six development calls per UTC day. Available account allowance may impose a lower limit.
- Use a two-second observation upload interval, 30-second device heartbeat and immediate publication after a qualifying batch commits. Batching adds up to two seconds of transport latency; "immediate" here does not mean zero time from camera exposure.
- Keep accepted cause and physical severity unknown unless their existing independent review requirements are met. Scene recognition does not establish ignition cause or physical safety.
- This plan does not add SMS, a siren, suppression hardware, continuous DVR, Roboflow, Modal or a new subscription.

There are three separate completion claims: code implemented, PC pilot validated, and Pi pilot validated. Missing external evidence must not be converted into a pass for any of them.

## 2. Immediate corrections and trustworthy evaluation

### Stage A — Close the three reproduced defects

1. Add regressions for the exact contradiction: `The flame isn't contained; burning extends beyond the candle.` Include straight/curly contractions, `is not`, `wasn't`, uncertain association and contradictory same-frame claims.
2. Disable live automatic downgrading from the existing unversioned prose contract. Preserve its valid observations and historical display. This is the immediate containment fix while the replacement contract is built; expanding a word list is not the final design.
3. Introduce one `classifyReplay(run, requirements)` helper in `scripts/evaluation/replay-policy.mjs`, consumed by replay judgment, standalone evaluation and extended metrics.
4. Make AI requirements depend on an actual confirmation or investigation, independently of positive, negative or unknown annotations. A false-positive confirmation on a labeled negative clip must also satisfy `--require-ai`; a correctly quiet negative needs no model call.

The shared completion contract must verify payloads instead of trusting saved `passed`, `aiVerified` or `modelSchemaVerified` flags:

- Successful agent exit; explicit null socket error; nonzero sampled count; acknowledged sample count matching the eligible capture.
- Record expected scheduled attempts, successful inference samples, explicit gaps/drops, image-retention failures and acknowledged sequences separately. A quality-complete capture requires every scheduled attempt in the requested source interval to have valid inference/evidence and acknowledgement, with no unexplained sequence hole or inference/upload/evidence error. Do not shrink the denominator to whichever samples uploaded successfully. Derive negative exposure from verified covered source intervals; missing required intervals block the full-corpus metric. Intentional unsampled camera frames between configured sample times are not failures.
- Explicit completed analysis, with `active`, `queued`, `pending_followup` and `native_inference_pending` all false; a valid latest-job watermark and no unmatched analysis job.
- Persisted events and completed jobs match captured events. Introduce monotonically increasing camera event sequences and a final-state watermark so a clean WebSocket does not imply complete event capture.
- For a negative pass: explicit `confirmation:null`, no confirmation events, no investigation, latest job zero and explicitly idle analysis. Missing values are unknown, never equivalent to zero/false.
- Recompute schema validity from the actual received provider payload and its qualification results. Cached output can satisfy a parser/policy replay; only fresh successful output can satisfy live cloud readiness.

A run with incomplete capture/analysis or persistence mismatch cannot contribute a true negative or zero-false-alert denominator. Keep diagnostic observations from partial runs under a separate, visibly partial section.

### Stage B — Separate readiness and measurement coverage

Report `pass | fail | blocked | not_run`, with reason codes and evidence paths, for:

| Stage | What a pass establishes |
|---|---|
| `core_pc` | Local detector, temporal lifecycle, urgent event, persistence, evidence and fallback behavior on PC |
| `cloud_contract` | Fresh requests with the exact supported image/schema shape produce validated output |
| `cloud_replay` | Fresh inference completes, qualifies and persists during an actual video incident |
| `quality_held_out` | Frozen independent footage was fully captured and scored against independent labels |
| `free_tier_profile` | Measured traffic, storage and inference accounting fit the declared one-camera workload |
| `core_pi` | The same behavior and sustained performance were measured on actual Pi hardware |

Wrong behavior is a failure. Missing footage, unsettled work or an unavailable provider blocks the relevant stage. An intentionally offline run leaves cloud stages not run. Keep legacy `passed` only as a derived field for explicitly requested stages; never present it as overall product readiness.

Every metric must include numerator, denominator, requested count, eligible count and exclusions. Required full-corpus metrics stay null when coverage is incomplete; optional partial summaries cannot satisfy release gates. Report received-output schema conformance separately from provider success rate, and fresh versus cached inference separately.

**Acceptance:** Both reproduced evaluation loopholes fail; existing valid quiet-negative tests still pass; unknown labels do not waive AI checks; missing event sequences/idle flags and persistence mismatches prevent false success. An offline replay cannot pass either cloud stage.

## 3. Structured scene decisions and useful temporal behavior

### Stage C — Replace the decision contract, not just its wording

Introduce investigation contract version 2, generated from one canonical definition for prompting, provider projection, application validation, persistence and test fixtures. Keep provider-specific schema projections explicit and deterministic.

Each scene assertion references one attached frame, an exact reviewed source/zone ID and server-issued detection references. Its fields are fixed enums:

- `containment`: `contained | uncontained | uncertain`.
- `smoke`, `secondary_burning`, `spread_outside_source`, `occlusion`: `present | not_observed | uncertain`.
- `source_type`: `candle | stationary_burner | handheld_tool | unknown`.
- Exact `frame_id`, `source_id`, and bounded `detection_ids`.

Retain the separate bounded causal hypothesis as an unverified display claim. Generate scene captions on the server from validated enums. The decision-bearing scene object contains no free-text description or free-text limitations. The model does not provide the final operator priority or authoritative scene category; derive them from the qualified assertions.

Two distinct chronological attached frames must positively support the same source's containment. Reject unknown references, incompatible geometry, duplicate contradictory assertions and missing required fields. Positive smoke, secondary burning, spread, occlusion, or uncertainty in any required assertion blocks monitoring. `not_observed` describes these images only; it never becomes a verified hazard-absence field.

Containment is source-local; smoke, secondary burning and spread assertions cover the whole attached image. A candle within its zone cannot hide a separate burning object or smoke outside that zone. Require `source_type` to match the reviewed stationary-source type, and every detection reference to belong to that exact frame and source geometry. Conflicting whole-image assertions from different source rows invalidate qualification.

V1 observations remain readable, but cannot authorize the new live monitoring path. Invalid sibling claims retain precise indexed errors; valid observations remain inspectable. There is no permissive parse/repair path that silently upgrades malformed output.

This removes the negation-regex bug class. It does not prove that a model's structured answer matches the image; that remains an evaluation requirement.

### Stage D — Reviewed source geometry and bounded continuity

Extend operator-managed camera context with revision, geometry revision, reviewed reference-image hash, review expiry and normalized rectangular expected-source zones. Use a local rectangle annotation utility to create a draft; activate it only through the existing trusted server configuration path. Camera uploads and model output cannot mark their own context reviewed.

The annotation utility also writes a versioned local reference bundle containing the actual reviewed JPEG, dimensions, crop geometry and zone JSON. Copy that bundle to the edge configuration directory during camera setup; verify its JPEG/config hashes against the trusted active context before producing stability measurements. Keep bytes outside ordinary cloud incident records. Missing/unreadable/mismatched bundles yield unknown stability and disable monitoring; image or crop changes require a new reviewed bundle. Background comparisons use this anchored image, not an unavailable hash alone.

Default review validity is 30 days, with immediate invalidation after camera relocation, resolution/crop changes or reference mismatch. A camera-wide `expected_flame_use:true` without reviewed geometry is insufficient for the new monitoring path. Limit the first live implementation to one stationary candle/burner source per incident. Handheld lighter recognition remains available, but moving-tool or ambiguous source association stays urgent and is reported as unsupported for live downgrade.

Maintain a bounded chain of actual observations between the assessed frames and current observation. Every link must preserve camera session, incident, source zone, context revision and geometry revision. Initial experimental association gates are fixed for development evaluation:

- Every reported fire candidate, including weak candidates, lies inside the reviewed rectangle inset by 5% on each side.
- Unique adjacent flame-region match with IoU at least 0.5, centroid movement at most half the previous box diagonal, and area ratio between 0.5 and 2.
- No unmatched region, new source, positive smoke, supported growth, missing observation or source gap exceeding two seconds.
- Cheap background stability against the reviewed reference, excluding flame zones: ORB features on a 320-pixel-wide grayscale image; at least 30 RANSAC inliers and 0.6 inlier fraction; translation at most 1% of image width/height, rotation at most one degree, scale within 0.98–1.02. Insufficient texture/matches means unknown.
- Image-quality rejection starts with Laplacian variance below 40 or more than 25% near-black/near-white pixels outside the flame region. Passing this check is a usable-image signal, not proof of adequate visibility. These starting values must be tested on development footage and frozen before held-out evaluation.

Do not claim that continuous fire boxes prove continuous candle/tool identity. Material starting to burn within the same zone is a required adversarial evaluation case.

### Stage E — Short-lived live reassessment

Replace exact-timestamp equality with an explicit finite scene-evidence lease:

1. Confirmation always emits urgent review immediately after durable commit.
2. A qualified V2 result can produce a new **live** priority event at the current observation's source time only if the entire continuity chain passes.
3. The lease expires five seconds after its freshest supporting frame, evaluated in source time and elapsed wall time since that frame's receipt. A late response does not start a new five-second clock.
4. A new box alone cannot renew semantic evidence. Smoke, secondary burning, spread, motion, missing history, context expiry or incident change cancels the lease immediately.
5. Secondary burning/spread latches urgent for the remainder of that incident. Other uncertainty cancels the lease; it requires a newly qualified result to reestablish eligibility.
6. Expiry publishes urgent even if the stream stops. It never emits clearance or removes the original urgent event. Keep historical `observed_interval` assessment separate from the new live event.

Every priority event records `evidence_source_ts_ms`, `effective_at_ms`, `emitted_at_ms` and the receiving client's `received_at_ms`, plus `trigger: observation | model_result | lease_expiry | health`. Lease expiry has its actual wall-clock effective time and the last evidence timestamp; it must not invent a new camera frame. Store a replay source-to-wall mapping for paced runs and report both clock domains explicitly.

Use the first investigation at confirmation. Reserve the second for one later measured peak or one changed-scene reassessment after at least two new sampled observations; coalesce competing triggers and dispatch once. Changed hazardous evidence restores urgency immediately without waiting for that second call. Persist spending and cancellation generation before dispatch. Timeouts, crashes and discarded results never refund a call or release an unresolved native permit.

A five-second lease may be unusable if real provider latency exceeds it. That is a failed live-downgrade gate, not a reason to extend validity silently. Report the fraction of useful results and retain interval-only output when late. Longer leases, moving-source association or indefinite monitoring require a separately validated local semantic model; they are not obtained by reusing stale Scout output. Under the chosen two-call limit, a long flame can correctly revert to urgent.

Before enabling this path, require at least three independently labeled held-out stationary-source cases, a valid live downgrade in every one, and at least 80% of all eligible fresh reassessments arriving with at least two seconds left on their five-second lease. Measure the entire supporting-frame receipt to evidence upload to provider to live-event path; budget therefore requires that path to complete within three seconds for those useful results. Compare urgent duration with the same frozen run's always-urgent baseline and require a strictly positive reduction on every supported case. Failure leaves automatic live downgrading disabled. These pilot thresholds establish usefulness in the declared cases, not general safety or long-duration clearance.

**Acceptance:** The same delayed response lowers current priority only with a complete qualifying chain inside the age bound. Test expiry during silence, slow camera drift, low-texture backgrounds, second flame regions, same-zone secondary burning, scene cuts, moved tools, old sessions/jobs and context changes. No hazardous held-out transition may receive a monitoring downgrade. Keep this feature in shadow mode until those gates pass.

## 4. Repair the provider boundary without uncontrolled spending

### Stage F — A single durable budget

Replace separate probe/replay allowances with one durable account/day neuron ledger shared across development and production. The original fixed six-call ceiling in this historical plan was removed at the user's request; the current implementation uses a configurable per-batch sanity bound and a reconciled account-wide neuron allowance with headroom. Subphase names and new batch IDs cannot evade durable reservations.

Every actual dispatch consumes a reservation before provider entry. Failed calls remain spent; unknown charged usage remains unknown. Persist request/model/schema fingerprints, dispatch state, returned usage and completion identity. Unsettled work prevents replacement/resubmission. Delivery retries and cache hits never grant additional provider calls. Bound caches/captures as today, including image redaction; regenerate cache keys for the V2 contract and each provider adapter.

Before a fresh batch, verify account entitlement and remaining daily allowance via supported account reporting/dashboard evidence. Reserve conservative per-request neuron estimates using documented model pricing, bounded input/context and output limits; include an uncertainty margin. One account/UTC-day spend ledger covers development and pilot traffic together, not independent monetary balances. Store the allowance snapshot, its observation time and the usage-through watermark. At admission, atomically subtract all locally reserved/settled charges not already reflected by that snapshot and the new request's upper bound from an 80%-of-verified-remaining budget fixed at reconciliation. Recheck local balances before each dispatch; reconcile account-wide usage before each new invocation and at least every 15 minutes during a pilot. Missing reconciliation blocks further enrichment. Never count a settled charge twice or refund an unknown charge: null provider usage retains its reserved upper bound until account reconciliation. Unresolved reservations survive day rollover until their billing date/settlement is established. If remaining allowance or a defensible cost bound is unavailable, block new remote calls while local work continues. Never treat six calls as equivalent to six fixed-price units. Unobserved concurrent spending by unrelated applications remains an explicit account-wide dependency; the ledger cannot guarantee those applications' spending.

### Stage G — Adaptive diagnosis within the verified neuron allowance

Do read-only account/model and request-shape checks first. Preserve the already observed unsupported `uniqueItems` rejection and subsequent `8005` failures as evidence; do not repeat identical failed variants without a new hypothesis.

Use one real JPEG and deterministic bounded options to establish the smallest working vision request. Then advance only after success:

| Step | Test | Maximum new calls |
|---|---|---:|
| 1 | Scout, one JPEG, minimal documented vision prompt, no generation schema | 1 |
| 2 | Same image with a minimal supported structured schema | 1 |
| 3 | Full V2 contract with two chronological real images | 1 |
| 4 | Full V2 contract with the actual six-image evidence pack | 1 |
| 5 | One actual recorded incident through the production adapter | Up to 2 |

Stop the dependent sequence at the first failure. Save sanitized error/status/request ID when provided, image hashes/dimensions/bytes, model, request/schema hash, latency, strict validation results and returned usage. A probe deadline does not cancel or free an unresolved native call. Error 8005 remains an unresolved provider/request failure unless isolation establishes more.

If Scout fails at an identified boundary, the sole alternative candidate in this plan is Cloudflare `@cf/mistralai/mistral-small-3.1-24b-instruct`. Its published description includes vision and its API advertises guided JSON, but exact combined request compatibility and account allowance still require verification. Use a model-specific adapter; never assume Scout's request shape works unchanged. Spend only within a current, reconciled neuron allowance and carry unfinished checks to a later budgeted batch. If it cannot pass equivalent image/contract tests, keep cloud readiness blocked. No runtime fallback model is enabled automatically.

Select an alternative only after paired development evidence shows valid output, acceptable useful-result latency, no worse hazardous decisions and a recorded cost advantage or resolution of Scout's demonstrated failure. A successful generic caption is insufficient. Public documentation is the starting point, not the runtime acceptance test.

**Acceptance:** All fresh calls across probe, replay, alternate, restart and follow-up consume durable neuron reservations; changing phase/configuration cannot evade accounting, and unknown usage does not become zero. A fresh actual-video investigation is required for cloud replay pass. Captured-response replays remain explicitly cached.

## 5. Continuous operation within a measured free-tier profile

### Stage H — Ordered metadata batching and atomic acknowledgement

Keep temporal incident authority in Cloudflare for this iteration. Do not duplicate the confirmation policy in Python merely to reduce traffic.

Add authenticated `POST /v2/observations/camera/:id`. Each request carries protocol version, source-session UUID, batch sequence, payload hash and up to 12 ordered sample records; ordinary two-second batches contain six samples at 3 FPS. Bound the body to 512 KiB. Samples preserve attempt sequence, source timestamp, dimensions, detections, exact JPEG hash, local-image availability and quality/stability metadata. Invalid/missing inference is an explicit gap record, never an empty successful detection.

The Worker validates the whole body before making **one** CameraDO request. Refactor the inner ingestion step into a pure synchronous reducer with no persistence, broadcasts or inference. Apply every sample in order; preserve intermediate confirmation/clearance transitions. Commit final checkpoint, lifecycle/priority events, accepted watermark and investigation intents together in one SQLite transaction; synchronize durable storage before ACK. On failed commit, discard candidate state or fence the instance.

The ACK contains session/batch identity, `accepted_through`, final state, committed event watermark and pending evidence requests. A retry retains the same identity and payload. Recent matching duplicates return an idempotent acknowledgement; conflicting duplicates fail. Persist a bounded last-64 batch identity/hash ledger in the checkpoint. Earlier sequences cannot be replayed as new observations. New sessions force a continuity break and cancel scene leases without clearing an existing confirmed incident.

Add `POST /v2/sessions/camera/:id` for explicit startup activation using compare-and-swap against the last durable camera generation. Return a new monotonically increasing generation and bind it to the session UUID; persist both on the edge. All observation/evidence requests carry that generation. Reject retired or concurrent losing sessions; they stop rather than automatically taking ownership back. Initial setup starts from generation zero; a replacement host or lost local generation requires an explicit operator handoff. On V2 activation disable legacy ingestion for that camera until an explicit rollback handoff. Both directions retain confirmed state, incident identity and watermarks.

For live admission, check matching durable duplicates before age checks so a committed lost-ACK retry stays idempotent. For new batches, check each sample's source age at the server, not only at edge dequeue: reject future source clocks beyond one second and mark samples older than five seconds `skipped_stale`. A mixed-age batch atomically records skipped identities as discontinuities and reduces only fresh records, returning per-sequence dispositions. It never converts stale negatives into live absence or re-stamps old positives. Retry the identical batch; do not filter/repack under the same batch ID. Recorded-video evaluation uses its explicit isolated replay clock mode. The completion classifier counts any unexpected stale disposition as incomplete quality coverage.

Do not journal every per-frame `fire_update`. Coalesce routine display updates to the batch's final state. Durably retain confirmation, clearance, priority transitions, incident metadata and investigation results. Retry D1 writes with existing immutable event keys. Arm alarms only for actual pending outbox work, health expiry and scene-lease expiry, not unconditionally every five seconds on ingestion.

Retain the old single-observation endpoint as a compatibility adapter through the same reducer only for cameras not activated on V2. The new edge profile exclusively uses V2; the legacy endpoint is not the free-tier operating profile and cannot displace an active V2 session.

### Stage I — Decouple capture from upload and request only useful images

Separate live capture, inference/recording and upload:

- A capture thread drains live frames into a one-slot latest-frame handoff with capture timestamps. Replaced/failed scheduled samples are counted as discontinuities. Recorded-video mode remains deterministic and does not drop scheduled source frames.
- The inference worker keeps requested 3 FPS on PC, encodes once and runs YOLO on those exact decoded JPEG pixels. It writes local evidence before networking as today. Preserve the 24-frame ring and pinned incident evidence.
- A metadata uploader consumes a SQLite spool capped at 10,000 sample records or 16 MiB, whichever comes first. A separate bounded evidence lane owns a 32 MiB image handoff. Each lane has one in-flight request, separate sessions/timeouts and shared retry/traffic accounting; metadata has queue priority, and a stalled image request cannot block it. Existing incident archive limits remain separate. Overflow raises explicit degraded health and records a sequence gap; it cannot silently drop negative samples or stop local inference.
- Use the existing bounded retry/backoff policy in each lane. After disconnection, samples older than five seconds remain local historical records; they never enter the live reducer. Resume with an explicit discontinuity and current data. Server admission independently enforces freshness because a fresh queued request can become stale in transit. Stop retry storms; report cloud-unavailable separately from camera/inference health.
- Associate acknowledgements and cloud incident IDs with their exact session/sample sequence and local manifest. Replace the current recorder behavior that associates a delayed response with `recent[-1]`.

Remove routine JPEG uploads. Metadata declares immutable local image identities; at confirmation the server freezes up to six requested references. Return them in the ACK, publish urgent immediately, and receive them through authenticated `POST /v2/evidence/camera/:id`. A pack contains a server-issued job ID, exact requested frame identities/hashes and original bytes, bounded by existing per-image limits and an 8 MiB total body limit. Include only allowed missing-frame declarations; never substitute a nearby frame.

Separate a selectable local source reference from an already uploaded cloud snapshot in the evidence selector. Reserve a job before requesting images, but reserve a provider call only before actual dispatch. Hold image requests for at most 30 seconds; then record evidence unavailable. Duplicate pack delivery cannot start another call. Images remain transient in the cloud; the Pi is the archive. On cloud restart, a not-yet-dispatched job can request its same pack again; an ambiguous dispatched job remains spent/unresolved.

### Stage J — Measure all meters, not only inference calls

Expected steady baseline for one camera, before incidents/retries/other account traffic:

| Meter | Two-second batches and 30-second heartbeat |
|---|---:|
| Sampled observations at 3 FPS | 259,200/day |
| Observation batches | 43,200/day |
| Worker requests including heartbeat | 46,080/day |
| Camera DO requests including conservative health alarms | Approximately 48,960/day |
| Checkpoint + health + alarm row writes | Approximately 54,720/day |

These are design estimates, not bills or guarantees. Count request retries, row/index writes, deletes, generation claims, alarm invocations, D1 events, evidence packs, inference-ledger operations, row reads, bytes and DO duration. Avoid scanning a 64-event outbox for every inner sample. Use returned runtime statistics and account dashboard measurements where available; report gaps explicitly.

Acceptance is less than 60,000 measured baseline DO row writes/day and at least 20% headroom on every relevant daily allowance under the declared pilot event/retry profile. Test idle traffic, a long incident, 100 short incidents/day, 1% transport retries, disconnect recovery and a restart. If any meter fails, the free-tier stage fails; do not silently reduce sampling or discard observations. Optional enrichment is the first work disabled when its allowance is exhausted. Unbounded incident storms and unrelated account usage cannot be promised unlimited free operation.

**Acceptance:** A 24-hour simulated run processes all 259,200 source samples through 43,200 ordinary batches. Seven/eight negatives, gaps and duplicates behave identically across batch boundaries. Crash-before-commit and lost-ACK cases produce no duplicate incidents or extra inference. A 120-second network outage does not block local capture/evidence. Wrong image hashes, disk-full, queue overflow and reconnect history remain explicit failures/degradation.

Implementation note: heartbeat replay IDs now live in the existing bounded health-state row. A startup migration copies the retained legacy IDs before new heartbeats stop inserting and pruning a separate dedup table. The local profile estimates writes to indexes from the SQLite schema and counts alarm API calls, while leaving Cloudflare billing readiness blocked until actual service metrics are reconciled.

Local profile result, `.hermes/free-tier-profile-20261019.json`: all local invariants passed across 259,200 source observations, 43,200 batches, 432 exact retries, one mid-day Durable Object restart, 100 short incidents, one long incident and 120 seconds of queued outage capture. The run measured 46,575 Worker requests, 48,035 Durable Object requests including 1,460 alarms, 48,797 local estimated DO row/index/alarm writes, 808 D1 row/index writes, 233,472 bytes of local DO SQLite pages and 905,216 bytes of local D1 SQLite pages. Local request estimates fit the published Free request limits. The report does not measure account usage, scanned-row billing, Worker CPU, Cloudflare DO duration, aggregate storage or Workers AI neurons; free-tier readiness therefore remains blocked.

## 6. Independent quality evidence and release gates

### Stage K — Build and freeze the corpus before tuning

Acquire at least 36 independent clips: six each of contained flame, lighter-to-material ignition, uncontrolled/material burning, smoke-only, reflections/ordinary nonfire scenes and obscured/degraded scenes. Assign three per category to development and three to held-out, grouped by original recording, scene, camera and session. Keep the existing three as extra development regressions. Detect both byte-identical copies and excerpts/re-encodes of the same source. Do not create dangerous scenes to fill categories.

The held-out subset must include at least six non-null actionable-positive cases, three supported stationary contained-source cases with independently reviewed zones, and three hazardous transitions, including secondary burning inside the same zone and smoke/material burning outside a contained source's zone. These may overlap the six-category counts. An all-unknown actionable set or an always-urgent implementation cannot pass the live-reassessment gate.

Start public-source screening with the original [FIRESENSE video collection](https://zenodo.org/records/836749), [MIVIA fire videos](https://mivia.unisa.it/datasets/video-analysis-datasets/fire-detection-dataset/) and [MIVIA smoke videos](https://mivia.unisa.it/datasets/video-analysis-datasets/smoke-detection-dataset/). These are acquisition candidates, not an assertion that every clip meets the project's reuse rights or scene requirements; verify the source's actual license/terms before downloading and grouping it. Exclude shared source recordings across those collections. Audit the detector checkpoint's training provenance when available; if overlap with a public benchmark cannot be ruled out, label that benchmark's training independence unknown and reserve newly supplied camera sessions as the stronger generalization check.

Add ten hours of authentic held-out actionable-negative exposure: at least eight hours of normal nonflame footage and two hours of expected contained-use footage, reported separately. Download only where reuse is permitted, record exact source/license, and retain provenance. Missing public permissions or footage keep the corresponding gate blocked; synthetic contract clips do not replace independent exposure.

Label before viewing model answers. Store clip/source hashes, source/group IDs, license, annotator/reviewer, split, durations, flame and smoke presence, independent actionable label or null, observed onset/transition intervals, uncertainty and reviewed-zone configuration where applicable. The user reviews ambiguous labels; automated model output never becomes its own ground truth. Onset labels describe visible source time, not inferred ignition cause.

Freeze label and model/prompt/policy/config hashes before held-out execution. Tuning after a held-out failure retires that set from untouched-test status; collect a new independent final set. A different crop of the same event cannot go into another split.

### Stage L — Measure the actual goal

Report:

- Visible-flame and smoke detection separately from actionable incident detection.
- Event recall/missed incidents and clip-level confusion, with exact denominators.
- Initial false urgent incidents per labeled negative camera-hour, separated into normal backgrounds and permitted flames.
- Urgent seconds per negative camera-hour, time to a valid live downgrade, and source-time/receipt-time re-escalation delay after secondary burning.
- Confirmation delay, provider success/schema failure, uncertainty, eligible live-lease fraction, end-to-end latency and fresh/cached usage.
- Right-censored durations/delays when recording ends before an outcome. Historical interval monitoring does not end live urgent duration.

Use independently labeled source event IDs and onset/end intervals. For frame-level flame/smoke presence, score successful sampled observations at the frozen existing 0.08 confirmation-candidate confidence floor; retain the separate temporal incident metric and all weak detections in policy checks. Match labeled actionable intervals to predicted live urgent intervals by source-time overlap, one-to-one in labeled-onset order, choosing the earliest overlapping unmatched predicted incident. A predicted incident spanning multiple distinct ground-truth events cannot claim multiple detections; extra unmatched alerts and early alerts outside labeled intervals are reported separately. Where an already-active urgent incident covers a later hazardous onset, report zero additional notification delay while retaining its earlier false-urgent exposure. Compute urgent duration from complete effective-priority timelines intersected with labeled negative intervals, not from the last event alone. Report right-censoring and exclude unavailable boundaries from complete latency gates. Use exact binomial confidence intervals for event recall and exact Poisson intervals for false-urgent counts per exposure; report normal-background and contained-use strata separately.

Because immediate urgent notification is the user's choice, an initial urgent event for a permitted flame remains counted. Do not change its label to make the metric improve. The intended improvement is better supported later classification and less sustained unnecessary urgency, while preserving rapid escalation.

Pilot gates: zero known actionable-positive misses or unsafe monitoring downgrades in the small held-out pilot; zero unexpected urgent incidents in the normal nonflame subset; every confirmation publishes urgent without waiting for AI; live reassessment tests respect the five-second evidence bound. Report exact latency distributions and confidence intervals rather than inventing a validated accuracy percentage. Zero events in ten hours is limited evidence, not proof of reliability. If live latency prevents useful leases, that feature remains interval-only and its live-readiness gate stays blocked.

### Stage M — Migration, rollout and Pi validation

- Version the investigation, coordinator state, event and batch contracts. Explicitly decode validated V1 state; preserve incident identity, confirmed state and observation watermarks. Initialize new scene eligibility as unavailable. Do not infer V2 assertions/zones from old prose.
- If an active legacy incident's exact provider spending is unknown, conservatively mark its two-call allowance spent during migration. Unknown future state versions fail closed without resetting to idle.
- Preserve D1 history; use additive versioned records/migrations. Do not destructively rewrite old incidents or local evidence. Keep a local source/config hash snapshot and a rollback manifest before changing formats.
- Roll out in order: local fixtures, local actual-video replays, shadow V2 scene output, bounded cloud contract/replay, frozen held-out evaluation, one-camera continuous shadow run, then enabled reviewed-zone reassessment only if its gates pass.
- Rollback uses a configuration kill switch for new live downgrades and a compatible protocol/state reader; it must preserve urgent detection, evidence and acknowledged watermarks. Do not roll old binaries over unreadable V2 state.
- Until a Pi exists, `core_pi` is blocked. On arrival record model/RAM/OS, camera, cooling, package/weight hashes and actual CPU throughput. Start at 1 FPS, test 3 FPS, and select only a measured sustainable profile. Run a 24-hour thermal/memory/queue soak plus network-loss, disk-full and process-restart tests. A profile that cannot sustain observation intervals below the existing two-second gap bound fails this milestone; do not weaken the gap rule to conceal insufficient hardware.

## 7. Delivery order and proof required

| Work package | Depends on | Required evidence |
|---|---|---|
| A–B: emergency containment and evaluation corrections | Existing baseline | Three red/green bug reproductions; strict readiness/coverage regressions |
| C: V2 structured contract and migration codecs | A | Schema/persistence/cached fixtures; no prose-authorized monitor |
| F–G: unified budget and provider isolation | B, C | Durable neuron accounting; actual fresh compatible request or explicit blocker |
| H–I: pure reducer, batch protocol and asynchronous edge transport | A, B | State equivalence, crash/retry/fault tests, exact evidence identities |
| D–E: reviewed zones and finite live reassessment | C, H–I | Continuity/expiry/adversarial tests; useful-latency evidence |
| K: independent corpus acquisition and labels | B | Provenance, split audit, reviewed labels and frozen hashes |
| J, L: cost and quality gates | Integrated preceding packages | 24-hour accounting profile and complete held-out metrics |
| M: one-camera rollout/Pi validation | Passed relevant gates; Pi availability | Shadow report, rollback drill and actual hardware soak |

Run the existing JavaScript and Python suites after integration, including the targeted defect tests. Re-run real videos with unchanged weights, then use captured successful V2 responses for parser/policy changes. Repeat paid-metered inference only for changed model/prompt/request behavior and within the shared budget. Test names/counts alone are not acceptance: attach inputs, source hashes, expected behavior, outputs and measurement scope.

Final handoff includes a per-stage status report, provider compatibility evidence, versioned corpus manifest, metric report, resource accounting, migration/rollback instructions and exact unresolved external gates. There must be no single green "all done" result while cloud validation, independent footage or Pi validation is missing.

## Official references checked during planning

- [Cloudflare Workers AI pricing and daily allowance](https://developers.cloudflare.com/workers-ai/platform/pricing/).
- [Durable Objects request, duration and storage pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).
- [Scout model interface](https://developers.cloudflare.com/workers-ai/models/llama-4-scout-17b-16e-instruct/).
- [Mistral Small 3.1 candidate interface](https://developers.cloudflare.com/workers-ai/models/mistral-small-3.1-24b-instruct/).

Recheck account eligibility and pricing before remote execution. The documentation's advertised capabilities do not substitute for the exact image-plus-contract runtime probe.
