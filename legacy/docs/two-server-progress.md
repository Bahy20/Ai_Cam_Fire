# Two-server implementation ledger

Approved design: two PC services representing Pi capture and Modal analysis; compressed unannotated full frames; existing YOLO and JavaScript engine; direct Scout REST temporarily. Live WebSocket and recorded upload share one engine. Include continuous scene reassessment and lighter priority corrections.

Execution: inline using executing-plans and TDD; fresh whole-change review at completion.
Ruling: this workspace is not a Git repository. Implement in separate camera/ and analysis/ directories, share small pure modules with the legacy Worker, and retain the existing deployment.

Tasks:
- [x] Shared lifecycle + analysis coordinator, SQLite persistence, policy and regression tests.
- [x] Persistent Python detector/video decoder and Scout REST adapter.
- [x] Analysis HTTP upload + WebSocket server with integration tests.
- [x] Capture-only camera service, status/preview UI and launcher.
- [x] Fresh recorded-video verification and documentation of the three-video priority result.
- [ ] Physical live-camera lighter verification and independent review before shipment.

Defaults: 3 inference FPS, camera requests 640x480/30 FPS/JPEG80 and sends at most 10 FPS for analysis; Scout scene refresh >=5s with one global request in flight; 30s initial pending deadline; 30s live and 60s recorded request timeouts; source-evidence age <=10s; live receipt freshness <=5s. No six-call batch limit. One initial causal attempt per incident, then scene refreshes. Camera policies are server-owned. No automatic low priority while analysis is pending.

Verification so far: legacy Worker 517/517; existing Python 86/86; new JS 28/28; new Python 6/6. Fresh remote calls verified both HTTP and WS routes. The final three-video HTTP replay at `.hermes/risk-priority-final-regression-2026-10-21/summary.json` gave contained lighter -> monitor; material burning -> inspect urgently; third uncertain flame scene -> inspect urgently. Six fresh Scout calls succeeded with no schema errors. A second independent lighter replay also gave monitor. These are recorded-video results, not a physical live-camera acceptance test.
Live WS timing check: `.hermes/risk-priority-live-ws-2026-10-21/websocket.json` replayed the 11-second lighter clip at source speed with a fresh Scout call. Priority remained pending during the clip; the response arrived after footage stopped, when the receipt was stale, and the system reported current view unavailable. This does not pass the requested live lighter demonstration. Scout scene calls in recorded tests took roughly 10–15 seconds and their source evidence is limited to 10 seconds; a faster live scene model or another independently evaluated local classifier is required for reliable live monitoring priority. Do not lengthen evidence freshness merely to force a downgrade.
Latency probe: reducing the three lighter evidence images from 640 to 320 pixels wide preserved a valid contained-lighter assessment and reduced usage from about 145 to 79 neurons, but the fresh Scout response still took 14.2 seconds. Image-size reduction alone did not meet the live evidence window.

Ruling: preserve legacy image preprocessing inside the second service, including quality checks and inference on the exact retained JPEG. An initial full-resolution-only implementation changed detector behavior and was corrected.
Ruling: current detector warnings revoke a monitoring lease; validated scene material/smoke evidence latches an incident hazard. One transient candidate must not permanently label later evidence as material burning. Fresh evidence after a veto is required to requalify.
Ruling: retain strict Scout V3 validation. Fresh Scout returned narrative lighter labels under hand_near_fuel; follow-up scene requests now use a focused prompt and a narrower observation-kind schema (a subset of V3). Cause requests keep the existing prompt. Scene packs use three positive-fire frames spanning >=2s. This changes request focus, not validator thresholds.
Ruling: final recorded-video processing drains one coalesced latest scene after a slow initial call. File results are historical observed intervals; never replayed as current live priority.
Ruling: an end-of-file negative frame does not suppress a scene request while recent positive evidence remains. A fresh, validated lighter scene already covering the observed interval does not need an extra end-of-file request unless detector or model evidence contradicts it. Scout's scene prompt requires one grounded observation per image and does not treat absent smoke/material as positive evidence. A weaker YOLO box almost contained inside a stronger fire box is treated as a duplicate region rather than a second fire. The actual test camera reports 30 FPS but supplies approximately 12.4 FPS under current conditions.
Credentials: existing Cloudflare OAuth login refreshed using the project's existing wrapper solely to authorize verification. Normal services use the direct REST adapter; no Wrangler runtime dependency.
