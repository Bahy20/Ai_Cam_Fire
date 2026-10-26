# Operator review and device-health workflows

These are advisory operational APIs, not a fire-safety controller or proof of forensic correctness. There is no operator UI, SMS/siren integration, or automatic provider-cancellation API.

## Independent operator authorization

Every default Wrangler profile disables operator actions: `OPERATOR_ACCESS_ISSUER=""`, `OPERATOR_ACCESS_AUD=""`, `OPERATOR_POLICY_JSON="{}"`. Missing or invalid configuration fails closed with 503, including development. Camera ingest and device-health delivery continue to use `INGEST_API_KEY`; possession of that key, a reviewer header, a model assertion, or a serialized principal **never** grants review/recovery authority.

Before enabling controls:

1. Create a path-scoped Cloudflare Access application for `/operator/*` on the chosen API hostname. Do not accidentally put the Pi's `/observation/*` and `/heartbeat/*` endpoints behind an interactive human-login wall.
2. Independently select the actual human operator identities and camera scopes. Configure the exact Access issuer `https://your-team.cloudflareaccess.com` (no slash/path/port), the application's audience, and an operator policy JSON **string**. Read the real Access `sub` and `email`; do not invent them or substitute the camera-ingest identity.
3. Example policy structure (all identities below are placeholders, not provisioned accounts):

```json
{
  "reviewer-access-subject": {
    "email": "reviewer@example.test",
    "permissions": ["cause:review", "inference:recover"],
    "cameras": ["cam-01"]
  },
  "independent-reviewer-access-subject": {
    "email": "independent@example.test",
    "permissions": ["inference:recover"],
    "cameras": ["cam-01"]
  }
}
```

Use explicit camera IDs; an explicit `cameras:["*"]` grants all cameras. Empty permissions/scopes grant nothing. Apply configuration to the intended environment: Wrangler environment variables are not inherited. No operator is configured or approved automatically here.

Requests use Access's `Cf-Access-Jwt-Assertion` header. The application independently verifies RS256 signatures, the configured issuer and audience, human application claims, time bounds, exact subject/email and permissions. Time bounds are rechecked after awaited verification and when a privately branded capability is consumed; a body arriving after expiry cannot submit a review. Expired capabilities are discarded, not revived after clock rollback. It fetches public keys only from that configured team's `/cdn-cgi/access/certs`, without forwarding credentials or following redirects, under byte/time limits. A recovery request is verified again inside the receiving DO; a forwarded JSON identity is not a credential. Operator responses are `Cache-Control: no-store`. Mutating public routes require JSON and reject cross-origin browser requests.

Keep tokens out of URLs, logs, files and chat. Use the organization's authenticated client rather than pasting tokens into shell commands.

## Cause review: append-only human claims

- `POST /operator/cameras/:id/reviews`
- `GET /operator/cameras/:id/reviews?incident_id=...&limit=50&before_revision=...`

Permission: `cause:review` for that exact camera. Apply `0004_operator_reviews.sql` after migrations 0001–0003 in the chosen D1 environment. Local migration/test success is not remote migration/deployment.

All POST fields are required:

```json
{
  "request_id": "12345678-1234-4234-8234-123456789abc",
  "incident_id": "cam-01:1000000:1",
  "analysis_event_key": "COPY_THE_EXACT_STORED_ANALYSIS_EVENT_KEY",
  "expected_revision": 0,
  "disposition": "accept",
  "ignition_source": "electrical",
  "ignition_tool": "unknown",
  "independent_evidence": {
    "kind": "verified_investigation",
    "reference": "independent case/record reference",
    "summary": "What independently supported the review; not merely a model hypothesis."
  },
  "rationale": "The human review rationale."
}
```

This is an illustrative payload, not an assessment of any recorded incident. Use the exact existing camera, incident and **analysis** event identity; a durable confirmation must also exist. Obtain those identifiers from the trusted incident register. Do not normalize or repair a malformed identifier. `request_id` must be a lower-case UUID v4. Initial `expected_revision=0`; use the latest returned revision for subsequent decisions. A stale concurrent revision returns 409 rather than silently overwriting another review.

`disposition` is `accept`, `reject` or `inconclusive`; source is `human_activity`, `electrical`, `other` or `unknown`. Acceptance requires a known source and independent evidence. Evidence kinds are exactly `onsite_inspection`, `independent_recording` and `verified_investigation`. Rejection/inconclusion require source/tool `unknown`; evidence may then be null. There is no intent/arson enum, fuel/class approval, hazard-clearance or suppression authorization. Unknown tool can stay unknown even when an independently supported source is accepted.

The result is a separate `operator_review` with server-verified actor, revision/time and `provenance:"operator_attestation"`, `factual_correctness_verified:false`. This records **who accepted a claim**, not machine verification that it is true. Original model-event scalar cause, analysis JSON, aliases and safety advice remain unchanged/unknown. Consumers must inspect the newest review's disposition; never search backward for an old acceptance after a newer rejection/inconclusion. General `/events` and camera state do not expose reviewer identity data.

Retries with the same request ID, actor and identical validated payload return the exact committed review. Reusing an ID with changed claims/actor/target returns 409. Immutable D1 history rejects updates/deletes/replacements. GET pagination is newest-first, up to 100 entries, with `has_more` and `next_before_revision`.

Text bounds: tool 120 code points, evidence reference 512, summary/rationale 2000. Body limit is 32 KiB. External evidence references are human attestations and are not automatically fetched or certified.

## Unresolved native inference: externally verified, two-identity recovery

A timeout or DO restart is **not cancellation**. An old native backend outcome can remain unknown, while detection and durable incident recording continue. No elapsed-time heuristic automatically releases that gate.

- `GET /operator/cameras/:id/recovery` returns the current recovery requirement, lifetime `generation`, `analysis_job_id` and audit count.
- `POST /operator/cameras/:id/recovery` records a proposal or independent approval.
- `GET /operator/cameras/:id/recovery-audits?limit=50&before_row_id=...` reads protected immutable decisions.

All require `inference:recover`. **Keep the gate blocked unless external provider evidence establishes that the previous operation completed or was cancelled.** The API itself cannot look up the lost provider operation or verify a typed support reference. If that evidence cannot be obtained, do not approve recovery.

Proposal fields:

```json
{
  "request_id": "12345678-1234-4234-8234-123456789abc",
  "action": "propose",
  "expected_generation": 2,
  "expected_job_id": 1,
  "provider_outcome": "completed",
  "provider_reference": "provider operation/support record reference",
  "rationale": "How the first operator independently established the provider outcome."
}
```

The only claimed outcomes are `completed` and `cancelled`—not timeout, elapsed time, assumed termination or a model's statement. Proposing records evidence/identity but does not release the gate.

A second independently configured Access subject **and a different email identity** must independently review the provider evidence, then submit:

```json
{
  "request_id": "12345678-1234-4234-8234-123456789abd",
  "action": "approve",
  "expected_generation": 2,
  "expected_job_id": 1,
  "proposal_id": "12345678-1234-4234-8234-123456789abc",
  "review_reference": "independent verification reference",
  "rationale": "How the second operator checked the same provider outcome."
}
```

The organization must ensure these are independent people; distinct Access identities alone cannot prove that. The current generation/job must still match, the proposal must be younger than 15 minutes, and no live native promise, active analysis or queued analysis may be running. A cold restart invalidates an unfinished generation-bound proposal; obtain the current state and re-review rather than guessing a new epoch.

Approval atomically stores the audit and releases the **local recovered permit**; it neither cancels a provider job nor dispatches a replacement model call. A future eligible normal investigation may use the permit. Old-lifetime callbacks remain fenced. The response explicitly keeps `backend_status_verified_by_application:false`; neither an HTTP 200 nor two human attestations are an application-verified backend cancellation. Incorrect human attestations can still authorize overlap; this is an organizational verification boundary, not an account-wide concurrency guarantee.

Audits survive restart. Exact retries are idempotent, including after later work/restarts, and cannot clear a newer interrupted gate. Audit history is capped at 1024 decisions per camera; it is not silently pruned. Capacity exhaustion blocks further recovery decisions with 503 until an approved archival/maintenance procedure is provided; ordinary camera processing is not deliberately erased. Native control bodies are capped at 8 KiB. No retained JPEGs or incident records are deleted by recovery.

## Device heartbeat and recent health events

- `POST /heartbeat/camera/:id`, authenticated with the camera ingest key.
- `GET /health/camera/:id` and `GET /health-events/camera/:id?limit=50&before_sequence=...`, with ingest authentication.
- `GET /state/camera/:id` includes `device_health`, separately from observation/analysis freshness.

A heartbeat has exactly `camera_id`, a lower-case UUID-v4 `heartbeat_id`, integer `sent_at_ms` and `status` (`ok`, `capture_error`, `inference_error`, `storage_error`, `stalled`). Accepted freshness uses **server receipt time**, not the client's timestamp. Client time is only a replay/future check (within 30 seconds) and a strictly increasing watermark. Synchronize the Pi clock. Duplicates and old/reordered timestamps never refresh the receipt or emit another online transition.

Before a first heartbeat, health is `unknown`. Healthy receipt gives `online`; stage errors/stall give `degraded`. After 60 seconds without an accepted heartbeat, the shared durable alarm records one `offline/heartbeat_timeout` transition. Repeated alarm delivery does not repeat it. Fresh recovery records one online/degraded transition. Late heartbeat receipt can record both a missed offline transition and recovery in order. Device traffic never clears a fire incident or proves the scene safe/current.

Health and incident-delivery scheduling share the DO's one alarm; the earliest deadline wins, so continuous frame uploads cannot postpone expiry/retry indefinitely. Health receipt/deadlines survive cold restore even before the first observation. There is no separate cron. The pollable recent health log retains only the newest 256 transitions and 64 dedup IDs; the timestamp watermark prevents evicted old IDs becoming fresh again. History pages are at most 50 records. This rolling retention is **health-only** and never prunes incident evidence.

Transitions are available through authenticated reads and live WebSocket broadcasts. This is not guaranteed SMS/push/siren delivery, local offline fire protection, a cloud-outage detector available without the cloud, or a Pi-hardware acceptance result. Registry `cameras.last_seen_ms` is legacy metadata; use the dedicated health endpoints for heartbeat state.

The Pi live RTSP/network runner enables bounded outbound heartbeats (default 15 seconds, maximum interval 30 seconds, stall threshold 30 seconds) and monitors capture, inference and local-storage progress. Cadence is monotonic/deadline-based and does not accumulate request duration. A storage failure cannot clear on a negative/no-op sample: a new successfully indexed JPEG is required. Newly unreported terminal failures get at most one best-effort final attempt on the same nonoverlapping sender; failed/slow cloud communication may still leave receipt timeout as the only report. File replay and dry-run do not claim a live device heartbeat. Tune experimental timing only after actual Pi/camera measurements. No camera-inbound port or additional operator secret on the Pi is required.

Official JWT reference: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/

## Verified local acceptance and rerun

From the project root:

```sh
node --max-old-space-size=128 scripts/test_operator_runtime.mjs
```

On this Windows setup, use a tracked PTY if startup reports `stdin is not a tty`.
The harness starts and disposes only its owned Miniflare lifetimes, uses uniquely
scoped scratch SQLite/D1 storage, real signed test JWTs and actual public routes.
It waits for the real 60-second alarm rather than shortening the production
threshold or invoking the alarm manually. It never calls a remote model.

Final parent run: **15 contract assertions passed, exit 0**, 62,950 ms. Parent read
all 15 JSON artifacts, verified the unchanged production sources/migrations and
read the exact SQLite/D1 records after disposal: two recovery decisions, one
separate immutable human review, three incident events and three health
transitions. Offline was durable at 60,019 ms before any post-deadline public
health GET. Both owned listener ports were absent on a fresh OS check.

Result: `C:/Users/moihammed/AppData/Local/hermes/cache/scratch/operator-runtime-QQ0TAg/result.json`.
Scratch artifacts may be pruned. Detections and the empty native response are
test doubles; model events retained unknown accepted causes. This establishes
local operational contracts, not provider cancellation, forensic accuracy, actual
Pi performance, activated human identities or a production deployment.
