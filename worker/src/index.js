// Worker entry: REST + WebSocket routing, auth, DO dispatch.
// Default path: Pi CPU YOLO → observation ingress → camera DO → Workers AI.
import { CameraDO, IngressError, ingressErrorResponse, readBoundedJson, validateCameraIdentity,
  validateFrame, validateObservation } from "./camera-do.js";
import { timingSafeEqual } from "node:crypto";
import { authorizeOperator, OperatorError } from "./operator-auth.js";
import { submitCauseReview, listCauseReviews } from "./operator-review.js";
import { isEvaluationEnvironment, isLoopbackRequest } from './inference-runtime.js';
import { OBSERVATION_BATCH_BYTES } from './camera-do.js';
import { canonicalObservationBatchHash, validateObservationBatch, validateSessionActivation } from './observation-batch.js';

export { CameraDO };

const isDevelopment = (env) => env.APP_ENV === "development";
const hasKey = (key) => typeof key === "string" && key.trim().length > 0;

// Offline deployment preflight: validate supplied identifiers, not provision or
// infer them. A well-formed UUID does not prove that a remote database exists.
export function deploymentConfigErrors(config) {
  const errors = [];
  const databaseId = config?.d1_databases?.find(db => db.binding === "DB")?.database_id;
  if (typeof databaseId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(databaseId) ||
      databaseId === "00000000-0000-0000-0000-000000000000") {
    errors.push("DB.database_id: supply an existing D1 UUID");
  }
  const vars = config?.vars;
  if (vars?.DETECTOR_PROVIDER !== "edge") errors.push("DETECTOR_PROVIDER: Pi-side edge detection is required");
  if (vars?.VLM_PROVIDER !== "workers_ai") errors.push("VLM_PROVIDER: native Workers AI is required");
  if (config?.ai?.binding !== "AI") errors.push("ai.binding: Workers AI requires the AI binding");
  if (!hasKey(vars?.VLM_MODEL) || vars.VLM_MODEL !== vars.VLM_MODEL.trim()) {
    errors.push("VLM_MODEL: supply an explicit Workers AI model");
  }
  if (vars?.APP_ENV !== "production") errors.push("APP_ENV: cloud deployments require production mode");
  return errors;
}

function authOk(request, env) {
  const key = request.headers.get("x-api-key") ?? "";
  const expected = env.INGEST_API_KEY;
  if (!hasKey(expected)) return isDevelopment(env);
  const actualBytes = new TextEncoder().encode(key);
  const expectedBytes = new TextEncoder().encode(expected);
  return actualBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(actualBytes, expectedBytes);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const evaluationIngress = isEvaluationEnvironment(env) && (isLoopbackRequest(request) ||
      (env.REMOTE_EVALUATION_ENABLED === 'true' && url.protocol === 'https:' &&
        hasKey(env.INGEST_API_KEY) && authOk(request, env)));

    if (url.pathname === "/health") {
      return Response.json({ ok: true, ts: Date.now() });
    }
    const developmentRoute = ['/dev/inference-batch','/dev/inference-probe'].includes(url.pathname);
    if (developmentRoute && !evaluationIngress)
      return new Response('not found',{status:404});

    // Separate authorization domain: an ingest credential never approves a cause.
    if (url.pathname.startsWith('/operator/')) {
      const response=await handleOperatorRequest(request,env,url);
      const privateResponse=new Response(response.body,response);
      privateResponse.headers.set('cache-control','no-store');
      return privateResponse;
    }

    if (!isDevelopment(env) && !hasKey(env.INGEST_API_KEY)) {
      return Response.json({ error: "server_misconfigured" }, { status: 503 });
    }

    if (!authOk(request, env)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const v2SessionMatch = url.pathname.match(/^\/v2\/sessions\/camera\/([A-Za-z0-9_-]{1,128})$/);
    if (v2SessionMatch) {
      if (request.method !== 'POST') return new Response('method not allowed',{status:405});
      const cameraId=v2SessionMatch[1];
      try {
        const body=await readBoundedJson(request,8192);
        validateSessionActivation(body);
        const stub=env.CAMERA_DO.get(env.CAMERA_DO.idFromName(cameraId));
        return stub.fetch(new Request(`https://do/${cameraId}/v2/session`,{method:'POST',body:JSON.stringify(body)}));
      } catch(error) {
        if (error instanceof IngressError) return ingressErrorResponse(error);
        return Response.json({error:'invalid_session_activation'},{status:400});
      }
    }
    const v2BatchMatch = url.pathname.match(/^\/v2\/observations\/camera\/([A-Za-z0-9_-]{1,128})$/);
    if (v2BatchMatch) {
      if (request.method !== 'POST') return new Response('method not allowed',{status:405});
      const cameraId=v2BatchMatch[1];
      try {
        const body=await readBoundedJson(request,OBSERVATION_BATCH_BYTES);
        const batch=validateObservationBatch(body,cameraId);
        if (batch.clock_mode==='replay' && !evaluationIngress)
          throw new IngressError(403,'replay_clock_requires_local_evaluation');
        if (await canonicalObservationBatchHash(batch)!==batch.payload_hash)
          throw new IngressError(400,'observation_batch_hash_mismatch');
        for (const sample of batch.samples) if (sample.status==='ok') {
          validateObservation({ts_ms:sample.ts_ms,frame_wh:sample.frame_wh,detections:sample.detections,
            visibility:sample.visibility,camera_motion:sample.camera_motion});
        }
        const stub=env.CAMERA_DO.get(env.CAMERA_DO.idFromName(cameraId));
        return stub.fetch(new Request(`https://do/${cameraId}/v2/observations`,{method:'POST',body:JSON.stringify(batch)}));
      } catch(error) {
        if (error instanceof IngressError) return ingressErrorResponse(error);
        return Response.json({error:'invalid_observation_batch'},{status:400});
      }
    }
    const v2EvidenceMatch = url.pathname.match(/^\/v2\/evidence\/camera\/([A-Za-z0-9_-]{1,128})$/);
    if (v2EvidenceMatch) {
      if (request.method !== 'POST') return new Response('method not allowed',{status:405});
      const cameraId=v2EvidenceMatch[1];
      try {
        const body=await readBoundedJson(request,8*1024*1024);
        const stub=env.CAMERA_DO.get(env.CAMERA_DO.idFromName(cameraId));
        return stub.fetch(new Request(`https://do/${cameraId}/v2/evidence`,{method:'POST',body:JSON.stringify(body)}));
      } catch(error) {
        if (error instanceof IngressError) return ingressErrorResponse(error);
        return Response.json({error:'invalid_evidence_pack'},{status:400});
      }
    }
    if (developmentRoute) {
      const probe = url.pathname.endsWith('-probe');
      if ((probe && request.method !== 'POST') || (!probe && !['GET','POST'].includes(request.method)))
        return new Response('method not allowed',{status:405});
      const stub = env.CAMERA_DO.get(env.CAMERA_DO.idFromName(probe ? '__evaluation_probe' : '__inference_budget'));
      const target = probe ? '/__probe' : `/__evaluation/${request.method === 'GET' ? 'snapshot' : 'configure'}`;
      const result = await stub.fetch(new Request(`https://do${target}`,request));
      const response = new Response(result.body,result);
      response.headers.set('cache-control','no-store');
      return response;
    }

    const healthMatch=url.pathname.match(/^\/(heartbeat|health|health-events)\/camera\/([A-Za-z0-9_-]{1,128})$/);
    if (healthMatch) {
      const [,action,cameraId]=healthMatch;
      const stub=env.CAMERA_DO.get(env.CAMERA_DO.idFromName(cameraId));
      return stub.fetch(new Request(`https://do/${cameraId}/${action}${url.search}`,request));
    }

    // WebSocket live events: /ws/camera/:id (dashboard connects here)
    const wsMatch = url.pathname.match(/^\/ws\/camera\/([\w-]+)$/);
    if (wsMatch) {
      const id = env.CAMERA_DO.idFromName(wsMatch[1]);
      const stub = env.CAMERA_DO.get(id);
      return stub.fetch(new Request(`https://do/${wsMatch[1]}/ws`, request));
    }

    // Pi-side YOLO supplies observations; cloud coordinates temporal state and evidence.
    const observationMatch = url.pathname.match(/^\/observation\/camera\/([\w-]+)$/);
    if (observationMatch && request.method === "POST") {
      return handleEdgeObservation(request, env, observationMatch[1]);
    }

    // Legacy/test-only ingestion of detection results.
    const ingestMatch = url.pathname.match(/^\/ingest\/camera\/([\w-]+)$/);
    if (ingestMatch && request.method === "POST") {
      const id = env.CAMERA_DO.idFromName(ingestMatch[1]);
      const stub = env.CAMERA_DO.get(id);
      return stub.fetch(new Request(`https://do/${ingestMatch[1]}`, request));
    }

    // Explicit rejection is retained as a migration hint, not an inference path.
    const frameMatch = url.pathname.match(/^\/frame\/camera\/([\w-]+)$/);
    if (frameMatch && request.method === "POST") {
      return Response.json({error: "edge_observation_required", route: `/observation/camera/${frameMatch[1]}`}, {status: 409});
    }

    // Camera registry (calibration, context, status)
    if (url.pathname === "/cameras" && request.method === "GET") {
      const rows = await env.DB.prepare(
        "SELECT camera_id, location, context_json, last_seen_ms FROM cameras"
      ).all();
      return Response.json(rows.results ?? []);
    }

    // Authenticated live coordinator metadata; no transient JPEG bytes.
    const stateMatch = url.pathname.match(/^\/state\/camera\/([\w-]+)$/);
    if (stateMatch && request.method === "GET") {
      const stub = env.CAMERA_DO.get(env.CAMERA_DO.idFromName(stateMatch[1]));
      return stub.fetch(new Request(`https://do/${stateMatch[1]}`));
    }

    // Recent events for dashboards
    if (url.pathname === "/events" && request.method === "GET") {
      const rows = await env.DB.prepare(
        "SELECT * FROM events ORDER BY ts_ms DESC LIMIT 100"
      ).all();
      return Response.json(rows.results ?? []);
    }

    return new Response("not found", { status: 404 });
  },

};

function operatorInteger(url,name,fallback) {
  const value=url.searchParams.get(name);
  if (value===null) return fallback;
  if (!/^[1-9][0-9]*$/.test(value) || url.searchParams.getAll(name).length!==1 || !Number.isSafeInteger(Number(value)))
    throw new OperatorError(400,'operator_invalid_pagination');
  return Number(value);
}

async function handleOperatorRequest(request,env,url) {
  try {
    const match=url.pathname.match(/^\/operator\/cameras\/([A-Za-z0-9_-]{1,128})\/(reviews|recovery|recovery-audits)$/);
    if (!match) return Response.json({error:'not_found'},{status:404});
    const [,cameraId,action]=match;
    if (!['GET','POST'].includes(request.method)) return Response.json({error:'method_not_allowed'},{status:405});
    if (action==='recovery-audits' && request.method!=='GET') return Response.json({error:'method_not_allowed'},{status:405});
    if (request.method==='POST') {
      const origin=request.headers.get('origin');
      if ((origin!==null && origin!==url.origin) || request.headers.get('sec-fetch-site')==='cross-site')
        throw new OperatorError(403,'operator_cross_origin_forbidden');
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')
        throw new OperatorError(415,'operator_json_required');
    }
    const principal=await authorizeOperator(request,env,action==='reviews'?'cause:review':'inference:recover',cameraId);
    if (action!=='reviews') {
      // The receiving isolate re-verifies the ORIGINAL signed assertion. A
      // serialized principal or an ingest-supplied reviewer flag is not trusted.
      const stub=env.CAMERA_DO.get(env.CAMERA_DO.idFromName(cameraId));
      return stub.fetch(new Request(`https://do/${cameraId}/operator/${action}${url.search}`,request));
    }
    if (request.method==='POST') {
      const body=await readBoundedJson(request,32768);
      return Response.json(await submitCauseReview(env.DB,principal,cameraId,body));
    }
    return Response.json(await listCauseReviews(env.DB,principal,cameraId,url.searchParams.get('incident_id'),
      {limit:operatorInteger(url,'limit',50),beforeRevision:operatorInteger(url,'before_revision',null)}));
  } catch(error) {
    if (error instanceof OperatorError) return Response.json({error:error.code},{status:error.status});
    if (error instanceof IngressError) return ingressErrorResponse(error);
    return Response.json({error:'operator_storage_unavailable'},{status:503});
  }
}

async function handleEdgeObservation(request, env, cameraId) {
  let body, observation;
  try {
    body = await readBoundedJson(request);
    validateCameraIdentity(body, cameraId);
    observation = validateObservation(body);
    if (typeof body.camera_id !== "string") throw new IngressError(400, "camera_id_required");
    if (["snapshot_key", "snapshot_keys", "snap_b64", "r2_key"].some(key => Object.hasOwn(body, key))) {
      throw new IngressError(400, "client_snapshot_keys_not_allowed");
    }
    validateFrame({ ...body, width: body.frame_wh[0], height: body.frame_wh[1] }, cameraId);
  } catch (error) {
    return ingressErrorResponse(error);
  }

  // All identity, detection and JPEG resource checks precede even DO lookup.
  const stub = env.CAMERA_DO.get(env.CAMERA_DO.idFromName(cameraId));
  const snapshot = await stub.fetch(new Request(`https://do/${cameraId}/snapshot`, {
    method: "POST",
    body: JSON.stringify({ ts_ms: body.ts_ms, snap_b64: body.jpeg_b64 }),
  }));
  if (!snapshot.ok) return snapshot;
  const ingest = await stub.fetch(new Request(`https://do/${cameraId}`, {
    method: "POST",
    body: JSON.stringify({ camera_id: cameraId, ts_ms: observation.ts_ms,
      frame_wh: observation.frame_wh, detections: observation.detections,
      edge_observation: true,
      visibility: observation.visibility, camera_motion: observation.camera_motion }),
  }));
  if (!ingest.ok) return ingest;
  let state;
  try {
    state = await readBoundedJson(ingest, 65536);
    if (!state || !["idle", "watch", "confirmed"].includes(state.alert) ||
        !Number.isSafeInteger(state.hits) || state.hits < 0 ||
        !Array.isArray(state.published) || !state.published.every(event => typeof event === "string")) {
      throw new Error("invalid_camera_state");
    }
  } catch {
    return Response.json({ error: "invalid_camera_state" }, { status: 502 });
  }
  return Response.json({ camera_id: cameraId, alert: state.alert, hits: state.hits, events: state.published });
}


