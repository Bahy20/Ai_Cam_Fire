# MiniCPM-o 4.5 evaluation

Scope approved 23 October 2026: benchmark self-hosted MiniCPM on Modal before replacing the deployed Scout adapter.

- Model: `openbmb/MiniCPM-o-4_5`, pinned revision `d59117d19ddb8a28a62f1b5f4e3b34ac48d510a4`.
- Isolated ephemeral app: `fireguard-minicpm-benchmark`; one L40S, zero minimum containers, 30-second idle timeout, bounded function timeouts. No production credentials or public endpoint.
- Cache weights on a dedicated Modal Volume, downloaded in a CPU function before allocating GPU inference.
- First gate: vision-only single/multiple-image recognition, model load time, per-window latency, peak GPU memory and strict response validation.
- Second gate, only if recognition is useful: native continuous streaming and its state/memory behavior. The first gate does not establish full-duplex performance.
- Runtime: publisher-recommended Transformers 4.51.0 and PyTorch 2.8, no thinking or speech synthesis in the initial visual benchmark.

Cases are the saved failed webcam desk frames, a normal-room image, video 3 lighter frames, and visible burning wood. Each case repeats once to separate first inference from warm behavior. These are development regressions, not independent held-out accuracy evidence. The first lighter image includes sparks and a possible smoke wisp: assess the raw visual fields as well as the derived category; never tune the prompt until it gives a desired label.

The benchmark contract reports flame, smoke, other burning material, lighter presence and flame relation. It does not output product priority or verified cause. Malformed/incomplete output is invalid, never a negative scene. The derived lighter category is explicitly a candidate and is not an operator-priority downgrade.

Run:

```powershell
$env:PYTHONIOENCODING='utf-8'
.venv\Scripts\python.exe -m unittest scripts.tests.test_minicpm_benchmark
.venv\Scripts\python.exe -m modal run deploy/minicpm_benchmark.py
```

Artifacts: `.hermes/minicpm-benchmark/run.log` and, on completion, `report.json`. Private frame bytes are sent only to the isolated Modal function. Existing `fireguard-analysis` remains the live app until a measured replacement passes integration tests.

Execution ledger:

- Resolved public model SHA and verified ungated access.
- Read publisher image/video APIs and dependency constraints.
- Response-parser tests failed on missing implementation, then passed (3 tests).
- Launched the isolated benchmark. Actual remote results are required before any model-performance claim.

## Measured outcome, 23 October 2026

The isolated Modal run completed successfully on NVIDIA L40S. Model load took 18.75 seconds. Eight fresh window assessments took 2.81–5.30 seconds, median 3.12 seconds. Peak allocated GPU memory was 17.12 GiB. Total local-entrypoint wall time, including initial model download, was 156.68 seconds; image construction was additional. These timings are not full-duplex latency or billed GPU duration.

- Saved actual webcam desk frames: twice reported flame present at a red lighter tip. Visual inspection of these three saved frames does not show a flame, so this fails the normal-desk acceptance case.
- Normal room: twice reported no visible fire/smoke.
- Lighter video: twice recognized the lighter and tip flame, but also reported smoke. The first sampled frame contains sparks and a possible smoke wisp, so this does not independently establish a smoke-classification error; it also does not establish the required steady-lighter monitoring behavior.
- Burning wood: twice reported other material burning.
- All eight outputs passed the revised strict parser, including the added contradiction and duplicate-field protections. Valid syntax did not establish correct visual recognition.

Decision: visual recognition gate failed on the actual desk regression. Do not replace Scout with this candidate or claim continuous streaming was verified. Native full-duplex testing was not advanced because the preceding recognition gate failed. The existing live backend remains unchanged. The ephemeral benchmark app completed; no persistent GPU service was deployed. Billing balance/actual charges have not been independently verified.

Raw evidence: `.hermes/minicpm-benchmark/report.json`, `run.log`. Run URL: https://modal.com/apps/geminiai340/main/ap-GVHX3zyVyDQWVy6yT7t1C5 . Four local parser tests passed after the review fix. Two repeats of four development cases are not a held-out accuracy estimate.
