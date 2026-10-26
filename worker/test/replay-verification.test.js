import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import * as replay from '../../scripts/test_edge_runtime.mjs';
const {verifyPersistedAnalyses,verifyPersistedRecords} = replay;
import worker from '../src/index.js';
import { CameraDO } from '../src/camera-do.js';

const cause = {ignition_source: 'unknown', probable_cause: 'unknown', requires_human_review: true};
const manifest = [{frame_id: 'frame-1000', ts_ms: 1000, roles: ['recent'], pre_ignition_verified: false}];
const event = {camera_id: 'cam', ts_ms: 1000, incident_id: 'cam:1000:1', cause,
  response_priority: 'inspect_urgently', evidence_manifest: manifest};
const row = {camera_id: 'cam', ts_ms: 1000, incident_id: event.incident_id, cause: 'unknown',
  event_key: `${event.incident_id}:analysis:1`, event_kind: 'analysis', analysis_job_id: 1,
  operator_priority: 'inspect_urgently', snapshot_key: null,
  analysis_json: JSON.stringify({cause, evidence_manifest: manifest, response_priority: 'inspect_urgently',
    event_kind:'analysis',analysis_status:'complete',analysis_job_id:1})};

test('real replay persistence verification compares complete analysis with null cloud archive, not absent event keys', () => {
  assert.equal(verifyPersistedAnalyses([event], [row]), true);
  for (const changed of [{incident_id: 'another'}, {camera_id: 'another'}, {ts_ms: 2000},
    {cause: 'human'}, {operator_priority: 'monitor'}, {snapshot_key: 'invented-cloud-image'},
    {analysis_json: '{}'}, {analysis_json: '{'},
    {analysis_json: JSON.stringify({cause: {...cause, ignition_source: 'human'}, evidence_manifest: manifest})},
    {analysis_json: JSON.stringify({cause, evidence_manifest: []})}]) {
    assert.equal(verifyPersistedAnalyses([event], [{...row, ...changed}]), false, JSON.stringify(changed));
  }
  assert.equal(verifyPersistedAnalyses([], []), false, 'empty capture is not a verified persistence run');
  assert.equal(verifyPersistedAnalyses([event], []), false);
});

test('replay persistence also reconciles the saved confirmation row and rejects extra records',()=>{
  const confirmation={type:'fire_confirmed',camera_id:'cam',incident_id:event.incident_id,ts_ms:1000,
    response_priority:'inspect_urgently',operator_priority:'inspect_urgently'};
  const saved={camera_id:'cam',ts_ms:1000,incident_id:event.incident_id,
    event_key:`${event.incident_id}:confirmation`,event_kind:'confirmation',snapshot_key:null,
    cause:'unknown',confidence:'low',operator_priority:'inspect_urgently',
    analysis_json:JSON.stringify({event_kind:'confirmation',analysis_status:'pending',
      response_priority:'inspect_urgently',priority_assessment:null})};
  assert.equal(verifyPersistedRecords([],confirmation,[saved]),true);
  assert.equal(verifyPersistedRecords([],confirmation,[]),false);
  assert.equal(verifyPersistedRecords([],null,[saved]),false);
  assert.equal(verifyPersistedRecords([],confirmation,[{...saved,ts_ms:1001}]),false);
});

test('authenticated state read exposes actual investigation completion flags without exposing image bytes', async () => {
  const camera = new CameraDO({storage: {}, getWebSockets: () => []}, {EVIDENCE_STORAGE: 'pi'});
  let lookups = 0;
  const env = {APP_ENV: 'production', INGEST_API_KEY: 'unit-key', CAMERA_DO: {
    idFromName: id => {lookups++; assert.equal(id, 'cam'); return id;}, get: () => camera,
  }};
  const request = key => new Request('https://worker/state/camera/cam', {headers: {'x-api-key': key}});
  assert.equal((await worker.fetch(request('wrong'), env, {})).status, 401);
  assert.equal(lookups, 0);
  const response = await worker.fetch(request('unit-key'), env, {});
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.deepEqual(state.analysis_status, {active: false, queued: false, pending_followup: false,
    pending_evidence: false, native_inference_pending: false, latest_job_id: 0});
  assert.equal(JSON.stringify(state).includes('image_b64'), false);
});

test('replay completion waits for evidence requests, queued and underlying timed-out native work', async () => {
  assert.equal(typeof replay.waitForAnalysisCompletion, 'function');
  const idle = {active: false, queued: false, pending_followup: false, pending_evidence: false,
    native_inference_pending: false, latest_job_id: 2};
  const states = [{...idle, active: true}, {...idle, queued: true}, {...idle, pending_evidence: true},
    {...idle, native_inference_pending: true}, idle];
  let calls = 0;
  const completed = await replay.waitForAnalysisCompletion(async () => states[calls++], {waitMs: 1000, pollMs: 1});
  assert.equal(completed.completed, true);
  assert.equal(calls, 5, 'a pending follow-up evidence request is not completion');
  const stalled = await replay.waitForAnalysisCompletion(async () => ({...idle, native_inference_pending: true}), {waitMs: 0});
  assert.equal(stalled.completed, false);
  await assert.rejects(replay.waitForAnalysisCompletion(async () => ({}), {waitMs: 0}), /invalid_analysis_state/);
});

test('real-time replay anchors the clip at the current epoch and enables edge pacing', async () => {
  const launch = await replay.buildAgentReplayCommand({
    video: 'clip.mp4', camera: 'cam', worker: 'http://127.0.0.1:8791',
    report: 'agent.json', evidenceDir: 'evidence', realtime: true,
    now: () => 1792419343000,
  });
  assert.equal(launch.startTsMs, 1792419343000);
  assert.equal(launch.args[launch.args.indexOf('--start-ts-ms') + 1], '1792419343000');
  assert.equal(launch.args.includes('--realtime'), true);
  assert.equal(launch.args.includes('--allow-http'), true);
});

test('accelerated replay stays on its deterministic source clock without pacing', async () => {
  const launch = await replay.buildAgentReplayCommand({
    video: fileURLToPath(new URL('../../test_images/neg1.jpg', import.meta.url)),
    camera: 'cam', worker: 'https://worker.example',
    report: 'agent.json', evidenceDir: 'evidence', realtime: false,
    now: () => 1792419343000,
  });
  assert.equal(Number.isSafeInteger(launch.startTsMs), true);
  assert.notEqual(launch.startTsMs, 1792419343000);
  assert.equal(launch.args[launch.args.indexOf('--start-ts-ms') + 1], String(launch.startTsMs));
  assert.equal(launch.args.includes('--realtime'), false);
  assert.equal(launch.args.includes('--allow-http'), false);
});
