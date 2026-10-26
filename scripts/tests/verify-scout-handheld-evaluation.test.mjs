import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import test from 'node:test';
import {isReviewedHandheldUseContext, parseCameraContexts} from '../../worker/src/site-context.js';

const {buildScoutHandheldEvaluationProfile} = await import(
  '../evaluation/scout-handheld-evaluation.mjs'
).catch(() => ({}));
const {buildVerifierRuntimeEnv} = await import(
  '../evaluation/wrangler-runtime-env.mjs'
).catch(() => ({}));

const annotationDoc = JSON.parse(fs.readFileSync(
  new URL('../evaluation/analysis-policy-labels.json', import.meta.url), 'utf8'));
const labels = annotationDoc.clips;

test('builds an explicit, expiring handheld-only development evaluation profile', () => {
  assert.equal(typeof buildScoutHandheldEvaluationProfile, 'function');

  const reviewedAtMs = 1792430000000;
  const profile = buildScoutHandheldEvaluationProfile({
    annotations:annotationDoc,
    cameraPrefix:'eval-run',
    reviewedAtMs,
  });

  assert.equal(profile.cameraId, 'eval-run-2');
  assert.deepEqual(profile.cameraContexts, {
    'eval-run-2': {
      reviewed:true,
      reviewed_by:'development-fixture',
      reviewed_at_ms:reviewedAtMs,
      review_expires_at_ms:reviewedAtMs + 30 * 24 * 60 * 60 * 1000,
      occupied_area:false,
      known_hazards:[],
      critical_zones:[],
      expected_handheld_flame_use:true,
    },
  });
  assert.equal(profile.annotations.clips[2].priority_expected, 'inspect_urgently');
  assert.equal(profile.annotations.clips[2].interval_priority_expected, 'monitor');
  assert.equal(profile.annotations.clips[2].scene_expected, 'contained_tool_flame');
  assert.equal('interval_priority_expected' in profile.annotations.clips[0], false);
  assert.equal('interval_priority_expected' in profile.annotations.clips[1], false);
  assert.equal('interval_priority_expected' in annotationDoc.clips[2], false);

  const parsed = parseCameraContexts(JSON.stringify(profile.cameraContexts));
  assert.equal(isReviewedHandheldUseContext(parsed[profile.cameraId], profile.cameraId,
    reviewedAtMs + 1000, reviewedAtMs + 1000), true);
});

test('rejects a missing or ambiguous contained-flame clip', () => {
  assert.equal(typeof buildScoutHandheldEvaluationProfile, 'function');
  assert.throws(() => buildScoutHandheldEvaluationProfile({
    annotations:{...annotationDoc, clips:labels.slice(0, 2)}, cameraPrefix:'eval-run', reviewedAtMs:1792430000000,
  }), /complete_three_clip_labels_required/);
  assert.throws(() => buildScoutHandheldEvaluationProfile({
    annotations:{...annotationDoc, clips:labels.map((clip, index) => index === 0 ?
      {...clip, category:'contained', actionable_fire_present:null,
        scene_expected:'contained_tool_flame'} : clip)},
    cameraPrefix:'eval-run', reviewedAtMs:1792430000000,
  }), /exactly_one_contained_clip_required/);
});

test('applies the monitor expectation only to the project lighter clip', () => {
  const current = JSON.parse(fs.readFileSync(
    new URL('../evaluation/analysis-policy-labels.json', import.meta.url), 'utf8'));
  const profile = buildScoutHandheldEvaluationProfile({
    annotations:current,
    cameraPrefix:'current-run',
    reviewedAtMs:1792430000000,
  });

  assert.equal(profile.annotations.clips.length, 3);
  assert.deepEqual(profile.annotations.clips.map(clip => clip.interval_priority_expected),
    [undefined, undefined, 'monitor']);
  assert.equal(profile.annotations.clips[2].priority_expected, 'inspect_urgently');
  assert.equal(profile.annotations.clips[2].scene_expected, 'contained_tool_flame');
});

test('rejects a malformed material sibling and a duplicate source identity', () => {
  const current = annotationDoc;
  const options = {cameraPrefix:'current-run', reviewedAtMs:1792430000000};

  assert.throws(() => buildScoutHandheldEvaluationProfile({
    ...options,
    annotations:{...current, clips:current.clips.map((clip, index) => index === 0 ?
      {...clip, priority_expected:'monitor'} : clip)},
  }), /invalid_complete_development_clip/);
  assert.throws(() => buildScoutHandheldEvaluationProfile({
    ...options,
    annotations:{...current, clips:current.clips.map((clip, index) => index === 1 ?
      {...clip, source_sha256:current.clips[0].source_sha256} : clip)},
  }), /duplicate_development_clip_identity/);
});

test('directs Wrangler logs into the run output while preserving remote authentication env', () => {
  assert.equal(typeof buildVerifierRuntimeEnv, 'function');
  const outputDirectory = path.resolve('E:/coding/fire/.hermes/run-output');
  const remoteEnv = buildVerifierRuntimeEnv({
    baseEnv:{WRANGLER_LOG_PATH:'C:/outside/writable/root', CLOUDFLARE_API_TOKEN:'provided'},
    outputDirectory,
    localKey:'local-ingest-key',
    remote:true,
  });

  assert.equal(remoteEnv.WRANGLER_LOG_PATH, path.join(outputDirectory, 'wrangler-logs'));
  assert.equal(remoteEnv.CLOUDFLARE_API_TOKEN, 'provided');
  assert.equal(remoteEnv.INGEST_API_KEY, 'local-ingest-key');
  assert.equal('XDG_CONFIG_HOME' in remoteEnv, false);
});

test('documents the opt-in live Scout evaluation command', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts/verify_quality_runtime.mjs'), '--help',
  ], {cwd:root, encoding:'utf8'});

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--scout-handheld-evaluation/);
});

test('requires the full bounded remote batch and probe skip before creating output', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fireguard-eval-'));
  try {
    const now = Date.now();
    const utcDay = new Date(now).toISOString().slice(0, 10);
    const usageThroughMs = Date.parse(`${utcDay}T00:00:00.000Z`);
    const snapshotFile = path.join(temp, 'allowance.json');
    const out = path.join(temp, 'out');
    fs.writeFileSync(snapshotFile, JSON.stringify({
      version:1,
      source:'cloudflare_workers_ai_dashboard',
      model:'@cf/meta/llama-4-scout-17b-16e-instruct',
      utc_day:utcDay,
      remaining_neurons:10000,
      observed_at_ms:now,
      usage_through_ms:usageThroughMs,
    }));

    const result = spawnSync(process.execPath, [
      path.join(root, 'scripts/verify_quality_runtime.mjs'),
      '--out', out,
      '--attachments', temp,
      '--remote-ai',
      '--allowance-snapshot', snapshotFile,
      '--scout-handheld-evaluation',
    ], {cwd:root, encoding:'utf8'});

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /scout_handheld_evaluation_requires_remote_all_clips_without_probe/);
    assert.equal(fs.existsSync(out), false);
  } finally {
    fs.rmSync(temp, {recursive:true, force:true});
  }
});

test('rejects changed annotated footage before creating output or starting Wrangler', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fireguard-hash-preflight-'));
  const attachments = path.join(temp, 'attachments');
  const out = path.join(temp, 'out');
  fs.mkdirSync(attachments);
  try {
    for (const clip of annotationDoc.clips) {
      const alias = clip.video.replace(/-3(?=\.mp4$)/, '');
      fs.writeFileSync(path.join(attachments, alias), 'fixture bytes, not the annotated source');
    }
    const now = Date.now();
    const utcDay = new Date(now).toISOString().slice(0, 10);
    const snapshotFile = path.join(temp, 'allowance.json');
    fs.writeFileSync(snapshotFile, JSON.stringify({
      version:1,
      source:'cloudflare_workers_ai_dashboard',
      model:'@cf/meta/llama-4-scout-17b-16e-instruct',
      utc_day:utcDay,
      remaining_neurons:10000,
      observed_at_ms:now,
      usage_through_ms:Date.parse(`${utcDay}T00:00:00.000Z`),
    }));

    const result = spawnSync(process.execPath, [
      path.join(root, 'scripts/verify_quality_runtime.mjs'),
      '--out', out,
      '--attachments', attachments,
      '--remote-ai',
      '--allowance-snapshot', snapshotFile,
      '--skip-probe', '--all-clips', '--scout-handheld-evaluation',
    ], {cwd:root, encoding:'utf8'});

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /development_video_source_hash_mismatch:/);
    assert.equal(fs.existsSync(out), false);
  } finally {
    fs.rmSync(temp, {recursive:true, force:true});
  }
});
