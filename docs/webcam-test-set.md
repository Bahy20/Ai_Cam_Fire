# Labelled webcam test set

The main open problem is false smoke reports, such as a dark mousepad reported as smoke. This set is about 20 short clips from the live webcam, each labelled by hand. `scripts/evaluate_webcam_set.py` replays them through the hosted or local gateway and records the smoke false-positive rate for the gateway's `policy_version`. `scripts/export_false_alarms.py` turns operator "False alarm" reviews into more clips for the same set.

## Layout

```
webcam-set/                  repository root
  labels.json                labels (tracked in git)
  clips/                     your recordings (not tracked)
  false-alarms/              clips exported from operator reviews (not tracked)
  hosted-db-YYYYMMDD/        downloaded gateway database and evidence (not tracked, contains room images)
  reports/                   one JSON + CSV per run, run folders of raw jobs, history.csv (rates over time)
```

To start, create `webcam-set/clips/` and copy `scripts/evaluation/webcam-set.template.json` to `webcam-set/labels.json`. Then add one entry per clip, using the list below. Paths in the labels are relative to `labels.json`.

## Recording

- Use the same webcam, room and camera position as live use. Fix the camera on a stand or tape it down: camera motion makes the gateway drop frames.
- Record 20–30 s per clip with one condition per clip. The condition should be in view for most of the clip, because labels describe the whole clip.
- Save MP4 (MOV or AVI also work), at most 1920×1080, under 250 MiB and 10 min. Do not trim a clip after you have recorded its sha256.
- Lighting: "dim" means dim, not black. Black frames are rejected as dark and test nothing. Write the lighting in `notes`.
- Keep faces and personal screens out of view. Clips are uploaded to the hosted gateway, and a nearby face can make the model report the view as obscured.
- Record the development clips in one session. On another day, or in other lighting, record the held-out clips in a second session. A recording session supplies one split only. Tune policy on development clips; use held-out clips only to report.
- Label each clip from the recording itself, before running the evaluator or looking at any model output. Use `null` when you cannot tell; null means unmeasured, never "absent".

## Clip list

| id | category | split | what to record | smoke / flame / material / lighter |
|---|---|---|---|---|
| neg-mousepad-01 | negative_dark_object | development | dark mousepad fully in view, normal light (the known false smoke case) | F / F / F / F |
| neg-mousepad-dim-01 | negative_dark_object | development | same mousepad, ceiling light off, monitor on | F / F / F / F |
| neg-dark-cloth-01 | negative_dark_object | development | dark hoodie or bag on the desk or chair | F / F / F / F |
| neg-dim-room-01 | negative_dim_room | development | room lit only by the monitor | F / F / F / F |
| neg-steam-mug-01 | negative_steam | development | mug of just-boiled water close to the camera | F / F / F / F |
| neg-steam-kettle-01 | negative_steam | development | kettle steam or humidifier mist at the edge of view | F / F / F / F |
| neg-glare-01 | negative_reflection | development | lamp or sunlight glare on a glossy surface or window | F / F / F / F |
| neg-led-01 | negative_reflection | development | keyboard RGB or orange lamp light on the wall | F / F / F / F |
| neg-clear-desk-01 | negative_clear_scene | development | normal light, nothing unusual; one hand reaches in and out | F / F / F / F |
| lighter-unlit-01 | lighter_unlit | development | lighter held and turned, never lit | F / F / F / T |
| lighter-lit-01 | lighter_contained | development | lighter lit about 5 s, released, twice; nothing else burning | F / T / F / T |
| smoke-incense-01 | smoke_real | development | incense smoke plume, glowing tip just out of frame (see safety) | T / F / F / F |
| smoke-candle-out-01 | smoke_real | development | candle blown out just before recording starts; wick smoke in view | T / F / F / F |
| material-paper-01 | material_burning | development | outdoors only: a small paper strip burning in a metal tray | T / T / T / null |
| neg-mousepad-02 | negative_dark_object | held_out | mousepad, second session, different position in view | F / F / F / F |
| neg-dark-cloth-02 | negative_dark_object | held_out | another dark object (bag, cable bundle) | F / F / F / F |
| neg-dim-room-02 | negative_dim_room | held_out | evening light or one corner lamp | F / F / F / F |
| neg-steam-mug-02 | negative_steam | held_out | steam, second session | F / F / F / F |
| lighter-lit-02 | lighter_contained | held_out | lit lighter in dim light | F / T / F / T |
| smoke-incense-02 | smoke_real | held_out | incense smoke, second session | T / F / F / F |

If the flame appears in a candle clip, set `flame_present` to true; for incense, set `burning_material_present` to true if the glowing tip is in frame. The table gives intended labels: check each one against what the recording actually shows.

## Safety for real smoke and flame

These clips are optional. Skip them if you cannot do them safely.

- Use safe smoke sources: an incense stick or a candle you have just blown out. Burn no material indoors, ever.
- Work over a sink, next to an open window, or outdoors, on a non-flammable surface, with nothing flammable within a metre. Keep hair and sleeves back, and keep children and pets away.
- Keep a fire extinguisher, or at least a bowl of water and a damp towel, within reach. Never leave a flame or smouldering stick unattended. Put incense and candles out in water afterwards.
- Lighter: use short bursts held away from paper, curtains and the desk, and let it cool between bursts.
- Burning material: outdoors only, one small strip of paper in a metal tray on bare ground, little wind, water ready, and only where local rules allow it. This is the one clip that cannot come from the live room; note that in `notes`.
- Do not disable smoke alarms. If incense would set one off, record outdoors or at the open window instead.

## Labels (`version: 1`)

| field | values |
|---|---|
| `id` | unique, letters, digits, `_` or `-` |
| `file` | relative path to the clip (.mp4, .mov, .avi) |
| `sha256` | 64 hex characters; fill with `--write-sha256` after recording |
| `status` | `missing` (not recorded yet), `available`, `excluded` (kept, not scored) |
| `category` | `negative_dark_object`, `negative_dim_room`, `negative_steam`, `negative_reflection`, `negative_clear_scene`, `negative_false_alarm`, `lighter_unlit`, `lighter_contained`, `smoke_real`, `material_burning`, `other` |
| `split` | `development` or `held_out` |
| `recording_session` | session name, such as `desk-a`; one session belongs to one split |
| `smoke_present`, `flame_present`, `burning_material_present`, `lighter_present` | `true`, `false` or `null` (unmeasured) |
| `expected_priority` | `null`, a level, or a list of acceptable levels, compared with the final priority |
| `recorded_at`, `labelled_by`, `notes` | ISO time, name, free text, or null |
| `source` | `webcam` or `operator_false_alarm` (the latter carries a `review` object) |

The validator rejects unknown fields, duplicate ids, files or hashes, a session used in both splits, and labels that contradict the category. For example, a `negative_*` clip cannot have `smoke_present: true`.

Suggested `expected_priority` values:

- Negatives and an unlit lighter: `["monitor", "unknown"]`. Unknown is a valid "review required" answer.
- Smoke and material: `"inspect_urgently"`, or `["inspect_urgently", "escalate"]` if the camera id is in `HAZARDOUS_CAMERAS`.
- A lit lighter: depends on the gateway's `EXPECTED_LIGHTER_CAMERAS`. With the default (empty or `*`) a contained flame is downgraded on every camera, so `["monitor", "unknown"]` fits; if the setting lists cameras and the run's camera id is not among them, the flame is `inspect_urgently`. Leave `null` when you do not know the setting.

## Running the evaluation

Commands from the repository root (Windows paths as elsewhere in this repo):

```bash
.venv/Scripts/python.exe scripts/evaluate_webcam_set.py --write-sha256     # once after recording; implies --dry-run
.venv/Scripts/python.exe scripts/evaluate_webcam_set.py --dry-run          # labels, files and sha256 only, no upload
.venv/Scripts/python.exe scripts/evaluate_webcam_set.py                    # hosted gateway
.venv/Scripts/python.exe scripts/evaluate_webcam_set.py --local            # gateway started by scripts/run_two_server.py
.venv/Scripts/python.exe scripts/evaluate_webcam_set.py --only neg-mousepad-01 --only smoke-incense-01
.venv/Scripts/python.exe scripts/evaluate_webcam_set.py --from-jobs webcam-set/reports/<run>-jobs   # rescore after fixing labels
```

- **Hosted:** the URL and service token come from `analysis/.modal-client.json`, as for the other Modal scripts, or pass `--base-url https://...`. The token is sent as a bearer header and is never printed or saved.
- **Local:** the run uses `http://127.0.0.1:8002` (or `--port`) and `FIREGUARD_TOKEN` from the environment or `analysis/.env.local`. Put the token there so that the gateway and the evaluator share it; otherwise `run_two_server.py` generates a random one.
- **Camera id:** `--camera-id` (default `test-camera`) is the camera id the gateway applies `EXPECTED_LIGHTER_CAMERAS` and `HAZARDOUS_CAMERAS` to. Each report records it.
- **What happens:** the script reads `/health` for `policy_version` and `build_id`, then uploads one clip at a time and polls the job until it finishes. Each clip has a bounded wait: `--job-timeout`, default 900 s, extended for long clips. If another job is running, the upload waits up to 10 minutes.
- **Run time and cost:** uploads replay in real time, so 20 clips of 30 s take roughly 15–25 minutes, and every clip uses fresh GPU inference.
- **Changed files:** if a clip's sha256 no longer matches its label, nothing is uploaded.

## Reading the report

Each run writes `webcam-set/reports/<policy_version>-<UTC time>.json` and a `.csv` with one line per clip. It also saves the raw jobs in `<same name>-jobs/` and appends one line per policy and split to `history.csv`. The JSON repeats these definitions:

- **Rows:** model rows the gateway applied, after its description check, rebuilt from the job timeline. The job API does not return raw model rows. `model_rows` counts what the model returned. It is larger than `valid_rows` because each batch's oldest frame often predates the previous batch and is discarded. A smoke report on a discarded frame does not appear here, and the policy ignores it too.
- **Smoke false positive (clip):** a clip with `smoke_present: false` whose run latched smoke. If the labels also say no flame and no burning material, a latch of any hazard, or a priority of `inspect_urgently` or `escalate`, also counts. A labelled lighter that reaches `inspect_urgently` for its flame is therefore not a smoke false positive, but a lighter clip that latches smoke is.
- **Smoke false-positive row rate:** rows reporting smoke / all applied rows, pooled over smoke-negative clips. One stray smoke row that never latches shows up here and not in the clip rate.
- **Miss:** a `smoke_present: true` clip that neither latched nor reached `inspect_urgently` or `escalate`.
- **Pass/fail:** the smoke check plus the `expected_priority` check. `unscored` means a clip has neither; `error` means the upload or job failed, and such clips stay out of every rate.
- **description_check:** when the gateway reports it, `description_flagged_rows` counts model rows whose own description contradicts a hazard field it reported present, such as smoke reported with the description "no smoke". The gateway treats such a field as uncertain before the policy sees it. `smoke_rows_contradicted` counts the smoke claims removed this way. On negatives these are caught false rows (`smoke_fp_rows_contradicted`); on positives they are lost true rows (`smoke_positive_rows_contradicted`). Both are null on gateways without the check.

Compare runs only with the same labels (`labels_sha256` in `history.csv`) and the same camera id. Read development and held-out lines separately. With about 20 clips, a single clip moves a rate by 10 points or more. The rates track regressions between policy versions; they are not a measured accuracy or a fire-safety claim.

## Exporting operator false alarms

1. **Download the hosted database.** The gateway snapshots `fireguard.sqlite` and `evidence/` to the root of Modal Volume `fireguard-analysis-data` (mounted at `/persist`, see `deploy/modal_app.py`) every 5 s, and commits the Volume every 10 s, so a download is the last committed snapshot. Use a new folder each time:

   ```bash
   .venv/Scripts/python.exe -m modal volume get fireguard-analysis-data / webcam-set/hosted-db-20261027
   ```

   For the local gateway, the database is `analysis-data/fireguard.sqlite`, with `analysis-data/evidence/` beside it.
2. **Export.** Run the dry run first, then the real export:

   ```bash
   .venv/Scripts/python.exe scripts/export_false_alarms.py --db webcam-set/hosted-db-20261027/fireguard.sqlite --dry-run
   .venv/Scripts/python.exe scripts/export_false_alarms.py --db webcam-set/hosted-db-20261027/fireguard.sqlite
   ```

   The database is opened read-only. Each review with action `false_alarm` becomes `webcam-set/false-alarms/fa-<review id>-<incident>.avi`, an MJPEG at 3 fps. The clip uses that live session's evidence frames, from 30 s before the incident started up to 10 s after the last hazard report, and never frames from after the review. At most 900 frames are kept, the newest ones.

   Each clip's label entry has `source: operator_false_alarm`, `category: negative_false_alarm`, `smoke_present: false`, `split: development`, and null for the other flags. The entry's `recording_session` is the live session. Reviews already in the labels, matched by review id and incident or by sha256, are skipped, and existing entries are never changed.
3. **Check each exported clip.** If the frames show something other than a false alarm, correct `category` and the flags, or set `status: excluded`. Then run the evaluator as usual. Exported clips stay in development, because policy may be tuned on them.

Exported clips are time-compressed: the gateway archives only the frames it sent to the model. They also go through the upload path, which analyses image batches, while live use may run the native stream. A replayed false alarm is a regression case, not a reproduction of the live session.
