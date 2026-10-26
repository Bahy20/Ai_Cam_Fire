# Legacy (retired)

Archived code from the earlier FireGuard design, kept for reference only. None of it is used, imported or deployed by the current Modal/MiniCPM product.

- `worker/`: Cloudflare Worker / Durable Object coordinator (Wrangler, Workers AI, D1).
- `edge/`: Raspberry Pi edge agent (capture, local YOLO, upload, heartbeat).
- `detector/`, `requirements-yolo.txt`: YOLO fire/smoke checkpoint, its regression script and Ultralytics dependencies.
- `analysis/`: the old two-server coordinator, Scout and priority modules and their tests.
- `scripts/`, `docs/`: Worker/workerd/Pi harnesses, the Worker evaluation suite and their tests and docs.

The shared modules still in use were copied to `analysis/shared/`. These files are not maintained and their tests are not part of the product suites.
