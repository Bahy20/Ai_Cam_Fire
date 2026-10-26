# Modal verification — 21 October 2026

Deployment: https://geminiai340--fireguard-analysis-analysis-web.us-east.modal.run

**Deployment and transport verified; fresh Scout evaluation blocked by exhausted Cloudflare quota.** The deployed health check confirms the YOLO process is available and Scout credentials are configured. Account token verification succeeded. A bounded direct Scout request returned HTTP 429, Cloudflare error code 4006: the account has used its daily free allocation of 10,000 neurons. No successful new model responses were obtained, and returned inference usage is unavailable. No model outputs were replayed from cache. No paid plan was enabled.

| Recorded video | Decoded frames | Inferred samples | Processing | Successful Scout calls |
|---|---:|---:|---|---:|
| 63658-506816251.mp4 | 331 | 34 | Complete | 0 |
| WhatsApp 5.40.37 PM | 116 | 15 | Complete | 0 |
| WhatsApp 5.40.44 PM | 662 | 67 | Complete | 0 |

All three returned urgent priority in this run. For the lighter and third video, the reason was unavailable/expired scene assessment; the second showed smoke/secondary-fire evidence. These results do not establish that Scout got risk or cause right. The first request hit HTTP 429; subsequent recorded attempts were suppressed by the provider cooldown. Earlier console output called attempt counts `fresh_calls`; the harness now labels attempts and successful fresh responses separately.

Authenticated live WSS accepted 34 replayed lighter frames and returned 37 events. It received no successful Scout assessment. This validates the remote transport and detector path, not the live lighter priority requirement. Source frames were not frozen or resent to hide latency.

HTTP without a token returned 401; an authenticated missing-result lookup returned 404. Unauthorized WSS was rejected: Modal's proxy exposed 500 for the backend's 401 handshake, confirmed in service logs. Authorized WSS worked.

After stopping and redeploying only FireGuard, all three completed jobs were recovered from the dedicated Volume with identical final results. The local camera launcher at http://127.0.0.1:8001 now connects to Modal; capture remains stopped until the user clicks Start.

Local checks: 36 JavaScript and 9 Python tests passed. A fresh review found and fixed two defects: omitted policy keys failing to revoke a remote lighter-use permission, and pending live Scout work writing after SQLite shutdown. Regression tests failed before each fix and passed afterward.

Evidence: `.hermes/modal-verification-2026-10-21/summary.json`, `websocket.json`, `restart.json`, `.hermes/modal-auth-check.json`, `.hermes/modal-runtime.log` and `.hermes/modal-local-tests.log`.

Remaining gate: once Cloudflare's free allowance resets, rerun the remote HTTP/WSS verification to measure fresh Scout results. Existing live latency and independent accuracy requirements remain unproven. One-container capacity and possible loss of recent uncommitted snapshot data remain documented prototype limits.
