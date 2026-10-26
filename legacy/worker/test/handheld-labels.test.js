import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateHandheldCorpus, summarizeHandheldCoverage} from '../../scripts/evaluation/handheld-corpus.mjs';

const baseClip = (overrides = {}) => ({
  video: 'clip.mp4', source_sha256: 'a'.repeat(64), source_identity: 'recording-a',
  split: 'development', categories: [], lighter_only_intervals_ms: null, actionable_intervals_ms: null,
  visible_flame_onset_bounds_ms: null, actionable_onset_bounds_ms: null,
  visibility: 'unknown', reviewer: null, reviewed_camera_policy: null, ...overrides,
});
const corpus = clips => ({version:1, categories:['controlled_lighter','lighter_to_material','uncontrolled_burning',
  'smoke_only','reflection','obscured'], clips});
const categories = ['controlled_lighter','lighter_to_material','uncontrolled_burning',
  'smoke_only','reflection','obscured'];
function reviewedSplit(split, startIndex = 0) {
  return categories.flatMap((category, categoryIndex) => Array.from({length:3}, (_unused, copyIndex) => {
    const index = startIndex + categoryIndex * 3 + copyIndex;
    return baseClip({video:`${split}-${category}-${copyIndex}.mp4`,
      source_sha256:index.toString(16).padStart(64,'0'),source_identity:`${split}-${index}`,
      split,categories:[category],reviewer:`reviewer-${index}`,
      ...(category === 'controlled_lighter' ? {lighter_only_intervals_ms:[{start_ms:100,end_ms:300}]} : {}),
      ...(category === 'lighter_to_material' ? {actionable_intervals_ms:[{start_ms:200,end_ms:400}],
        actionable_onset_bounds_ms:{start_ms:180,end_ms:220}} : {}),
    });
  }));
}

test('corpus rejects copied or re-encoded recordings split across development and held-out', () => {
  assert.throws(() => validateHandheldCorpus(corpus([
    baseClip(), baseClip({split:'held_out',source_sha256:'b'.repeat(64)}),
  ])), /cross-split duplicate source identity/);
  assert.throws(() => validateHandheldCorpus(corpus([
    baseClip(), baseClip({split:'held_out',source_identity:'recording-b',video:'copy.mp4'}),
  ])), /cross-split duplicate source/);
});

test('an actionable interval requires a named independent reviewer and explicit onset bounds', () => {
  assert.throws(() => validateHandheldCorpus(corpus([baseClip({
    actionable_intervals_ms:[{start_ms:100,end_ms:200}],
  })])), /reviewer required/);
});

test('hazardous lighter-to-material labels require a nonempty actionable interval and onset bounds', () => {
  const transition = {categories:['lighter_to_material'],reviewer:'reviewer-1'};
  for (const labels of [
    {actionable_intervals_ms:null,actionable_onset_bounds_ms:null},
    {actionable_intervals_ms:[],actionable_onset_bounds_ms:{start_ms:100,end_ms:120}},
    {actionable_intervals_ms:[{start_ms:100,end_ms:200}],actionable_onset_bounds_ms:null},
  ]) {
    assert.throws(() => validateHandheldCorpus(corpus([baseClip({...transition,...labels})])),
      /lighter_to_material requires a nonempty actionable interval and onset bounds/);
  }
});

test('model selection coverage requires three reviewed clips per category in both data splits', () => {
  const heldOutOnly=summarizeHandheldCoverage(corpus(reviewedSplit('held_out')));
  assert.equal(heldOutOnly.held_out_clip_count,18);
  assert.equal(heldOutOnly.held_out_coverage_complete,true);
  assert.equal(heldOutOnly.development_coverage_complete,false);
  assert.equal(heldOutOnly.release_ready,false);

  const complete=summarizeHandheldCoverage(corpus([
    ...reviewedSplit('development'),...reviewedSplit('held_out',18),
  ]));
  assert.equal(complete.development_coverage_complete,true);
  assert.equal(complete.held_out_coverage_complete,true);
  assert.equal(complete.release_ready,true);
});

test('copies and re-encodings within one split cannot inflate coverage or exposure', () => {
  for (const split of ['development','held_out']) {
    const original=baseClip({split});
    assert.throws(()=>summarizeHandheldCoverage(corpus([original,
      {...original,video:'copy.mp4',source_identity:'different-name'}])),/duplicate source hash/);
    assert.throws(()=>summarizeHandheldCoverage(corpus([original,
      {...original,video:'reencoded.mp4',source_sha256:'b'.repeat(64)}])),/duplicate source identity/);
  }
});

test('contradictory lighter-only and actionable labels may not overlap', () => {
  assert.throws(() => validateHandheldCorpus(corpus([baseClip({reviewer:'reviewer-1',
    lighter_only_intervals_ms:[{start_ms:100,end_ms:250}],
    actionable_intervals_ms:[{start_ms:200,end_ms:300}],
  })])), /contradictory overlapping intervals/);
});

test('unmeasured labels stay null and missing held-out categories block the release gate', () => {
  const validated=validateHandheldCorpus(corpus([baseClip()]));
  assert.equal(validated.clips[0].actionable_intervals_ms,null);
  const coverage=summarizeHandheldCoverage(validated);
  assert.equal(coverage.release_ready,false);
  assert.ok(coverage.missing_held_out_categories.length > 0);
  assert.equal(coverage.lighter_to_material_held_out_count,0);
});

test('checked-in handheld corpus contains only the three unreviewed development recordings', () => {
  const source=JSON.parse(readFileSync(new URL('../../scripts/evaluation/handheld-priority-corpus.json',import.meta.url),'utf8'));
  const validated=validateHandheldCorpus(source);
  assert.equal(validated.clips.length,3);
  assert.ok(validated.clips.every(clip=>clip.split==='development' && clip.reviewer===null &&
    clip.lighter_only_intervals_ms===null && clip.actionable_intervals_ms===null));
  assert.equal(summarizeHandheldCoverage(validated).release_ready,false);
});
