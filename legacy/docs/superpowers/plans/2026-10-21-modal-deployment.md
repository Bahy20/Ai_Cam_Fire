# FireGuard Modal deployment

Goal: host the existing analysis service on Modal, retaining Scout and the local PC camera bridge.
Architecture: one CPU container, authenticated HTTPS/WSS, local SQLite with consistent backups to a dedicated Modal Volume. Scout uses a durable Cloudflare API token stored in Modal Secrets. Node 24, Python 3.11, existing YOLO checkpoint.
Scope: current single-camera MVP; do not alter model prompts or risk policy.

- [x] Test and implement snapshot/restore without copying an open SQLite WAL database.
- [x] Package explicit source paths and CPU dependencies, add Modal lifecycle hooks and authenticated secret provisioning.
- [x] Add remote camera launcher and real HTTP/WS verification mode.
- [x] Deploy, verify authorization, execute three videos and WSS replay, verify restart persistence.
- [ ] Obtain successful fresh Scout results: blocked by Cloudflare daily free allocation exhaustion (HTTP 429 / code 4006), not by credentials or Modal deployment.
- [x] Fresh review and documentation of deployment status and remaining limitations.

Review focus: source/secret leakage, SQLite consistency, shutdown ordering, cold starts, async-job survival, remote authentication, accidental changes to risk policy.

## Execution ledger

Ruling: no Git operations or worktree — this workspace has no Git repository; retain this plan and test evidence on disk.
Ruling: webcam capture stays local — Modal cannot access a PC webcam; remote analysis and storage move to Modal.
Ruling: use one CPU container and scale to zero — existing YOLO uses CPU; Scout remains an external API. This limits capacity to the existing single live session and single upload job.
Pre-flight: snapshot restore must precede Store construction; final backup must precede Store.close. Remote clients consume the same bearer token as the Modal secret.
Credential check: existing fire-inference-auth contains only INFERENCE_API_KEY; durable Cloudflare credentials requested from user. Do not deploy expiring Wrangler OAuth.

2026-10-21: User supplied account-scoped Cloudflare token; verification returned active/HTTP 200. Stored in ignored local env and dedicated Modal secret; values excluded from image.
Task 1: snapshot/restore regression RED (missing module) -> GREEN; graceful close checkpoint regression RED -> GREEN.
Task 2: deployed CPU image; health 200 with detector_available/scout_configured true. Fixed Windows CLI UTF-8 output and Modal image operation ordering. Endpoint: https://geminiai340--fireguard-analysis-analysis-web.us-east.modal.run
Task 3: remote harness and local bridge launcher implemented; HTTPS-origin validation tested.
Final review: fresh reviewer identified stale policy values in merged Modal secrets and pending live inference writes after store shutdown. Both fixed with RED -> GREEN tests; full JS 36/36, Python 9/9.
Ruling: dedicated snapshot Volume with one active writer; stop this app before redeploying to prevent overlapping deployment writers. Abrupt termination may lose changes since the last committed snapshot; report interrupted jobs instead of replaying inference silently.
Remote verification: 3 HTTP videos completed (34/15/67 samples), WSS 34 frames/37 events; no successful Scout responses because daily neurons exhausted. HTTP auth rejection confirmed; Modal proxy converts WS 401 to 500 but rejects connection. All 3 final results match after a stopped-app redeployment. Camera bridge switched to Modal at localhost:8001, camera off. See docs/modal-verification-2026-10-21.md.
Final limitations: one CPU container, webcam stays local, recent snapshots can be lost on abrupt termination. No Git integration was possible because no repository metadata exists. No unrelated Modal app changed. No minor review findings were deferred.
