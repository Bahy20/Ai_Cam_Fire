# Uploaded webcam recording: fresh inference comparison

Source: `C:/Users/moihammed/Downloads/2026-10-23 19-47-28.mp4`, 74.015 seconds, 1920x1080 screen recording. This is a development regression, not a held-out accuracy estimate.

## Input preparation

The file records the FireGuard browser page, not a raw camera stream. The webcam rectangle was cropped before inference so the earlier alarm text could not tell the model what to answer. The stable rectangle at source seconds 25 onward is x=323..990, y=289..789. Twelve three-image windows at source seconds 26–72 were sent to the isolated MiniCPM benchmark using its existing prompt, pinned weights, deterministic generation and strict validator. No prompt tuning or retry-until-success was performed.

The final 70–72-second window includes the camera being stopped: at 72 seconds the crop contains page controls instead of camera footage. Exclude this window from visual recognition scoring. The HTTP replay also contains this short ending; its first urgent alert occurred much earlier, at original source time 27.667 seconds.

## MiniCPM-o 4.5

Twelve fresh remote calls completed on L40S. Median inference time was 2.694 seconds per three-image window; first inference took 5.324 seconds. Model load took 13.360 seconds. Peak allocated GPU memory was 17.124 GiB. These are model-call measurements, not live end-to-end or native full-duplex streaming latency.

- 26–28, 38–40, 42–44, 46–48, 50–52 and 54–56 seconds: no observed flame, smoke or material burning.
- 30–32 seconds: falsely described the red illuminated keyboard keys as emitting flames and reported other material burning. Also claimed flame at a lighter tip while declaring no lighter observed; strict validation rejected the response as `contradictory_tool_relation`.
- 34–36 seconds: falsely described the keyboard lights as multiple small flames and reported other material burning. The same contradictory relation caused rejection.
- 58–60 seconds: reported a lighter but no flame, while also claiming flame at its tip. Rejected as contradictory.
- 62–64 and 66–68 seconds: reported a blue lighter, flame at its tip, no observed smoke and no observed other material burning. Both outputs passed validation and derived `contained_lighter_candidate`.
- 70–72 seconds: no visible fire; excluded from recognition scoring due to page-control contamination after camera stop.

All twelve raw responses reported smoke `not_observed`. Six of the eleven camera-only windows correctly described the normal room without fire; two recognized the lighter flame; two contained false visual fire claims; one had a contradictory lighter relation. A rejected response means uncertain, not no danger. The two keyboard failures remain recognition failures even though validation caught them.

The successful lighter responses do not constitute a production operator-priority decision. No cause determination or live integration was tested with MiniCPM. The benchmark app `ap-H3tYVXjSuRsooZNuwc195x` stopped with zero tasks after completion; the live backend was not replaced.

## Existing deployed pipeline

The existing authenticated HTTPS endpoint accepted the 49-second cropped replay at 3 fps, corresponding to original source seconds 25–74. Job ID: `b2ab91ad-11f1-4035-a44b-a737b68e7556`. All 147 generated video frames were sampled.

The first urgent event was at replay time 2.667 seconds, original source time 27.667 seconds, before the later lighter sequence. It had fire `detected`, smoke `candidate`, scene `uncertain`, no VLM inference yet, and priority reason `smoke_or_secondary_fire`. Therefore this first urgent alert came from detector/policy processing, not a successful Scout finding. The first fresh Scout request timed out after 60.004 seconds with usage unavailable.

The job completed with 147 decoded and 147 sampled frames. Both fresh Scout requests timed out (60.004 and 60.002 seconds), with no returned usage. The final recorded-interval priority remained `inspect_urgently`, reason `smoke_or_secondary_fire`, cause unknown. The timeline contains 140 urgent events, four pending events and four monitor events; those are event counts, not independent incidents or frame-level accuracy. The replay is recorded-mode HTTP processing, not a reproduction of physical live-camera transport, original JPEG compression, or the earlier deployment's exact state. A model-only comparison and a full pipeline comparison have different scope.

## Decision

MiniCPM recognizes the important lighter windows and is responsive enough to justify further development, but this recording also demonstrates false fire recognition on keyboard LEDs. Replacing Scout alone will not eliminate the current detector-driven urgent alerts. Neither the raw model nor the present pipeline passes this entire regression.

Evidence: `E:/coding/fire/.hermes/minicpm-recording-20261023/` contains the manifest, crops, screen contact sheet, MiniCPM `report.json`, deployed `deployed-report.json`, job ID, logs and app-state snapshot. Preparation scripts are `.hermes/prepare_uploaded_recording.py` and `.hermes/prepare_recording_crops.py`. No service tokens are embedded in the reports.
