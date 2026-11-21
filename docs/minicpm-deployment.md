# MiniCPM provider on Modal

Native webcam streaming is described in [native streaming](native-streaming.md). The independent image-batch implementation below remains the recorded-upload path; live sessions now have a separate persistent native GPU WSS service when `MINICPM_NATIVE_URL` is configured.

The active analysis backend defaults to MiniCPM-o 4.5 (`openbmb/MiniCPM-o-4_5`, revision `d59117d19ddb8a28a62f1b5f4e3b34ac48d510a4`). The existing hosted URL, upload API and WSS protocol remain the same. The old Scout adapter was removed (git history, commit `7cbeb2b`).

`deploy/modal_app.py` contains a private `Vision` class: one maximum L40S, zero minimum containers, 120-second idle timeout and a dedicated cached-model Volume. It has no public HTTP inference endpoint and receives no service or Cloudflare secrets. Recorded uploads call it using Modal's authenticated Python SDK over a bounded JSON bridge. An upload warms that model before starting its recorded timeline. When native streaming is enabled, CPU startup does not start the separate batch GPU. The first live connection starts the native GPU and the page shows its connecting state. A later idle cold start may delay an assessment; stale results do not gain authority. GPU inference consumes the existing Modal allowance/credits, and actual remaining balance is unverified.

The GPU batches three independent one-image prompts. Each output reports flame, smoke, other burning material, lighter presence, flame relation, occlusion and a short description. The service requires exactly one result per batch slot and binds it to that slot's actual input frame ID; it never copies a whole-window label onto other frames. Strict parsing rejects duplicate/extra fields, bad enums and contradictory flame/tool relations; the Node adapter independently verifies the exact frame IDs and order. One exact outer JSON Markdown fence is accepted; surrounding prose is not. Findings are translated into the existing V3 validator; absent or uncertain evidence is never invented to qualify a lighter. Model outputs are not operator instructions. Existing priority/freshness/hazard rules remain in effect.

This provider is scene-only. It does not invent an ignition cause: `verified_cause` remains unknown and `scene_assessment.observations` carries the separate visual account. Existing detector-driven false urgent alerts and the measured keyboard LED VLM false positives are known limitations. Replacing Scout is not evidence those have been fixed.

Health reports `vlm_provider`, `vlm_model`, `vlm_configured`; the old `scout_configured` field is false. Inference records identify model, revision, source, fresh/failed mode, measured GPU duration and memory when returned. These are measured inference statistics, not actual billing charges. Bounded native output is stored privately under the existing diagnostic retention limit; the public job API strips raw model output.

Deploy after confirming no active live/video work, allowing the existing snapshot to commit, and stopping only the current `fireguard-analysis` app to avoid simultaneous writers to the persistence Volume:

```powershell
.venv\Scripts\python.exe scripts/configure_modal.py
.venv\Scripts\python.exe -m modal deploy deploy/modal_app.py
```

Provisioning no longer requires Cloudflare credentials and explicitly clears them from this service's named secret. Service/tester credentials and reviewed camera policy remain separately configured. The model weights must be populated in `fireguard-minicpm-model-cache` first; that cache was created during the approved benchmark.

Local verification: `npm test` in `analysis/`, `python -m unittest discover -s scripts/tests`, and `python -m unittest discover -s analysis/test -p '*_test.py'`. Fresh GPU probe: `python -m modal run deploy/modal_app.py::probe`. Deployment and fresh upload/WSS evidence will be recorded under `.hermes/minicpm-replacement/`.

## Verified deployment, 23 October 2026

The existing hosted origin now reports MiniCPM on Modal, `vlm_configured: true`, `scout_configured: false`. The active path requires no Cloudflare credentials. The named service secret's unused Cloudflare credential values were explicitly cleared, preserving backend/tester credentials and reviewed camera policy.

The cropped 49-second recording completed all 147 samples through the public authenticated upload endpoint. Nine model requests were recorded: seven fresh, shared-validator-valid responses and two rejected responses. The seven successful provider round trips took 3.825–5.628 seconds, median 4.171 seconds; hardware usage was returned for successful calls. Rejected-call usage was not retained in the current metadata, so it must not be treated as zero. Final priority remained urgent under existing detector/policy rules; scene uncertain. The replacement does not solve the recording's false alarms.

The lighter-image WSS replay returned 150 results with no detector flame/smoke proposals and monitoring priority. It did not invoke MiniCPM, so it cannot demonstrate correct VLM lighter classification and exposes a faint-flame detector limitation. The initial verification script incorrectly required a fresh VLM call for that negative detector path and failed that assertion; it was corrected to distinguish transport/detector behavior from inference gating. A burning-wood positive-control WSS replay then returned 27 results, fresh MiniCPM inference, and urgent priority. These checks sent repeated image fixtures over the actual public WSS connection, not a new physical webcam capture.

Local checks: 57 JavaScript tests, 97 script Python tests and 3 analysis detector tests passed. A separate reviewer found a cancellation defect, which was fixed and rechecked; final batch mapping had no material review findings. Deployment and verification logs plus full JSON evidence are under `.hermes/minicpm-replacement*`. The test page remains at https://geminiai340--fireguard-analysis-analysis-web.us-east.modal.run/testing .
