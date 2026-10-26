/**
 * Estimate visual footprint activity, not physical spread, extinction, or hazard.
 *
 * Input: a caller-selected recent history of observations
 * { ts: number (event-time milliseconds), area_ratio: number (frame fraction
 * in [0, 1]), reliable: boolean, camera_motion?: boolean|null,
 * visibility?: 'adequate'|'unknown'|'degraded' }.
 * Only reliable === true observations are eligible; omitted observations are
 * not synthesized. The caller must establish reliability from detector evidence.
 * Supply a bounded, recent window from one camera/scene; this helper does not
 * choose a lookback window or detect unreported gaps/motion. A true motion flag
 * or explicit degraded visibility anywhere in that window invalidates the result,
 * even on an excluded sample. Callers must preserve those warnings in history.
 *
 * At least three distinct eligible event times spanning >= 2000 ms are needed.
 * Duplicate eligible times are averaged (one vote per timestamp); sample_count
 * counts these distinct times, including when an estimate is unavailable.
 * Missing/invalid/unreliable samples are excluded, never coerced into zero.
 * Missing visibility defaults to unknown, never adequate. Unverified visibility
 * permits only positive area and limits confidence to low; these footprints
 * measure only observed box change, never absence, extinction, or safety.
 * Exclusions and duplicate times lower confidence; insufficient support or
 * invalidating motion/visibility yields unknown, null rate, and low confidence.
 * Explicit reliable zero remains supported only with adequate visibility; a
 * detector miss is never such a measurement. No output establishes clearance.
 *
 * options.slope_threshold_per_s defaults to 0.001 frame fraction/second.
 * It must be a finite nonnegative number (otherwise throws RangeError).
 * Rates strictly above/below +/- threshold are growing/shrinking; others steady.
 *
 * Output rates are frame fractions per second. Confidence is at most medium:
 * this is an uncalibrated visual-area estimate, not a safety assessment.
 * Returns { visual_activity: 'growing'|'steady'|'shrinking'|'unknown',
 * normalized_rate_per_s: number|null, confidence: 'low'|'medium',
 * sample_count: number, limitations: string[] }.
 */
export function estimateTrend(history, options = {}) {
  const threshold = options.slope_threshold_per_s === undefined ? 0.001 : options.slope_threshold_per_s;
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new RangeError('slope_threshold_per_s must be a finite nonnegative number');
  }
  const limitations = ['visual_footprint_not_physical_growth_or_hazard',
    'footprint_change_not_extinction_or_safety'];
  const grouped = new Map();
  let invalid = false;
  let unreliable = false;
  let duplicates = false;
  let motion = false;
  let visibilityUnverified = false;
  let degradedVisibility = false;
  if (!Array.isArray(history)) {
    limitations.push('invalid_history');
    history = [];
  }
  for (const sample of history) {
    // Warnings remain relevant even on an excluded/missing sample.
    if (sample?.camera_motion === true) motion = true;
    const visibility = sample?.visibility === undefined ? 'unknown' : sample.visibility;
    if (visibility === 'unknown') visibilityUnverified = true;
    if (visibility === 'degraded') degradedVisibility = true;
    if (!sample || typeof sample !== 'object' || Array.isArray(sample)
      || !['adequate', 'unknown', 'degraded'].includes(visibility)
      || !Number.isFinite(sample.ts) || !Number.isFinite(sample.area_ratio)
      || sample.area_ratio < 0 || sample.area_ratio > 1) {
      invalid = true;
      continue;
    }
    if (sample.reliable !== true || visibility === 'degraded' ||
      (visibility === 'unknown' && sample.area_ratio === 0)) {
      unreliable = true;
      continue;
    }
    const group = grouped.get(sample.ts);
    if (group) {
      // Incremental mean avoids an unbounded sum of duplicate ratios.
      group.count++;
      group.area_ratio += (sample.area_ratio - group.area_ratio) / group.count;
      duplicates = true;
    } else {
      grouped.set(sample.ts, { ts: sample.ts, area_ratio: sample.area_ratio, count: 1 });
    }
  }
  if (invalid) limitations.push('invalid_observations_excluded');
  if (unreliable) limitations.push('unreliable_observations_excluded');
  if (duplicates) limitations.push('duplicate_timestamps_averaged');
  if (visibilityUnverified) limitations.push('visibility_unverified');
  const samples = [...grouped.values()].sort((a, b) => a.ts - b.ts);
  const unknown = {
    visual_activity: 'unknown',
    normalized_rate_per_s: null,
    confidence: 'low',
    sample_count: samples.length,
    limitations,
  };
  if (samples.length < 3) {
    limitations.push('insufficient_distinct_timestamps');
  }
  if (motion) {
    limitations.push('camera_motion');
  }
  if (degradedVisibility) limitations.push('degraded_visibility');
  if (samples.length < 3 || motion || degradedVisibility) return unknown;
  if (samples[samples.length - 1].ts - samples[0].ts < 2000) {
    limitations.push('insufficient_time_support');
    return unknown;
  }
  // Shift before centering: subtracting large absolute event-time squares
  // causes catastrophic cancellation on ordinary epoch timestamps.
  const times = samples.map((sample) => (sample.ts - samples[0].ts) / 1000);
  const meanTime = times.reduce((sum, time) => sum + time, 0) / times.length;
  const meanArea = samples.reduce((sum, sample) => sum + sample.area_ratio, 0) / samples.length;
  let covariance = 0;
  let variance = 0;
  for (let i = 0; i < samples.length; i++) {
    const deltaTime = times[i] - meanTime;
    covariance += deltaTime * (samples[i].area_ratio - meanArea);
    variance += deltaTime * deltaTime;
  }
  const rate = covariance / variance;
  if (!Number.isFinite(rate) || !Number.isFinite(variance) || variance <= 0) {
    limitations.push('unstable_time_support');
    return unknown;
  }
  return {
    visual_activity: rate > threshold ? 'growing' : rate < -threshold ? 'shrinking' : 'steady',
    normalized_rate_per_s: rate,
    confidence: invalid || unreliable || duplicates || visibilityUnverified ? 'low' : 'medium',
    sample_count: samples.length,
    limitations,
  };
}
