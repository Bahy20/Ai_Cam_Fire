# Repair live assessment startup and visual streaming

User reports the browser waits for a current valid visual assessment and authorizes camera testing through the browser. Keep YOLO removed and keep the persistent WSS transport.

Evidence: the user's saved live session first supplied a valid report at29.981s and monitoring at33.948s. A subsequent short session sent black frames and ended during startup. The dry-grass duplex replay produced unsupported repeated fire/smoke/lighter labels before ignition, unlike the HTTP visual path.

The native visual API with explicit image questions recognized all control scene transitions. Its pinned upstream text-only context trim corrupted output at4038tokens (repeated `flavor`). A bounded application context reset before2800tokens avoided that path and passed15 actual GPU frames, including the user's archived camera image, unlit/burning grass and lit lighter. Cache epochs are explicit and do not clear the coordinator's incident history.

- Use native `streaming_prefill` and text `streaming_generate` with strict per-image JSON, one WSS and shared GPU/model per session. No `chat()` loop or repeated HTTP fallback.
- Reset bounded model context before upstream trimming; reset malformed context; retain fresh evidence and validated incident hazards separately.
- Distinguish startup, unreadable/blank camera and invalid model reports in browser priority/status. Keep monitoring blocked by missing evidence.
- Run regression suites and independent code review, deploy idle existing app, then make fresh public WSS dry-grass, lighter/room and dark-camera checks. Verify a reconnect and context reset.
- Browser-only preference: do not continue attempting exclusive direct camera capture. Physical preview in the user's unconnected browser must not be claimed as directly observed by the agent.

## Public test follow-up

The first deployed visual adapter correctly labeled the lighter, but its verbose JSON reports took about2.8–3.5seconds plus transport lag. The third report often arrived after the oldest support exceeded the unchanged10second freshness bound. The105second public user-recording replay produced33 valid reports and no false urgent/smoke ending, but zero lighter-monitoring results; that run failed acceptance and is retained under `.hermes/live-camera-20261025/lighting/` until superseded evidence is separately preserved.

Do not increase the evidence lifetime or reduce the required independent reports to make this pass. Compact array prompt candidates failed real GPU schema validation; compact numeric objects passed schemas but hallucinated hazards on the unlit control. None was deployed. Keep the accurate full named-enum contract and benchmark the exact adapter on H100, as authorized by the user when faster streaming requires a GPU upgrade. Verify all15 control frames, then repeat public grass/lighting and hazard/darkness/reconnect controls. Preserve failed candidates and test-feeder timestamp failures separately.
