# Modal analysis deployment

Current architecture: the browser `/testing` page or the local camera bridge (`camera/`, started by `scripts/run_camera_modal.py`) sends JPEG frames over authenticated WSS to the Modal CPU gateway `Analysis`. The gateway runs the MiniCPM-only coordinator (policy `minicpm-only-v4`, see [model-only analysis](model-only-analysis.md)), HTTP uploads and storage; live frames go to the H100 `NativeLive` service ([native streaming](native-streaming.md)) and uploads to the L40S `Vision` image-batch class ([MiniCPM setup](minicpm-deployment.md)). YOLO, Scout and Cloudflare are not used; the earlier YOLO/Scout-era measurements recorded in this file's history and in `legacy/docs/` are historical.

The local camera UI stays at `http://127.0.0.1:8001/`; a cloud container cannot open the PC webcam. The PC sends compressed camera frames, not its own conclusions. Modal offers `/v1/live` and `/v1/videos`.

Deployed origin: https://geminiai340--fireguard-analysis-analysis-web.us-east.modal.run

## Deploy

No Cloudflare credentials are needed; `scripts/configure_modal.py` explicitly blanks the old `CLOUDFLARE_*` keys in the gateway secret.

`EXPECTED_LIGHTER_CAMERAS=test-camera` explicitly allows the existing contained-lighter assessment for the supervised test camera. Other cameras default to no downgrade permission. Set `HAZARDOUS_CAMERAS` where appropriate. The policy still requires visual evidence; it never treats every lighter as safe. Hosted testers have their own policy id `tester` (see Sharing with testers), so listing `test-camera` does not affect them.

From the repository root in PowerShell:

```powershell
$env:PYTHONIOENCODING='utf-8'
.venv\Scripts\python.exe scripts/configure_modal.py
.venv\Scripts\python.exe -m modal deploy deploy/modal_app.py
```

The credential script creates/updates only `fireguard-analysis-config` and `fireguard-native-config` (see Secrets). The gateway image uploads only `analysis/src`, `analysis/shared`, the frame-reader and MiniCPM client scripts and the dependency manifests. It excludes camera recordings, local env files, client credentials and results.

Record the printed HTTPS origin as `url` in ignored `analysis/.modal-client.json`, alongside the generated `token`. Do not put the token in URLs or shell command arguments. Start the camera bridge:

```powershell
.venv\Scripts\python.exe scripts/run_camera_modal.py
```

The launcher warms the remote service and checks authentication before opening the local UI server. Click Start camera to begin capture. Stop the old two-server launcher first if it occupies port 8001. `--port 8003` permits a separate camera control server.

To test a recording from the website, use **Analyze a recorded video** below the live camera controls: choose an MP4/MOV/AVI and click **Analyze video**. The page shows upload progress, polls the remote job, then displays detection, possible cause, operator priority and the JSON response. Model failures appear as an incomplete-assessment warning. The local server forwards the file to Modal's `/v1/videos` endpoint and keeps the bearer token out of browser code. Multipart uploads retain their content length because Modal's proxy rejects chunked uploads.

## Secrets

`FIREGUARD_TOKEN` is now only the service-client bearer. The gateway reaches the H100 native service with `FIREGUARD_NATIVE_TOKEN`, held in its own Modal secret `fireguard-native-config` (the only secret `NativeLive` receives), and signs tester cookies with `FIREGUARD_COOKIE_SECRET` in `fireguard-analysis-config`. `scripts/configure_modal.py` generates both once and keeps them in ignored `analysis/.modal-client.json` (`native_token`, `cookie_secret`); it never prints them. Run it before the next deploy: the deploy fails until `fireguard-native-config` exists. Either value left unset falls back to `FIREGUARD_TOKEN`. Saved values win over `.env.local`: a value there is used only when the JSON file has none. To rotate one, delete its key (`native_token` or `cookie_secret`) from `analysis/.modal-client.json`, rerun the script and deploy. Rotating the cookie secret (or the first deploy that introduces it) signs every tester out; they sign in again with the same tester code. The frame-reader Python worker gets a minimal environment with no credentials.

## Sharing with testers

The hosted page is https://geminiai340--fireguard-analysis-analysis-web.us-east.modal.run/testing . Testers need no installation or access to the PC. Share the separate tester code saved in ignored `analysis/.modal-client.json` (`tester_code`); never share its `token` field.

The page supports video upload and live browser webcam streaming. Webcam access requires the tester to click Start webcam and allow their browser's camera permission. It sends JPEG frames over WSS, not audio. Preview uses browser video capture, while analysis transmits at up to five frames per second and the server samples three. Hidden tabs stop capture. Live test sessions end after ten minutes; users can start another session. The gateway timestamps each frame on arrival, so a tester's device clock need not be correct. A browser that disappears without closing its connection (laptop sleep, dropped network) is disconnected within about 30 s, which frees the live slot.

Sign-in issues a Secure, HttpOnly, SameSite=Strict cookie valid for 24 hours. Browser upload results are scoped to that session; tester cookies cannot retrieve other testers' or service-client jobs. Requests that change state and WSS handshakes require the configured HTTPS origin. Webcam camera identities are isolated per tester, and all testers share the policy id `tester`, configured independently of `test-camera`. Not listed (the default), it is the stricter policy: no contained-lighter downgrade. To keep the old demo behavior, add `tester` to `EXPECTED_LIGHTER_CAMERAS` in ignored `.env.local` (for example `EXPECTED_LIGHTER_CAMERAS=test-camera,tester`), then rerun `scripts/configure_modal.py` and deploy; `HAZARDOUS_CAMERAS` accepts `tester` the same way. Do not name a real camera `tester`. Only one live session and one upload can run concurrently across all testers.

Enable with `python scripts/enable_tester.py`, then `python scripts/configure_modal.py` and redeploy after existing work is idle. `TESTER_PUBLIC_ORIGIN` must match the deployed HTTPS origin. Change `TESTER_ACCESS_CODE` in ignored `.env.local`, provision the secret and redeploy to revoke existing tester sessions. Set it empty and redeploy to disable hosted access. The service bearer credential remains separate.

22 October hosted checks: public page 200; login works in the real browser; authenticated upload completes; another tester gets 404 for that job; anonymous access gets 401; tester-cookie WSS accepts a JPEG and returns an isolated-camera assessment. The transport test uses synthetic dark frames and invokes no model calls. Physical webcam permission/capture must be exercised on the tester's own device. Evidence: `.hermes/hosted-tester-verification/checks.json`. Local JavaScript suite: 38 passed.

## Command-line remote verification

```powershell
.venv\Scripts\python.exe scripts/verify_two_server.py --base-url https://YOUR-ENDPOINT.modal.run --video-dir C:\Users\moihammed\Desktop\test --output .hermes/modal-verification --websocket-video C:\Users\moihammed\Desktop\test\63658-506816251.mp4
```

This mode does not start a local analysis backend. Each uploaded video runs fresh MiniCPM inference on the deployed path. Reports retain the deployment URL, provider usage when returned, timing, validation failures, hypotheses and priorities. Missing provider usage is unknown, not zero. Protected endpoints require the bearer token; `/health` is public.

On this Modal SDK version, the web-server proxy converts the backend's unauthorized WebSocket handshake (401) to a public 500. Unauthorized connections are still rejected; authenticated WSS must be checked separately.

## Capacity, persistence and costs

- One CPU gateway container (2 CPUs, 4 GiB) scales to zero. Its 20-minute idle window avoids stopping a bounded background video job immediately after HTTP 202. Poll jobs until completion. A continuous WSS connection keeps a container busy and incurs runtime costs.
- A cold `NativeLive` H100 start (container scheduling, image load, then up to `startup_timeout=180` for the model) can take several minutes. The gateway waits up to 300 s and the page shows *Starting live analysis* meanwhile. `min_containers=1` on `NativeLive` would remove the wait but bills an idle H100 around the clock, so it is not set.
- An upload body may take up to 15 minutes to arrive (Node's server-wide request timeout, sized for 250 MiB on a ~2.3 Mbit/s uplink); every other request must still arrive within 2 minutes. The local camera bridge (15.5 minutes) and both upload pages (16 minutes) wait slightly longer, so the gateway's limit applies first. Modal's own web-endpoint request limits may cut very slow uploads off sooner; whether they do has not been verified.
- Existing service capacity remains one live session and one video job. Videos are limited to 250 MiB, 10 minutes and 1920×1080. This is a single-camera prototype, not a distributed queue.
- Active SQLite lives on the container's local disk. Every five seconds a consistent SQLite backup and incident evidence are copied to dedicated Volume `fireguard-analysis-data`; the Volume is committed every ten seconds and on graceful exit. Abrupt container loss can lose recent changes. Interrupted jobs are marked interrupted on restart and must be uploaded again.
- Uploaded source videos are temporary and removed after processing. Incident JPEG evidence has the existing 256 MiB cap. Event/database retention requires operational monitoring; no automatic deletion policy was added.
- Before redeploying an active instance, stop camera traffic, wait for uploads to finish and a checkpoint to commit, then stop **only** the `fireguard-analysis` app before deploying. This prevents old and new singleton containers from writing different snapshots to the same Volume. Do not stop unrelated apps.
- No subscription is added. Modal runtime, GPU inference and storage consume the existing account allowances; this deployment does not guarantee that usage stays free. Use the respective dashboards to check balances.

## Quality limits

Hosting does not certify detection, ignition cause or risk. Recorded-video and live-stream results must be reported separately. Deployment alone does not prove the live lighter demonstration passes; see the webcam test set (`docs/webcam-test-set.md`). A cause hypothesis remains distinct from verified cause.
