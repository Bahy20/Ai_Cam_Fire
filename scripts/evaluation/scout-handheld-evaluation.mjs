const REVIEW_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function buildScoutHandheldEvaluationProfile({annotations, cameraPrefix, reviewedAtMs} = {}) {
  if (!annotations || typeof annotations !== 'object' || !Array.isArray(annotations.clips) ||
      !/^[A-Za-z0-9_-]{1,56}$/.test(cameraPrefix ?? '') ||
      !Number.isSafeInteger(reviewedAtMs) || reviewedAtMs <= 0 ||
      !Number.isSafeInteger(reviewedAtMs + REVIEW_MAX_AGE_MS)) {
    throw new Error('invalid_handheld_evaluation_profile');
  }

  if (annotations.version !== 1 || typeof annotations.annotation_scope !== 'string' ||
      annotations.annotation_scope.trim() === '' || annotations.clips.length !== 3) {
    throw new Error('complete_three_clip_labels_required');
  }

  const contained = annotations.clips.flatMap((clip, index) =>
    clip?.category === 'contained' ? [index] : []);
  if (contained.length !== 1) throw new Error('exactly_one_contained_clip_required');

  const names = new Set();
  const hashes = new Set();
  for (const clip of annotations.clips) {
    const validFilename = typeof clip?.video === 'string' && clip.video.trim() !== '' &&
      clip.video === clip.video.trim() && !/[\\/\0]/.test(clip.video) &&
      /\.mp4$/i.test(clip.video);
    const validHash = typeof clip?.source_sha256 === 'string' &&
      /^[a-f0-9]{64}$/i.test(clip.source_sha256);
    const identity = validFilename ? clip.video.toLowerCase() : '';
    const hash = validHash ? clip.source_sha256.toLowerCase() : '';
    if (validFilename && validHash && (names.has(identity) || hashes.has(hash))) {
      throw new Error('duplicate_development_clip_identity');
    }
    if (!validFilename || !validHash || clip.source_provenance !== 'user_supplied_local' ||
        clip.split !== 'development' || clip.status !== 'available' ||
        !['material', 'contained'].includes(clip.category) || clip.fire_present !== true ||
        clip.visible_flame_present !== true || clip.priority_expected !== 'inspect_urgently' ||
        clip.accepted_cause_expected !== 'unknown') {
      throw new Error('invalid_complete_development_clip');
    }
    if (clip.category === 'material' && clip.actionable_fire_present !== true) {
      throw new Error('invalid_complete_development_clip');
    }
    if (clip.category === 'contained' && (clip.actionable_fire_present !== null ||
        clip.scene_expected !== 'contained_tool_flame')) {
      throw new Error('invalid_complete_development_clip');
    }
    names.add(identity);
    hashes.add(hash);
  }
  if (annotations.clips.filter(clip => clip.category === 'material').length !== 2) {
    throw new Error('invalid_complete_development_clip');
  }

  const targetIndex = contained[0];
  const target = annotations.clips[targetIndex];
  if (target.status !== 'available' || target.visible_flame_present !== true ||
      target.priority_expected !== 'inspect_urgently' ||
      target.scene_expected !== 'contained_tool_flame') {
    throw new Error('contained_clip_labels_do_not_support_handheld_evaluation');
  }

  const cameraId = `${cameraPrefix}-${targetIndex}`;
  const cameraContexts = {
    [cameraId]: {
      reviewed:true,
      reviewed_by:'development-fixture',
      reviewed_at_ms:reviewedAtMs,
      review_expires_at_ms:reviewedAtMs + REVIEW_MAX_AGE_MS,
      occupied_area:false,
      known_hazards:[],
      critical_zones:[],
      expected_handheld_flame_use:true,
    },
  };
  const clips = annotations.clips.map((clip, index) => index === targetIndex ? {
    ...clip,
    interval_priority_expected:'monitor',
    scene_expected:'contained_tool_flame',
  } : {...clip});

  return {
    cameraId,
    cameraContexts,
    annotations:{...annotations, clips},
  };
}
