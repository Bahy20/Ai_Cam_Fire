# Handheld-lighter operator priority design

Date: 2026-10-19. Status: experimental implementation present; the automatic handheld downgrade remains disabled pending independent release gates.

## Intent

A lighter flame by itself should be recorded as visible flame without being presented to an operator as a high-danger fire. A lighter igniting other material must still receive urgent attention. The desired decision is about **operator response**, not a claim that the scene is physically safe or that ignition cause has been proved.

This revises the earlier [root-cause plan](../../fireguard-root-cause-plan-2026-10-19.md), which deliberately emits `inspect_urgently` for every confirmed flame and excludes moving handheld tools from live downgrades. That conservative rule remains active until the replacement passes the release gates below.

## Implementation status

- Scout V3 now has descriptive handheld tool assertions separate from cause and priority. It can derive `contained_tool_flame` from qualified frame-linked assertions and validate them against attached images and authenticated candidate IDs. V1/V2 decoding remains supported.
- A separate optional local candidate path and five-second incident-bound lease are implemented. Initial live `monitor` requires reviewed `expected_handheld_flame_use`, two current local frames, adequate image quality, a matching hash-pinned model and no veto evidence. Scout V3 is a later second opinion, not a prerequisite for the local fast path. A lighter mention alone cannot lower priority.
- Contradictory or uncertain scene results restore live urgency; material burning/smoke/extra flame regions also veto or latch urgent status. Historical `cause_update` is kept separate from sequenced live priority. Physical severity and accepted cause remain `unknown` without independent proof.
- The feature is disabled in all Worker profiles. The existing `detector/fire_seg.pt` lacks `lighter_flame` and `secondary_burning` classes, and `edge/agent.py` currently reports visibility as `unknown`; the ordinary pipeline therefore cannot produce an eligible candidate.
- The latest three-video local replay confirms the default-off urgent path only. A subsequent six-image V3 `response_format` probe passed schema validation but supplied no scene/tool assertions, so recognition remains uncertain. The three Desktop files are development regressions, and the `Desktop\\test` folder is byte-identical copies. Video 3's actionable-fire label remains `null`; there are no independent held-out intervals or Pi measurements. A further checkpoint-transition defect and the remaining release work are tracked in the release-completion plan.

## Target behavior

| Observed situation | Scene description | Live operator priority |
| --- | --- | --- |
| Confirmed flame attached to a tracked lighter tip across at least two usable frames, with no contradictory current evidence and a reviewed permitted-use policy | `contained_tool_flame` | `monitor` while evidence stays current |
| Lighter visible, but attachment/other burning/visibility is unresolved | `uncertain` | `inspect_urgently` |
| Material ignites separately, smoke appears, another flame region appears, or supported visual activity grows | `material_burning`/`smoke_only`/`uncertain` as warranted | `inspect_urgently` or `escalate` when existing independent escalation conditions hold |
| Local classifier evidence gets stale or fails, context expires, tracking breaks, camera changes, or an incident changes | `uncertain` | Cancel monitoring immediately; restore urgent review and report the reason |

`monitor` means lower *queue priority with operator review still required*. It never means no fire, low physical severity, verified cause, permission to suppress alerts, or clearance. A lighter label alone never authorizes `monitor`. Known site hazards, occupancy and critical zones retain the current escalation veto.

### Evidence contract

Keep V2 fixed-source data readable. Add a separate versioned moving-tool assertion, with fields generated from one canonical contract for prompt, provider schema, validator and persistence. The model may report a visible lighter and its relation to a flame, but cannot supply the final priority. Every assertion cites an attached full frame; a nullable candidate ID must exactly match a server-validated candidate from authenticated edge evidence when one is available. Required facts are `tool_type`, `flame_relation` (`at_tool_tip | separate | uncertain`), `secondary_burning`, `smoke`, `occlusion`, `frame_id` and `candidate_id`. The Worker validates exact fields, IDs and chronology and derives the scene category. Without a local candidate, the category is descriptive only and cannot authorize live monitoring. `not_observed` means only that the object was not visible in the attached full frame; it is not proof of absence.

For live monitoring, the edge must independently track the tool/flame relation over successive frames and send a bounded, authenticated continuity record. A model assertion is supporting evidence, not an authoritative track. Moving-tool continuity is a new path; static source rectangles and reference-image geometry remain specific to candles/burners. The edge should use local inference only. No Roboflow or paid provider is added.

The reviewed camera policy gains an explicit `expected_handheld_flame_use` permission with reviewer, camera binding and expiry. Uploaded values and Scout text cannot set this permission. A missing permission still allows the descriptive `contained_tool_flame` label for the recorded interval, but blocks a live automatic `monitor` decision. This preserves the previously chosen requirement for reviewed expected use while removing the stationary-zone mismatch.

### The initial-alert problem

Changing Scout output alone cannot prevent the initial urgent event: Scout runs after confirmation. The final goal of **no urgent notification during an independently labeled lighter-only interval** needs a fast, validated tool-only classifier/tracker on the edge. Before or at confirmation, it must link the flame to the lighter across at least two actual frames and pass strict vetoes for smoke, extra flame regions, unusable images, uncertain source association, missing samples and source gaps. With a matching reviewed camera policy, the Worker may emit `fire_confirmed` with `monitor` directly; the fire detection and operator review requirement still publish immediately. Every other confirmed flame stays immediately urgent under the existing rule. This avoids a new waiting state that could delay an actual fire while Scout responds.

Do not enable this gate based on small flame size, a free-text “lighter” label, or the present fire/smoke weights. The local relation classifier/tracker needs separately labeled controlled and hazardous-transition data, frozen operating thresholds, PC/Pi timing, a short renewable evidence lease and independent held-out testing. Scout then serves as a bounded second opinion; contradiction restores urgent review, and Scout failure cannot turn uncertain evidence into monitoring. Until the local gate is validated, the existing immediate urgent response remains active, and improved Scout interpretation can only reduce *later* urgent duration.

### Data and release gates

1. Freeze independent labels before tuning: lighter-only intervals, lighter-to-material ignition, other material burning, smoke, reflection and obscured scenes. Keep the three existing clips in development; collect genuinely separate development and held-out footage. Retain the earlier root-cause plan's minimum of three development and three held-out examples per category, including at least three held-out hazardous lighter-to-material transitions, plus separately measured expected-use exposure before claiming a false-urgent rate. Record actionable onset, image-quality limits and whether expected lighter use is reviewed. Do not relabel video 3 merely to make a test pass.
2. Compare the current baseline and candidate on the same complete replays. Report flame detection separately from scene classification, first live priority, every urgent notification, urgent duration on lighter-only footage, hazardous-event recall and delay, uncertain/abstention rate, and current-vs-historical priority. An initial urgent notification counts even if a later Scout response downgrades the incident.
3. Shadow-test moving-tool assertions and local candidate/continuity without changing live priority. Pass only if every held-out lighter-to-material transition is urgent, no independently labeled hazardous interval is ever downgraded to `monitor`, and complete lighter-only replays show the intended lower priority. These are minimum gates, not proof of general safety; report corpus size and confidence limits rather than claiming broad accuracy from three clips.
4. Enable live monitor only when the edge fast path runs within the measured PC/Pi budget, the declared urgent-delay limit passes, valid Scout responses stay schema-conformant, event persistence matches the live timeline, and the shadow run meets the above gates. Roll back automatically to current urgent behavior on missing classifier, unsupported hardware, stale policy, contradictory Scout output or incomplete local evidence. Provider failure cannot initiate monitoring or certify the scene; it also does not invalidate an independently qualified current local lease solely because a second opinion is unavailable.

Use cached Scout responses for parser/policy iterations; reserve fresh inference for contract probes and changed-prompt video verification within the reconciled account-wide neuron allowance. The former fixed six-call development cap was removed at the user's request. The finished implementation must update the replay evaluator and documentation for the new scene category and local-evidence path.

## Non-goals

No assertion of ignition cause, physical risk score, extinguisher choice or clearance. No paid subscription, Roboflow integration or production deployment in the planning phase. No silent delay of an urgent alert before the early gate is validated.
