// Durable Object: one per camera. Owns the temporal state machine.
// Edge YOLO supplies observations; this object coordinates detection confirmation
// and advisory visual activity, not validated real-world fire hazard.
import { assessResponsePriority, contextForCamera, evaluateSeverity, fireCleared, fireConfirmed, fireUpdate } from "./rules.js";
import * as investigation from "./investigation.js";
import { normalizeObservation } from "./observations.js";
import { estimateTrend } from "./trend.js";
import { createEvidenceState, appendEvidence, selectLaterEvidence, protectEvidence, releaseEvidence, evidenceAnchorKeys } from "./evidence.js";
import { encodeCoordinatorState, decodeCoordinatorState } from "./coordinator-state.js";
import { CoordinatorJournal } from "./coordinator-journal.js";
import { CameraHealth, CameraHealthError, HEALTH_LIMITS } from "./camera-health.js";
import { authorizeOperator, OperatorError } from "./operator-auth.js";
import { applyNativeRecovery, nativeRecoveryStatus } from "./native-recovery.js";
import { createConfirmationRecord, createAnalysisRecord, writeIncidentRecord } from "./incident-store.js";
import { InferenceBatchStore, inferenceKey, normalizeInferenceUsage, isEvaluationEnvironment,
  providerErrorDiagnostic, estimateMaxNeuronReservation } from "./inference-runtime.js";
import { createSceneLease, advanceSceneLease, isSceneLeaseCurrent } from "./scene-lease.js";
import { canonicalObservationBatchHash, validateObservationBatch, validateSessionActivation } from './observation-batch.js';
import { createHandheldLease, advanceHandheldLease } from './handheld-lease.js';
import { confirmationHit, detectedFrame, confirmationDecision } from './lifecycle.js';

export class IngressError extends Error {
  constructor(status, message, validation_errors = []) {
    super(message);
    this.status = status;
    this.validation_errors = validation_errors;
  }
}

// Experimental continuity and receipt-freshness policies, not calibrated alarm timing.
export const OPERATIONAL_LIMITS = Object.freeze({ confirmationGapMs: 2000, receiptFreshnessMs: 5000 });
export const SNAPSHOT_LIMITS = Object.freeze({ imageBase64Bytes: 512 * 1024, totalBase64Bytes: 8 * 1024 * 1024 });

export const INGRESS_LIMITS = Object.freeze({ requestBytes: 6 * 1024 * 1024,
  detections: 256, dimension: 8192, pixels: 16 * 1024 * 1024, cameraId: 128, timestamp: 8640000000000000 });
export const OBSERVATION_BATCH_BYTES = 512 * 1024;

export function validateImageDimensions(width, height) {
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new IngressError(422, "invalid_image_dimensions");
  }
  if (width > INGRESS_LIMITS.dimension || height > INGRESS_LIMITS.dimension || width * height > INGRESS_LIMITS.pixels) {
    throw new IngressError(413, "image_dimensions_too_large");
  }
}

// Consume bytes incrementally: Content-Length may be absent, wrong, or malicious.
export async function readBoundedJson(message, maxBytes = INGRESS_LIMITS.requestBytes, signal) {
  const reader = message.body?.getReader();
  if (!reader) throw new IngressError(400, "invalid_json");
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  const chunks = [];
  let size = 0;
  try {
    signal?.throwIfAborted();
    while (true) {
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        // Do not await cancellation: a tee/remote peer may never complete it.
        void reader.cancel().catch(() => {});
        throw new IngressError(413, "body_too_large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof IngressError) throw error;
    throw new IngressError(400, "invalid_json");
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export function validateObservation(result) {
  if (Number.isFinite(result?.ts_ms) && result.ts_ms > INGRESS_LIMITS.timestamp) throw new IngressError(422, "invalid_timestamp");
  if (Array.isArray(result?.detections) && result.detections.length > INGRESS_LIMITS.detections) {
    throw new IngressError(413, "too_many_detections");
  }
  if (Array.isArray(result?.frame_wh) && result.frame_wh.length === 2) validateImageDimensions(...result.frame_wh);
  const observation = normalizeObservation(result);
  if (!observation.observation_valid) {
    throw new IngressError(observation.http_status, "invalid_observation", observation.validation_errors);
  }
  return observation;
}

export function validateCameraIdentity(body, cameraId) {
  if (typeof cameraId !== "string" || !/^[A-Za-z0-9_-]+$/.test(cameraId) || cameraId.length > INGRESS_LIMITS.cameraId) {
    throw new IngressError(400, "invalid_camera_identity");
  }
  if (body && typeof body === "object" && Object.hasOwn(body, "camera_id") && body.camera_id !== cameraId) {
    throw new IngressError(400, "camera_id_mismatch");
  }
}

export function validateFrame(body, cameraId) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new IngressError(400, "invalid_frame");
  validateCameraIdentity(body, cameraId);
  if (["frames", "images", "images_b64"].some(key => Object.hasOwn(body, key))) {
    throw new IngressError(400, "single_image_required");
  }
  if (typeof body.jpeg_b64 !== "string" || !body.jpeg_b64.length) throw new IngressError(400, "jpeg_b64_required");
  if (!Number.isFinite(body.ts_ms) || body.ts_ms < 0 || body.ts_ms > INGRESS_LIMITS.timestamp) throw new IngressError(422, "invalid_timestamp");
  validateImageDimensions(body.width, body.height);
  if (body.conf !== undefined && (!Number.isFinite(body.conf) || body.conf < 0 || body.conf > 1)) {
    throw new IngressError(422, "invalid_confidence");
  }
  const [width, height] = validateJpeg(body.jpeg_b64);
  if (width !== body.width || height !== body.height) throw new IngressError(422, "jpeg_dimensions_mismatch");
  return body;
}

export function validateJpeg(encoded) {
  const maxDecoded = 4 * 1024 * 1024;
  if (encoded.length > 4 * Math.ceil(maxDecoded / 3)) throw new IngressError(413, "encoded_image_too_large");
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const decodedSize = encoded.length / 4 * 3 - padding;
  if (decodedSize > maxDecoded) throw new IngressError(413, "decoded_image_too_large");
  // Avoid repeated-group regexes: multi-MiB input can overflow the regex stack.
  if (encoded.length % 4 !== 0 || /[^A-Za-z0-9+/]/.test(encoded.slice(0, encoded.length - padding))) {
    throw new IngressError(422, "invalid_base64");
  }
  const decoded = atob(encoded);
  if (decoded.length < 4 || decoded.charCodeAt(0) !== 255 || decoded.charCodeAt(1) !== 216 ||
    decoded.charCodeAt(decoded.length - 2) !== 255 || decoded.charCodeAt(decoded.length - 1) !== 217) {
    throw new IngressError(422, "invalid_jpeg");
  }
  // Inspect SOF dimensions before asking a decoder to allocate a raster. This is
  // a header/resource check, NOT a successful pixel decode; detector errors still reject.
  const byte = index => decoded.charCodeAt(index);
  const word = index => byte(index) * 256 + byte(index + 1);
  let offset = 2;
  while (offset < decoded.length - 2) {
    if (byte(offset++) !== 255) break;
    while (byte(offset) === 255) offset++;
    const marker = byte(offset++);
    if (marker === 0xda || marker === 0xd9) break;
    if (offset + 2 > decoded.length) break;
    const length = word(offset);
    if (length < 2 || offset + length > decoded.length) break;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8 || length !== 8 + 3 * byte(offset + 7)) break;
      const height = word(offset + 3);
      const width = word(offset + 5);
      validateImageDimensions(width, height);
      return [width, height];
    }
    offset += length;
  }
  throw new IngressError(422, "invalid_jpeg_header");
}

export function ingressErrorResponse(error) {
  if (!(error instanceof IngressError)) throw error;
  return Response.json({ error: error.message, validation_errors: error.validation_errors }, { status: error.status });
}

export class CameraDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.cameraId = null;
    this.siteContext = null;
    this.contextCamera = null;
    this.currentObservation = null;
    this.lastObservationTs = null;
    this.lastReceiptAtMs = null;
    this.window = []; // rolling 24 frames: {ts, area, dets} — 12-frame fast lane + 24-frame persistence lane
    this.trendWindow = [];
    this.evidenceState = createEvidenceState();
    this.measurement = { area_px: null, area_fraction: null, area_reliable: false,
      frame_wh: null, visibility_status: "unknown" };
    this.alert = "idle"; // idle | watch | confirmed
    this.fire = null; // active fire state once confirmed
    this.cause = null;
    this.evidenceManifest = [];
    this.incidentId = null;
    this.closedIncidentId = null;
    this.incidentSequence = 0;
    this.analysisJob = 0;
    this.eventSequence = 0;
    this.sceneLease = null;
    this.sceneLeaseGeneration = 0;
    this.sceneHazardLatchIncidentId = null;
    this.handheldLease = null; // short-lived in-memory proof; intentionally not checkpointed
    this.handheldHazardLatchIncidentId = null;
    this.handheldQualificationRequiredAfterTs = null;
    this.edgeSessionId = null;
    this.edgeGeneration = 0;
    this.edgeAttemptSequence = 0;
    this.edgeAttemptTs = null;
    this.edgeBatchSequence = 0;
    this.observationBatchLedger = [];
    this.pendingEvidenceRequest = null;
    this.completedEvidenceRequests = [];
    this.batchEffects = null;
    this.sessionId = globalThis.crypto?.randomUUID?.() ?? `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.analysisActive = false;
    this.nativeInference = null; // Caller timeout is not cancellation.
    this.pendingAnalysis = null;
    this.followupUsed = false;
    this.followupRequested = null;
    this.initialPeakTs = null;
    this.persistCount = 0;
    this.transientSnapshots = new Map(); // Pi profile: inference buffer only, no cloud image archival
    this.snapshotKeys = new Set(); // fallback for minimal storage test doubles
    this.capturedSnapshotKeys = new Map(); // reference counts until evidence reads finish
    this.analysisInterrupted = false;
    this.nativeInferenceInterrupted = false;
    this.journal = null;
    this.persistenceFailure = false;
    this.outboxFlushing = null;
    this.alarmScheduling = null;
    this.healthMonitor = null;
    // Full runtime uses SQLite. Minimal historic unit doubles have no SQL API.
    if (typeof state.storage?.sql?.exec === "function" && typeof state.storage.transactionSync === "function") {
      try {
        this.journal = new CoordinatorJournal(state.storage);
        const {restored} = this.journal.claim(encodeCoordinatorState(this), decodeCoordinatorState);
        if (restored) Object.assign(this, restored);
        this.healthMonitor = new CameraHealth(state.storage, this.cameraId);
        if (this.cameraId) {
          this.siteContext = contextForCamera(env.CAMERA_CONTEXTS_JSON, this.cameraId);
          this.contextCamera = this.cameraId;
        }
        // The in-memory local track/lease cannot be trusted across a DO
        // lifetime. Require both candidate frames to start after the last
        // restored observation before monitoring can be requalified.
        if (restored && this.alert === 'confirmed' && this.lastObservationTs !== null &&
            this.handheldHazardLatchIncidentId !== this.incidentId) {
          this.handheldQualificationRequiredAfterTs = Math.max(
            this.handheldQualificationRequiredAfterTs ?? -1, this.lastObservationTs);
          this.saveCoordinator();
        }
        // A new coordinator process has a new in-memory session fence. A lease
        // from the prior process cannot resume after restart; persist its loss
        // and return to urgent review immediately.
        if (this.sceneLease && this.sceneLease.session_id !== this.sessionId) {
          this.sceneLease = null;
          this.sceneLeaseGeneration++;
          this.saveCoordinator();
        }
      } catch {
        this.persistenceFailure = true; // Never reinterpret malformed state as idle.
      }
    }
  }

  saveCoordinator(records = [], recoveryRecord = null) {
    if (!this.journal) return;
    if (this.persistenceFailure) throw new IngressError(503, "coordinator_state_unavailable");
    try { this.journal.commit(encodeCoordinatorState(this), records, recoveryRecord); }
    catch {
      this.persistenceFailure = true;
      throw new IngressError(503, "coordinator_state_unavailable");
    }
  }

  sequenceEvents(messages) {
    if (!Array.isArray(messages) || messages.some(message => !message || typeof message !== 'object')) {
      throw new Error('invalid_camera_events');
    }
    if (messages.length > Number.MAX_SAFE_INTEGER - this.eventSequence) throw new Error('camera_event_sequence_exhausted');
    return messages.map(message => ({...message, event_sequence: ++this.eventSequence}));
  }

  lifetimeCurrent() {
    if (this.persistenceFailure) return false;
    try {this.journal?.assertCurrent(); return true;} catch {return false;}
  }

  async armOutboxRetry() {
    if (!this.journal || !this.journal.pending().length) return;
    try { await this.armEarliestAlarm(Date.now() + 5000); }
    catch { throw new IngressError(503,'coordinator_state_unavailable'); }
  }

  async armEarliestAlarm(deadline) {
    // Serialize storage-only scheduling. setAlarm replaces the single alarm;
    // continuous ingress must never push an existing retry/health deadline out.
    const previous = this.alarmScheduling ?? Promise.resolve();
    const scheduling = previous.catch(() => {}).then(async () => {
      this.journal?.assertCurrent();
      const existing = typeof this.state.storage.getAlarm === 'function' ? await this.state.storage.getAlarm() : null;
      this.journal?.assertCurrent();
      const healthDeadline = this.healthMonitor?.nextDeadline();
      const leaseDeadline = this.sceneLease?.expires_at_ms ?? Infinity;
      const handheldDeadline = this.handheldLease?.expires_at_ms ?? Infinity;
      const evidenceDeadline = this.pendingEvidenceRequest?.expires_at_ms ?? Infinity;
      const target = Math.min(deadline, healthDeadline ?? Infinity, leaseDeadline, handheldDeadline, evidenceDeadline);
      if (existing === null || target < existing) await this.state.storage.setAlarm(target);
    });
    this.alarmScheduling = scheduling;
    try {await scheduling;}
    finally {if (this.alarmScheduling === scheduling) this.alarmScheduling = null;}
  }

  async alarm() {
    if (!this.lifetimeCurrent()) throw new Error("coordinator_state_unavailable");
    try {
      this.expireSceneLease(Date.now());
      this.expireHandheldLease(Date.now());
      await this.expirePendingEvidenceRequest(Date.now());
      const result = this.healthMonitor?.expire();
      if (result?.transitions.length) {
        const events = this.sequenceEvents(result.transitions);
        this.saveCoordinator();
        this.broadcast(events);
      }
      await this.flushOutbox();
    }
    finally {
      if (this.lifetimeCurrent()) {
        const deadlines = [];
        if (this.journal.pending().length) deadlines.push(Date.now()+5000);
        const healthDeadline = this.healthMonitor?.nextDeadline();
        if (healthDeadline !== null && healthDeadline !== undefined) deadlines.push(healthDeadline);
        if (this.sceneLease && this.sceneLease.expires_at_ms > Date.now()) deadlines.push(this.sceneLease.expires_at_ms);
        if (this.handheldLease && this.handheldLease.expires_at_ms > Date.now()) deadlines.push(this.handheldLease.expires_at_ms);
        if (this.pendingEvidenceRequest && this.pendingEvidenceRequest.expires_at_ms > Date.now()) deadlines.push(this.pendingEvidenceRequest.expires_at_ms);
        if (deadlines.length) await this.armEarliestAlarm(Math.min(...deadlines));
      }
      // Never delete an alarm newly armed by concurrent ingress. A fired alarm
      // is already consumed by the runtime when no retry needs scheduling.
    }
  }

  async expirePendingEvidenceRequest(now=Date.now()) {
    const request=this.pendingEvidenceRequest;
    if (!request || request.expires_at_ms>now || this.analysisActive) return false;
    this.pendingEvidenceRequest=null;
    this.rememberCompletedEvidenceRequest(request.request_id);
    this.saveCoordinator();
    await this.state.storage.sync?.();
    if (request.incident_id===this.incidentId && request.analysis_job_id===this.analysisJob) {
      const selection=this.evidenceState.protected_selection ?? [];
      this.startPreparedEnrichment({ts:request.ts_ms,reason:request.reason,selection,
        keys:selection.flatMap(frame=>typeof frame.snapshot_key==='string'?[frame.snapshot_key]:[]),
        priority_input:null,incidentId:request.incident_id,jobId:request.analysis_job_id,
        evidence_unavailable:true,sceneContext:this.handheldSceneContext(selection)});
    }
    return true;
  }

  async flushOutbox() {
    if (!this.journal) return;
    if (this.outboxFlushing) return this.outboxFlushing;
    const task = (async () => {
      await this.state.storage.sync();
      while (true) {
        const records = this.journal.pending();
        if (!records.length) return;
        for (const record of records) {
          this.journal.assertCurrent();
          await writeIncidentRecord(this.env.DB, record);
          // A lost D1 acknowledgement is safe to retry with the same event key.
          this.journal.ack(record.event_key);
        }
      }
    })();
    this.outboxFlushing = task;
    const release = () => {if (this.outboxFlushing === task) this.outboxFlushing = null;};
    void task.then(release, release);
    return task;
  }

  scheduleOutboxFlush() {
    if (!this.journal || !this.journal.pending().length) return;
    const task = this.flushOutbox().catch(() => console.error("incident outbox flush deferred"));
    if (typeof this.state.waitUntil === "function") this.state.waitUntil(task);
  }

  async storeSnapshot(key, value) {
    if (value.length > SNAPSHOT_LIMITS.imageBase64Bytes) throw new IngressError(413, "snapshot_image_budget_exceeded");
    if (this.env.EVIDENCE_STORAGE !== "pi") {await this.state.storage.put(key, value); return;}
    const pinned = new Set([...this.capturedSnapshotKeys.keys(), ...evidenceAnchorKeys(this.evidenceState), key]);
    let bytes = [...this.transientSnapshots.values()].reduce((sum, image) => sum + image.length, 0) -
      (this.transientSnapshots.get(key)?.length ?? 0) + value.length;
    const evict = [];
    for (const old of [...this.transientSnapshots.keys()].sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))) {
      if (bytes <= SNAPSHOT_LIMITS.totalBase64Bytes) break;
      if (pinned.has(old)) continue;
      bytes -= this.transientSnapshots.get(old).length;
      evict.push(old);
    }
    if (bytes > SNAPSHOT_LIMITS.totalBase64Bytes) throw new IngressError(503, "snapshot_buffer_budget_exceeded");
    for (const old of evict) {
      this.transientSnapshots.delete(old);
      this.snapshotKeys.delete(old);
    }
    if (evict.length) this.evidenceState = {...this.evidenceState,
      snapshots: this.evidenceState.snapshots.filter(frame => !evict.includes(frame.snapshot_key))};
    this.transientSnapshots.set(key, value);
  }

  async readSnapshot(key) {
    if (this.transientSnapshots.has(key)) return this.transientSnapshots.get(key);
    return this.env.EVIDENCE_STORAGE === "pi" ? undefined : this.state.storage.get(key);
  }

  async deleteSnapshot(key) {
    this.transientSnapshots.delete(key);
    if (this.env.EVIDENCE_STORAGE !== "pi") await this.state.storage.delete(key);
  }

  async fetch(request) {
    try {
      if (this.persistenceFailure) throw new Error("unavailable");
      this.journal?.assertCurrent();
    } catch {
      return Response.json({error: "coordinator_state_unavailable"}, {status: 503});
    }
    this.scheduleOutboxFlush();
    if (this.pendingEvidenceRequest && this.pendingEvidenceRequest.expires_at_ms > Date.now())
      void this.armEarliestAlarm(this.pendingEvidenceRequest.expires_at_ms).catch(()=>{});
    const url = new URL(request.url);
    const v2Route = url.pathname.match(/^\/([A-Za-z0-9_-]{1,128})\/v2\/(session|observations|evidence)$/);
    if (v2Route) {
      if (request.method !== 'POST') return new Response('method not allowed', {status:405});
      const [,cameraId,action] = v2Route;
      try {
        const body = await readBoundedJson(request, action === 'observations' ? OBSERVATION_BATCH_BYTES :
          action === 'evidence' ? 8 * 1024 * 1024 : 8192);
        const result = action === 'session' ? await this.activateEdgeSession(body,cameraId) :
          action === 'evidence' ? await this.acceptEvidencePack(body,cameraId) :
          await this.acceptObservationBatch(body,cameraId);
        return Response.json(result);
      } catch (error) {
        if (error instanceof IngressError) return ingressErrorResponse(error);
        return Response.json({error:'v2_observation_unavailable'}, {status:503});
      }
    }
    if (url.pathname.startsWith('/__evaluation/')) {
      if (!isEvaluationEnvironment(this.env)) return new Response('not found', {status:404});
      try {
        const store = new InferenceBatchStore(this.state.storage);
        const action = url.pathname.split('/').at(-1);
        if (action === 'snapshot' && request.method === 'GET') return Response.json(store.snapshot());
        if (request.method !== 'POST') return new Response('method not allowed', {status:405});
        const body = await readBoundedJson(request, 512 * 1024);
        const result = action === 'configure' ? store.configure(body) : action === 'reserve' ?
          store.reserve(body.key,body.probe===true,body.allow_fresh!==false,body.max_neurons) :
          action === 'complete' ? store.complete(body.key, body) : action === 'annotate' ? store.annotate(body.key, body.validation_errors) : null;
        return result ? Response.json(result) : new Response('not found', {status:404});
      } catch (error) {
        const code = /^[a-z_]{1,80}$/.test(error?.message ?? '') ? error.message : 'vlm_evaluation_unavailable';
        return Response.json({error:code}, {status:409});
      }
    }
    if (url.pathname.startsWith('/__production_inference_budget/')) {
      if (this.env.APP_ENV !== 'production') return new Response('not found', {status:404});
      try {
        const action = url.pathname.split('/').at(-1);
        if (request.method !== 'POST' || !['reserve', 'complete'].includes(action))
          return new Response('method not allowed', {status:405});
        const body = await readBoundedJson(request, 8192);
        const store = new InferenceBatchStore(this.state.storage);
        let result;
        if (action === 'reserve') {
          store.configure(body.batch);
          result = store.reserve(body.key, false, true, body.max_neurons);
        } else result = store.complete(body.key, body);
        return Response.json(result);
      } catch (error) {
        const code = /^[a-z_]{1,80}$/.test(error?.message ?? '') ? error.message : 'vlm_budget_reconciliation_required';
        return Response.json({error:code}, {status:409});
      }
    }
    if (url.pathname === '/__probe' && request.method === 'POST') {
      if (!isEvaluationEnvironment(this.env)) return new Response('not found', {status:404});
      try {
        const body = await readBoundedJson(request);
        if (!Array.isArray(body.frames) || !body.frames.length || body.frames.length > 6) throw new IngressError(400,'invalid_probe_frames');
        for (const frame of body.frames) {
          const dimensions = validateJpeg(frame.image_b64);
          if (frame.frame_id !== `frame-${frame.ts_ms}` || !Number.isSafeInteger(frame.ts_ms) || frame.ts_ms < 0 ||
              !Array.isArray(frame.roles) || (frame.frame_wh && frame.frame_wh.some((n,i) => n !== dimensions[i])))
            throw new IngressError(400,'invalid_probe_frames');
        }
        // A contract probe has no detected incident. Reuse the actual native
        // adapter without fabricating lifecycle state to satisfy its checkpoint
        // codec. The separate durable batch still retains spent/in-flight work.
        if (this.probeAnalyzer?.nativeInference) throw new IngressError(409,'vlm_inference_still_running');
        const analyzer = new CameraDO({storage:{},getWebSockets:()=>[]},this.env);
        analyzer.evaluationProbe = true;
        this.probeAnalyzer = analyzer;
        return Response.json({cause:await analyzer.analyzeCause({frames:body.frames}),
          native_inference_pending:analyzer.nativeInference !== null});
      } catch(error) {
        return error instanceof IngressError ? ingressErrorResponse(error) : Response.json({error:'invalid_probe_frames'}, {status:400});
      }
    }
    const operatorRoute=url.pathname.match(/^\/([A-Za-z0-9_-]{1,128})\/operator\/(recovery|recovery-audits)$/);
    if (operatorRoute) {
      try {
        const [,cameraId,action]=operatorRoute;
        const principal=await authorizeOperator(request,this.env,'inference:recover',cameraId);
        if (!this.cameraId || cameraId!==this.cameraId) throw new OperatorError(404,'native_recovery_camera_unknown');
        this.journal?.assertCurrent();
        if (action==='recovery' && request.method==='POST') {
          const body=await readBoundedJson(request,8192);
          return Response.json(applyNativeRecovery(this,principal,body));
        }
        if (action==='recovery' && request.method==='GET') return Response.json({recovery:nativeRecoveryStatus(this,principal)});
        if (action==='recovery-audits' && request.method==='GET') {
          nativeRecoveryStatus(this,principal); // Scope/brand and current lifetime.
          const integer=(name,fallback)=>{
            const value=url.searchParams.get(name);
            if (value===null) return fallback;
            if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || url.searchParams.getAll(name).length!==1)
              throw new OperatorError(400,'operator_invalid_pagination');
            return Number(value);
          };
          const limit=integer('limit',50);
          if (limit>100) throw new OperatorError(400,'operator_invalid_pagination');
          return Response.json(this.journal.recoveryAudits({limit,beforeRowId:integer('before_row_id',null)}));
        }
        return Response.json({error:'method_not_allowed'},{status:405});
      } catch(error) {
        if (error instanceof OperatorError) return Response.json({error:error.code},{status:error.status});
        if (error instanceof IngressError) return ingressErrorResponse(error);
        return Response.json({error:'native_recovery_unavailable'},{status:503});
      }
    }
    const healthRoute = url.pathname.match(/^\/([A-Za-z0-9_-]{1,128})\/(heartbeat|health|health-events)$/);
    if (healthRoute) {
      try {
        const [,cameraId,action] = healthRoute;
        if (!this.healthMonitor) throw new IngressError(503,'camera_health_storage_unavailable');
        if ((this.cameraId && this.cameraId !== cameraId) ||
            (this.healthMonitor.cameraId && this.healthMonitor.cameraId !== cameraId)) throw new IngressError(400,'camera_id_mismatch');
        if (action==='heartbeat' && request.method==='POST') {
          const body=await readBoundedJson(request,HEALTH_LIMITS.requestBytes);
          validateCameraIdentity(body,cameraId);
          // Arm first: a committed heartbeat must be able to expire without traffic.
          await this.armEarliestAlarm(Date.now()+HEALTH_LIMITS.offlineMs);
          this.journal.assertCurrent();
          const result=this.healthMonitor.receive(body);
          if (result.transitions.length) {
            const events=this.sequenceEvents(result.transitions);
            this.saveCoordinator();
            this.broadcast(events);
          }
          return Response.json(result);
        }
        if (action==='health' && request.method==='GET') {
          return Response.json({...this.healthMonitor.snapshot(),camera_id:cameraId});
        }
        if (action==='health-events' && request.method==='GET') {
          const integer=(name,fallback)=>{
            const value=url.searchParams.get(name);
            if (value===null) return fallback;
            if (!/^[1-9][0-9]*$/.test(value) || url.searchParams.getAll(name).length!==1) throw new IngressError(400,'invalid_health_history_pagination');
            return Number(value);
          };
          return Response.json(this.healthMonitor.history({limit:integer('limit',50),beforeSequence:integer('before_sequence',null)}));
        }
        return new Response('method not allowed',{status:405});
      } catch(error) {
        if (error instanceof CameraHealthError) return Response.json({error:error.code},{status:error.status});
        if (error instanceof IngressError) return ingressErrorResponse(error);
        return Response.json({error:'camera_health_storage_failed'},{status:503});
      }
    }
    if (url.pathname.endsWith("/ws")) return this.handleWs(request);
    if (request.method === "POST" && url.pathname.endsWith("/snapshot")) {
      try {
        if (this.edgeGeneration > 0) throw new IngressError(409, 'v2_session_active');
        const body = await readBoundedJson(request);
        const route = url.pathname.match(/^\/([\w-]+)\/snapshot$/);
        if (!route) throw new IngressError(400, "invalid_camera_route");
        if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.snap_b64 !== "string" || !body.snap_b64.length) {
          throw new IngressError(400, "invalid_snapshot");
        }
        validateCameraIdentity(body, route[1]);
        if (this.cameraId && this.cameraId !== route[1]) throw new IngressError(400, "camera_id_mismatch");
        if (!Number.isFinite(body.ts_ms) || body.ts_ms < 0 || body.ts_ms > INGRESS_LIMITS.timestamp) throw new IngressError(422, "invalid_timestamp");
        validateJpeg(body.snap_b64);
        const key = `snap:${body.ts_ms}`;
        // A retry identifies the same source instant; it cannot mutate pinned evidence.
        if (!this.snapshotKeys.has(key)) await this.storeSnapshot(key, body.snap_b64);
        this.snapshotKeys.add(key);
        await this.pruneSnapshots(key);
        return Response.json({ stored: true, ts: body.ts_ms });
      } catch (error) {
        return ingressErrorResponse(error);
      }
    }
    if (request.method === "POST") {
      try {
        if (this.edgeGeneration > 0) throw new IngressError(409, 'v2_session_active');
        const body = await readBoundedJson(request);
        const match = url.pathname.match(/^\/([\w-]+)$/);
        if (!match) throw new IngressError(400, "invalid_camera_route");
        validateCameraIdentity(body, match[1]);
        validateObservation(body);
        const result = this.ingest(body, match[1]);
        // Arm only after a durable event intent exists; routine observations do
        // not create five-second alarms of their own.
        await this.armOutboxRetry();
        return Response.json(result);
      } catch (error) {
        return ingressErrorResponse(error);
      }
    }
    if (request.method === "GET") return Response.json(this.snapshot());
    return new Response("method not allowed", { status: 405 });
  }

  async pruneSnapshots(currentKey) {
    if (this.env.EVIDENCE_STORAGE !== "pi" && typeof this.state.storage.list === "function") {
      // list() returns values too. Small pages avoid materializing 24 large JPEGs
      // together; noCache avoids retaining unselected images in the DO cache.
      const keys = new Set();
      let startAfter;
      while (true) {
        const page = await this.state.storage.list({ prefix: "snap:", limit: 4, noCache: true,
          ...(startAfter ? { startAfter } : {}) });
        for (const key of page.keys()) keys.add(key);
        if (page.size < 4) break;
        startAfter = [...page.keys()].at(-1);
      }
      this.snapshotKeys = keys;
      for (const key of this.transientSnapshots.keys()) this.snapshotKeys.add(key);
    }
    const newest = [...this.snapshotKeys].sort((a, b) => Number(b.slice(5)) - Number(a.slice(5)));
    const anchors = evidenceAnchorKeys(this.evidenceState);
    const keep = new Set([...this.capturedSnapshotKeys.keys(), ...anchors, ...(currentKey ? [currentKey] : [])]);
    for (const key of newest) { if (keep.size < 24) keep.add(key); }
    for (const key of newest) {
      if (!keep.has(key)) {
        await this.deleteSnapshot(key);
        this.snapshotKeys.delete(key);
      }
    }
  }

  breakObservationContinuity() {
    this.window = [];
    this.trendWindow = [];
    if (this.sceneLease) this.sceneLease = null;
    this.handheldLease = null;
    this.sceneLeaseGeneration++;
    if (this.alert !== 'confirmed') {
      this.alert = 'idle';
      this.cause = null;
      this.evidenceManifest = [];
      this.followupRequested = null;
    }
    // Keep the source watermark coherent while making the last frame an
    // isolated anchor; no later assessment can bridge across the gap.
    this.evidenceState = createEvidenceState();
    if (this.currentObservation) {
      const key = `snap:${this.currentObservation.ts_ms}`;
      this.evidenceState = appendEvidence(this.evidenceState,this.currentObservation,
        this.snapshotKeys.has(key) ? key : null).state;
    }
  }

  async activateEdgeSession(input,cameraId) {
    let activation;
    try { activation = validateSessionActivation(input); }
    catch { throw new IngressError(400,'invalid_session_activation'); }
    if (this.cameraId && this.cameraId !== cameraId) throw new IngressError(409,'camera_id_mismatch');
    if (this.edgeSessionId === activation.session_id) {
      if (activation.expected_generation === this.edgeGeneration - 1) {
        return {protocol_version:2,session_id:this.edgeSessionId,generation:this.edgeGeneration,idempotent:true};
      }
      throw new IngressError(409,'session_activation_conflict');
    }
    if (activation.expected_generation !== this.edgeGeneration) throw new IngressError(409,'camera_generation_conflict');
    if (this.edgeGeneration >= Number.MAX_SAFE_INTEGER) throw new IngressError(503,'camera_generation_exhausted');
    if (this.pendingEvidenceRequest) {
      this.rememberCompletedEvidenceRequest(this.pendingEvidenceRequest.request_id);
    }
    this.pendingEvidenceRequest=null;
    this.evidenceState={...this.evidenceState,
      snapshots:this.evidenceState.snapshots.filter(frame=>!frame.local_ref || frame.local_ref.session_id===activation.session_id),
      protected_selection:null};
    this.cameraId = cameraId;
    this.breakObservationContinuity();
    this.edgeSessionId = activation.session_id;
    this.edgeGeneration++;
    this.edgeAttemptSequence = 0;
    this.edgeAttemptTs = null;
    this.edgeBatchSequence = 0;
    this.observationBatchLedger = [];
    this.saveCoordinator();
    await this.state.storage.sync?.();
    return {protocol_version:2,session_id:this.edgeSessionId,generation:this.edgeGeneration,idempotent:false};
  }

  async acceptObservationBatch(input,cameraId) {
    let batch;
    try {
      batch = validateObservationBatch(input,cameraId);
      const digest = await canonicalObservationBatchHash(batch);
      if (digest !== batch.payload_hash) throw new IngressError(400,'observation_batch_hash_mismatch');
    } catch (error) {
      if (error instanceof IngressError) throw error;
      throw new IngressError(400,'invalid_observation_batch');
    }
    if (batch.session_id !== this.edgeSessionId || batch.generation !== this.edgeGeneration || this.edgeGeneration < 1) {
      throw new IngressError(409,'camera_session_retired');
    }
    const known = this.observationBatchLedger.find(entry => entry.batch_sequence === batch.batch_sequence);
    if (known) {
      if (known.session_id !== batch.session_id || known.generation !== batch.generation || known.payload_hash !== batch.payload_hash) {
        throw new IngressError(409,'observation_batch_conflict');
      }
      return {...structuredClone(known.ack),idempotent:true};
    }
    if (batch.batch_sequence <= this.edgeBatchSequence) throw new IngressError(409,'observation_batch_too_old');
    if (batch.batch_sequence !== this.edgeBatchSequence + 1) throw new IngressError(409,'observation_batch_sequence_gap');
    if (batch.samples[0].attempt_sequence !== this.edgeAttemptSequence + 1) throw new IngressError(409,'observation_attempt_sequence_gap');
    if (this.edgeAttemptTs !== null && batch.samples[0].ts_ms <= this.edgeAttemptTs)
      throw new IngressError(409,'observation_source_time_reversed');
    for (let index=1; index<batch.samples.length; index++) {
      if (batch.samples[index].attempt_sequence !== batch.samples[index-1].attempt_sequence + 1)
        throw new IngressError(409,'observation_attempt_sequence_gap');
    }
    const now = Date.now();
    const prepared = batch.samples.map(sample => {
      if (batch.clock_mode === 'live' && sample.ts_ms > now + 1000) throw new IngressError(422,'future_source_timestamp');
      if (sample.status === 'gap') return {sample,observation:null};
      let observation;
      try { observation = validateObservation({ts_ms:sample.ts_ms,frame_wh:sample.frame_wh,detections:sample.detections,
        visibility:sample.visibility,camera_motion:sample.camera_motion}); }
      catch(error) { throw error instanceof IngressError ? error : new IngressError(422,'invalid_observation'); }
      return {sample,observation};
    });

    const effects = {events:[],records:[],jobs:[],retiredKeys:new Set()};
    this.batchEffects = effects;
    const dispositions = [];
    try {
      for (const {sample,observation} of prepared) {
        this.edgeAttemptSequence = sample.attempt_sequence;
        this.edgeAttemptTs = sample.ts_ms;
        const stale = batch.clock_mode === 'live' && (now - sample.ts_ms > OPERATIONAL_LIMITS.receiptFreshnessMs ||
          (this.lastObservationTs !== null && sample.ts_ms <= this.lastObservationTs));
        if (stale) {
          const hadHandheldLease = this.handheldLease !== null;
          this.breakObservationContinuity();
          if (hadHandheldLease && this.alert === 'confirmed') effects.events.push(this.handheldInvalidationEvent('stale_observation',now));
          dispositions.push({attempt_sequence:sample.attempt_sequence,status:'skipped_stale'});
        } else if (!observation) {
          const hadHandheldLease = this.handheldLease !== null;
          this.breakObservationContinuity();
          if (hadHandheldLease && this.alert === 'confirmed') effects.events.push(this.handheldInvalidationEvent('observation_gap',now));
          dispositions.push({attempt_sequence:sample.attempt_sequence,status:'gap'});
        } else {
          const local_image_ref=sample.local_image_available?{session_id:batch.session_id,generation:batch.generation,
            attempt_sequence:sample.attempt_sequence,jpeg_sha256:sample.jpeg_sha256}:null;
          this.ingest({camera_id:cameraId,ts_ms:observation.ts_ms,frame_wh:observation.frame_wh,
            detections:observation.detections,visibility:observation.visibility,camera_motion:observation.camera_motion,
            local_image_ref,handheld_candidate:sample.handheld_candidate ?? null},cameraId);
          dispositions.push({attempt_sequence:sample.attempt_sequence,status:'accepted'});
        }
      }
      this.edgeBatchSequence = batch.batch_sequence;
      const chosen = new Set();
      for (let index=0; index<effects.events.length; index++) {
        const type = effects.events[index].type;
        if (type === 'fire_confirmed' || type === 'fire_cleared') chosen.add(index);
      }
      if (this.alert === 'confirmed') {
        const last = effects.events.findLastIndex(event => event.type === 'fire_update');
        if (last >= 0) chosen.add(last);
      } else if (this.alert === 'watch') {
        const last = effects.events.findLastIndex(event => event.type === 'fire_watch');
        if (last >= 0) chosen.add(last);
      }
      const events = this.sequenceEvents(effects.events.filter((_event,index)=>chosen.has(index)));
      const ack = {protocol_version:2,session_id:batch.session_id,generation:batch.generation,
        batch_sequence:batch.batch_sequence,payload_hash:batch.payload_hash,
        accepted_through:this.edgeAttemptSequence,dispositions,
        final_state:{alert:this.alert,incident_id:this.incidentId,last_observation_ts:this.lastObservationTs,
          hits:this.window.slice(-12).filter(frame=>confirmationHit(frame,'strong')).length},
        event_watermark:this.eventSequence,
        events:events.map(event=>({type:event.type,event_sequence:event.event_sequence,ts_ms:event.ts_ms,
          incident_id:event.incident_id ?? null})),pending_evidence_requests:this.pendingEvidenceRequest?
            [structuredClone(this.pendingEvidenceRequest)]:[]};
      this.observationBatchLedger.push({session_id:batch.session_id,generation:batch.generation,
        batch_sequence:batch.batch_sequence,payload_hash:batch.payload_hash,ack});
      this.observationBatchLedger = this.observationBatchLedger.slice(-64);
      this.saveCoordinator(effects.records);
      await this.state.storage.sync?.();
      this.batchEffects = null;
      if (this.pendingEvidenceRequest) await this.armEarliestAlarm(this.pendingEvidenceRequest.expires_at_ms);
      for (const key of effects.retiredKeys) if (!this.capturedSnapshotKeys.has(key)) {
        this.snapshotKeys.delete(key);
        const cleanup=this.deleteSnapshot(key);
        if (typeof this.state.waitUntil === 'function') this.state.waitUntil(cleanup);
      }
      if (events.length) this.broadcast(events);
      for (const job of effects.jobs) this.startPreparedEnrichment(job);
      if (effects.records.length) {
        await this.armOutboxRetry();
        this.scheduleOutboxFlush();
      }
      return {...ack,idempotent:false};
    } catch (error) {
      this.batchEffects = null;
      // A partially reduced batch must never be followed by new ingress. A new
      // Durable Object lifetime restores only the last committed checkpoint.
      this.persistenceFailure = true;
      if (error instanceof IngressError) throw error;
      throw new IngressError(503,'observation_batch_commit_failed');
    }
  }

  async acceptEvidencePack(input,cameraId) {
    const fields=['protocol_version','session_id','generation','request_id','incident_id','analysis_job_id','frames'];
    if (!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).length!==fields.length ||
        fields.some(key=>!Object.hasOwn(input,key)) || input.protocol_version!==2 ||
        typeof input.session_id!=='string' || !Number.isSafeInteger(input.generation) ||
        typeof input.request_id!=='string' || typeof input.incident_id!=='string' ||
        !Number.isSafeInteger(input.analysis_job_id) || !Array.isArray(input.frames) || input.frames.length>6)
      throw new IngressError(400,'invalid_evidence_pack');
    if (input.session_id!==this.edgeSessionId || input.generation!==this.edgeGeneration)
      throw new IngressError(409,'camera_session_retired');
    if (this.completedEvidenceRequests.includes(input.request_id))
      return {protocol_version:2,request_id:input.request_id,accepted:true,idempotent:true};
    const request=this.pendingEvidenceRequest;
    if (!request || request.request_id!==input.request_id || request.session_id!==input.session_id ||
        request.generation!==input.generation || request.incident_id!==input.incident_id ||
        request.analysis_job_id!==input.analysis_job_id)
      throw new IngressError(409,'evidence_request_unknown');
    if (request.expires_at_ms<=Date.now()) {
      await this.expirePendingEvidenceRequest(Date.now());
      throw new IngressError(410,'evidence_request_expired');
    }
    if (input.frames.length!==request.frames.length) throw new IngressError(422,'evidence_pack_identity_mismatch');
    const allowedMissing=['not_in_local_ring','not_in_local_archive','local_storage_error','image_exceeds_limit'];
    const verified=[]; let packedBytes=0;
    for (let index=0;index<request.frames.length;index++) {
      const expected=request.frames[index], frame=input.frames[index];
      if (!frame || typeof frame!=='object' || Array.isArray(frame) ||
          frame.frame_id!==expected.frame_id || frame.ts_ms!==expected.ts_ms ||
          frame.attempt_sequence!==expected.attempt_sequence || frame.jpeg_sha256!==expected.jpeg_sha256)
        throw new IngressError(422,'evidence_pack_identity_mismatch');
      const hasImage=Object.hasOwn(frame,'image_b64'),hasMissing=Object.hasOwn(frame,'missing_reason');
      if (hasImage===hasMissing) throw new IngressError(422,'invalid_evidence_frame');
      if (hasMissing) {
        if (Object.keys(frame).length!==5 || !allowedMissing.includes(frame.missing_reason))
          throw new IngressError(422,'invalid_missing_frame_declaration');
        verified.push({expected,missing_reason:frame.missing_reason});
        continue;
      }
      if (Object.keys(frame).length!==5 || typeof frame.image_b64!=='string' || !frame.image_b64.length ||
          frame.image_b64.length>SNAPSHOT_LIMITS.imageBase64Bytes)
        throw new IngressError(413,'evidence_image_too_large');
      packedBytes+=frame.image_b64.length;
      if (packedBytes>8*1024*1024) throw new IngressError(413,'evidence_pack_too_large');
      const dimensions=validateJpeg(frame.image_b64);
      if (dimensions[0]!==expected.frame_wh[0] || dimensions[1]!==expected.frame_wh[1])
        throw new IngressError(422,'evidence_image_dimensions_mismatch');
      const binary=atob(frame.image_b64),bytes=Uint8Array.from(binary,character=>character.charCodeAt(0));
      const digest=await crypto.subtle.digest('SHA-256',bytes);
      const hash=[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
      if (hash!==expected.jpeg_sha256) throw new IngressError(422,'evidence_image_hash_mismatch');
      verified.push({expected,image_b64:frame.image_b64});
    }
    for (const item of verified) if (item.image_b64) await this.storeTransientSnapshot(`snap:${item.expected.ts_ms}`,item.image_b64);
    const keys=new Set(verified.filter(item=>item.image_b64).map(item=>`snap:${item.expected.ts_ms}`));
    const attach=frames=>frames.map(frame=>keys.has(`snap:${frame.ts_ms}`)?
      {...frame,snapshot_key:`snap:${frame.ts_ms}`} : frame);
    this.evidenceState={...this.evidenceState,snapshots:attach(this.evidenceState.snapshots),
      protected_selection:this.evidenceState.protected_selection?attach(this.evidenceState.protected_selection):null};
    this.pendingEvidenceRequest={...request,status:'ready'};
    this.saveCoordinator();
    await this.state.storage.sync?.();
    if (this.analysisActive) return {protocol_version:2,request_id:request.request_id,accepted:true,idempotent:true};
    const selection=this.evidenceState.protected_selection ?? [];
    const sceneContext=this.handheldSceneContext(selection);
    const priorityInput={...this.priorityInput(),ts_ms:request.ts_ms,evidence_ts_ms:request.ts_ms,
      evidence_current:false,scene_evidence_current:false,scene_chronological_match:false,
      scene_continuity_qualified:false,scene_lease_current:false};
    // The first request intentionally had no usable priority input while its
    // Pi images were unverified. Once the exact JPEG pack passes identity,
    // dimensions and hash checks, capture the current trusted camera state so
    // a valid Scout result can reassess only that observed interval. Missing
    // images or stale current evidence keep the assessment urgent.
    const verifiedPriorityInput=verified.every(item=>item.image_b64)?this.priorityInput():null;
    const job={ts:request.ts_ms,reason:request.reason,selection,
      keys:selection.flatMap(frame=>typeof frame.snapshot_key==='string'?[frame.snapshot_key]:[]),
      priority_input:verifiedPriorityInput,priority_assessment:assessResponsePriority(priorityInput),
      incidentId:request.incident_id,jobId:request.analysis_job_id,
      evidence_request_id:request.request_id,evidence_unavailable:verified.every(item=>!item.image_b64),sceneContext};
    this.startPreparedEnrichment(job);
    return {protocol_version:2,request_id:request.request_id,accepted:true,idempotent:false};
  }

  async storeTransientSnapshot(key,value) {
    if (value.length>SNAPSHOT_LIMITS.imageBase64Bytes) throw new IngressError(413,'evidence_image_too_large');
    const previous=this.transientSnapshots.get(key);
    if (previous!==undefined) {
      if (previous!==value) throw new IngressError(409,'evidence_image_conflict');
      return;
    }
    if (this.env.EVIDENCE_STORAGE!=='pi') {
      const stored=await this.state.storage.get(key);
      if (stored!==undefined && stored!==value) throw new IngressError(409,'evidence_image_conflict');
    }
    const pinned=new Set([...this.capturedSnapshotKeys.keys(),...evidenceAnchorKeys(this.evidenceState),key,
      ...(this.pendingEvidenceRequest?.frames ?? []).map(frame=>`snap:${frame.ts_ms}`),
      ...(this.evidenceState.protected_selection ?? []).flatMap(frame=>frame.snapshot_key?[frame.snapshot_key]:[])]);
    let bytes=[...this.transientSnapshots.values()].reduce((sum,image)=>sum+image.length,0)+value.length;
    const evict=[];
    for (const old of [...this.transientSnapshots.keys()].sort((a,b)=>Number(a.slice(5))-Number(b.slice(5)))) {
      if (bytes<=SNAPSHOT_LIMITS.totalBase64Bytes) break;
      if (pinned.has(old)) continue;
      bytes-=this.transientSnapshots.get(old).length;
      evict.push(old);
    }
    if (bytes>SNAPSHOT_LIMITS.totalBase64Bytes) throw new IngressError(503,'snapshot_buffer_budget_exceeded');
    for (const old of evict) {this.transientSnapshots.delete(old);this.snapshotKeys.delete(old);}
    this.transientSnapshots.set(key,value);this.snapshotKeys.add(key);
  }

  ingest(result, cameraId = this.cameraId ?? result?.camera_id) {
    validateCameraIdentity(result, cameraId);
    const observation = validateObservation(result);
    if (typeof cameraId !== "string" || !/^[\w-]+$/.test(cameraId) || (this.cameraId && this.cameraId !== cameraId)) {
      throw new IngressError(400, "camera_id_mismatch");
    }
    // The Pi transport retries an unacknowledged upload. Count a source instant
    // once, and ignore delayed packets rather than manufacturing extra hits.
    // Keep the watermark across rearm: retries cannot become a new incident.
    if (this.lastObservationTs !== null && observation.ts_ms <= this.lastObservationTs) {
      const hits = this.window.slice(-12).filter(frame =>
        confirmationHit(frame, "strong")).length;
      return { alert: this.alert, hits, published: [] };
    }
    const receivedAtMs = Date.now();
    // Reserve room for the running/latest queued analyses; never evict delivery intent.
    if (this.journal && this.journal.pending().length >= 62) throw new IngressError(503, "incident_event_backlog");
    if (this.lastObservationTs !== null && observation.ts_ms - this.lastObservationTs > OPERATIONAL_LIMITS.confirmationGapMs) {
      this.window = []; // Old hits expire; a gap is not an observed negative or a clearance.
      if (this.alert !== "confirmed") this.evidenceState = createEvidenceState();
    }
    this.cameraId = cameraId;
    if (this.contextCamera !== cameraId) {
      // Keep the privately branded reference; request/model JSON cannot supply it.
      this.siteContext = contextForCamera(this.env.CAMERA_CONTEXTS_JSON, cameraId);
      this.contextCamera = cameraId;
    }
    if (this.sceneLease) this.cancelSceneLeaseForObservation(observation, receivedAtMs);
    this.currentObservation = observation;
    this.lastObservationTs = observation.ts_ms;
    this.lastReceiptAtMs = receivedAtMs;
    const snapshotKey = `snap:${observation.ts_ms}`;
    const evidence = appendEvidence(this.evidenceState, observation, this.snapshotKeys.has(snapshotKey) ? snapshotKey : null,
      result?.local_image_ref ?? null);
    if (evidence.accepted) this.evidenceState = evidence.state;
    const dets = observation.detections;
    // Experimental confirmation tiers, not validated fire-safety thresholds:
    //   strong: conf >= 0.25 → drives the fast lane (lane A)
    //   any:    conf >= 0.08 → drives watch arming and persistence lane (lane B)
    // The detector reports everything down to 0.05; the DO does the tiering.
    // Union area includes uncertain candidates rather than filtering weak boxes
    // into a fabricated zero. Only the normalizer's reliability gate feeds trend.
    const area = observation.fire.area_px;
    this.measurement = { area_px: area, area_fraction: observation.fire.area_fraction,
      area_reliable: observation.fire.area_reliable, frame_wh: observation.frame_wh,
      visibility_status: observation.visibility };
    const ts = observation.ts_ms;
    const previous = this.trendWindow.at(-1);
    const previousReliable = this.trendWindow.findLast(sample => sample.reliable);
    // Two seconds is a conservative continuity policy, not a calibrated camera
    // sampling guarantee. Scene/resolution changes need fresh temporal support.
    const reset = previous && (observation.frame_wh.some((value, i) => value !== previous.frame_wh[i]) ? "frame_dimensions_changed" :
      ts - previous.ts > 2000 ? "observation_gap_reset" :
      observation.fire.area_reliable && previousReliable && ts - previousReliable.ts > 2000 ?
        "reliable_observation_gap_reset" : null);
    if (reset) this.trendWindow = [];
    this.trendWindow.push({ ts, area_ratio: observation.fire.area_fraction,
      reliable: observation.fire.area_reliable, camera_motion: observation.camera_motion,
      visibility: observation.visibility, frame_wh: observation.frame_wh, reset });
    this.trendWindow = this.trendWindow.filter(sample => sample.ts >= ts - 8000).slice(-24);

    // rolling windows: last 12 frames (fast lane) and last 24 (persistence lane)
    this.window.push({ ts, area, dets });
    if (this.window.length > 24) this.window.shift();
    const decision = confirmationDecision(this.window, this.alert);
    const {strong12, any12, any24} = decision;

    const CONFIRM_NEED = 5; // lane A: 5 of last 12 strong
    const WATCH_NEED = 2;
    const PERSIST_NEED = 8; // lane B: 8 of last 24 at conf >= 0.08
    const PERSIST_WIN = 24;
    let published = [];

    if (this.alert === "confirmed") {
      this.updateHandheldLease(result?.handheld_candidate ?? null, observation, receivedAtMs);
      this.fire.peakArea = Math.max(this.fire.peakArea, area ?? 0);
      const laterEvidence = !this.followupUsed && this.initialPeakTs !== null ?
        selectLaterEvidence(this.evidenceState, this.initialPeakTs, ts) : null;
      if (laterEvidence) {
        this.followupRequested = ts;
        if (!this.analysisActive && !this.pendingAnalysis && !this.pendingEvidenceRequest) {
          const job = this.prepareEnrichment(ts, "later_scene_evidence");
          if (job) {
            this.followupUsed = true;
            this.followupRequested = null;
            if (this.batchEffects) this.batchEffects.jobs.push(job);
            else this.startPreparedEnrichment(job);
          }
        }
      }
      const peakArea = this.fire.peakArea;
      const durationS = Math.max(0, (ts - this.fire.startedAt) / 1000);
      published.push(
        fireUpdate({
          camera_id: this.cameraId,
          incident_id: this.incidentId,
          ts_ms: ts,
          ...this.measurement,
          peak_area_px: peakArea,
          duration_s: durationS,
          detections: dets,
          ...this.priorityInput(),
          trigger: "observation", evidence_source_ts_ms: ts, effective_at_ms: receivedAtMs,
          emitted_at_ms: Date.now(), received_at_ms: receivedAtMs,
        })
      );
      if (decision.clear) {
        this.alert = "idle";
        this.closedIncidentId = this.incidentId;
        published.push(fireCleared({ camera_id: this.cameraId, ts_ms: ts, incident_id: this.incidentId }));
        this.fire = null;
        this.cause = null;
        this.evidenceManifest = [];
        this.incidentId = null;
        this.handheldLease = null;
        this.handheldHazardLatchIncidentId = null;
        this.handheldQualificationRequiredAfterTs = null;
        this.sceneLease = null;
        this.sceneLeaseGeneration++;
        this.sceneHazardLatchIncidentId = null;
        this.followupRequested = null;
        this.window = [];
        this.trendWindow = [];
        this.evidenceState = appendEvidence(createEvidenceState(), observation,
          this.snapshotKeys.has(snapshotKey) ? snapshotKey : null).state;
      }
    } else if (
      decision.confirm
    ) {
      this.alert = "confirmed";
      this.fire = { peakArea: area ?? 0, startedAt: ts };
      this.incidentId = `${this.cameraId}:${ts}:${++this.incidentSequence}`;
      this.closedIncidentId = null;
      this.handheldHazardLatchIncidentId = null;
      this.handheldQualificationRequiredAfterTs = null;
      this.sceneLease = null;
      this.sceneLeaseGeneration++;
      this.sceneHazardLatchIncidentId = null;
      this.initialPeakTs = this.evidenceState.peak?.ts_ms ?? null;
      this.followupUsed = false;
      this.followupRequested = null;
      this.cause = null;
      this.evidenceManifest = [];
      this.updateHandheldLease(result?.handheld_candidate ?? null, observation, receivedAtMs);
      published.push(
        fireConfirmed({
          camera_id: this.cameraId,
          incident_id: this.incidentId,
          ts_ms: ts,
          ...this.measurement,
          detections: dets,
          lane: strong12 >= CONFIRM_NEED ? "fast" : "persistent",
          ...this.priorityInput(),
          trigger: "observation", evidence_source_ts_ms: ts, effective_at_ms: receivedAtMs,
          emitted_at_ms: Date.now(), received_at_ms: receivedAtMs,
        })
      );
      // Journal the confirmation independently of investigation. This transaction
      // includes its lifecycle/watermark; D1 must acknowledge it before AI starts.
      if (this.journal) {
        const record = createConfirmationRecord({cameraId: this.cameraId,
          incidentId: this.incidentId, ts, priority: assessResponsePriority(this.priorityInput()),
          priority_scope:'live'});
        if (this.batchEffects) this.batchEffects.records.push(record);
        else this.saveCoordinator([record]);
      }
      if (this.batchEffects) this.batchEffects.jobs.push(this.prepareEnrichment(ts, "initial_confirmation"));
      else this.startEnrichment(ts, "initial_confirmation");
    } else if (decision.watch) {
      this.alert = "watch";
      this.persistCount = any24;
      published.push({ type: "fire_watch", camera_id: this.cameraId, ts_ms: ts, hits: strong12, weak_hits: any12,
        ...assessResponsePriority(this.priorityInput()) });
    } else if (decision.idle) {
      this.alert = "idle";
      this.cause = null;
      this.evidenceManifest = [];
      this.incidentId = null;
      this.evidenceState = appendEvidence(createEvidenceState(), observation,
        this.snapshotKeys.has(snapshotKey) ? snapshotKey : null).state;
    }

    if (this.batchEffects) {
      this.batchEffects.events.push(...published);
    } else {
      published = this.sequenceEvents(published);
      this.saveCoordinator();
    }
    for (const key of evidence.retired_keys) {
      if (!this.capturedSnapshotKeys.has(key)) {
        if (this.batchEffects) this.batchEffects.retiredKeys.add(key);
        else {
          this.snapshotKeys.delete(key);
          const cleanup = this.deleteSnapshot(key);
          if (typeof this.state.waitUntil === "function") this.state.waitUntil(cleanup);
        }
      }
    }
    if (published.length && !this.batchEffects) this.broadcast(published);
    return { alert: this.alert, hits: strong12, published: published.map((p) => p.type) };
  }

  startEnrichment(ts, reason) {
    const job = this.prepareEnrichment(ts, reason);
    this.startPreparedEnrichment(job);
  }

  prepareEnrichment(ts, reason) {
    const laterSelection = reason === 'later_scene_evidence' ?
      selectLaterEvidence(this.evidenceState, this.initialPeakTs, ts) : null;
    if (reason === 'later_scene_evidence' && !laterSelection) return null;
    let protectedEvidence = protectEvidence(laterSelection ?
      {...this.evidenceState, protected_selection:laterSelection} : this.evidenceState);
    this.evidenceState = protectedEvidence.state;
    const baseSelection=protectedEvidence.selection.filter(frame=>frame.ts_ms<=ts);
    let selection=this.includeHandheldFrames(baseSelection,ts);
    if (selection!==baseSelection) {
      protectedEvidence=protectEvidence({...this.evidenceState,protected_selection:selection});
      this.evidenceState=protectedEvidence.state;
      selection=protectedEvidence.selection.filter(frame=>frame.ts_ms<=ts);
    }
    const sceneContext=this.handheldSceneContext(selection);
    const incidentId = this.incidentId ??= `${this.cameraId}:${ts}:${++this.incidentSequence}`;
    const job = {ts, reason, selection, keys: selection.flatMap(frame => typeof frame.snapshot_key==='string'?[frame.snapshot_key]:[]),
      priority_input: this.priorityInput(), incidentId, jobId: ++this.analysisJob,
      priority_assessment: assessResponsePriority(this.priorityInput()),sceneContext};
    const localFrames=selection.filter(frame=>frame.local_ref).slice(0,6);
    if (this.edgeGeneration>0 && localFrames.length && !this.pendingEvidenceRequest) {
      const requestId=`evidence:${this.edgeSessionId}:${this.edgeGeneration}:${job.jobId}`;
      const request={request_id:requestId,session_id:this.edgeSessionId,generation:this.edgeGeneration,
        incident_id:incidentId,analysis_job_id:job.jobId,reason,ts_ms:ts,
        expires_at_ms:Date.now()+30_000,status:'awaiting_images',
        frames:localFrames.map(frame=>({frame_id:frame.frame_id,ts_ms:frame.ts_ms,
          attempt_sequence:frame.local_ref.attempt_sequence,jpeg_sha256:frame.local_ref.jpeg_sha256,
          frame_wh:frame.frame_wh}))};
      this.pendingEvidenceRequest=request;
      job.evidence_request_id=requestId;
      // Keep the interval conservative until a fresh, exact evidence pack arrives.
      job.priority_input=null;
    }
    for (const key of job.keys) this.capturedSnapshotKeys.set(key, (this.capturedSnapshotKeys.get(key) ?? 0) + 1);
    return job;
  }

  startPreparedEnrichment(job) {
    if (job.evidence_request_id && (this.pendingEvidenceRequest?.request_id!==job.evidence_request_id ||
        this.pendingEvidenceRequest.status!=='ready')) return;
    const task = this.enrich(job.ts, job, job.reason).catch(error => console.error("enrich failed", error));
    if (typeof this.state.waitUntil === "function") this.state.waitUntil(task);
  }

  // Capture the manifest before the first await; never reconstruct it from a rolling window.
  async enrich(ts, job = null, reason = "initial_confirmation") {
    if (!job) {
      job = this.prepareEnrichment(ts, reason);
      if (job.evidence_request_id) {
        // A follow-up can be prepared after the last edge batch. Persist its
        // request and deadline before yielding; otherwise DO eviction loses
        // the job while the public state briefly appears idle.
        this.saveCoordinator();
        await this.state.storage.sync?.();
        if (this.journal) await this.armEarliestAlarm(this.pendingEvidenceRequest.expires_at_ms);
      }
    }
    if (job.evidence_request_id && (this.pendingEvidenceRequest?.request_id!==job.evidence_request_id ||
        this.pendingEvidenceRequest.status!=='ready')) return;
    if (this.analysisActive) {
      // At most one running pack plus one queued pack, even across repeated rearming.
      if (this.pendingAnalysis) this.releaseJobKeys(this.pendingAnalysis.keys);
      this.pendingAnalysis = job;
      return;
    }
    this.analysisActive = true;
    const {incidentId, jobId, selection, keys} = job;
    const frames = [];
    let completed = false;
    try {
      if (this.journal) {
        this.saveCoordinator();
        await this.flushOutbox();
      }
      for (const {snapshot_key, ...metadata} of selection) {
        const {local_ref, ...modelMetadata}=metadata;
        if (typeof snapshot_key!=='string') continue;
        const image_b64 = await this.readSnapshot(snapshot_key);
        if (image_b64) frames.push({...modelMetadata, image_b64});
      }
      if (job.evidence_request_id && this.pendingEvidenceRequest?.request_id===job.evidence_request_id) {
        this.pendingEvidenceRequest=null;
        this.rememberCompletedEvidenceRequest(job.evidence_request_id);
        this.saveCoordinator();
        await this.state.storage.sync?.();
      }
      const cause = await this.analyzeCause({frames,sceneContext:job.sceneContext ?? {},
        evidenceUnavailable:job.evidence_unavailable===true});
      await this.armOutboxRetry();
      if (!this.lifetimeCurrent()) return;
      this.journal?.assertCurrent();
      const currentJob = this.analysisJob === jobId;
      const active = currentJob && this.incidentId === incidentId;
      const closed = currentJob && this.incidentId === null && this.closedIncidentId === incidentId;
      if (!active && !closed) return; // Never publish an obsolete job into a later incident.
      const evidence_manifest = frames.map(({image_b64, ...metadata}) => {
        const local_ref=selection.find(frame=>frame.frame_id===metadata.frame_id)?.local_ref;
        return local_ref?{...metadata,local_ref}:metadata;
      });
      if (active) {
        this.cause = cause;
        this.evidenceManifest = evidence_manifest;
        this.applyHandheldSceneResult(cause, job, evidence_manifest, Date.now());
      }
      // A delayed model result describes its captured source interval. It cannot
      // clear/downgrade a later live observation merely because the job is current.
      const intervalInput = job.priority_input;
      const reassessment = intervalInput ? assessResponsePriority({...intervalInput,
        ...this.scenePriorityInput(cause, evidence_manifest, ts, intervalInput.evidence_current),
        priority_scope:'observed_interval', scout_interval_reassessment:true}) : job.priority_assessment;
      const priority_assessment = {...reassessment,
        limitations:[...reassessment.limitations,'assessment_applies_to_observed_interval']};
      const causeEvent = this.sequenceEvents([{type: "cause_update", camera_id: this.cameraId, ts_ms: ts, incident_id: incidentId,
        analysis_job_id: jobId, analysis_reason: job.reason, incident_closed: closed, priority_scope:'observed_interval',
        ...priority_assessment, cause, evidence_manifest, evidence_location: this.env.EVIDENCE_STORAGE === "pi" ? "pi" : "not_configured", edge_archive_verified: false}])[0];
      const persistence = this.recordEvent(ts, cause, null, {incident_id: incidentId, evidence_manifest,
        analysis_job_id: jobId, analysis_reason: job.reason, incident_closed: closed,
        priority_assessment, response_priority: priority_assessment.response_priority,
        priority_scope:'observed_interval'});
      this.broadcast([causeEvent]);
      await persistence;
      completed = true;
    } finally {
      if (!this.lifetimeCurrent()) return;
      this.releaseJobKeys(keys);
      if (this.incidentId === incidentId && this.analysisJob === jobId) {
        this.evidenceState = releaseEvidence(this.evidenceState, {completed: true}).state;
      }
      await this.pruneSnapshots();
      if (!this.lifetimeCurrent()) return;
      this.analysisActive = false;
      if (this.analysisJob === jobId && this.incidentId === incidentId) {
        this.analysisInterrupted = !completed;
      }
      const pending = this.pendingAnalysis;
      this.pendingAnalysis = null;
      let liveReviewContinues = Boolean(pending);
      // A recorded clip can end while Scout is running. Without a recent edge
      // receipt, no live Pi remains to answer a new follow-up image request.
      if (this.followupRequested !== null && (this.lastReceiptAtMs === null ||
          Date.now() - this.lastReceiptAtMs > 5_000)) this.followupRequested = null;
      this.saveCoordinator();
      if (pending) {
        if (pending.incidentId === this.incidentId) await this.enrich(pending.ts, pending);
        else this.releaseJobKeys(pending.keys);
      } else if (this.incidentId === incidentId && this.followupRequested !== null && !this.followupUsed) {
        const followupTs = this.lastObservationTs;
        const laterSelection = this.initialPeakTs === null ? null :
          selectLaterEvidence(this.evidenceState, this.initialPeakTs, followupTs);
        if (laterSelection) {
          this.followupRequested = null;
          this.followupUsed = true;
          liveReviewContinues = true;
          await this.enrich(followupTs, null, "later_scene_evidence");
        }
      }
      if (!liveReviewContinues && this.incidentId === incidentId && this.scoutHandheldLiveTestEnabled()) {
        const nowMs=Date.now();
        const liveEvent=fireUpdate({camera_id:this.cameraId,incident_id:this.incidentId,
          ts_ms:this.lastObservationTs,evidence_source_ts_ms:ts,effective_at_ms:nowMs,
          emitted_at_ms:nowMs,received_at_ms:this.lastReceiptAtMs,
          trigger:completed?'scout_live_scene_review':'scout_live_scene_review_failed',
          priority_scope:'live',...this.measurement,peak_area_px:this.fire?.peakArea ?? null,
          duration_s:this.fire && this.lastObservationTs!==null ?
            Math.max(0,(this.lastObservationTs-this.fire.startedAt)/1000):null,
          ...this.priorityInput()});
        this.broadcast(this.sequenceEvents([liveEvent]));
      }
    }
  }

  releaseJobKeys(keys) {
    for (const key of keys) {
      const remaining = (this.capturedSnapshotKeys.get(key) ?? 1) - 1;
      if (remaining) this.capturedSnapshotKeys.set(key, remaining);
      else this.capturedSnapshotKeys.delete(key);
    }
  }

  rememberCompletedEvidenceRequest(requestId) {
    this.completedEvidenceRequests=[...this.completedEvidenceRequests.filter(id=>id!==requestId),requestId].slice(-64);
  }

  async analyzeCause({ frames = [], sceneContext = {}, evidenceUnavailable = false } = {}) {
    const seen = new Set();
    const imageFrames = frames.filter(frame => frame && typeof frame.image_b64 === "string" &&
      frame.image_b64.length && Number.isFinite(frame.ts_ms) && frame.frame_id === `frame-${frame.ts_ms}`)
      .sort((a,b) => a.ts_ms - b.ts_ms).filter(frame => {
        if (seen.has(frame.ts_ms)) return false;
        seen.add(frame.ts_ms); return true;
      }).slice(0, 6);
    let inferenceMode = 'skipped';
    let usage = normalizeInferenceUsage(null);
    const finish = (raw, source, model) => ({...investigation.qualifyModelInvestigation(raw,
      {frames: imageFrames, sceneContext}),
      source, ...(model ? {model} : {}), inference_metadata:{mode:inferenceMode,usage}});
    if (evidenceUnavailable) return {...finish({reasons:['evidence_unavailable']},'rules_fallback'),
      vlm_error:'evidence_unavailable'};
    if (!imageFrames.length) return finish({reasons: ["no snapshot stored by edge"]}, "rules_only");
    let model;
    try {
      if (this.env.VLM_PROVIDER !== undefined && this.env.VLM_PROVIDER !== "workers_ai") {
        throw new Error("invalid_vlm_provider");
      }
      const evaluation = isEvaluationEnvironment(this.env);
      if (!evaluation && typeof this.env.AI?.run !== "function") throw new Error("workers_ai_binding_missing");
      if (typeof this.env.VLM_MODEL !== "string" || !this.env.VLM_MODEL.trim() ||
          this.env.VLM_MODEL.length > 160 || /[\u0000-\u001f\u007f]/.test(this.env.VLM_MODEL)) {
        throw new Error("vlm_model_missing");
      }
      model = this.env.VLM_MODEL;
      const timeout = Number(this.env.VLM_TIMEOUT_MS ?? 120000);
      if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 180000) throw new Error("invalid_vlm_timeout");
      if (this.nativeInferenceInterrupted) throw new Error("vlm_previous_lifetime_unresolved");
      if (this.nativeInference) throw new Error("vlm_inference_still_running");
      const content = [{type: "text", text: investigation.buildInvestigationPromptV3(imageFrames, sceneContext)}];
      for (const frame of imageFrames) {
        content.push({type: "image_url", image_url: {url: `data:image/jpeg;base64,${frame.image_b64}`}});
      }
      const schemaTransport=this.env.VLM_SCHEMA_TRANSPORT ?? 'response_format';
      if(!['response_format','guided_json','prompt_only'].includes(schemaTransport) ||
          (schemaTransport==='prompt_only' && !evaluation))throw new Error('invalid_vlm_schema_transport');
      const schema=investigation.buildInvestigationGenerationSchemaV3(imageFrames, sceneContext);
      const input = {messages:[{role:'user',content}],max_tokens:1536,temperature:0.1,stream:false,
        ...(schemaTransport==='prompt_only'?{}:schemaTransport==='guided_json'?{guided_json:schema}:{response_format:{type:'json_schema',json_schema:schema}})};
      const maxNeurons = estimateMaxNeuronReservation(model, input);
      if (maxNeurons === null) throw new Error('vlm_budget_estimate_unavailable');
      // The shared durable budget needs an idempotency key in every environment.
      // Production disables response caching, but still uses the request hash to
      // prevent overlapping reservations for an identical request.
      const key = await inferenceKey(model,input);
      const admission = evaluation ? await this.evaluationCommand('reserve',{key,probe:this.evaluationProbe===true,
        allow_fresh:typeof this.env.AI?.run==='function',max_neurons:maxNeurons}) :
        await this.productionBudgetCommand('reserve',{key,max_neurons:maxNeurons});
      if (admission.mode === 'skipped') throw new Error(admission.reason);
      inferenceMode = admission.mode;
      if (admission.mode === 'cached') {
        usage = normalizeInferenceUsage(admission.usage);
        const result = finish(admission.raw,'workers_ai',model);
        if (evaluation) await this.evaluationCommand('annotate',{key,validation_errors:result.validation_errors});
        return result;
      }
      let timer;
      let response;
      try {
        // Retain the permit until the underlying operation settles, even after
        // this caller returns a timeout. Never multiply stalled native calls.
        const running = Promise.resolve().then(async () => {
          let result, provider_error, failed = true;
          try {
            if (this.journal) await this.state.storage.sync();
            if (!this.lifetimeCurrent()) throw new Error("coordinator_state_unavailable");
            if (typeof this.env.AI?.run !== 'function') throw new Error('workers_ai_binding_missing');
            result = await this.env.AI.run(model,input);
            usage = normalizeInferenceUsage(result?.usage);
            failed = false;
            return result;
          } catch(error) {
            provider_error = providerErrorDiagnostic(error);
            throw error;
          } finally {
            const completion = {key,failed,usage,
              raw:result && typeof result === 'object' && Object.hasOwn(result,'response') ? result.response : result};
            if (evaluation) await this.evaluationCommand('complete',completion);
            else await this.productionBudgetCommand('complete',completion);
          }
        });
        this.nativeInference = running;
        const release = () => {
          if (this.nativeInference !== running || !this.lifetimeCurrent()) return;
          this.nativeInference = null;
          try {this.saveCoordinator();} catch { /* The failed lifetime remains fail-closed. */ }
        };
        void running.then(release, release);
        this.saveCoordinator(); // Mark the uncertain operation BEFORE dispatching it.
        response = await Promise.race([
          new Promise((_, reject) => {timer = setTimeout(() => reject(new Error("vlm_timeout")), timeout);}),
          running,
        ]);
      } finally { clearTimeout(timer); }
      const raw = response && typeof response === "object" && Object.hasOwn(response, "response") ? response.response : response;
      const result = finish(raw, "workers_ai", model);
      if (evaluation) await this.evaluationCommand('annotate',{key,validation_errors:result.validation_errors});
      return result;
    } catch (error) {
      return {...finish({reasons: ["vlm_error"]}, "rules_fallback", model),
        vlm_error: investigation.VLM_ERROR_CODES.includes(error?.message) ? error.message : "vlm_error"};
    }
  }

  async evaluationCommand(action, body) {
    if (!isEvaluationEnvironment(this.env) || !this.env.CAMERA_DO) throw new Error('vlm_evaluation_unavailable');
    const stub = this.env.CAMERA_DO.get(this.env.CAMERA_DO.idFromName('__inference_budget'));
    try {
      const response = await stub.fetch(new Request(`https://do/__evaluation/${action}`,{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));
      if (!response.ok) throw new Error('vlm_evaluation_unavailable');
      return await response.json();
    } catch {throw new Error('vlm_evaluation_unavailable');}
  }

  async productionBudgetCommand(action, body) {
    if (this.env.APP_ENV !== 'production' || !this.env.CAMERA_DO ||
        typeof this.env.VLM_ALLOWANCE_SNAPSHOT_JSON !== 'string') throw new Error('vlm_budget_reconciliation_required');
    let account_snapshot;
    try { account_snapshot = JSON.parse(this.env.VLM_ALLOWANCE_SNAPSHOT_JSON); }
    catch { throw new Error('vlm_budget_reconciliation_required'); }
    const utcDay = account_snapshot?.utc_day;
    if (typeof utcDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(utcDay))
      throw new Error('vlm_budget_reconciliation_required');
    const stub = this.env.CAMERA_DO.get(this.env.CAMERA_DO.idFromName('__inference_budget'));
    const batch = {batch_id:`production-${utcDay}`,max_calls:256,diagnostics:false,cache_mode:'off',account_snapshot};
    try {
      const response = await stub.fetch(new Request(`https://do/__production_inference_budget/${action}`,{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,batch})}));
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error ?? 'vlm_budget_reconciliation_required');
      return result;
    } catch (error) {
      if (investigation.VLM_ERROR_CODES.includes(error?.message)) throw error;
      throw new Error('vlm_budget_reconciliation_required');
    }
  }

  scenePriorityInput(cause, manifest, ts, current) {
    const scene = cause?.scene_assessment;
    const ids = Array.isArray(scene?.frame_ids) ? scene.frame_ids : [];
    const times = ids.map(id => manifest.find(frame => frame.frame_id === id)?.ts_ms ?? null);
    const matches = ids.length >= 2 && times.every((time, index) => Number.isFinite(time) && time <= ts &&
      (index === 0 || time > times[index - 1]));
    const validatedV3 = cause?.source==='workers_ai' && !Object.hasOwn(cause,'vlm_error') &&
      Array.isArray(cause.validation_errors) && cause.validation_errors.length===0 &&
      scene?.contract_version===3 && Array.isArray(scene.validation_errors) && scene.validation_errors.length===0;
    const scoutHandheldSceneQualified=this.env.SCOUT_HANDHELD_PRIORITY_ENABLED==='true' && validatedV3 &&
      investigation.scoutHandheldAssessmentApplies(scene,{frames:manifest,observations:cause?.observations,
        ts_ms:ts,evidence_current:current,chronological_match:matches,model_result_valid:validatedV3});
    const semanticCurrent = current === true && matches && (investigation.sceneAssessmentApplies(scene,
      {ts_ms:ts,evidence_current:true,chronological_match:true}) || scoutHandheldSceneQualified);
    const leaseCurrent = this.sceneHazardLatchIncidentId !== this.incidentId && isSceneLeaseCurrent(this.sceneLease, {
      camera_id: this.cameraId, incident_id: this.incidentId, analysis_job_id: this.analysisJob,
      cancellation_generation: this.sceneLeaseGeneration, session_id: this.sessionId,
      site_context: this.siteContext, scene_assessment: scene, source_ts_ms: ts, now_ms: Date.now()});
    return {scene_assessment:scene,scene_evidence_current:semanticCurrent,
      scene_chronological_match:semanticCurrent && !cause?.validation_errors?.length,
      scene_source_zone_id:leaseCurrent ? this.sceneLease.source_zone_id : null,
      scene_context_revision:leaseCurrent ? this.sceneLease.context_revision : null,
      scene_geometry_revision:leaseCurrent ? this.sceneLease.geometry_revision : null,
      scene_reference_image_sha256:leaseCurrent ? this.sceneLease.reference_image_sha256 : null,
      scene_continuity_qualified:leaseCurrent,scene_lease_current:leaseCurrent,
      scout_handheld_scene_qualified:scoutHandheldSceneQualified};
  }

  handheldCandidateEvidenceCurrent(candidate) {
    if (!candidate || candidate.camera_id!==this.cameraId || candidate.session_id!==this.edgeSessionId ||
        candidate.generation!==this.edgeGeneration || typeof candidate.model_sha256!=='string' ||
        !Array.isArray(candidate.frame_ids) || candidate.frame_ids.length!==2) return false;
    return candidate.frame_ids.every(frameId=>{
      if (typeof frameId!=='string' || !/^frame-\d+(?:\.\d+)?$/.test(frameId)) return false;
      const ts=Number(frameId.slice(6));
      if (!Number.isFinite(ts) || frameId!==`frame-${ts}`) return false;
      const frame=this.evidenceState.snapshots.find(item=>item.ts_ms===ts);
      return frame?.local_ref?.session_id===candidate.session_id &&
        frame.local_ref.generation===candidate.generation && frame.local_ref.attempt_sequence>0 &&
        /^[a-f0-9]{64}$/.test(frame.local_ref.jpeg_sha256);
    });
  }

  handheldSceneContext(selection) {
    const lease=this.handheldLease;
    if (!lease || lease.incident_id!==this.incidentId || !Array.isArray(selection)) return {};
    const available=new Set(selection.map(frame=>frame.frame_id));
    if (!lease.frame_ids.every(frameId=>available.has(frameId))) return {};
    return {handheld_candidates:[{candidate_id:lease.candidate_id,frame_ids:[...lease.frame_ids]}]};
  }

  includeHandheldFrames(selection,sourceTsMs) {
    const lease=this.handheldLease;
    if (!lease || lease.incident_id!==this.incidentId || lease.source_ts_ms>sourceTsMs ||
        !Array.isArray(selection)) return selection;
    const mandatory=new Set(lease.frame_ids.map(id=>Number(id.slice(6))));
    if (mandatory.size!==2 || [...mandatory].some(ts=>!Number.isFinite(ts))) return selection;
    const frames=new Map(selection.map(frame=>[frame.ts_ms,{...frame,roles:[...frame.roles]}]));
    for (const ts of mandatory) {
      if (frames.has(ts)) continue;
      const retained=this.evidenceState.snapshots.find(frame=>frame.ts_ms===ts &&
        frame.local_ref?.session_id===lease.session_id && frame.local_ref.generation===lease.generation);
      if (!retained) return selection;
      frames.set(ts,{...retained,frame_id:`frame-${ts}`,
        roles:['handheld_context',...(selection.some(frame=>frame.roles.includes('followup_context')) &&
          ts>this.initialPeakTs?['followup_context']:[])],
        pre_ignition_verified:false,peak_scope:null});
    }
    if (selection.some(frame=>frame.roles.includes('followup_context'))) {
      const temporal=[...frames.values()].filter(frame=>frame.roles.includes('followup_context'))
        .sort((a,b)=>a.ts_ms-b.ts_ms);
      if (temporal.length<3 || temporal.at(-1).ts_ms-temporal[0].ts_ms<2000) return selection;
      const chosen=new Map();
      for (const ts of mandatory) chosen.set(ts,frames.get(ts));
      chosen.set(temporal[0].ts_ms,temporal[0]);
      chosen.set(temporal.at(-1).ts_ms,temporal.at(-1));
      const spare=temporal.filter(frame=>!chosen.has(frame.ts_ms));
      const slots=Math.min(6-chosen.size,spare.length);
      for (let index=0;index<slots;index++) {
        const candidateIndex=slots===1?Math.floor((spare.length-1)/2):
          Math.round(index*(spare.length-1)/(slots-1));
        chosen.set(spare[candidateIndex].ts_ms,spare[candidateIndex]);
      }
      return [...chosen.values()].sort((a,b)=>a.ts_ms-b.ts_ms).slice(0,6);
    }
    const rank=frame=>mandatory.has(frame.ts_ms)?100:
      (frame.roles.includes('onset')?60:0)+(frame.roles.includes('peak')?50:0)+
      (frame.roles.includes('context_after_onset')||frame.roles.includes('context_before_onset')?40:0)+
      (frame.roles.includes('recent')?30:0)+(frame.roles.includes('handheld_context')?20:0)+
      (frame.roles.includes('early')?10:0);
    const chosen=[...frames.values()].sort((a,b)=>rank(b)-rank(a)||a.ts_ms-b.ts_ms).slice(0,6)
      .sort((a,b)=>a.ts_ms-b.ts_ms);
    if (![...mandatory].every(ts=>chosen.some(frame=>frame.ts_ms===ts))) return selection;
    return chosen;
  }

  latchHandheldHazard() {
    if (this.alert!=='confirmed' || !this.incidentId) return false;
    this.handheldLease=null;
    this.handheldQualificationRequiredAfterTs=null;
    this.handheldHazardLatchIncidentId=this.incidentId;
    return true;
  }

  updateHandheldLease(wireCandidate, observation, nowMs) {
    const expectedHash=this.env.HANDHELD_MODEL_SHA256;
    const enabled=this.env.HANDHELD_PRIORITY_ENABLED==='true' && typeof expectedHash==='string' && /^[a-f0-9]{64}$/.test(expectedHash);
    if (this.alert!=='confirmed' || !this.incidentId) {
      this.handheldLease=null;
      return;
    }
    const fireRegionCount=observation.detections.filter(item=>item.cls==='fire').length;
    const positiveHazard=fireRegionCount>1 || observation.smoke.evidence_level==='strong' ||
      observation.smoke.evidence_level==='weak' || wireCandidate?.smoke_evidence==='detected' ||
      wireCandidate?.secondary_burning_evidence==='detected';
    if (positiveHazard) {
      this.latchHandheldHazard();
      return;
    }
    // A local tool track cannot stand in for the cloud-confirmed flame on the
    // current sample. If cloud sees zero regions, retain the urgent fallback
    // and require a fresh qualified track after a later positive observation.
    if (fireRegionCount!==1) {
      this.handheldLease=null;
      return;
    }
    if (!enabled) {
      this.handheldLease=null;
      return;
    }
    let candidate=wireCandidate && wireCandidate.model_sha256===expectedHash &&
      wireCandidate.source_ts_ms===observation.ts_ms && this.handheldCandidateEvidenceCurrent(wireCandidate) ?
      {...wireCandidate,incident_id:this.incidentId} : null;
    if (candidate && this.handheldQualificationRequiredAfterTs !== null) {
      const firstTs=Number(candidate.frame_ids[0].slice(6));
      if (firstTs <= this.handheldQualificationRequiredAfterTs) candidate=null;
      else this.handheldQualificationRequiredAfterTs=null;
    }
    if (this.handheldHazardLatchIncidentId===this.incidentId) {
      this.handheldLease=null;
      return;
    }
    if (this.handheldLease) {
      const advanced=advanceHandheldLease(this.handheldLease,{observation_valid:observation.observation_valid,
        ts_ms:observation.ts_ms,fire_region_count:fireRegionCount,
        smoke_evidence:observation.smoke.evidence_level==='not_detected'?'not_detected':observation.smoke.evidence_level,
        handheld_candidate:candidate},nowMs);
      this.handheldLease=advanced.lease;
      if (advanced.urgent) this.latchHandheldHazard();
    }
    if (!this.handheldLease && this.handheldHazardLatchIncidentId!==this.incidentId && candidate) {
      this.handheldLease=createHandheldLease(candidate,this.siteContext,nowMs);
    }
  }

  cancelSceneLeaseForObservation(observation, receivedAtMs) {
    if (!this.sceneLease) return false;
    // The cloud currently receives detector boxes without the edge's reviewed
    // geometry/ORB continuity proof. Until that proof is wired end to end, any
    // new frame cancels the short lease; it can never be renewed by a box alone.
    const result = advanceSceneLease(this.sceneLease, {camera_id:this.cameraId, incident_id:this.incidentId,
      session_id:this.sessionId, source_zone_id:this.sceneLease.source_zone_id,
      context_revision:this.sceneLease.context_revision, geometry_revision:this.sceneLease.geometry_revision,
      reference_image_sha256:this.sceneLease.reference_image_sha256, source_ts_ms:observation.ts_ms,
      received_at_ms:receivedAtMs, now_ms:receivedAtMs, observation_valid:observation.observation_valid,
      fire_region_count:observation.detections.filter(item => item.cls === 'fire').length,
      unique_region_match:false, inside_reviewed_zone:false, continuity_qualified:false,
      camera_motion:observation.camera_motion, image_quality_usable:false, background_stable:false,
      smoke_present:observation.smoke.evidence_level !== 'not_detected',
      secondary_burning:false, spread_outside_source:false});
    if (!result.cancelled) return false;
    this.sceneLease = null;
    this.sceneLeaseGeneration++;
    if (result.hazard_latched && this.incidentId) this.sceneHazardLatchIncidentId = this.incidentId;
    return true;
  }

  expireSceneLease(nowMs = Date.now()) {
    const lease = this.sceneLease;
    if (!lease || nowMs < lease.expires_at_ms) return false;
    this.sceneLease = null;
    this.sceneLeaseGeneration++;
    const event = fireUpdate({camera_id:this.cameraId, incident_id:this.incidentId,
      evidence_source_ts_ms:lease.support_source_ts_ms,
      effective_at_ms:nowMs, emitted_at_ms:Date.now(), received_at_ms:this.lastReceiptAtMs,
      trigger:'lease_expiry', ...this.measurement, peak_area_px:this.fire?.peakArea ?? null,
      duration_s:this.fire && this.lastObservationTs !== null ?
        Math.max(0, (this.lastObservationTs - this.fire.startedAt) / 1000) : null,
      ...this.priorityInput(), ts_ms:lease.support_source_ts_ms, evidence_ts_ms:lease.support_source_ts_ms,
      evidence_current:false, now_ms:nowMs});
    const sequenced = this.sequenceEvents([event]);
    this.saveCoordinator();
    this.broadcast(sequenced);
    return true;
  }

  expireHandheldLease(nowMs = Date.now()) {
    const lease=this.handheldLease;
    if (!lease || nowMs<lease.expires_at_ms) return false;
    this.handheldLease=null;
    if (this.alert!=='confirmed' || !this.incidentId) return true;
    const event=fireUpdate({camera_id:this.cameraId,incident_id:this.incidentId,
      ts_ms:this.lastObservationTs,evidence_source_ts_ms:lease.source_ts_ms,
      effective_at_ms:nowMs,emitted_at_ms:Date.now(),received_at_ms:this.lastReceiptAtMs,
      trigger:'handheld_lease_expiry',...this.measurement,
      peak_area_px:this.fire?.peakArea ?? null,
      duration_s:this.fire && this.lastObservationTs!==null ? Math.max(0,(this.lastObservationTs-this.fire.startedAt)/1000):null,
      ...this.priorityInput(),evidence_current:false,now_ms:nowMs});
    const sequenced=this.sequenceEvents([event]);
    this.saveCoordinator();
    this.broadcast(sequenced);
    return true;
  }

  handheldInvalidationEvent(trigger, nowMs=Date.now()) {
    return fireUpdate({camera_id:this.cameraId,incident_id:this.incidentId,
      ts_ms:this.lastObservationTs,evidence_source_ts_ms:this.lastObservationTs,
      effective_at_ms:nowMs,emitted_at_ms:Date.now(),received_at_ms:this.lastReceiptAtMs,
      trigger,...this.measurement,peak_area_px:this.fire?.peakArea ?? null,
      duration_s:this.fire && this.lastObservationTs!==null ? Math.max(0,(this.lastObservationTs-this.fire.startedAt)/1000):null,
      ...this.priorityInput(),evidence_current:false,now_ms:nowMs});
  }

  scoutHandheldLiveTestEnabled() {
    return this.env.APP_ENV==='development' && this.env.VLM_EVALUATION_MODE==='true' &&
      this.env.SCOUT_HANDHELD_LIVE_TEST_ENABLED==='true' &&
      this.env.SCOUT_HANDHELD_PRIORITY_ENABLED==='true';
  }

  applyHandheldSceneResult(cause, job, evidenceManifest, nowMs=Date.now()) {
    const lease=this.handheldLease;
    if (this.alert!=='confirmed' || (lease && lease.incident_id!==this.incidentId) ||
        job?.incidentId!==this.incidentId || job?.jobId!==this.analysisJob) return null;
    const scene=cause?.scene_assessment;
    const rows=Array.isArray(scene?.tool_assertions)?scene.tool_assertions:[];
    const hazardous=scene?.contract_version===3 && (scene.category==='material_burning' ||
      scene.category==='smoke_only' || rows.some(row=>row?.secondary_burning==='present' ||
        row?.smoke==='present' || row?.flame_relation==='separate') ||
      cause?.observations?.some(row=>row?.kind==='material_burning' || row?.kind==='smoke_visible'));
    // Provider availability is not scene evidence. The existing local lease
    // still has to pass all freshness, observation and policy gates, and this
    // result cannot create or renew it.
    const unavailable=cause?.source==='rules_only' || (cause?.source==='rules_fallback' &&
      investigation.VLM_ERROR_CODES.includes(cause.vlm_error));
    if (!hazardous && unavailable) return null;
    if (!lease && !hazardous && !job?.sceneContext?.handheld_candidates?.length) return null;
    const validatedV3=cause?.source==='workers_ai' && !Object.hasOwn(cause,'vlm_error') &&
      Array.isArray(cause.validation_errors) && cause.validation_errors.length===0 &&
      scene?.contract_version===3 && Array.isArray(scene.validation_errors) && scene.validation_errors.length===0;
    // A current incident's hazard evidence outlives the short local lease.
    // Expiry, missing frames or restart must not discard a delayed hazard veto.
    const capturedCandidate=lease && job?.sceneContext?.handheld_candidates?.find(item=>item?.candidate_id===lease.candidate_id);
    const capturedFrameIds=Array.isArray(capturedCandidate?.frame_ids)?capturedCandidate.frame_ids:[];
    const matchingRows=lease ? rows.filter(row=>row?.candidate_id===lease.candidate_id && capturedFrameIds.includes(row.frame_id)) : [];
    const attachedFrames=capturedFrameIds.length===2 && capturedFrameIds.every(frameId=>evidenceManifest.some(frame=>
      frame.frame_id===frameId && frame.ts_ms===Number(frameId.slice(6))));
    const contained=validatedV3 && scene.category==='contained_tool_flame' && attachedFrames &&
      capturedFrameIds.every(frameId=>scene.frame_ids?.includes(frameId)) &&
      matchingRows.length===2 && capturedFrameIds.every(frameId=>{
        const row=matchingRows.find(item=>item.frame_id===frameId);
        return row?.tool_type==='lighter' && row.flame_relation==='at_tool_tip' &&
          row.secondary_burning==='not_observed' && row.smoke==='not_observed' && row.occlusion==='not_observed';
      });
    if (contained && !hazardous) return null;

    this.handheldLease=null;
    if (hazardous) {
      this.latchHandheldHazard();
    } else {
      this.handheldQualificationRequiredAfterTs=Math.max(this.handheldQualificationRequiredAfterTs ?? -1,
        this.lastObservationTs ?? job.ts);
    }
    const event=fireUpdate({camera_id:this.cameraId,incident_id:this.incidentId,
      ts_ms:this.lastObservationTs,evidence_source_ts_ms:scene?.evidence_interval?.end_ts_ms ?? job.ts,
      effective_at_ms:nowMs,emitted_at_ms:Date.now(),received_at_ms:this.lastReceiptAtMs,
      trigger:hazardous?'handheld_scene_assessment_hazard':'handheld_scene_assessment_uncertain',
      ...this.measurement,peak_area_px:this.fire?.peakArea ?? null,
      duration_s:this.fire && this.lastObservationTs!==null ? Math.max(0,(this.lastObservationTs-this.fire.startedAt)/1000):null,
      ...this.priorityInput(),now_ms:nowMs});
    const sequenced=this.sequenceEvents([event]);
    this.saveCoordinator();
    this.broadcast(sequenced);
    return sequenced[0];
  }

  applySceneReassessment(candidate) {
    const scene = candidate?.scene_assessment;
    const currentIdentity = this.alert === 'confirmed' && this.incidentId !== null &&
      candidate?.camera_id === this.cameraId && candidate?.incident_id === this.incidentId &&
      candidate?.analysis_job_id === this.analysisJob &&
      candidate?.cancellation_generation === this.sceneLeaseGeneration &&
      candidate?.session_id === this.sessionId && candidate?.site_context === this.siteContext &&
      candidate?.current_observation?.source_ts_ms === this.lastObservationTs &&
      candidate?.current_observation?.received_at_ms === this.lastReceiptAtMs &&
      Array.isArray(candidate?.supporting_frames) && candidate.supporting_frames.every(frame =>
        this.evidenceManifest.some(actual => actual.frame_id === frame.frame_id && actual.ts_ms === frame.source_ts_ms)) &&
      JSON.stringify(scene) === JSON.stringify(this.cause?.scene_assessment);
    if (!currentIdentity || this.sceneHazardLatchIncidentId === this.incidentId) return null;
    const hazardous = scene?.contract_version === 2 && Array.isArray(scene.assertions) &&
      scene.assertions.some(row => row?.secondary_burning === 'present' ||
        row?.spread_outside_source === 'present' || row?.containment === 'uncontained');
    if (hazardous) {
      this.sceneLease = null;
      this.sceneLeaseGeneration++;
      this.sceneHazardLatchIncidentId = this.incidentId;
      return this.publishScenePriorityEvent('model_result', candidate.now_ms, candidate.current_observation.source_ts_ms);
    }
    const lease = createSceneLease(candidate);
    if (!lease?.useful_at_issue) return null;
    this.sceneLease = lease;
    const event = this.publishScenePriorityEvent('model_result', candidate.now_ms, lease.support_source_ts_ms);
    if (event.response_priority !== 'monitor') {
      this.sceneLease = null;
      this.sceneLeaseGeneration++;
      this.saveCoordinator();
      return null;
    }
    this.saveCoordinator();
    if (this.journal) void this.armEarliestAlarm(lease.expires_at_ms).catch(() => {});
    return event;
  }

  publishScenePriorityEvent(trigger, effectiveAtMs, evidenceSourceTsMs) {
    const emittedAtMs = Date.now();
    const event = fireUpdate({camera_id:this.cameraId, incident_id:this.incidentId,
      ...this.measurement, peak_area_px:this.fire?.peakArea ?? null,
      duration_s:this.fire && this.lastObservationTs !== null ?
        Math.max(0, (this.lastObservationTs - this.fire.startedAt) / 1000) : null,
      ...this.priorityInput(), ts_ms:this.lastObservationTs,
      trigger, evidence_source_ts_ms:evidenceSourceTsMs, effective_at_ms:effectiveAtMs,
      emitted_at_ms:emittedAtMs, received_at_ms:this.lastReceiptAtMs});
    const sequenced = this.sequenceEvents([event]);
    this.saveCoordinator();
    this.broadcast(sequenced);
    return sequenced[0];
  }

  recordEvent(ts, cause, _unusedCloudKey, metadata = {}) {
    const record = createAnalysisRecord({cameraId: this.cameraId,
      incidentId: metadata.incident_id ?? this.incidentId, ts,
      jobId: metadata.analysis_job_id ?? Math.max(1, this.analysisJob), cause,
      evidence_manifest: metadata.evidence_manifest ?? [],
      priority: metadata.priority_assessment ?? metadata.response_priority ?? "inspect_urgently",
      reason: metadata.analysis_reason ?? "investigation", incident_closed: metadata.incident_closed === true,
      priority_scope: metadata.priority_scope});
    if (this.journal) {
      this.saveCoordinator([record]);
      return this.flushOutbox();
    }
    return writeIncidentRecord(this.env.DB, record);
  }

  priorityInput() {
    const current = this.currentObservation;
    const reliable = this.trendWindow.filter(sample => sample.reliable);
    const receiptAge = this.lastReceiptAtMs === null ? null : Date.now() - this.lastReceiptAtMs;
    const fresh = receiptAge !== null && receiptAge >= 0 && receiptAge <= OPERATIONAL_LIMITS.receiptFreshnessMs;
    const trend = this.trendFields();
    if (!fresh) Object.assign(trend, {visual_activity: "unknown", normalized_rate_per_s: null,
      trend_confidence: "low", trend_limitations: [...trend.trend_limitations, "observation_stale_or_unavailable"]});
    const sceneInput=this.scenePriorityInput(this.cause,this.evidenceManifest,this.lastObservationTs,fresh);
    const liveTestEnabled=this.scoutHandheldLiveTestEnabled();
    const liveSceneQualified=sceneInput.scout_handheld_scene_qualified===true;
    const liveReviewPending=liveTestEnabled && this.alert==='confirmed' && !this.analysisInterrupted &&
      !liveSceneQualified && (this.cause===null || this.analysisActive || this.pendingAnalysis!==null ||
        this.followupRequested!==null || this.pendingEvidenceRequest!==null);
    return { camera_id: this.cameraId, ts_ms: this.lastObservationTs, now_ms: Date.now(), detection_status: this.alert,
      observation_valid: current?.observation_valid === true,
      evidence_current: fresh && current !== null && current.ts_ms === this.lastObservationTs,
      receipt_age_ms: receiptAge,
      evidence_ts_ms: current?.ts_ms, smoke_evidence: current?.smoke.evidence_level ?? "unknown",
      camera_motion: current?.camera_motion ?? null, ...this.measurement, ...trend,
      fire_region_count:Array.isArray(current?.detections)?current.detections.filter(item=>item.cls==='fire').length:undefined,
      trend_duration_s: reliable.length > 1 ? (reliable.at(-1).ts - reliable[0].ts) / 1000 : 0,
      site_context: this.siteContext,
      handheld_feature_enabled:this.env.HANDHELD_PRIORITY_ENABLED==='true' &&
        typeof this.env.HANDHELD_MODEL_SHA256==='string' && /^[a-f0-9]{64}$/.test(this.env.HANDHELD_MODEL_SHA256),
      scout_handheld_priority_enabled:this.env.SCOUT_HANDHELD_PRIORITY_ENABLED==='true',
      scout_handheld_live_test_enabled:liveTestEnabled,
      scout_handheld_review_pending:liveReviewPending,
      handheld_lease:this.handheldLease,
      incident_id:this.incidentId,
      session_id:this.edgeSessionId,
      ...sceneInput };
  }

  trendFields() {
    const estimate = estimateTrend(this.trendWindow);
    estimate.limitations.push(...this.trendWindow.filter(sample => sample.reset).map(sample => sample.reset));
    // The helper excludes missing samples; the adapter must also ensure its
    // current claim is supported now, rather than repeating a historical decline.
    if (this.trendWindow.at(-1)?.reliable !== true) {
      estimate.visual_activity = "unknown";
      estimate.normalized_rate_per_s = null;
      estimate.confidence = "low";
      estimate.limitations.push("current_fire_area_unreliable");
    }
    return { visual_activity: estimate.visual_activity,
      normalized_rate_per_s: estimate.normalized_rate_per_s,
      trend_confidence: estimate.confidence, trend_sample_count: estimate.sample_count,
      // Deprecated compatibility fields; never substitute pixel endpoints for
      // normalized visual activity or translate growing into physical spreading.
      growth_rate_px_per_s: null, growth_rate_deprecated: true,
      trend: estimate.visual_activity, trend_deprecated: true,
      trend_limitations: [...estimate.limitations,
        ...(!this.trendWindow.length || this.trendWindow.some(sample => sample.camera_motion === null) ? ["camera_motion_not_assessed"] : [])] };
  }

  snapshot() {
    const w12 = this.window.slice(-12);
    const severity = evaluateSeverity();
    const input = this.priorityInput();
    const {site_context, now_ms, handheld_feature_enabled, handheld_lease, session_id,
      scout_handheld_priority_enabled, scout_handheld_scene_qualified, scout_handheld_live_test_enabled,
      scout_handheld_review_pending, scout_interval_reassessment,
      fire_region_count, ...publicInput} = input;
    return {
      camera_id: this.cameraId,
      alert: this.alert,
      cause: this.cause,
      incident_id: this.incidentId,
      durability_status: {coordinator: this.journal ? "sqlite" : "unit_memory",
        pending_events: this.journal?.pending().length ?? 0, analysis_interrupted: this.analysisInterrupted,
        native_inference_interrupted: this.nativeInferenceInterrupted},
      device_health: this.healthMonitor?.snapshot() ?? null,
      analysis_status: {active: this.analysisActive, queued: this.pendingAnalysis !== null,
        pending_followup: this.followupRequested !== null, native_inference_pending: this.nativeInference !== null || this.nativeInferenceInterrupted,
        pending_evidence: this.pendingEvidenceRequest !== null,
        latest_job_id: this.analysisJob},
      event_sequence: this.eventSequence,
      evidence_manifest: this.evidenceManifest,
      severity: severity.level, hazard_level: severity.level,
      severity_details: severity, advisory_only: true,
      ...publicInput,
      ...assessResponsePriority(input),
      hits: w12.filter((f) => confirmationHit(f, "strong")).length,
      window_size: this.window.length,
      persist_hits_24: this.window.filter((f) =>
        confirmationHit(f, "any")
      ).length,
    };
  }

  // ---- WebSocket fan-out (dashboard / fire-truck app) ----
  async handleWs(request) {
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    pair[1].send(JSON.stringify({ type: "hello", camera_id: this.cameraId, alert: this.alert,
      event_sequence: this.eventSequence }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  broadcast(messages) {
    if (messages.some(message => !Number.isSafeInteger(message?.event_sequence))) {
      messages = this.sequenceEvents(messages);
      this.saveCoordinator();
    }
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(JSON.stringify(messages.length === 1 ? messages[0] : messages));
      } catch {
        // stale socket; runtime cleans up
      }
    }
  }
}

