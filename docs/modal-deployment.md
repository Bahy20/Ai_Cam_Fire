# Modal analysis deployment

Current architecture: PC (later Raspberry Pi) captures the camera, then sends JPEG frames over authenticated WSS to Modal. Modal runs YOLO, the coordinator, priority rules, HTTP uploads, storage and a private MiniCPM-o 4.5 GPU class. Scout has been replaced in this active path; see [current MiniCPM setup](minicpm-deployment.md). The dated Scout measurements below are historical, not the current provider configuration.

23 October smoke fix (`two-server-priority-v2`): raw smoke boxes are displayed as `candidate`, with pending priority for smoke-only candidates. Five smoke observations at confidence >= .25 among the last twelve valid samples, spanning at least one second, confirm detector smoke. The .25 tier is inherited from the existing evidence contract; it is not a measured probability or an independently evaluated threshold. Persistent smoke-only proposals (three positive samples spanning two seconds) now trigger Scout scene analysis. Valid Scout smoke evidence also confirms smoke; malformed responses cannot do so. Strong smoke alongside an existing fire incident, confirmed smoke, and validated material burning still request urgent inspection. Gaps reset sample/clearance counters; eight actual adequate negative observations clear smoke and its old evidence history. Briefly losing the camera cannot clear a confirmed incident.

Verification: 46 JavaScript tests passed, including weak smoke beside a fresh validated lighter scene remaining pending rather than urgent. The deployed WSS path processed both `neg1.jpg` and `neg2.jpg` as repeated camera-frame fixtures with no urgent alerts and no smoke detections, on policy v2. These fixtures do not establish real-webcam false-alarm performance. Reports: `.hermes/smoke-deployment/checks.json`; reproduce with `python scripts/verify_smoke_deployment.py`.

Positive controls: `fire1.jpg` failed to request inspection because its view was rejected by the existing image-quality gate (result unknown); this remains a detection limitation. `fire2.jpg` produced confirmed fire and urgent inspection. That run made a fresh Scout request which timed out after 30 seconds; no usage was returned. Detector urgency remained active. Reports: `.hermes/smoke-deployment/positive.json` and `positive-fire2.json`. These checks used real remote inference on repeated still images, not physical webcam footage.

23 October follow-up: whole-frame analysis no longer rejects the entire camera image merely because one YOLO proposal touches a frame border. The existing edge-only path retains its default conservative region handling. Uniform extreme-luminance frames still fail, and no reviewed visibility profile is fabricated. The result now includes `view.status`, a rejection reason, bounded quality reasons and source/processing frame ages; the hosted page displays actionable warnings. The screenshot's camera crop did not reproduce the exact raw-camera predictions locally, so it cannot establish the screenshot's exact trigger. Local verification: 47 JavaScript and 29 Python tests passed. Deployed follow-up evidence is saved in `.hermes/camera-view/deployed-checks.json`.

After that deployment, the screenshot-derived camera crop returned `available_for_detection`, no detections and monitor (19 results, zero urgent). The previously rejected `fire1.jpg` returned `available_for_detection`, confirmed fire and urgent inspection; the clipped-box warning remained visible in diagnostics. Its fresh Scout request again timed out at 30 seconds. These are repeated-image transport checks; the user's physical webcam still needs retesting.

The local camera UI stays at `http://127.0.0.1:8001/`; a cloud container cannot open the PC webcam. The PC sends compressed camera frames, not its own detector conclusions. Modal offers `/v1/live` and `/v1/videos`, with the same result format as the two-server prototype.

Deployed origin: https://geminiai340--fireguard-analysis-analysis-web.us-east.modal.run

Latest measured status: [21 October deployment verification](modal-verification-2026-10-21.md). Transport, YOLO and restart persistence passed; Scout analysis was blocked by the account's exhausted daily free neuron allowance.

22 October browser upload verification: the new file field successfully uploaded `63658-506816251.mp4` through the local proxy to Modal. All 34 samples completed, with two fresh Scout responses, no inference errors and final priority `monitor` / `contained_lighter`. This confirms the recorded-video UI path; it does not establish live-camera latency or general accuracy. Evidence is saved in `.hermes/video-upload-browser-result.json` and `.hermes/video-upload-ui.jpg`. Eight camera/configuration tests and browser script syntax validation passed.

## Deploy

Save `CLOUDFLARE_ACCOUNT_ID` and a durable `CLOUDFLARE_API_TOKEN` with Workers AI access in ignored `analysis/.env.local`. `CF_ACCOUNT_ID` and `CF_API_TOKEN` aliases are also accepted. Never use the expiring Wrangler OAuth token for unattended operation.

`EXPECTED_LIGHTER_CAMERAS=test-camera` explicitly allows the existing contained-lighter assessment for the supervised test camera. Other cameras default to no downgrade permission. Set `HAZARDOUS_CAMERAS` where appropriate. The policy still requires visual evidence; it never treats every lighter as safe.

From the repository root in PowerShell:

```powershell
$env:PYTHONIOENCODING='utf-8'
.venv\Scripts\python.exe scripts/configure_modal.py
.venv\Scripts\python.exe -m modal deploy deploy/modal_app.py
```

The credential script creates/updates only `fireguard-analysis-config`. The image uploads only selected source directories, dependency manifests and `detector/fire_seg.pt`. It excludes camera recordings, local env files, client credentials and results.

Record the printed HTTPS origin as `url` in ignored `analysis/.modal-client.json`, alongside the generated `token`. Do not put the token in URLs or shell command arguments. Start the camera bridge:

```powershell
.venv\Scripts\python.exe scripts/run_camera_modal.py
```

The launcher warms the remote service and checks authentication before opening the local UI server. Click Start camera to begin capture. Stop the old two-server launcher first if it occupies port 8001. `--port 8003` permits a separate camera control server.

To test a recording from the website, use **Analyze a recorded video** below the live camera controls: choose an MP4/MOV/AVI and click **Analyze video**. The page shows upload progress, polls the remote job, then displays detection, possible cause, operator priority and the JSON response. Scout failures appear as an incomplete-assessment warning. The local server forwards the file to Modal's `/v1/videos` endpoint and keeps the bearer token out of browser code. Multipart uploads retain their content length because Modal's proxy rejects chunked uploads.

## Sharing with testers

The hosted page is https://geminiai340--fireguard-analysis-analysis-web.us-east.modal.run/testing . Testers need no installation or access to the PC. Share the separate tester code saved in ignored `analysis/.modal-client.json` (`tester_code`); never share its `token` field or the Cloudflare token.

The page supports video upload and live browser webcam streaming. Webcam access requires the tester to click Start webcam and allow their browser's camera permission. It sends JPEG frames over WSS, not audio. Preview uses browser video capture, while analysis transmits at up to five frames per second and the server samples three. Hidden tabs stop capture. Live test sessions end after ten minutes; users can start another session.

Sign-in issues a Secure, HttpOnly, SameSite=Strict cookie valid for 24 hours. Browser upload results are scoped to that session; tester cookies cannot retrieve other testers' or service-client jobs. Requests that change state and WSS handshakes require the configured HTTPS origin. Webcam camera identities are isolated per tester, and the reviewed `test-camera` policy is used for the demo. Only one live session and one upload can run concurrently across all testers.

Enable with `python scripts/enable_tester.py`, then `python scripts/configure_modal.py` and redeploy after existing work is idle. `TESTER_PUBLIC_ORIGIN` must match the deployed HTTPS origin. Change `TESTER_ACCESS_CODE` in ignored `.env.local`, provision the secret and redeploy to revoke existing tester sessions. Set it empty and redeploy to disable hosted access. The service bearer credential remains separate.

22 October hosted checks: public page 200; login works in the real browser; authenticated upload completes; another tester gets 404 for that job; anonymous access gets 401; tester-cookie WSS accepts a JPEG and returns an isolated-camera assessment. The transport test uses synthetic dark frames and invokes no Scout calls. Physical webcam permission/capture must be exercised on the tester's own device. Evidence: `.hermes/hosted-tester-verification/checks.json`. Local JavaScript suite: 38 passed.

## Command-line remote verification

```powershell
.venv\Scripts\python.exe scripts/verify_two_server.py --base-url https://YOUR-ENDPOINT.modal.run --video-dir C:\Users\moihammed\Desktop\test --output .hermes/modal-verification --websocket-video C:\Users\moihammed\Desktop\test\63658-506816251.mp4
```

This mode does not start a local analysis backend. Each uploaded video runs fresh YOLO and Scout on the deployed path. Reports retain the deployment URL, provider usage when returned, timing, validation failures, hypotheses and priorities. Missing provider usage is unknown, not zero. Protected endpoints require the bearer token; `/health` is public.

On this Modal SDK version, the web-server proxy converts the backend's unauthorized WebSocket handshake (401) to a public 500. Unauthorized connections are still rejected; authenticated WSS must be checked separately. `scout_configured` reports credential presence, not quota availability.

## Capacity, persistence and costs

- One CPU container (2 CPUs, 4 GiB), no GPU, scales to zero. Its 20-minute idle window avoids stopping a bounded background video job immediately after HTTP 202. Poll jobs until completion. A continuous WSS connection keeps a container busy and incurs runtime costs.
- Existing service capacity remains one live session and one video job. Videos are limited to 250 MiB, 10 minutes and 1920×1080. This is a single-camera prototype, not a distributed queue.
- Active SQLite lives on the container's local disk. Every five seconds a consistent SQLite backup and incident evidence are copied to dedicated Volume `fireguard-analysis-data`; the Volume is committed every ten seconds and on graceful exit. Abrupt container loss can lose recent changes. Interrupted jobs are marked interrupted on restart and must be uploaded again.
- Uploaded source videos are temporary and removed after processing. Incident JPEG evidence has the existing 256 MiB cap. Event/database retention requires operational monitoring; no automatic deletion policy was added.
- Before redeploying an active instance, stop camera traffic, wait for uploads to finish and a checkpoint to commit, then stop **only** the `fireguard-analysis` app before deploying. This prevents old and new singleton containers from writing different snapshots to the same Volume. Do not stop unrelated apps.
- No subscription is added. Modal runtime/storage and Scout calls consume the existing account allowances; this deployment does not guarantee that usage stays free. Use the respective dashboards to check balances.

## Quality limits

Hosting does not certify detection, ignition cause or risk. Recorded-video and live-stream results must be reported separately. Earlier local evidence showed Scout latency can outlast the live evidence-freshness window; deployment alone does not prove the live lighter demonstration passes. A cause hypothesis remains distinct from verified cause.
