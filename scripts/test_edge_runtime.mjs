// Replay real video through the Pi agent and a running workerd instance.
// No deployment, model installation, synthetic detections, or assumed model answer.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
export {classifyReplay, judgeReplay, planReplayBatch, summarizePriorities, verifyModelSchemas,
  verifyPersistedAnalyses, verifyPersistedRecords} from './evaluation/replay-policy.mjs';
import {classifyReplay, judgeReplay, planReplayBatch, summarizeInference, summarizePriorities, urgent,
  verifyModelSchemas, verifyPersistedRecords} from './evaluation/replay-policy.mjs';
export {loadInferenceCache, loadAllowanceSnapshot, saveInferenceCache, configureInferenceBatch,
  remainingInferenceCalls} from './evaluation/inference-batch.mjs';
import {loadInferenceCache, loadAllowanceSnapshot, saveInferenceCache, configureInferenceBatch, readInferenceBatch,
  remainingInferenceCalls, stableSourceTime} from './evaluation/inference-batch.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'worker', 'package.json'));
const WebSocket = require('ws');
export async function buildAgentReplayCommand({video, camera, worker, report, evidenceDir,
  realtime = false, now = Date.now} = {}) {
  const startTsMs = realtime ? now() : await stableSourceTime(video);
  if (!Number.isSafeInteger(startTsMs) || startTsMs <= 0) throw new Error('invalid_replay_start_timestamp');
  const origin = new URL(worker);
  const args = ['-u', 'edge/agent.py', '--video', video, '--camera', camera,
    '--worker', origin.origin, '--fps', '3', '--report', report,
    '--evidence-dir', evidenceDir, '--start-ts-ms', String(startTsMs)];
  if (origin.protocol === 'http:') args.push('--allow-http');
  if (realtime) args.push('--realtime');
  return {args, startTsMs};
}

export async function waitForAnalysisCompletion(readState, {waitMs = 365000, pollMs = 250} = {}) {
  if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 370000 || !Number.isFinite(pollMs) || pollMs < 0) {
    throw new Error('invalid_analysis_wait');
  }
  const deadline = Date.now() + waitMs;
  while (true) {
    const status = await readState();
    const flags = ['active', 'queued', 'pending_followup', 'native_inference_pending'];
    if (!status || !flags.every(key => typeof status[key] === 'boolean') ||
      (status.pending_evidence !== undefined && typeof status.pending_evidence !== 'boolean') ||
        !Number.isSafeInteger(status.latest_job_id) || status.latest_job_id < 0) throw new Error('invalid_analysis_state');
    if (flags.every(key => status[key] === false) && status.pending_evidence !== true)
      return {completed: true, analysis_status: status};
    if (Date.now() >= deadline) return {completed: false, analysis_status: status};
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, deadline - Date.now())));
  }
}

export async function runReplay(argv = process.argv.slice(2)) {
if (argv.includes('--help')) {
  console.log('node scripts/test_edge_runtime.mjs --worker http://127.0.0.1:8791 --out NEW_DIR --video VIDEO [--video VIDEO] [--python PYTHON] [--annotations JSON] [--require-ai] [--realtime] [--max-ai-calls N] [--batch-id INVOCATION_ID] [--allowance-snapshot DASHBOARD_JSON] [--analysis-wait-ms MS] [--inference-cache FILE] [--cache-mode read_write|read_only|off] [--capture-diagnostics] [--camera-prefix PREFIX]');
  console.log('--realtime anchors the clip at the current epoch and paces sampled frames against clip-relative offsets. Default replay is accelerated and uses a deterministic cache clock.');
  console.log('Preflight reserves two calls per positive/unknown clip, zero per labeled negative. Fresh AI requires a current Cloudflare account allowance snapshot and a conservative neuron reservation. The per-batch ceiling is configurable; there is no six-call daily limit. Cache is opt-in captured response replay, never quality evidence. No retries.');
  return [];
}
const values = name => argv.flatMap((v, i) => v === name ? [argv[i + 1]] : []);
const worker = values('--worker')[0];
const videos = values('--video');
const out = values('--out')[0];
const python = values('--python')[0] || path.join(root, '.venv', 'Scripts', 'python.exe');
const cameraPrefix = values('--camera-prefix')[0];
if (cameraPrefix != null && !/^[A-Za-z0-9_-]{1,64}$/.test(cameraPrefix)) throw new Error('invalid_camera_prefix');
if (!worker || !out || !videos.length) throw new Error('worker, new output directory and videos are required; see --help');
const origin = new URL(worker);
if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('Worker must be an origin');
if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) throw new Error('HTTPS or explicit loopback only');
const annotations = values('--annotations').length ? JSON.parse(fs.readFileSync(values('--annotations')[0], 'utf8')) : null;
const maxCalls = values('--max-ai-calls').length ? Number(values('--max-ai-calls')[0]) : videos.length * 2;
const requestedBatchId = values('--batch-id')[0];
if (requestedBatchId !== undefined && !/^[A-Za-z0-9_-]{1,80}$/.test(requestedBatchId)) throw new Error('invalid_batch_id');
const allowanceSnapshotFile = values('--allowance-snapshot')[0];
const allowanceSnapshot = allowanceSnapshotFile ? loadAllowanceSnapshot(allowanceSnapshotFile) : undefined;
const requireAi = argv.includes('--require-ai');
const realtime = argv.includes('--realtime');
const cacheFile = values('--inference-cache')[0];
const cacheMode = values('--cache-mode')[0] ?? (cacheFile ? 'read_write' : 'off');
if (!['off', 'read_write', 'read_only'].includes(cacheMode) || (cacheMode !== 'off' && !cacheFile)) throw new Error('invalid_cache_mode');
const captures = cacheFile ? loadInferenceCache(cacheFile) : [];
for (const video of videos) if (!fs.statSync(video).isFile()) throw new Error(`invalid_video: ${video}`);
const key = process.env.INGEST_API_KEY;
const headers = key ? { 'x-api-key': key } : {};
const batch = {batch_id: requestedBatchId ?? `replay-${Date.now()}`, max_calls: maxCalls,
  diagnostics: argv.includes('--capture-diagnostics'), cache_mode: cacheMode, captures,
  ...(allowanceSnapshot ? {account_snapshot: allowanceSnapshot} : {})};
// Every replay needs a verified ceiling. An absent --require-ai flag does not
// establish that the selected server has no remote AI binding.
if (fs.existsSync(out)) throw new Error('output_directory_already_exists');
let batchStatus = await configureInferenceBatch(origin, headers, batch);
const availableCalls = remainingInferenceCalls(batchStatus);
const plan = planReplayBatch(videos, annotations, availableCalls);
fs.mkdirSync(out, { recursive: false });
const save = (name, data) => fs.writeFileSync(path.join(out, name), JSON.stringify(data, null, 2));
save('batch-plan.json', {...plan, labels: undefined, batch_id: batch.batch_id, configured_max_calls: batch.max_calls,
  day_fresh_calls_before_replay: batchStatus.day_fresh_calls, cache_mode: cacheMode,
  replay_clock_mode: realtime ? 'wall_clock_realtime' : 'deterministic_fast_replay',
  server_enforced: Boolean(batchStatus)});
const results = [];
for (const [index, video] of videos.entries()) {
  const camera = cameraPrefix ? `${cameraPrefix}-${index}` : `pi-replay-${Date.now()}-${index}`;
  const events = [];
  let eventSequenceStart = null;
  let resolveEventStart;
  const eventStartReady = new Promise(resolve => { resolveEventStart = resolve; });
  const wsUrl = new URL(`/ws/camera/${camera}`, origin);
  wsUrl.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(wsUrl, { headers, followRedirects: false, handshakeTimeout: 15000 });
  socket.on('message', bytes => {
    try {
      const payload = JSON.parse(bytes.toString());
      for (const event of Array.isArray(payload) ? payload : [payload]) {
        if (event?.type === 'hello') {
          if (Number.isSafeInteger(event.event_sequence) && event.event_sequence >= 0) {
            eventSequenceStart = event.event_sequence;
            resolveEventStart();
          }
          continue;
        }
        events.push(event);
        fs.appendFileSync(path.join(out, `${index}-events.jsonl`), JSON.stringify(event) + '\n');
      }
    } catch (error) { console.error('event_decode_error', error.name); }
  });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  await Promise.race([eventStartReady, new Promise((_resolve, reject) =>
    setTimeout(() => reject(new Error('event_start_watermark_unavailable')), 5000))]);
  // Prevent later asynchronous socket failures from becoming uncaught exceptions.
  let socketError = null;
  socket.on('error', error => { socketError = error.name; });
  const {args, startTsMs} = await buildAgentReplayCommand({video, camera, worker: origin.origin,
    report: path.join(out, `${index}-agent.json`), evidenceDir: path.join(out, 'evidence'), realtime});
  const child = spawn(python, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const log = fs.createWriteStream(path.join(out, `${index}-agent.log`));
  child.stdout.on('data', data => { log.write(data); process.stdout.write(data); });
  child.stderr.on('data', data => { log.write(data); process.stderr.write(data); });
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  log.end();
  const analysisCompletion = await waitForAnalysisCompletion(async () => {
    const response = await fetch(new URL(`/state/camera/${camera}`, origin), {
      headers, redirect: 'manual', signal: AbortSignal.timeout(5000)});
    if (!response.ok) throw new Error(`analysis state readback ${response.status}`);
    return (await response.json()).analysis_status;
  }, {waitMs: values('--analysis-wait-ms').length ? Number(values('--analysis-wait-ms')[0]) : 365000});
  const analysisComplete = analysisCompletion.completed;
  let persisted = [], persistedMatch = false;
  // cause_update can arrive before its asynchronous INSERT finishes. Read the
  // exact incident back with a bounded wait, never mistake broadcast for commit.
  // The Durable Object can become idle before the cause event is broadcast
  // and the D1 readback becomes visible on a remote Worker.
  for (let attempt = 0; attempt < 120; attempt++) {
    const response = await fetch(new URL('/events', origin), { headers, redirect: 'manual' });
    if (!response.ok) throw new Error(`events readback ${response.status}`);
    persisted = (await response.json()).filter(row => row.camera_id === camera);
    const captured = events.filter(event => event.type === 'cause_update');
    const confirmation = events.find(event => event.type === 'fire_confirmed') ?? null;
    const latestJob = analysisCompletion.analysis_status.latest_job_id;
    persistedMatch = latestJob === 0 ? captured.length === 0 :
      captured.some(event => event.analysis_job_id === latestJob) &&
        verifyPersistedRecords(captured, confirmation, persisted);
    if (latestJob === 0) persistedMatch = persistedMatch && verifyPersistedRecords([], confirmation, persisted);
    if (persistedMatch) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const finalStateResponse = await fetch(new URL(`/state/camera/${camera}`, origin), {
    headers, redirect: 'manual', signal: AbortSignal.timeout(5000)});
  if (!finalStateResponse.ok) throw new Error(`final state readback ${finalStateResponse.status}`);
  const finalState = await finalStateResponse.json();
  socket.close();
  const causes = events.filter(event => event.type === 'cause_update');
  const confirmation = events.find(event => event.type === 'fire_confirmed') ?? null;
  save(`${index}-persisted.json`, persisted);
  const aiVerified = causes.length > 0 && causes.every(e => e.cause?.source === 'workers_ai' && typeof e.cause?.model === 'string');
  const modelSchemaVerified = verifyModelSchemas(causes);
  const modelSafetyVerified = causes.every(e => e.cause?.source !== 'workers_ai' ||
    (e.cause?.requires_human_review === true && e.cause?.hazard_absence_verified === false &&
      ['ignition_source', 'probable_cause', 'accepted_cause', 'ignition_tool', 'fuel_type', 'fire_class'].every(key => e.cause[key] === 'unknown') &&
      !['water_or_soil_sand', 'wet_chemical'].includes(e.cause?.recommended_agent)));
  const agentReportFile = path.join(out, `${index}-agent.json`);
  const agentReport = fs.existsSync(agentReportFile) ? JSON.parse(fs.readFileSync(agentReportFile, 'utf8')) : null;
  const agentVerified = agentReport?.exit_code === 0 && agentReport.inference_errors === 0 &&
    agentReport.upload_errors === 0 && agentReport.evidence_errors === 0 && agentReport.frames_sampled > 0 &&
    agentReport.uploaded === agentReport.frames_sampled;
  const eventCounts = events.reduce((acc, e) => { acc[e.type] = (acc[e.type] || 0) + 1; return acc; }, {});
  eventCounts.fire_confirmed ??= 0;
  const result = { video: path.basename(video), camera, code, socketError, aiVerified, modelSafetyVerified,
    modelSchemaVerified, analysisComplete, analysis_status: finalState.analysis_status,
    agentVerified, replay_clock_mode: realtime ? 'wall_clock_realtime' : 'deterministic_fast_replay',
    source_start_ts_ms: agentReport?.start_ts_ms ?? startTsMs,
    confirmation_offset_ms: confirmation && agentReport ? confirmation.ts_ms - agentReport.start_ts_ms : null,
    sampled_frames: agentReport?.frames_sampled ?? null, uploaded_frames: agentReport?.uploaded ?? null,
    persistedMatch, persisted_events: persisted, event_sequence_start: eventSequenceStart,
    final_event_watermark: finalState.event_sequence,
    captured_event_sequences: events.map(event => event.event_sequence),
    event_counts: eventCounts,
    confirmation, last_update: events.filter(e => e.type === 'fire_update').at(-1), causes,
    priority_events: events.filter(event => ['fire_confirmed', 'fire_update', 'cause_update'].includes(event.type) &&
      (event.response_priority != null || event.operator_priority != null)).map(event => ({type: event.type,
      incident_id: event.incident_id, ts_ms: event.ts_ms, priority_scope: event.priority_scope,
      response_priority: event.response_priority ?? event.operator_priority})),
    urgent_alerts: events.filter(event => ['fire_confirmed', 'fire_update', 'cause_update'].includes(event.type) &&
      event.priority_scope !== 'observed_interval' &&
      urgent(event.response_priority ?? event.operator_priority)).map(event => ({type: event.type,
      incident_id: event.incident_id, ts_ms: event.ts_ms, priority_scope: event.priority_scope,
      analysis_job_id: event.analysis_job_id,
      response_priority: event.response_priority ?? event.operator_priority})),
    ...summarizeInference(causes), annotation: plan.labels[index] };
  Object.assign(result, summarizePriorities(result));
  Object.assign(result, judgeReplay(result, plan.labels[index], {requireAi}));
  if (batchStatus) {
    const after = await readInferenceBatch(origin, headers, batch);
    result.batch_inference_counts = {fresh_calls: after.fresh_calls - batchStatus.fresh_calls,
      cached_calls: after.cached_calls - batchStatus.cached_calls, skipped_calls: after.skipped_calls - batchStatus.skipped_calls};
    // Authoritative server counts also include calls whose payload never made it
    // to cause_update; event metadata alone cannot count those attempts.
    batchStatus = after;
    save('inference-batch.json', after);
    if (cacheFile && cacheMode === 'read_write') saveInferenceCache(cacheFile, after.captures);
    if (after.in_flight || (index < videos.length - 1 && after.fresh_calls + plan.reservations[index + 1] > plan.max_calls)) {
      result.passed = false;
      result.failures.push(after.in_flight ? 'native_inference_still_pending' : 'remaining_ai_budget_exhausted');
    }
  }
  save(`${index}-summary.json`, result);
  results.push(result);
  console.log('REPLAY_RESULT', JSON.stringify(result));
  if (result.failures.some(failure => ['native_inference_still_pending', 'remaining_ai_budget_exhausted'].includes(failure))) break;
}
save('summary.json', results);
console.log('EVIDENCE_DIRECTORY', path.resolve(out));
if (results.some(result => !result.passed)) process.exitCode = 1;
return results;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runReplay();
