/**
 * Pure, synchronous evidence metadata for ONE camera/incident lifetime. No clocks,
 * image bytes, I/O or storage deletion. Accept normalizeObservation() results from
 * observations.js, never raw detector payloads. Initialize before first detection.
 *
 * API:
 * - createEvidenceState() -> versioned JSON-serializable state.
 * - appendEvidence(state, observation, snapshot_key = null, local_ref = null)
 *     -> {state, accepted, reason, retired_keys}.
 *   Only pass a key for an actually available snapshot (1..512 characters); null
 *   means missing. Keys must be unique among retained frames. Event time must be
 *   strictly increasing. Rejection is a no-op; an unused valid incoming key is
 *   returned for cleanup, but a key still retained by state is NEVER retired.
 * - selectEvidence(state) -> deeply frozen frame array (maximum six).
 * - selectLaterEvidence(state, after_ts_ms, source_ts_ms) -> a fresh, time-spread
 *   post-confirmation pack for the single bounded scene follow-up, or null.
 * - protectEvidence(state) -> {state, selection}; pins one frozen manifest until
 *   archive completion. Repeated calls return the original selection, not a new
 *   in-flight job. Persist the returned state before asynchronous storage work.
 * - releaseEvidence(state, {archived: true}|{completed: true}) -> {state, retired_keys: []}.
 *   Explicit archive/job completion removes protection, not retained snapshots;
 *   subsequent append calls retire them under the normal policy.
 *
 * State holds <=120 compact observation summaries and <=24 snapshot references
 * INCLUDING protected evidence, plus constant-size onset/peak/latest aggregates.
 * pre_onset holds the last two accepted observations before first observed fire;
 * it is frozen in time once onset is seen, not labeled verified pre-ignition.
 * onset_successor is the first accepted observation after onset, if one exists.
 * Retention anchors the oldest two available snapshots, onset, its immediate
 * predecessor/successor, observed peak and one protected selection. Before onset,
 * the last two observations' snapshots are anchored instead. Remaining slots
 * hold recent snapshots. Missing adjacent images are not replaced. Adapters must
 * delete retired_keys themselves, AFTER persisting the returned state. Do not
 * accumulate retired-key lists inside this state. JSON round-trip restoration
 * needs no class constructor; only use states produced here, not arbitrary input.
 *
 * Onset means first observed weak/strong FIRE evidence, not verified ignition.
 * Peak means greatest measured normalized bbox footprint OBSERVED SO FAR, with
 * the first timestamp winning ties; confidence/visibility/reliability are retained
 * in the aggregate. Even an unreliable measurement is not silently discarded or
 * made reliable. No frame is guaranteed to precede ignition or a future maximum.
 * Missing onset/peak snapshots are omitted, never replaced by a convenient frame.
 * Selection merges roles at equal timestamps and sorts chronologically. Roles:
 * early, context_before_onset, onset, context_after_onset, peak, recent. If all
 * seven candidates differ, omit the second early frame to keep at most six.
 * Context roles mean adjacent accepted observations, not actual ignition timing.
 * 'recent' is latest AVAILABLE snapshot, which may precede the latest observation.
 *
 * Each selected frame has {frame_id: 'frame-'+ts_ms, ts_ms, snapshot_key?, local_ref?, roles,
 * pre_ignition_verified: false, peak_scope: 'observed_so_far'|null, fire_evidence,
 * smoke_evidence, confidence, area_px, area_fraction, area_reliable, visibility,
 * frame_wh?: [width,height]}. confidence/areas/reliability are FIRE measurements,
 * not physical hazard, ignition causation, segmentation or calibrated certainty.
 * frame_wh and roles are copied and frozen, including after JSON restoration.
 * No arbitrary caller/model metadata, scene labels or fabricated crop IDs escape.
 *
 * Pi-storage adapter: store transient full-frame bytes under snap:<ts_ms>, pass
 * that key only when present, append, persist returned state, then prune exactly
 * retired_keys from the transient map (never from permanent Pi incident files).
 * At confirmation protectEvidence(), persist its state, and use its selection
 * unchanged for one incident/job's image/metadata pairing. If bytes disappeared
 * (e.g. cold restart), omit that frame AND its metadata; never borrow another
 * frame's image/role. This pure helper pins references, not image bytes or I/O.
 * Keep protection until the caller's archive/job acknowledgement; release does
 * not delete images immediately. Later appends perform bounded retirement.
 * State lifetime/reset, incident IDs, retention age, archive I/O and retry policy
 * belong to the caller. Archive/release before discarding a lifetime's state.
 */
const HISTORY_LIMIT = 120;
const SNAPSHOT_LIMIT = 24;

/** At most six chronological frames; adjacent onset context outranks second early. */
export function selectEvidence(state) {
  const selected = new Map();
  function add(frame, role) {
    if (!frame) return;
    let entry = selected.get(frame.ts_ms);
    if (!entry) {
      entry = { ...frame, frame_id: `frame-${frame.ts_ms}`,
        roles: [], pre_ignition_verified: false, peak_scope: null };
      selected.set(frame.ts_ms, entry);
    }
    if (!entry.roles.includes(role)) entry.roles.push(role);
    if (role === 'peak') entry.peak_scope = 'observed_so_far';
  }
  state.snapshots.slice(0, 2).forEach((frame) => add(frame, 'early'));
  if (state.onset) add(state.snapshots.find((frame) =>
    frame.ts_ms === state.pre_onset?.at(-1)?.ts_ms), 'context_before_onset');
  add(state.snapshots.find((frame) => frame.ts_ms === state.onset?.ts_ms), 'onset');
  add(state.snapshots.find((frame) =>
    frame.ts_ms === state.onset_successor?.ts_ms), 'context_after_onset');
  add(state.snapshots.find((frame) => frame.ts_ms === state.peak?.ts_ms), 'peak');
  add(state.snapshots.at(-1), 'recent');
  // Seven distinct candidates are possible. Adjacent context outranks the
  // second oldest frame; if it carries another role, there are at most six.
  if (selected.size > 6) selected.delete(state.snapshots[1].ts_ms);
  return freezeSelection([...selected.values()].sort((a, b) => a.ts_ms - b.ts_ms));
}

/**
 * Select a distinct later scene sequence, not another copy of the onset pack.
 * Require three available images spanning two seconds and a recent last image;
 * spread at most six images across the latest six seconds. These are sampling
 * requirements for temporal scene review, not proof that any image is safe.
 */
export function selectLaterEvidence(state, after_ts_ms, source_ts_ms) {
  if (!Number.isFinite(after_ts_ms) || !Number.isFinite(source_ts_ms) || source_ts_ms <= after_ts_ms) return null;
  const later = state.snapshots.filter(frame => frame.ts_ms > after_ts_ms && frame.ts_ms <= source_ts_ms);
  const latest = later.at(-1);
  if (!latest || source_ts_ms - latest.ts_ms > 1500) return null;
  const candidates = later.filter(frame => frame.ts_ms >= latest.ts_ms - 6000);
  if (candidates.length < 3 || candidates.at(-1).ts_ms - candidates[0].ts_ms < 2000) return null;
  const count = Math.min(6, candidates.length);
  const chosen = [];
  let firstAvailable = 0;
  for (let index = 0; index < count; index++) {
    const remaining = count - index - 1;
    const lastAvailable = candidates.length - remaining - 1;
    const targetTs = candidates[0].ts_ms + (candidates.at(-1).ts_ms - candidates[0].ts_ms) * index / (count - 1);
    let candidateIndex = firstAvailable;
    for (let cursor = firstAvailable + 1; cursor <= lastAvailable; cursor++) {
      if (Math.abs(candidates[cursor].ts_ms - targetTs) < Math.abs(candidates[candidateIndex].ts_ms - targetTs)) {
        candidateIndex = cursor;
      }
    }
    chosen.push(candidates[candidateIndex]);
    firstAvailable = candidateIndex + 1;
  }
  if (chosen.at(-1).ts_ms - chosen[0].ts_ms < 2000) return null;
  return freezeSelection(chosen.map((frame, index) => {
    const roles = [...(frame.roles ?? [])];
    if (state.peak?.ts_ms === frame.ts_ms) roles.push('peak');
    roles.push('followup_context');
    if (index === chosen.length - 1) roles.push('recent');
    const uniqueRoles = [...new Set(roles)];
    return {...frame, frame_id:`frame-${frame.ts_ms}`, roles:uniqueRoles,
      pre_ignition_verified:false, peak_scope:uniqueRoles.includes('peak')?'observed_so_far':null};
  }));
}

function freezeSelection(selection) {
  return Object.freeze(selection.slice(0, 6)
    .map((frame) => Object.freeze({ ...frame,
      ...(frame.frame_wh ? { frame_wh: Object.freeze([...frame.frame_wh]) } : {}),
      ...(frame.local_ref ? {local_ref:Object.freeze({...frame.local_ref})} : {}),
      roles: Object.freeze([...frame.roles]),
    })));
}

/** Capture at most one in-flight manifest; repeated calls preserve its exact frames. */
export function protectEvidence(state) {
  const selection = state.protected_selection === null ? selectEvidence(state) :
    freezeSelection(state.protected_selection);
  return { state: { ...state, protected_selection: selection }, selection };
}

/** A completed inference pack is not an acknowledgement of permanent Pi archival. */
export function releaseEvidence(state, { archived = false, completed = false } = {}) {
  if (archived !== true && completed !== true) throw new Error('Evidence must be archived or its job completed before release');
  return { state: { ...state, protected_selection: null }, retired_keys: [] };
}

export function createEvidenceState() {
  return {
    version: 1, history: [], snapshots: [], onset: null, peak: null, latest: null,
    pre_onset: [], onset_successor: null, protected_selection: null,
  };
}

function nullableNumber(value, maximum = Infinity) {
  return value === null || (Number.isFinite(value) && value >= 0 && value <= maximum);
}

function validObservation(observation) {
  return observation?.observation_valid === true &&
    Number.isFinite(observation.ts_ms) && observation.ts_ms >= 0 &&
    (observation.frame_wh == null || (Array.isArray(observation.frame_wh) &&
      observation.frame_wh.length === 2 &&
      observation.frame_wh.every((value) => Number.isSafeInteger(value) && value > 0) &&
      Number.isSafeInteger(observation.frame_wh[0] * observation.frame_wh[1]))) &&
    ['adequate', 'unknown', 'degraded'].includes(observation.visibility) &&
    ['strong', 'weak', 'not_detected'].includes(observation.fire?.evidence_level) &&
    ['strong', 'weak', 'not_detected'].includes(observation.smoke?.evidence_level) &&
    nullableNumber(observation.fire.confidence, 1) &&
    nullableNumber(observation.fire.area_px) &&
    nullableNumber(observation.fire.area_fraction, 1) &&
    typeof observation.fire.area_reliable === 'boolean';
}

function reject(state, snapshot_key, reason) {
  return {
    state, accepted: false, reason,
    retired_keys: snapshot_key !== null &&
      !state.snapshots.some((frame) => frame.snapshot_key === snapshot_key) ? [snapshot_key] : [],
  };
}

/** Shared retention anchors, including the second early frame omitted by the six-image manifest. */
export function evidenceAnchorKeys(state) {
  const times = new Set(state.snapshots.slice(0, 2).map(frame => frame.ts_ms));
  if (state.onset) {
    times.add(state.onset.ts_ms);
    if (state.pre_onset.length) times.add(state.pre_onset.at(-1).ts_ms);
  } else for (const frame of state.pre_onset) times.add(frame.ts_ms);
  if (state.onset_successor) times.add(state.onset_successor.ts_ms);
  if (state.peak) times.add(state.peak.ts_ms);
  for (const frame of state.protected_selection ?? []) times.add(frame.ts_ms);
  return state.snapshots.filter(frame => times.has(frame.ts_ms) && typeof frame.snapshot_key === 'string')
    .map(frame => frame.snapshot_key);
}

export function appendEvidence(state, observation, snapshot_key = null, local_ref = null) {
  if (snapshot_key !== null &&
      (typeof snapshot_key !== 'string' || snapshot_key.length === 0 || snapshot_key.length > 512)) {
    return reject(state, null, 'invalid_snapshot_key');
  }
  if (local_ref !== null && (!local_ref || typeof local_ref !== 'object' || Array.isArray(local_ref) ||
      Object.keys(local_ref).length !== 4 || typeof local_ref.session_id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(local_ref.session_id) ||
      !Number.isSafeInteger(local_ref.generation) || local_ref.generation < 1 ||
      !Number.isSafeInteger(local_ref.attempt_sequence) || local_ref.attempt_sequence < 1 ||
      typeof local_ref.jpeg_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(local_ref.jpeg_sha256))) {
    return reject(state, snapshot_key, 'invalid_local_image_reference');
  }
  if (!validObservation(observation)) return reject(state, snapshot_key, 'invalid_observation');
  if (state.latest !== null && observation.ts_ms <= state.latest.ts_ms) {
    return reject(state, snapshot_key,
      observation.ts_ms === state.latest.ts_ms ? 'duplicate_timestamp' : 'out_of_order');
  }
  if (snapshot_key !== null && state.snapshots.some((frame) => frame.snapshot_key === snapshot_key)) {
    return reject(state, snapshot_key, 'snapshot_key_reused');
  }
  if (local_ref !== null && state.snapshots.some(frame => frame.local_ref?.session_id === local_ref.session_id &&
      frame.local_ref?.generation === local_ref.generation && frame.local_ref?.attempt_sequence === local_ref.attempt_sequence)) {
    return reject(state, snapshot_key, 'local_image_reference_reused');
  }
  const sample = {
    ts_ms: observation.ts_ms,
    fire_evidence: observation.fire.evidence_level,
    smoke_evidence: observation.smoke.evidence_level,
    confidence: observation.fire.confidence,
    area_px: observation.fire.area_px,
    area_fraction: observation.fire.area_fraction,
    area_reliable: observation.fire.area_reliable,
    visibility: observation.visibility,
    ...(observation.frame_wh ? { frame_wh: [...observation.frame_wh] } : {}),
  };
  const hasFire = sample.fire_evidence === 'strong' || sample.fire_evidence === 'weak';
  const onset = state.onset ?? (hasFire ? sample : null);
  const pre_onset = onset === null ? [...(state.pre_onset ?? []).slice(-1), sample] :
    (state.pre_onset ?? []);
  const onset_successor = state.onset_successor ?? (state.onset ? sample : null);
  const peak = hasFire && sample.area_fraction !== null &&
    (state.peak === null || sample.area_fraction > state.peak.area_fraction) ? sample : state.peak;
  const snapshots = state.snapshots.map((frame) => ({ ...frame }));
  if (snapshot_key !== null || local_ref !== null) snapshots.push({ ...sample,
    ...(sample.frame_wh ? { frame_wh: [...sample.frame_wh] } : {}),
    ...(snapshot_key === null ? {} : {snapshot_key}),
    ...(local_ref === null ? {} : {local_ref: {...local_ref}})});
  const anchorTimes = new Set([...snapshots.slice(0,2).map(frame=>frame.ts_ms),
    ...(onset ? [onset.ts_ms] : []), ...(onset && pre_onset.length ? [pre_onset.at(-1).ts_ms] : []),
    ...(onset_successor ? [onset_successor.ts_ms] : []), ...(peak ? [peak.ts_ms] : []),
    ...(state.protected_selection ?? []).map(frame=>frame.ts_ms)]);
  const retired_keys = [];
  while (snapshots.length > SNAPSHOT_LIMIT) {
    const index = snapshots.findIndex((frame) => !anchorTimes.has(frame.ts_ms));
    const [retired] = snapshots.splice(index, 1);
    if (retired.snapshot_key !== undefined) retired_keys.push(retired.snapshot_key);
  }
  return {
    accepted: true, reason: null, retired_keys,
    state: {
      version: 1,
      history: [...state.history.slice(-(HISTORY_LIMIT - 1)), sample],
      snapshots, onset, peak, latest: sample, pre_onset, onset_successor,
      protected_selection: state.protected_selection === null ? null :
        freezeSelection(state.protected_selection),
    },
  };
}
