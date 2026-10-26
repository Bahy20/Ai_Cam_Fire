# fire-guard — Raspberry Pi + Cloudflare

## Deployment boundary

**Pi performs camera capture, local YOLO and permanent incident-image storage. Cloudflare performs coordination, investigation and D1 event-summary storage. Neither Modal nor R2 is required.** Superseded Modal/local-VLM/HTTP-detector adapters and duplicate simulators have been removed.

```text
Camera -> Pi edge/agent.py (sample, JPEG, local YOLO)
       -> authenticated HTTPS POST /observation/camera/:id
       -> Worker validation -> CameraDO temporal confirmation + footprint trend
       -> SQLite lifecycle checkpoint + confirmation outbox -> live detection events
       -> D1 confirmation acknowledgement -> asynchronous Workers AI investigation
       -> durable analysis outbox + cause_update -> D1 summary (no cloud snapshot key)
Pi -> local incident JPEGs + manifest for review
```

No public Pi detector server, inbound port forwarding, tunnel or cloud GPU VM is required. The Pi initiates outbound requests. CPU is the conservative default; no FPS claim is made before measuring the actual hardware.

Handheld lighter priority is experimental and default-off. The ordinary fire/smoke checkpoint cannot qualify a lighter candidate, and current visibility measurements are unknown. The live path still requires reviewed camera permission, fresh local two-frame evidence and a matching V3 scene result before it can request `monitor`; uncertainty or secondary burning stays urgent. Separately, an opt-in Scout V3 result can label only its own post-confirmation observed interval `monitor` when fresh multi-frame lighter evidence, reviewed camera policy and a single current fire region qualify. It cannot rewrite the live alert or establish hazard absence, cause or physical severity. Persist `priority_scope` (`live` or `observed_interval`) with every new priority record, and keep dashboards from displaying a historical interval as the current incident priority. A monitor result still requires operator review and is not a safety finding.

## Pi responsibilities

- Load existing `detector/fire_seg.pt` once; no VLM on the Pi.
- Sample capture frames, resize, encode JPEG, then infer on the decoded **same JPEG** so boxes describe uploaded pixels.
- Send `{camera_id, ts_ms, frame_wh:[width,height], detections, jpeg_b64}` to `/observation/camera/:id` using `x-api-key`. Each detection contains `cls`, `conf`, `bbox_xyxy`.
- Preserve source timestamps for video replay and capture timestamps for live streams.
- Report candidates down to the experimental 0.05 floor. Inference/decode failure is an error, not an empty negative result.
- **This version uploads every sampled JPEG**, including valid empty detections. Moving YOLO does not by itself reduce image-upload bandwidth. Selected-frame-only upload is future work.
- Save incident JPEGs and a manifest on the Pi, including a bounded recent context buffer; recording starts from detector candidates even if the cloud is unavailable. Storage success is reported separately from upload success.
- Warn on cloud failure. Local evidence recording is not a local alarm, offline incident coordinator, retry queue or delivery guarantee.
- In live RTSP network mode, report bounded capture/inference/storage progress heartbeats. File replay and dry-run are not live-device health claims; an alive thread does not establish healthy inference.

Use `edge/requirements.txt` and `edge/README.md`; the Pi installation excludes Modal.

## Cloud responsibilities

- `INGEST_API_KEY` authentication fails closed outside explicit development mode.
- Validate bounded JSON, route/body identity, timestamp, normalized boxes, JPEG header and matching dimensions before DO mutation. Do not accept caller-supplied snapshot keys.
- `DETECTOR_PROVIDER=edge` disables legacy `/frame/camera/:id` external-detector calls. `/ingest/camera/:id` is a lower-level authenticated compatibility/testing interface, not the Pi client path.
- Keep temporal tiers in actual JavaScript: strong >=0.25, fast confirmation 5-of-12; persistent >=0.08, 8-of-24 after watch. These remain experimental, not a certified alarm specification.
- Estimate normalized union footprint from bounded recent observations. Pixels do not establish physical size or hazard. Unknown visibility limits confidence; missing/weak detections are not measured zero area. Gaps, motion and degraded visibility constrain trends.
- Investigate after confirmation without delaying the initial alert. Native AI binding, `VLM_PROVIDER=workers_ai`, configurable default `@cf/meta/llama-4-scout-17b-16e-instruct`.
- Freeze up to six chronological actual images: early, adjacent onset context, first detected flame, measured peak observed so far, and recent. Attach stable frame IDs/source timestamps and pair metadata only with successfully read bytes. Sampling roles never verify pre-ignition. At most one later measured-peak follow-up runs per incident; one inference plus one latest pending pack bounds concurrency.
- Require bounded observation-first JSON with actual frame references, then a distinct unverified hypothesis (`worker/src/investigation.js`). Reject malformed/forged/nonchronological references. Accepted cause/source/tool/fuel/class remain unknown for every unreviewed model output, including apparently frame-linked actions. Hypotheses/observations remain untrusted model claims for review, never hazard clearance or suppression authority.
- Repeated/delayed timestamps never advance confirmation on any ingress; keep the source-time watermark across incident rearming.
- In `EVIDENCE_STORAGE=pi`, at most 24 transient cloud images are retained, additionally limited to 512 KiB base64 per image and an 8 MiB aggregate base64 buffer, with selected frames pinned during inference; no permanent cloud image archive exists. DO eviction loses this buffer. The Pi owns permanent evidence; cloud metadata never verifies its disk writes. D1 migration `0002_analysis.sql` adds qualified analysis metadata; `0003_event_keys.sql` adds separate confirmation/analysis identities and unique event keys for retry-safe delivery. The cloud snapshot key stays null.
- `rules.js` is the single operator-response policy: `monitor`, `inspect_urgently`, or `escalate`, with reasons/limitations. Physical severity remains unknown. Reviewed site context comes only from operator-managed `CAMERA_CONTEXTS_JSON`, not uploads, model output or raw D1 registry JSON. It is camera-wide context, not measured physical overlap.
- Independently authenticate operator actions with signed Cloudflare Access assertions and exact reviewed subject/email/permission/camera policy. Ingest authority never becomes review authority; controls are disabled until real identities are configured.
- Append human causal attestations to separate immutable D1 review history (`0004_operator_reviews.sql`), with optimistic revisions and retry identities. Original model fields stay unknown; human attestation is not automatic factual verification or suppression approval.
- Keep device-health receipt/history separate from incident/source state. One shared durable alarm handles both outbox retries and receipt-time expiry, retaining the earliest deadline.

## Endpoints and semantics

- `POST /observation/camera/:id`: Pi detections plus matching JPEG; response `{camera_id, alert, hits, events}`.
- `GET /ws/camera/:id`: full live event payloads; subscribe before uploading.
- Authenticated `GET /events`, `GET /cameras`, `GET /state/camera/:id`; public `GET /health`. State reports current receipt freshness and running/queued/native inference flags, never JPEG bytes.
- Ingest-authenticated `POST /heartbeat/camera/:id`, `GET /health/camera/:id`, `GET /health-events/camera/:id`: server-receipt device health and bounded recent transitions, not fire clearance or guaranteed emergency notification delivery.
- Independently Access-authorized `/operator/cameras/:id/reviews`, `/recovery` and `/recovery-audits`: see `docs/operator-workflows.md`. Recovery proposals alone never release a permit; two distinct authorized identities must attest an externally verified provider outcome. The application cannot machine-verify that reference or cancel the old provider operation.
- Events: `fire_watch`, `fire_confirmed`, `fire_update`, `fire_cleared`, `cause_update`.
- `fire_cleared` means **fire no longer detected**, not safe/extinguished. Hazard level remains unknown without a validated context-aware policy.

## Resources and verification boundaries

Keep Worker/DO, Workers AI and D1. Permanent images are on the Pi; R2 is removed from all default configs. Superseded inference/archival adapters are not selectable; prior cloud evidence is not deleted. Never delete previously retained cloud incident data or unrelated services.

The implementation-time read-only audit listed only the unrelated `resumable-download-server` Modal app and reported no `fire-guard-api` Worker (10007). There was no deployed fire inference app to terminate. D1 was previously created/migrated; R2 activation was previously blocked. Configuration is not provisioning evidence.

Tests, actual local workerd replay, remote model inference, remote persistence and Pi benchmarks are separate gates. Old replay directories validate old local adapters, not this architecture. Known `fire1.jpg` detector miss remains. Independent negative-video/real-camera evaluation is still required.

CameraDO stores a versioned, at-most-256-KiB SQLite metadata checkpoint: compact confirmation flags, evidence references (not JPEGs), lifecycle/source watermark, original server-receipt time and qualified cause. Malformed state fails closed rather than resetting to idle. A bounded durable outbox holds confirmation independently of AI and retries D1 via the shared per-object alarm. D1 acknowledgement is required before native investigation starts; backlog capacity preserves retry room for existing analyses.

A recovered native call is unresolved, not cancelled. New native calls stay blocked until the guarded, audited external-provider review procedure releases the local permit. This never automatically cancels/replays native inference, and two human attestations are not application-verified provider status. Active promises cannot be forcibly cleared. Audit/checkpoint commits and generation/job guards prevent old retries or callbacks from releasing a newer operation or changing a newer incident.

Server-receipt heartbeat state survives restart independently of observations. The shared earliest-deadline alarm records one offline transition after the experimental 60-second timeout, with deduplicated recovery and bounded health-only retention. Health logs/live broadcasts are not a guaranteed delivered alarm or a replacement for a cloud-independent siren. The unsupported cron stays removed. Confirmation support resets after a source-time gap over two seconds without treating the gap as clearance; snapshot assessments use a separate five-second receipt freshness gate. Hardware-specific validation is still required. No physical-scale estimator, validated suppression controller or local alarm fallback exists. Images leave the site; privacy, retention and budget need operational review.

See `docs/cloud-deployment.md`, `docs/operator-workflows.md` and `edge/README.md` for setup and acceptance.
