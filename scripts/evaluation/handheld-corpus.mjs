const CATEGORIES = Object.freeze(['controlled_lighter', 'lighter_to_material', 'uncontrolled_burning',
  'smoke_only', 'reflection', 'obscured']);
const CORPUS_FIELDS = ['version', 'categories', 'clips'];
const CLIP_FIELDS = ['video', 'source_sha256', 'source_identity', 'split', 'categories',
  'lighter_only_intervals_ms', 'actionable_intervals_ms', 'visible_flame_onset_bounds_ms',
  'actionable_onset_bounds_ms', 'visibility', 'reviewer', 'reviewed_camera_policy'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, fields) => record(value) && Object.keys(value).length === fields.length &&
  fields.every(field => Object.hasOwn(value, field));
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const nonempty = (value, max = 160) => typeof value === 'string' && value.trim().length > 0 &&
  value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

function validateIntervals(value, field) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 256) throw new TypeError(`${field}: expected null or bounded interval array`);
  let end = -1;
  return value.map((interval, index) => {
    if (!exact(interval, ['start_ms', 'end_ms']) || !Number.isSafeInteger(interval.start_ms) ||
        !Number.isSafeInteger(interval.end_ms) || interval.start_ms < 0 || interval.end_ms <= interval.start_ms ||
        interval.start_ms < end) throw new TypeError(`${field}[${index}]: invalid or overlapping interval`);
    end = interval.end_ms;
    return {start_ms:interval.start_ms, end_ms:interval.end_ms};
  });
}

function validateBounds(value, field) {
  if (value === null) return null;
  if (!exact(value, ['start_ms', 'end_ms']) || !Number.isSafeInteger(value.start_ms) ||
      !Number.isSafeInteger(value.end_ms) || value.start_ms < 0 || value.end_ms < value.start_ms) {
    throw new TypeError(`${field}: invalid onset bounds`);
  }
  return {start_ms:value.start_ms, end_ms:value.end_ms};
}

function overlaps(left, right) {
  return left.some(a => right.some(b => Math.max(a.start_ms, b.start_ms) < Math.min(a.end_ms, b.end_ms)));
}

/** Strictly validate independent video labels; null remains unmeasured, never negative. */
export function validateHandheldCorpus(value) {
  if (!exact(value, CORPUS_FIELDS) || value.version !== 1 || !Array.isArray(value.categories) ||
      value.categories.length !== CATEGORIES.length || !value.categories.every((item, index) => item === CATEGORIES[index]) ||
      !Array.isArray(value.clips) || value.clips.length > 10_000) throw new TypeError('invalid handheld corpus');
  const clips = value.clips.map((clip, index) => {
    if (!exact(clip, CLIP_FIELDS) || !nonempty(clip.video) || !digest(clip.source_sha256) ||
        !nonempty(clip.source_identity) || !['development', 'held_out'].includes(clip.split) ||
        !Array.isArray(clip.categories) || clip.categories.length > CATEGORIES.length ||
        !clip.categories.every(category => CATEGORIES.includes(category)) || new Set(clip.categories).size !== clip.categories.length ||
        !['adequate', 'unknown', 'degraded'].includes(clip.visibility) ||
        !(clip.reviewer === null || nonempty(clip.reviewer, 120)) ||
        !(clip.reviewed_camera_policy === null || typeof clip.reviewed_camera_policy === 'boolean')) {
      throw new TypeError(`clips[${index}]: invalid identity or metadata`);
    }
    const lighter = validateIntervals(clip.lighter_only_intervals_ms, `clips[${index}].lighter_only_intervals_ms`);
    const actionable = validateIntervals(clip.actionable_intervals_ms, `clips[${index}].actionable_intervals_ms`);
    const visibleBounds = validateBounds(clip.visible_flame_onset_bounds_ms, `clips[${index}].visible_flame_onset_bounds_ms`);
    const actionableBounds = validateBounds(clip.actionable_onset_bounds_ms, `clips[${index}].actionable_onset_bounds_ms`);
    if (actionable !== null && clip.reviewer === null) throw new TypeError(`clips[${index}]: reviewer required for actionable label`);
    if (clip.categories.includes('lighter_to_material') &&
        (!actionable?.length || actionableBounds === null)) {
      throw new TypeError(`clips[${index}]: lighter_to_material requires a nonempty actionable interval and onset bounds`);
    }
    if (clip.reviewer === null && (clip.categories.length || lighter !== null || visibleBounds !== null ||
        actionableBounds !== null || clip.reviewed_camera_policy !== null)) {
      throw new TypeError(`clips[${index}]: reviewer required for measured labels`);
    }
    if (lighter !== null && actionable !== null && overlaps(lighter, actionable)) {
      throw new TypeError(`clips[${index}]: contradictory overlapping intervals`);
    }
    return {...clip, source_sha256:clip.source_sha256.toLowerCase(), categories:[...clip.categories],
      lighter_only_intervals_ms:lighter, actionable_intervals_ms:actionable,
      visible_flame_onset_bounds_ms:visibleBounds, actionable_onset_bounds_ms:actionableBounds};
  });
  const seenHashes = new Map();
  const seenIdentities = new Map();
  for (let index = 0; index < clips.length; index++) {
    const clip = clips[index];
    for (const [key, map, kind] of [['hash', seenHashes, 'source hash'],
      ['identity', seenIdentities, 'source identity']]) {
      const value = key === 'hash' ? clip.source_sha256 : clip.source_identity.toLowerCase();
      const prior = map.get(value);
      if (prior && prior.split !== clip.split) throw new TypeError(`cross-split duplicate ${kind}`);
      if (prior) throw new TypeError(`duplicate ${kind} within ${clip.split}`);
      map.set(value, clip);
    }
  }
  return {version:1, categories:[...CATEGORIES], clips};
}

/** Count only named human-reviewed labels; both development and held-out coverage gate selection. */
export function summarizeHandheldCoverage(corpus) {
  const validated = validateHandheldCorpus(corpus);
  const summarizeSplit = split => {
    const clips = validated.clips.filter(clip => clip.split === split && clip.reviewer !== null);
    const counts = Object.fromEntries(CATEGORIES.map(category => [category,
      clips.filter(clip => clip.categories.includes(category)).length]));
    const missing = CATEGORIES.filter(category => counts[category] < 3);
    const transitions = clips.filter(clip => clip.categories.includes('lighter_to_material') &&
      clip.actionable_intervals_ms?.length > 0 && clip.actionable_onset_bounds_ms !== null).length;
    const controlledExposureMs = clips.reduce((total, clip) => clip.categories.includes('controlled_lighter') &&
      clip.lighter_only_intervals_ms !== null ? total + clip.lighter_only_intervals_ms.reduce((sum, interval) =>
        sum + interval.end_ms - interval.start_ms, 0) : total, 0);
    return {clip_count:clips.length, category_counts:counts, missing_categories:missing,
      transition_count:transitions, controlled_exposure_ms:controlledExposureMs};
  };
  const development = summarizeSplit('development');
  const heldOut = summarizeSplit('held_out');
  const developmentComplete = development.missing_categories.length === 0 &&
    development.transition_count >= 3 && development.controlled_exposure_ms > 0;
  const heldOutComplete = heldOut.missing_categories.length === 0 &&
    heldOut.transition_count >= 3 && heldOut.controlled_exposure_ms > 0;
  return {
    development_clip_count:development.clip_count,
    development_category_counts:development.category_counts,
    missing_development_categories:development.missing_categories,
    lighter_to_material_development_count:development.transition_count,
    controlled_lighter_development_exposure_ms:development.controlled_exposure_ms,
    development_coverage_complete:developmentComplete,
    held_out_clip_count:heldOut.clip_count,
    held_out_category_counts:heldOut.category_counts,
    missing_held_out_categories:heldOut.missing_categories,
    lighter_to_material_held_out_count:heldOut.transition_count,
    controlled_lighter_exposure_ms:heldOut.controlled_exposure_ms,
    held_out_coverage_complete:heldOutComplete,
    release_ready:developmentComplete && heldOutComplete,
  };
}
