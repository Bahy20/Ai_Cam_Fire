import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import worker from '../src/index.js';
import { CameraDO } from '../src/camera-do.js';
import { canonicalObservationBatchHash } from '../src/observation-batch.js';
import { encodeCoordinatorState, decodeCoordinatorState } from '../src/coordinator-state.js';
import { qualifyModelInvestigation } from '../src/investigation.js';

// Header fixture: ingress bounds JPEG resources; it does not claim pixel decoding.
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 80, 0, 100, 3,
  1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xd9]).toString('base64');
const jpegSha256 = createHash('sha256').update(Buffer.from(jpeg,'base64')).digest('hex');
const detection = {cls: 'fire', conf: 0.8, bbox_xyxy: [-10, 0, 10, 10], area_px: 99999};
function observation(extra = {}) {
  return {camera_id: 'route', ts_ms: 0, frame_wh: [100, 80], detections: [detection], jpeg_b64: jpeg, ...extra};
}
function harness(overrides = {}) {
  const writes = [], dispatches = [], lookups = [], data = new Map();
  const camera = new CameraDO({storage: {
    put: async (key, value) => { writes.push(key); data.set(key, value); },
    get: async key => data.get(key), delete: async key => data.delete(key),
    setAlarm: async () => {}, getAlarm: async () => null, deleteAlarm: async () => {},
  }, getWebSockets: () => []}, {});
  const env = {APP_ENV: 'production', INGEST_API_KEY: 'test-edge-key', DETECTOR_PROVIDER: 'edge',
    CAMERA_DO: {idFromName: name => { lookups.push(name); return name; }, get: name => ({fetch: async request => {
      dispatches.push({name, url: request.url, body: await request.clone().json()});
      return camera.fetch(request);
    }})}, ...overrides};
  const run = (body = observation(), options = {}) => worker.fetch(new Request(
    `https://worker${options.path ?? '/observation/camera/route'}`, {
      method: options.method ?? 'POST',
      headers: options.key === null ? {} : {'x-api-key': options.key ?? 'test-edge-key'},
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }), env, {});
  return {env, run, camera, writes, dispatches, lookups, data};
}

async function verifiedPiJob({missingImageIndex=null,liveHandheldTest=false}={}) {
  const now=Date.now(), session='6bb18efc-10b8-4c75-a28f-499d572e7096';
  const policy={reviewed:true,reviewed_by:'test reviewer',reviewed_at_ms:now-1_000,
    review_expires_at_ms:now+60_000,expected_handheld_flame_use:true,occupied_area:false,
    known_hazards:[],critical_zones:[]};
  const h=harness({APP_ENV:'development',VLM_EVALUATION_MODE:'true',REMOTE_EVALUATION_ENABLED:'true'});
  Object.assign(h.camera.env,{APP_ENV:'development',VLM_EVALUATION_MODE:'true',
    CAMERA_CONTEXTS_JSON:JSON.stringify({route:policy}),
    SCOUT_HANDHELD_PRIORITY_ENABLED:'true',EVIDENCE_STORAGE:'pi',
    ...(liveHandheldTest?{SCOUT_HANDHELD_LIVE_TEST_ENABLED:'true'}:{})});
  const events=[];
  h.camera.broadcast=messages=>events.push(...messages);
  h.camera.startPreparedEnrichment=()=>{};
  const activation=await h.run({protocol_version:2,session_id:session,expected_generation:0},
    {path:'/v2/sessions/camera/route'});
  assert.equal(activation.status,200);
  const samples=Array.from({length:5},(_,index)=>({attempt_sequence:index+1,
    ts_ms:now-3_000+index*750,status:'ok',frame_wh:[100,80],
    detections:[{cls:'fire',conf:.8,bbox_xyxy:[10,10,25,30]}],
    jpeg_sha256:jpegSha256,local_image_available:true,visibility:liveHandheldTest?'unknown':'adequate',
    camera_motion:liveHandheldTest?null:false,
    quality:liveHandheldTest?{stability:'unknown',blur_score:null,occlusion:'unknown'}:
      {stability:'stable',blur_score:.1,occlusion:'none'},reason:null}));
  const body={protocol_version:2,session_id:session,generation:1,batch_sequence:1,
    clock_mode:'replay',payload_hash:'0'.repeat(64),samples};
  body.payload_hash=await canonicalObservationBatchHash(body);
  const response=await h.run(body,{path:'/v2/observations/camera/route'});
  assert.equal(response.status,200);
  const confirmation=events.find(event=>event.type==='fire_confirmed');
  assert.equal(confirmation?.response_priority,liveHandheldTest?'monitor':'inspect_urgently');
  if(liveHandheldTest) assert.ok(confirmation.priority_reasons.includes('scout_handheld_live_scene_review_pending'));
  const request=h.camera.pendingEvidenceRequest;
  assert.ok(request);
  let job;
  h.camera.startPreparedEnrichment=value=>{job=value;};
  const pack=await h.camera.acceptEvidencePack({protocol_version:2,session_id:request.session_id,
    generation:request.generation,request_id:request.request_id,incident_id:request.incident_id,
    analysis_job_id:request.analysis_job_id,frames:request.frames.map((frame,index)=>({
      frame_id:frame.frame_id,ts_ms:frame.ts_ms,attempt_sequence:frame.attempt_sequence,
      jpeg_sha256:frame.jpeg_sha256,...(index===missingImageIndex?{missing_reason:'not_in_local_archive'}:{image_b64:jpeg})}))},'route');
  assert.equal(pack.accepted,true);
  assert.ok(job);
  return {camera:h.camera,events,job};
}

test('verified Pi image pack can preserve a Scout-only historical monitor assessment', async () => {
  const {camera,events,job}=await verifiedPiJob();
  assert.ok(job.selection.length>=3,JSON.stringify(job.selection.map(frame=>frame.frame_id)));
  const selected=job.selection.slice(0,3);
  const frameIds=selected.map(frame=>frame.frame_id);
  const raw={contract_version:3,
    observations:frameIds.map(frame_id=>({frame_ids:[frame_id],kind:'flame_at_tool',
      description:'Flame is at the lighter tip.'})),
    hypothesis:{ignition_source:'unknown',ignition_tool:'unknown',fuel_type:'unknown',
      confidence:'low',action_frame_ids:[],ignition_frame_id:null},scene_assertions:[],
    tool_assertions:frameIds.map(frame_id=>({frame_id,candidate_id:null,tool_type:'lighter',
      flame_relation:'at_tool_tip',secondary_burning:'not_observed',smoke:'not_observed',
      occlusion:'not_observed'}))};
  const model=qualifyModelInvestigation(raw,{frames:job.selection.map(frame=>({...frame,image_b64:jpeg}))});
  assert.deepEqual(model.validation_errors,[]);
  assert.equal(model.scene_assessment.category,'contained_tool_flame');
  camera.analyzeCause=async()=>({...model,source:'workers_ai'});
  camera.recordEvent=async()=>{};
  await camera.enrich(job.ts,job);
  const interval=events.find(event=>event.type==='cause_update');
  assert.equal(interval?.priority_scope,'observed_interval');
  assert.equal(interval?.response_priority,'monitor',JSON.stringify(interval));
  assert.equal(camera.snapshot().response_priority,'inspect_urgently');
});

test('development live-camera test holds a lighter scene at monitor until fresh multi-frame Scout review', async()=>{
  const {camera,events,job}=await verifiedPiJob({liveHandheldTest:true});
  const initial=events.find(event=>event.type==='fire_confirmed');
  assert.equal(initial?.response_priority,'monitor','the development camera test must not flash urgent during its bounded assessment');
  assert.ok(initial?.priority_reasons.includes('scout_handheld_live_scene_review_pending'));
  assert.equal(Object.hasOwn(initial,'scout_handheld_live_test_enabled'),false);
  assert.equal(Object.hasOwn(initial,'scout_handheld_review_pending'),false);
  camera.analyzeCause=async({frames})=>{
    const selected=frames.slice(0,6);
    const frameIds=selected.map(frame=>frame.frame_id);
    const raw={contract_version:3,
      observations:frameIds.map(frame_id=>({frame_ids:[frame_id],kind:'flame_at_tool',
        description:'A lighter is visible with a small flame at its tip.'})),
      hypothesis:{ignition_source:'unknown',ignition_tool:'unknown',fuel_type:'unknown',
        confidence:'low',action_frame_ids:[],ignition_frame_id:null},scene_assertions:[],
      tool_assertions:frameIds.map(frame_id=>({frame_id,candidate_id:null,tool_type:'lighter',
        flame_relation:'at_tool_tip',secondary_burning:'not_observed',smoke:'not_observed',occlusion:'not_observed'}))};
    return {...qualifyModelInvestigation(raw,{frames:selected}),source:'workers_ai'};
  };
  camera.recordEvent=async()=>{};
  await camera.enrich(job.ts,job);
  const live=events.filter(event=>event.type==='fire_update'&&event.trigger==='scout_live_scene_review').at(-1);
  assert.equal(live?.priority_scope,'live');
  assert.equal(live?.response_priority,'monitor',JSON.stringify(live));
  assert.equal(camera.cause?.scene_assessment?.category,'contained_tool_flame');
  assert.equal(camera.snapshot().response_priority,'monitor');
});

test('development live-camera test returns to urgent when Scout cannot support a contained lighter scene',async()=>{
  const {camera,events,job}=await verifiedPiJob({liveHandheldTest:true});
  camera.analyzeCause=async()=>({source:'workers_ai',validation_errors:[],observations:[],
    scene_assessment:{contract_version:3,category:'uncertain',assertions:[],tool_assertions:[],
      frame_ids:[],provenance:'untrusted_model_output',support:'insufficient_evidence',
      validation_errors:[],limitations:[],evidence_interval:null}});
  camera.recordEvent=async()=>{};
  await camera.enrich(job.ts,job);
  const live=events.filter(event=>event.type==='fire_update'&&event.trigger==='scout_live_scene_review').at(-1);
  assert.equal(live?.response_priority,'inspect_urgently');
  assert.equal(live?.priority_scope,'live');
  assert.equal(live?.operator_review_required,true);
});

test('a partially missing Pi image pack keeps the historical priority urgent',async()=>{
  const {camera,events,job}=await verifiedPiJob({missingImageIndex:1});
  assert.equal(job.priority_input,null);
  camera.analyzeCause=async({frames})=>{
    const frameIds=frames.map(frame=>frame.frame_id);
    const raw={contract_version:3,
      observations:frameIds.map(frame_id=>({frame_ids:[frame_id],kind:'flame_at_tool',description:'Flame is at the lighter tip.'})),
      hypothesis:{ignition_source:'unknown',ignition_tool:'unknown',fuel_type:'unknown',confidence:'low',action_frame_ids:[],ignition_frame_id:null},
      scene_assertions:[],tool_assertions:frameIds.map(frame_id=>({frame_id,candidate_id:null,tool_type:'lighter',
        flame_relation:'at_tool_tip',secondary_burning:'not_observed',smoke:'not_observed',occlusion:'not_observed'}))};
    return {...qualifyModelInvestigation(raw,{frames}),source:'workers_ai'};
  };
  camera.recordEvent=async()=>{};
  await camera.enrich(job.ts,job);
  assert.equal(events.find(event=>event.type==='cause_update')?.response_priority,'inspect_urgently');
  assert.equal(camera.snapshot().response_priority,'inspect_urgently');
});

test('edge observations store evidence before ingest in the same camera DO without external inference or secrets', async t => {
  let externalCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { externalCalls++; throw new Error('external inference forbidden'); });
  const h = harness({DETECTOR_URL: 'https://obsolete.example.com/detect', VLM_URL: 'https://obsolete.example.com/analyze'});
  const response = await h.run();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {camera_id: 'route', alert: 'idle', hits: 1, events: []});
  assert.deepEqual(h.lookups, ['route']);
  assert.deepEqual(h.dispatches.map(({name, url}) => ({name, url})), [
    {name: 'route', url: 'https://do/route/snapshot'}, {name: 'route', url: 'https://do/route'},
  ]);
  assert.deepEqual(h.dispatches[0].body, {ts_ms: 0, snap_b64: jpeg});
  assert.equal(h.dispatches[1].body.jpeg_b64, undefined, 'image bytes are not detector output');
  assert.equal(h.data.get('snap:0'), jpeg);
  assert.equal(h.camera.cameraId, 'route');
  assert.equal(h.camera.window[0].ts, 0);
  assert.equal(h.camera.window[0].area, 100, 'DO recomputes clipped area rather than trusting client measurements');
  assert.equal(externalCalls, 0);
});

test('edge ingress rejects malformed observations, identity and client snapshot keys before any DO lookup', async t => {
  let externalCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { externalCalls++; throw new Error('external inference forbidden'); });
  const bomb = Buffer.from(jpeg, 'base64');
  bomb.writeUInt16BE(8193, 9);
  const cases = [
    ['{bad', 400], [null, 400], [[], 400],
    [observation({camera_id: 'other'}), 400], [observation({camera_id: undefined}), 400],
    [observation({snapshot_key: 'events/other/0.jpg'}), 400],
    [observation({snapshot_keys: ['events/other/0.jpg']}), 400],
    [observation({snap_b64: jpeg}), 400], [observation({r2_key: 'forged'}), 400],
    [observation({ts_ms: -1}), 422], [observation({ts_ms: '0'}), 422],
    [observation({frame_wh: undefined}), 422], [observation({frame_wh: [100]}), 422],
    [observation({frame_wh: [100, 80, 1]}), 422], [observation({frame_wh: [100, '80']}), 422],
    [observation({frame_wh: [8193, 1]}), 413], [observation({frame_wh: [5000, 5000]}), 413],
    [observation({frame_wh: [200, 80]}), 422],
    [observation({detections: undefined}), 422], [observation({detections: null}), 422],
    [observation({detections: [{...detection, conf: 2}]}), 422],
    [observation({detections: [{...detection, cls: 'person'}]}), 422],
    [observation({detections: [{...detection, bbox_xyxy: [10, 0, 0, 10]}]}), 422],
    [observation({detections: Array(257).fill(detection)}), 413],
    [observation({detections: [], error: 'jpeg_decode_failed'}), 422],
    [observation({visibility: 'clear'}), 422], [observation({camera_motion: 'false'}), 422],
    [observation({jpeg_b64: undefined}), 400], [observation({jpeg_b64: [jpeg]}), 400],
    [observation({jpeg_b64: '%%%='}), 422], [observation({jpeg_b64: 'AQID'}), 422],
    [observation({jpeg_b64: 'A'.repeat(5592412)}), 413],
    [observation({jpeg_b64: bomb.toString('base64')}), 413],
    [observation({jpeg_b64: Buffer.from([255, 216, 255, 217]).toString('base64')}), 422],
    [observation({frames: []}), 400],
  ];
  for (const [input, status] of cases) {
    const h = harness();
    const response = await h.run(input);
    assert.equal(response.status, status, `input keys: ${input && Object.keys(input)}`);
    assert.deepEqual(h.lookups, []);
    assert.deepEqual(h.dispatches, []);
    assert.deepEqual(h.writes, []);
    assert.equal(h.camera.window.length, 0);
  }
  assert.equal(externalCalls, 0);
});

test('edge upload retries and delayed packets cannot inflate temporal confirmation', async () => {
  const h = harness();
  for (let attempt = 0; attempt < 8; attempt++) {
    const response = await h.run(observation({ts_ms: 1000}));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.alert, 'idle');
    assert.equal(body.hits, 1);
    assert.deepEqual(body.events, []);
  }
  const delayed = await h.run(observation({ts_ms: 900}));
  assert.equal(delayed.status, 200);
  assert.equal(h.camera.window.length, 1);
  assert.equal(h.camera.window[0].ts, 1000);
  assert.equal(h.camera.trendWindow.length, 1);
});

test('edge auth fails closed before reading or dispatching observations', async () => {
  for (const key of [null, '', 'wrong']) {
    const h = harness();
    assert.equal((await h.run('{bad', {key})).status, 401);
    assert.deepEqual(h.lookups, []);
  }
  for (const INGEST_API_KEY of [undefined, '', '  ', 42]) {
    const h = harness({INGEST_API_KEY});
    assert.equal((await h.run()).status, 503);
    assert.deepEqual(h.lookups, []);
  }
});

test('edge body byte limit cancels an oversized stream despite missing or dishonest Content-Length', async () => {
  for (const headers of [{}, {'content-length': '1'}]) {
    let cancelled = false;
    const h = harness();
    const body = new ReadableStream({pull(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024)); },
      cancel() { cancelled = true; }});
    const request = new Request('https://worker/observation/camera/route', {method: 'POST', body, duplex: 'half',
      headers: {...headers, 'x-api-key': 'test-edge-key'}});
    assert.equal((await worker.fetch(request, h.env, {})).status, 413);
    assert.equal(cancelled, true);
    assert.deepEqual(h.lookups, []);
    assert.deepEqual(h.writes, []);
  }
});

test('edge mode disables legacy frame inference even when stale URLs and secrets are present', async t => {
  let externalCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { externalCalls++; throw new Error('external inference forbidden'); });
  const h = harness({DETECTOR_URL: 'https://obsolete.example.com/detect', DETECTOR_API_KEY: 'obsolete'});
  const response = await h.run({ts_ms: 0, width: 100, height: 80, jpeg_b64: jpeg}, {path: '/frame/camera/route'});
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {error: 'edge_observation_required', route: '/observation/camera/route'});
  assert.deepEqual(h.lookups, []);
  assert.equal(externalCalls, 0);
});

test('retired frame route rejects every provider instead of falling through to HTTP inference', async t => {
  let externalCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { externalCalls++; throw new Error('external inference forbidden'); });
  for (const DETECTOR_PROVIDER of ['EDGE', 'typo', '']) {
    const h = harness({DETECTOR_PROVIDER, DETECTOR_URL: 'https://obsolete.example.com/detect', DETECTOR_API_KEY: 'obsolete'});
    const response = await h.run({ts_ms: 0, width: 100, height: 80, jpeg_b64: jpeg}, {path: '/frame/camera/route'});
    assert.equal(response.status, 409);
    assert.deepEqual(h.lookups, []);
  }
  assert.equal(externalCalls, 0);
});

test('edge ingress preserves downstream rejections and never ingests after snapshot failure', async () => {
  for (const failedStage of ['snapshot', 'ingest']) {
    const calls = [];
    const h = harness({CAMERA_DO: {idFromName: name => name, get: () => ({fetch: async request => {
      const stage = request.url.endsWith('/snapshot') ? 'snapshot' : 'ingest';
      calls.push(stage);
      return stage === failedStage ? Response.json({error: `${stage}_rejected`}, {status: 422}) : Response.json({stored: true});
    }})}});
    const response = await h.run();
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error, `${failedStage}_rejected`);
    assert.deepEqual(calls, failedStage === 'snapshot' ? ['snapshot'] : ['snapshot', 'ingest']);
  }
});

test('invalid DO state output fails rather than returning a fabricated empty result', async () => {
  for (const makeOutput of [() => new Response('{bad'), () => Response.json(null), () => Response.json({}),
    () => Response.json({alert: 'idle', hits: -1, published: []}),
    () => Response.json({alert: 'unknown', hits: 0, published: []}),
    () => Response.json({alert: 'idle', hits: 0, published: null}),
    () => Response.json({alert: 'idle', hits: 0, published: [42]}),
    () => new Response(' '.repeat(65537))]) {
    const h = harness({CAMERA_DO: {idFromName: name => name, get: () => ({fetch: async request =>
      request.url.endsWith('/snapshot') ? Response.json({stored: true}) : makeOutput()})}});
    const response = await h.run();
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {error: 'invalid_camera_state'});
  }
});

test('edge response exposes actual temporal events from the same DO across observations', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('external inference forbidden'); });
  const h = harness();
  assert.equal((await h.run()).status, 200);
  const response = await h.run(observation({ts_ms: 1000}));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {camera_id: 'route', alert: 'watch', hits: 2, events: ['fire_watch']});
  assert.equal(h.data.get('snap:1000'), jpeg);
  assert.deepEqual(h.dispatches.map(d => d.name), ['route', 'route', 'route', 'route']);
});

test('valid empty edge observations are accepted, unlike detector errors or absent detections', async () => {
  const h = harness();
  const response = await h.run(observation({detections: []}));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {camera_id: 'route', alert: 'idle', hits: 0, events: []});
  assert.equal(h.camera.window.length, 1);
});

test('V2 batches activate with CAS, commit ordered observations once, retain retries, and fence legacy ingest', async t => {
  const h=harness();
  const jobs=[];
  h.camera.startPreparedEnrichment=job=>{jobs.push(job);h.camera.analysisActive=true;};
  const session='2cf1a098-15d8-45bc-96f1-87f776ec3611';
  const activation={protocol_version:2,session_id:session,expected_generation:0};
  const started=await h.run(activation,{path:'/v2/sessions/camera/route'});
  assert.equal(started.status,200);
  assert.deepEqual(await started.json(),{protocol_version:2,session_id:session,generation:1,idempotent:false});
  assert.equal(h.dispatches.length,1,'activation uses one DO request');
  assert.equal((await h.run(activation,{path:'/v2/sessions/camera/route'})).status,200,'lost activation ACK retries idempotently');
  assert.equal(h.camera.edgeGeneration,1);

  const now=Date.now();
  const detections=[{cls:'fire',conf:.8,bbox_xyxy:[10,10,30,30]}];
  const samples=Array.from({length:5},(_,index)=>({attempt_sequence:index+1,ts_ms:now-2000+index*100,
    status:'ok',frame_wh:[100,80],detections,jpeg_sha256:String(index).padStart(64,'a'),local_image_available:true,
    visibility:'adequate',camera_motion:false,quality:{stability:'stable',blur_score:.1,occlusion:'none'},reason:null}));
  const body={protocol_version:2,session_id:session,generation:1,batch_sequence:1,clock_mode:'live',
    payload_hash:'0'.repeat(64),samples};
  body.payload_hash=await canonicalObservationBatchHash(body);
  const accepted=await h.run(body,{path:'/v2/observations/camera/route'});
  assert.equal(accepted.status,200);
  const ack=await accepted.json();
  assert.equal(ack.final_state.alert,'confirmed');
  assert.equal(ack.accepted_through,5);
  assert.deepEqual(ack.dispositions.map(value=>value.status),Array(5).fill('accepted'));
  assert.deepEqual(ack.events.map(value=>value.type),['fire_confirmed']);
  assert.equal(ack.event_watermark,1);
  assert.equal(h.camera.observationBatchLedger.length,1);
  const durableShape=encodeCoordinatorState(h.camera);
  assert.deepEqual(decodeCoordinatorState(JSON.parse(JSON.stringify(durableShape))).observationBatchLedger,
    h.camera.observationBatchLedger);
  assert.equal(h.dispatches.length,3,'one request for session activation and one per batch, plus idempotent activation');
  assert.equal(jobs.length,1,'investigation intent is prepared only after the durable batch commit');

  const retried=await h.run(body,{path:'/v2/observations/camera/route'});
  assert.equal(retried.status,200);
  assert.deepEqual(await retried.json(),{...ack,idempotent:true});
  assert.equal(h.camera.eventSequence,1);
  assert.equal(h.camera.edgeAttemptSequence,5);
  assert.equal(jobs.length,1);

  const conflict=structuredClone(body);
  conflict.samples[0].detections=[];
  conflict.payload_hash=await canonicalObservationBatchHash(conflict);
  assert.equal((await h.run(conflict,{path:'/v2/observations/camera/route'})).status,409);

  const competing=await h.run({...activation,session_id:'34978c0a-95a4-422e-a8da-fb38cfe9f3b2'},
    {path:'/v2/sessions/camera/route'});
  assert.equal(competing.status,409,'stale CAS cannot take ownership');
  const legacy=await h.run(observation(),{path:'/observation/camera/route'});
  assert.equal(legacy.status,409,'V2 activation disables the legacy two-request path');
  assert.equal(h.camera.incidentId,ack.final_state.incident_id);
});

test('V2 exact evidence requests accept hash-bound JPEGs once and report oversized local images', async t => {
  const h=harness();
  const tasks=[];
  const records=[];
  h.camera.state.waitUntil=promise=>tasks.push(promise);
  h.camera.recordEvent=(...args)=>{records.push(args);return Promise.resolve();};
  const session='b54ea751-2bb9-41a0-a0cc-3b9b4c5dc7d4';
  await h.run({protocol_version:2,session_id:session,expected_generation:0},{path:'/v2/sessions/camera/route'});
  const bytes=Buffer.from(jpeg,'base64');
  const digest=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',value))]
    .map(byte=>byte.toString(16).padStart(2,'0')).join('');
  const hash=await digest(bytes);
  const now=Date.now();
  const samples=Array.from({length:5},(_,index)=>({attempt_sequence:index+1,ts_ms:now-1800+index*100,
    status:'ok',frame_wh:[100,80],detections:[detection],jpeg_sha256:hash,local_image_available:true,
    visibility:'adequate',camera_motion:false,quality:{stability:'stable',blur_score:.1,occlusion:'none'},reason:null}));
  const batch={protocol_version:2,session_id:session,generation:1,batch_sequence:1,clock_mode:'live',
    payload_hash:'0'.repeat(64),samples};
  batch.payload_hash=await canonicalObservationBatchHash(batch);
  const ackResponse=await h.run(batch,{path:'/v2/observations/camera/route'});
  assert.equal(ackResponse.status,200);
  const ack=await ackResponse.json();
  assert.equal(ack.pending_evidence_requests.length,1);
  const request=ack.pending_evidence_requests[0];
  assert.equal(request.status,'awaiting_images');
  assert.ok(request.frames.length>0 && request.frames.length<=6);
  const imageFrame=request.frames[0];
  const pack={protocol_version:2,session_id:session,generation:1,request_id:request.request_id,
    incident_id:request.incident_id,analysis_job_id:request.analysis_job_id,
    frames:request.frames.map(frame=>({frame_id:frame.frame_id,ts_ms:frame.ts_ms,
      attempt_sequence:frame.attempt_sequence,jpeg_sha256:frame.jpeg_sha256,image_b64:jpeg}))};
  const corrupted=Buffer.from(bytes);corrupted[15]=0x12;
  pack.frames[0].image_b64=corrupted.toString('base64');
  assert.equal((await h.run(pack,{path:'/v2/evidence/camera/route'})).status,422);
  pack.frames[0].image_b64=jpeg;
  const accepted=await h.run(pack,{path:'/v2/evidence/camera/route'});
  assert.equal(accepted.status,200);
  assert.equal((await accepted.json()).accepted,true);
  assert.equal(h.camera.transientSnapshots.get(`snap:${imageFrame.ts_ms}`),jpeg);
  assert.equal(tasks.length,1);
  const duplicate=await h.run(pack,{path:'/v2/evidence/camera/route'});
  assert.equal(duplicate.status,200);
  assert.equal((await duplicate.json()).idempotent,true);
  assert.equal(tasks.length,1,'duplicate pack must not start another investigation');
  await Promise.all(tasks);
  assert.equal(h.camera.analysisActive,false);
  assert.equal(h.camera.cause.source,'rules_fallback');
  assert.ok(records.some(([, , , metadata])=>metadata.evidence_manifest.some(frame=>
    frame.local_ref?.jpeg_sha256===hash)),'persisted manifest must retain the exact local image hash association');
  const roundTrip=decodeCoordinatorState(encodeCoordinatorState(h.camera));
  assert.deepEqual(roundTrip.evidenceManifest,h.camera.evidenceManifest);

  const missingHarness=harness();
  const missingTasks=[];
  missingHarness.camera.recordEvent=()=>Promise.resolve();
  missingHarness.camera.state.waitUntil=promise=>missingTasks.push(promise);
  const missingSession='88ec1aa9-6a69-4f66-9a6f-e4aa2e6dd410';
  await missingHarness.run({protocol_version:2,session_id:missingSession,expected_generation:0},
    {path:'/v2/sessions/camera/route'});
  const missingSamples=Array.from({length:5},(_,index)=>({...samples[index],
    ts_ms:now-1800+index*100,jpeg_sha256:'b'.repeat(64)}));
  const missingBatch={protocol_version:2,session_id:missingSession,generation:1,batch_sequence:1,
    clock_mode:'live',payload_hash:'0'.repeat(64),samples:missingSamples};
  missingBatch.payload_hash=await canonicalObservationBatchHash(missingBatch);
  const missingAck=await (await missingHarness.run(missingBatch,{path:'/v2/observations/camera/route'})).json();
  const missingRequest=missingAck.pending_evidence_requests[0];
  const missingPack={protocol_version:2,session_id:missingSession,generation:1,
    request_id:missingRequest.request_id,incident_id:missingRequest.incident_id,
    analysis_job_id:missingRequest.analysis_job_id,frames:missingRequest.frames.map(frame=>({
      frame_id:frame.frame_id,ts_ms:frame.ts_ms,attempt_sequence:frame.attempt_sequence,
      jpeg_sha256:frame.jpeg_sha256,missing_reason:'image_exceeds_limit'}))};
  const declaredMissing=await missingHarness.run(missingPack,{path:'/v2/evidence/camera/route'});
  assert.equal(declaredMissing.status,200);
  await Promise.all(missingTasks);
  assert.equal(missingHarness.camera.cause.vlm_error,'evidence_unavailable');
});

test('V2 follow-up asks the Pi for a fresh post-confirmation sequence spanning two seconds', async t => {
  const h=harness();
  h.camera.env.EVIDENCE_STORAGE='pi';
  h.camera.recordEvent=async()=>{};
  const policyNow=Date.now();
  const policy={reviewed:true,reviewed_by:'test reviewer',reviewed_at_ms:policyNow-1000,
    review_expires_at_ms:policyNow+60_000,expected_handheld_flame_use:true,occupied_area:false,
    known_hazards:[],critical_zones:[]};
  const modelHash='b'.repeat(64);
  Object.assign(h.camera.env,{CAMERA_CONTEXTS_JSON:JSON.stringify({route:policy}),
    HANDHELD_PRIORITY_ENABLED:'true',HANDHELD_MODEL_SHA256:modelHash});
  const jobs=[];
  h.camera.startPreparedEnrichment=job=>jobs.push(job);
  const session='f02df2a8-6ec1-45f8-b20a-d1258bc30c0c';
  const clock={value:Date.now()};
  t.mock.method(Date,'now',()=>clock.value);
  await h.run({protocol_version:2,session_id:session,expected_generation:0},{path:'/v2/sessions/camera/route'});
  let attempt=0;
  const makeSample=(ts,previousTs=null)=>({attempt_sequence:++attempt,ts_ms:ts,status:'ok',frame_wh:[100,80],
    detections:[{cls:'fire',conf:.8,bbox_xyxy:[10,10,25,30]}],jpeg_sha256:jpegSha256,local_image_available:true,
    visibility:'adequate',camera_motion:false,quality:{stability:'stable',blur_score:.1,occlusion:'none'},reason:null,
    ...(previousTs===null?{}:{handheld_candidate:{version:1,camera_id:'route',session_id:session,generation:1,
      candidate_id:'lighter-track-1',model_sha256:modelHash,source_ts_ms:ts,
      frame_ids:[`frame-${previousTs}`,`frame-${ts}`],tool_type:'lighter',flame_relation:'at_tool_tip',
      image_quality:'adequate',fire_region_count:1,smoke_evidence:'not_detected',
      secondary_burning_evidence:'not_detected'}})});
  const send=async(sequence,samples)=>{
    clock.value=samples.at(-1).ts_ms;
    const body={protocol_version:2,session_id:session,generation:1,batch_sequence:sequence,
      clock_mode:'live',payload_hash:'0'.repeat(64),samples};
    body.payload_hash=await canonicalObservationBatchHash(body);
    const response=await h.run(body,{path:'/v2/observations/camera/route'});
    assert.equal(response.status,200,await response.clone().text());
    return response.json();
  };
  const base=clock.value;
  const initialSamples=Array.from({length:5},(_,index)=>makeSample(base-2000+index*100,
    index?base-2000+(index-1)*100:null));
  const first=await send(1,initialSamples);
  assert.equal(first.final_state.alert,'confirmed');
  assert.equal(jobs.length,1);
  const initialRequest=h.camera.pendingEvidenceRequest;
  const confirmedPeak=h.camera.initialPeakTs;
  let previousTs=base-1600;
  const laterSamples=[];
  for(let index=1;index<=18;index++) {
    const ts=base-1600+index*333;
    laterSamples.push(makeSample(ts,previousTs));
    previousTs=ts;
  }
  await send(2,laterSamples.slice(0,12));
  const late=await send(3,laterSamples.slice(12));
  assert.equal(late.final_state.alert,'confirmed');
  assert.equal(h.camera.followupUsed,false,'the single follow-up waits until the first analysis finishes');
  const pack={protocol_version:2,session_id:initialRequest.session_id,generation:initialRequest.generation,
    request_id:initialRequest.request_id,incident_id:initialRequest.incident_id,
    analysis_job_id:initialRequest.analysis_job_id,
    frames:initialRequest.frames.map(frame=>({frame_id:frame.frame_id,ts_ms:frame.ts_ms,
      attempt_sequence:frame.attempt_sequence,jpeg_sha256:frame.jpeg_sha256,image_b64:jpeg}))};
  assert.equal((await h.run(pack,{path:'/v2/evidence/camera/route'})).status,200);
  const initialJob=jobs.at(-1);
  assert.equal(initialJob.reason,'initial_confirmation');
  h.camera.analyzeCause=async()=>({source:'rules_only',observations:[],validation_errors:[],scene_assessment:{category:'uncertain'}});
  await h.camera.enrich(initialJob.ts,initialJob);
  const followup=h.camera.pendingEvidenceRequest;
  assert.equal(followup?.reason,'later_scene_evidence');
  assert.ok(followup.frames.length>=3 && followup.frames.length<=6);
  assert.equal(h.camera.followupUsed,true);
  const captured=h.camera.handheldLease.frame_ids;
  const retained=h.camera.evidenceState.protected_selection;
  const temporal=retained.filter(frame=>frame.roles.includes('followup_context'));
  assert.ok(temporal.length>=3 && temporal.every(frame=>frame.ts_ms>confirmedPeak));
  assert.ok(temporal.at(-1).ts_ms-temporal[0].ts_ms>=2000);
  assert.ok(captured.every(frameId=>retained.some(frame=>frame.frame_id===frameId)),
    'follow-up retains both exact frames supporting the local track');
  assert.deepEqual(followup.frames.map(frame=>frame.frame_id).sort(),retained.map(frame=>frame.frame_id).sort());
});

test('V2 explicit gaps and server-stale samples break continuity without clearing a confirmed incident', async t => {
  const h=harness();
  h.camera.startPreparedEnrichment=()=>{};
  const session='667167b3-dca9-4661-980b-bc7a53cce81d';
  const clock={value:1_800_000_000_000};
  t.mock.method(Date,'now',()=>clock.value);
  await h.run({protocol_version:2,session_id:session,expected_generation:0},{path:'/v2/sessions/camera/route'});
  const positive={cls:'fire',conf:.8,bbox_xyxy:[10,10,30,30]};
  const makeSample=(attempt,ts,status='ok')=>({attempt_sequence:attempt,ts_ms:ts,status,
    frame_wh:status==='ok'?[100,80]:null,detections:status==='ok'?[positive]:null,
    jpeg_sha256:status==='ok'?'a'.repeat(64):null,local_image_available:status==='ok',visibility:'adequate',
    camera_motion:false,quality:{stability:'stable',blur_score:.1,occlusion:'none'},reason:status==='gap'?'inference_failed':null});
  const send=async(seq,samples)=>{
    const value={protocol_version:2,session_id:session,generation:1,batch_sequence:seq,clock_mode:'live',payload_hash:'0'.repeat(64),samples};
    value.payload_hash=await canonicalObservationBatchHash(value);
    const response=await h.run(value,{path:'/v2/observations/camera/route'});
    assert.equal(response.status,200);
    return response.json();
  };
  const first=await send(1,Array.from({length:5},(_,i)=>makeSample(i+1,clock.value-2000+i*100)));
  assert.equal(first.final_state.alert,'confirmed');
  const broken=await send(2,[makeSample(6,clock.value-1400,'gap'),makeSample(7,clock.value-1300,'ok')]);
  assert.deepEqual(broken.dispositions.map(d=>d.status),['gap','accepted']);
  assert.equal(broken.final_state.alert,'confirmed');
  assert.equal(h.camera.window.length,1,'the single negative after a gap is not enough to clear');
  clock.value+=10000;
  const stale=await send(3,[makeSample(8,clock.value-8000,'ok')]);
  assert.equal(stale.dispositions[0].status,'skipped_stale');
  assert.equal(stale.final_state.alert,'confirmed');
  assert.equal(h.camera.incidentId,first.final_state.incident_id);
});

test('handheld priority needs the reviewed policy, pinned model and current retained two-frame candidate', async () => {
  async function runCase({enabled,secondary='not_detected',multipleRegions=false}) {
    const now=Date.now(), hash='b'.repeat(64), session='2cf1a098-15d8-45bc-96f1-87f776ec3611';
    const context={reviewed:true,reviewed_by:'test operator',reviewed_at_ms:now-1000,
      review_expires_at_ms:now+60_000,expected_handheld_flame_use:true,occupied_area:false,
      known_hazards:[],critical_zones:[]};
    const h=harness({CAMERA_CONTEXTS_JSON:JSON.stringify({route:context}),
      HANDHELD_PRIORITY_ENABLED:enabled?'true':'false',HANDHELD_MODEL_SHA256:hash});
    Object.assign(h.camera.env,{CAMERA_CONTEXTS_JSON:JSON.stringify({route:context}),
      HANDHELD_PRIORITY_ENABLED:enabled?'true':'false',HANDHELD_MODEL_SHA256:hash});
    const events=[];
    h.camera.broadcast=messages=>events.push(...messages);
    let preparedJob=null;
    h.camera.startPreparedEnrichment=job=>{preparedJob=job;};
    const activation={protocol_version:2,session_id:session,expected_generation:0};
    assert.equal((await h.run(activation,{path:'/v2/sessions/camera/route'})).status,200);
    const samples=Array.from({length:5},(_,index)=>{
      const ts=now-1000+index*100;
      const detections=Array.from({length:multipleRegions?2:1},(_,region)=>({cls:'fire',conf:.8,
        bbox_xyxy:[10+region*30,10,25+region*30,30]}));
      const sample={attempt_sequence:index+1,ts_ms:ts,status:'ok',frame_wh:[100,80],detections,
        jpeg_sha256:jpegSha256,local_image_available:true,visibility:'adequate',
        camera_motion:false,quality:{stability:'stable',blur_score:.1,occlusion:'none'},reason:null};
      if(index>0) sample.handheld_candidate={version:1,camera_id:'route',session_id:session,generation:1,
        candidate_id:'lighter-track-1',model_sha256:hash,source_ts_ms:ts,
        frame_ids:[`frame-${ts-100}`,`frame-${ts}`],tool_type:'lighter',flame_relation:'at_tool_tip',
        image_quality:'adequate',fire_region_count:multipleRegions?2:1,smoke_evidence:'not_detected',
        secondary_burning_evidence:secondary};
      return sample;
    });
    const body={protocol_version:2,session_id:session,generation:1,batch_sequence:1,clock_mode:'live',
      payload_hash:'0'.repeat(64),samples};
    body.payload_hash=await canonicalObservationBatchHash(body);
    const response=await h.run(body,{path:'/v2/observations/camera/route'});
    assert.equal(response.status,200);
    const event=events.find(value=>value.type==='fire_confirmed');
    assert.ok(event);
    assert.equal(Object.hasOwn(event,'handheld_lease'),false);
    assert.equal(Object.hasOwn(event,'session_id'),false);
    return {event,camera:h.camera,h,events,preparedJob};
  }
  async function provideRequestedImages(run) {
    const request=run.camera.pendingEvidenceRequest;
    assert.ok(request);
    run.camera.startPreparedEnrichment=job=>{run.preparedJob=job;};
    const result=await run.camera.acceptEvidencePack({protocol_version:2,session_id:request.session_id,
      generation:request.generation,request_id:request.request_id,incident_id:request.incident_id,
      analysis_job_id:request.analysis_job_id,frames:request.frames.map(({frame_id,ts_ms,attempt_sequence,jpeg_sha256})=>
        ({frame_id,ts_ms,attempt_sequence,jpeg_sha256,image_b64:jpeg}))},'route');
    assert.equal(result.accepted,true);
    return run.preparedJob;
  }

  const eligible=await runCase({enabled:true});
  assert.equal(eligible.event.response_priority,'monitor',JSON.stringify(eligible.event));
  assert.equal(eligible.event.severity,'unknown');
  assert.equal(eligible.event.operator_review_required,true);
  assert.ok(eligible.event.priority_reasons.includes('reviewed_handheld_policy_with_current_local_tool_track'));
  assert.equal(Object.hasOwn(eligible.camera.snapshot(),'handheld_lease'),false);
  assert.deepEqual(eligible.preparedJob.sceneContext.handheld_candidates[0].frame_ids,
    eligible.camera.handheldLease.frame_ids,'both actual track frames are retained and attached to the V3 Scout contract');

  const scoutContradiction=await runCase({enabled:true});
  const lease=scoutContradiction.camera.handheldLease;
  await provideRequestedImages(scoutContradiction);
  const hazardousCause={source:'workers_ai',validation_errors:[],scene_assessment:{contract_version:3,
    category:'material_burning',assertions:[],tool_assertions:lease.frame_ids.map(frame_id=>({frame_id,
      candidate_id:lease.candidate_id,tool_type:'lighter',flame_relation:'at_tool_tip',
      secondary_burning:'present',smoke:'not_observed',occlusion:'not_observed'})),
    frame_ids:[...lease.frame_ids],provenance:'untrusted_model_output',support:'insufficient_evidence',
    validation_errors:[],evidence_interval:{start_ts_ms:lease.first_frame_ts_ms,end_ts_ms:lease.source_ts_ms}}};
  scoutContradiction.camera.analyzeCause=async()=>hazardousCause;
  scoutContradiction.camera.recordEvent=async()=>{};
  await scoutContradiction.camera.enrich(scoutContradiction.preparedJob.ts,
    scoutContradiction.preparedJob);
  const scoutUpdate=scoutContradiction.events.filter(value=>value.type==='fire_update').at(-1);
  assert.equal(scoutUpdate?.response_priority,'inspect_urgently',
    'a contradictory Scout material-burning result must revoke the live monitor priority');
  assert.equal(scoutUpdate?.trigger,'handheld_scene_assessment_hazard');
  assert.equal(scoutContradiction.camera.handheldLease,null);
  assert.equal(scoutContradiction.camera.handheldHazardLatchIncidentId,scoutContradiction.camera.incidentId);

  const delayedHazard=await runCase({enabled:true});
  await provideRequestedImages(delayedHazard);
  const delayedLease=delayedHazard.camera.handheldLease;
  const delayedCause={...hazardousCause,scene_assessment:{...hazardousCause.scene_assessment,
    frame_ids:[...delayedLease.frame_ids],tool_assertions:delayedLease.frame_ids.map(frame_id=>({
      frame_id,candidate_id:delayedLease.candidate_id,tool_type:'lighter',flame_relation:'at_tool_tip',
      secondary_burning:'present',smoke:'not_observed',occlusion:'not_observed'}))}};
  const expiredAt=delayedLease.expires_at_ms;
  delayedHazard.camera.expireHandheldLease(expiredAt);
  assert.equal(delayedHazard.camera.handheldLease,null);
  const delayedJob=delayedHazard.preparedJob;
  const delayedManifest=delayedJob.selection.map(({frame_id,ts_ms})=>({frame_id,ts_ms}));
  assert.equal(delayedHazard.camera.applyHandheldSceneResult(delayedCause,
    {...delayedJob,jobId:delayedJob.jobId+1},delayedManifest,expiredAt+1),null);
  assert.equal(delayedHazard.camera.handheldHazardLatchIncidentId,null,'obsolete jobs cannot latch the current incident');
  const delayedUpdate=delayedHazard.camera.applyHandheldSceneResult(delayedCause,
    delayedJob,delayedManifest,expiredAt+1);
  assert.equal(delayedHazard.camera.handheldHazardLatchIncidentId,delayedHazard.camera.incidentId,
    'current hazardous Scout evidence must latch urgency even after the local lease expires');
  assert.equal(delayedUpdate?.response_priority,'inspect_urgently');
  assert.equal(delayedUpdate?.trigger,'handheld_scene_assessment_hazard');

  const unavailableScout=await runCase({enabled:true});
  await provideRequestedImages(unavailableScout);
  const independentLease=unavailableScout.camera.handheldLease;
  const unavailableResult=unavailableScout.camera.applyHandheldSceneResult({source:'rules_fallback',
    vlm_error:'vlm_timeout',validation_errors:[],scene_assessment:{category:'uncertain'}},
    unavailableScout.preparedJob,[],Date.now());
  assert.equal(unavailableResult,null,'provider unavailability alone is not contradictory scene evidence');
  assert.equal(unavailableScout.camera.handheldLease,independentLease,
    'an unavailable second opinion must not revoke an independently qualified current local lease');
  unavailableScout.camera.handheldLease=null;
  unavailableScout.camera.applyHandheldSceneResult({source:'rules_fallback',vlm_error:'vlm_timeout'},
    unavailableScout.preparedJob,[],Date.now());
  assert.equal(unavailableScout.camera.handheldLease,null,'provider failure cannot initiate monitoring');

  const scoutSupport=await runCase({enabled:true});
  const supportedLease=scoutSupport.camera.handheldLease;
  await provideRequestedImages(scoutSupport);
  const capturedIds=scoutSupport.preparedJob.sceneContext.handheld_candidates[0].frame_ids;
  const containedCause={source:'workers_ai',validation_errors:[],scene_assessment:{contract_version:3,
    category:'contained_tool_flame',assertions:[],tool_assertions:capturedIds.map(frame_id=>({frame_id,
      candidate_id:supportedLease.candidate_id,tool_type:'lighter',flame_relation:'at_tool_tip',
      secondary_burning:'not_observed',smoke:'not_observed',occlusion:'not_observed'})),
    frame_ids:[...capturedIds],provenance:'untrusted_model_output',support:'insufficient_evidence',
    validation_errors:[],evidence_interval:{start_ts_ms:supportedLease.first_frame_ts_ms,end_ts_ms:supportedLease.source_ts_ms}}};
  scoutSupport.camera.analyzeCause=async()=>containedCause;
  scoutSupport.camera.recordEvent=async()=>{};
  await scoutSupport.camera.enrich(scoutSupport.preparedJob.ts,
    scoutSupport.preparedJob);
  assert.equal(scoutSupport.events.some(value=>value.type==='fire_update'),false,
    JSON.stringify({updates:scoutSupport.events.filter(value=>value.type==='fire_update'),lease:scoutSupport.camera.handheldLease,
      context:scoutSupport.preparedJob.sceneContext,manifest:scoutSupport.camera.evidenceManifest.map(frame=>frame.frame_id),scene:containedCause.scene_assessment}));
  assert.ok(scoutSupport.camera.handheldLease);

  const scoutUnclear=await runCase({enabled:true});
  const unclearLease=scoutUnclear.camera.handheldLease;
  await provideRequestedImages(scoutUnclear);
  scoutUnclear.camera.analyzeCause=async()=>({source:'workers_ai',validation_errors:[],scene_assessment:{
    contract_version:3,category:'uncertain',assertions:[],tool_assertions:[],frame_ids:[...unclearLease.frame_ids],
    provenance:'untrusted_model_output',support:'insufficient_evidence',validation_errors:[],evidence_interval:null}});
  scoutUnclear.camera.recordEvent=async()=>{};
  await scoutUnclear.camera.enrich(scoutUnclear.preparedJob.ts,
    scoutUnclear.preparedJob);
  const unclearUpdate=scoutUnclear.events.filter(value=>value.type==='fire_update').at(-1);
  assert.equal(unclearUpdate?.response_priority,'inspect_urgently');
  assert.equal(unclearUpdate?.trigger,'handheld_scene_assessment_uncertain');
  assert.equal(scoutUnclear.camera.handheldHazardLatchIncidentId,null,
    'uncertainty requires fresh qualification but is distinct from a positive hazard latch');
  const uploadFresh=async(sample,batchSequence)=>{
    const body={protocol_version:2,session_id:'2cf1a098-15d8-45bc-96f1-87f776ec3611',generation:1,
      batch_sequence:batchSequence,clock_mode:'live',payload_hash:'0'.repeat(64),samples:[sample]};
    body.payload_hash=await canonicalObservationBatchHash(body);
    return scoutUnclear.h.run(body,{path:'/v2/observations/camera/route'});
  };
  const uncertainTs=scoutUnclear.camera.lastObservationTs, firstNewTs=uncertainTs+100, secondNewTs=firstNewTs+100;
  const freshSample=(attempt,ts,previousTs)=>({attempt_sequence:attempt,ts_ms:ts,status:'ok',frame_wh:[100,80],
    detections:[{cls:'fire',conf:.8,bbox_xyxy:[10,10,25,30]}],jpeg_sha256:String(attempt).repeat(64).slice(0,64),
    local_image_available:true,visibility:'adequate',camera_motion:false,
    quality:{stability:'stable',blur_score:.1,occlusion:'none'},reason:null,
    handheld_candidate:{version:1,camera_id:'route',session_id:'2cf1a098-15d8-45bc-96f1-87f776ec3611',
      generation:1,candidate_id:'lighter-track-1',model_sha256:'b'.repeat(64),source_ts_ms:ts,
      frame_ids:[`frame-${previousTs}`,`frame-${ts}`],tool_type:'lighter',flame_relation:'at_tool_tip',
      image_quality:'adequate',fire_region_count:1,smoke_evidence:'not_detected',secondary_burning_evidence:'not_detected'}});
  assert.equal((await uploadFresh(freshSample(6,firstNewTs,uncertainTs),2)).status,200);
  assert.equal(scoutUnclear.camera.handheldLease,null,'a pair that reuses a pre-veto frame cannot restore monitoring');
  assert.equal((await uploadFresh(freshSample(7,secondNewTs,firstNewTs),3)).status,200);
  assert.ok(scoutUnclear.camera.handheldLease,'a wholly new two-frame candidate can qualify after uncertainty');
  assert.equal(scoutUnclear.events.filter(value=>value.type==='fire_update').at(-1).response_priority,'monitor');

  const hazardNextTs=delayedHazard.camera.lastObservationTs+100;
  const hazardFollowup={protocol_version:2,session_id:'2cf1a098-15d8-45bc-96f1-87f776ec3611',
    generation:1,batch_sequence:2,clock_mode:'live',payload_hash:'0'.repeat(64),
    samples:[freshSample(6,hazardNextTs,delayedHazard.camera.lastObservationTs)]};
  hazardFollowup.payload_hash=await canonicalObservationBatchHash(hazardFollowup);
  assert.equal((await delayedHazard.h.run(hazardFollowup,{path:'/v2/observations/camera/route'})).status,200);
  assert.equal(delayedHazard.camera.handheldLease,null,'a new local candidate cannot undo the delayed hazard veto');
  assert.equal(delayedHazard.events.filter(value=>value.type==='fire_update').at(-1).response_priority,'inspect_urgently');

  const localOnly=await runCase({enabled:true});
  const localOnlyTs=localOnly.camera.lastObservationTs+100;
  const mismatched={attempt_sequence:6,ts_ms:localOnlyTs,status:'ok',frame_wh:[100,80],detections:[],
    jpeg_sha256:'d'.repeat(64),local_image_available:true,visibility:'adequate',camera_motion:false,
    quality:{stability:'stable',blur_score:.1,occlusion:'none'},reason:null,
    handheld_candidate:{version:1,camera_id:'route',session_id:'2cf1a098-15d8-45bc-96f1-87f776ec3611',
      generation:1,candidate_id:'lighter-track-1',model_sha256:'b'.repeat(64),source_ts_ms:localOnlyTs,
      frame_ids:[`frame-${localOnly.camera.lastObservationTs}`,`frame-${localOnlyTs}`],tool_type:'lighter',
      flame_relation:'at_tool_tip',image_quality:'adequate',fire_region_count:1,smoke_evidence:'not_detected',
      secondary_burning_evidence:'not_detected'}};
  const mismatchBatch={protocol_version:2,session_id:'2cf1a098-15d8-45bc-96f1-87f776ec3611',
    generation:1,batch_sequence:2,clock_mode:'live',payload_hash:'0'.repeat(64),samples:[mismatched]};
  mismatchBatch.payload_hash=await canonicalObservationBatchHash(mismatchBatch);
  const mismatchResponse=await localOnly.h.run(mismatchBatch,{path:'/v2/observations/camera/route'});
  assert.equal(mismatchResponse.status,200);
  const mismatchUpdate=localOnly.events.filter(value=>value.type==='fire_update').at(-1);
  assert.equal(mismatchUpdate.response_priority,'inspect_urgently',
    'local lighter evidence cannot renew a monitor lease when cloud detector has no flame region');

  for(const input of [{enabled:false},{enabled:true,secondary:'detected'},{enabled:true,multipleRegions:true}]) {
    const vetoed=await runCase(input);
    assert.notEqual(vetoed.event.response_priority,'monitor',JSON.stringify(input));
    if(input.secondary==='detected'||input.multipleRegions)
      assert.equal(vetoed.camera.handheldHazardLatchIncidentId,vetoed.camera.incidentId);
  }

  const active=await runCase({enabled:true});
  const priorTs=active.camera.lastObservationTs, nextTs=priorTs+100;
  active.camera.handheldQualificationRequiredAfterTs=priorTs;
  const followup={attempt_sequence:6,ts_ms:nextTs,status:'ok',frame_wh:[100,80],
    detections:[{cls:'fire',conf:.8,bbox_xyxy:[10,10,25,30]}],jpeg_sha256:'c'.repeat(64),
    local_image_available:true,visibility:'adequate',camera_motion:false,
    quality:{stability:'stable',blur_score:.1,occlusion:'none'},reason:null,
    handheld_candidate:{version:1,camera_id:'route',session_id:'2cf1a098-15d8-45bc-96f1-87f776ec3611',
      generation:1,candidate_id:'lighter-track-1',model_sha256:'b'.repeat(64),source_ts_ms:nextTs,
      frame_ids:[`frame-${priorTs}`,`frame-${nextTs}`],tool_type:'lighter',flame_relation:'at_tool_tip',
      image_quality:'adequate',fire_region_count:1,smoke_evidence:'not_detected',secondary_burning_evidence:'detected'}};
  const batch={protocol_version:2,session_id:'2cf1a098-15d8-45bc-96f1-87f776ec3611',generation:1,
    batch_sequence:2,clock_mode:'live',payload_hash:'0'.repeat(64),samples:[followup]};
  batch.payload_hash=await canonicalObservationBatchHash(batch);
  const response=await active.h.run(batch,{path:'/v2/observations/camera/route'});
  assert.equal(response.status,200);
  const urgent=active.events.filter(value=>value.type==='fire_update').at(-1);
  assert.equal(urgent.response_priority,'inspect_urgently');
  assert.equal(active.camera.handheldLease,null);
  assert.equal(active.camera.handheldHazardLatchIncidentId,active.camera.incidentId);
  assert.equal(active.camera.handheldQualificationRequiredAfterTs,null);
  assert.doesNotThrow(()=>encodeCoordinatorState(active.camera),
    'secondary-burning evidence must leave a checkpointable hazard transition');

  const interrupted=await runCase({enabled:true});
  const gapTs=interrupted.camera.lastObservationTs+100;
  const gap={attempt_sequence:6,ts_ms:gapTs,status:'gap',frame_wh:null,detections:null,jpeg_sha256:null,
    local_image_available:false,visibility:'unknown',camera_motion:null,
    quality:{stability:'unknown',blur_score:null,occlusion:'unknown'},reason:'capture_failed',handheld_candidate:null};
  const gapBatch={protocol_version:2,session_id:'2cf1a098-15d8-45bc-96f1-87f776ec3611',generation:1,
    batch_sequence:2,clock_mode:'live',payload_hash:'0'.repeat(64),samples:[gap]};
  gapBatch.payload_hash=await canonicalObservationBatchHash(gapBatch);
  const gapResponse=await interrupted.h.run(gapBatch,{path:'/v2/observations/camera/route'});
  assert.equal(gapResponse.status,200);
  assert.equal(interrupted.camera.handheldLease,null);
  const gapUpdate=interrupted.events.filter(value=>value.trigger==='observation_gap').at(-1);
  assert.equal(gapUpdate.response_priority,'inspect_urgently');
});

test('V2 batch rejects bad hashes and local-only replay clocks before any DO lookup', async () => {
  const h=harness();
  const session='2cf1a098-15d8-45bc-96f1-87f776ec3611';
  const sample={attempt_sequence:1,ts_ms:1,status:'gap',frame_wh:null,detections:null,jpeg_sha256:null,
    local_image_available:false,visibility:'unknown',camera_motion:null,
    quality:{stability:'unknown',blur_score:null,occlusion:'unknown'},reason:'capture_failed'};
  for (const [clock_mode,hashValid,expected] of [['live',false,400],['replay',true,403]]) {
    const body={protocol_version:2,session_id:session,generation:1,batch_sequence:1,clock_mode,
      payload_hash:'0'.repeat(64),samples:[sample]};
    if(hashValid) body.payload_hash=await canonicalObservationBatchHash(body);
    const response=await h.run(body,{path:'/v2/observations/camera/route'});
    assert.equal(response.status,expected);
    assert.deepEqual(h.lookups,[]);
  }
});

test('remote replay clock reaches only an authenticated development camera', async () => {
  const h=harness({APP_ENV:'development',VLM_EVALUATION_MODE:'true',
    REMOTE_EVALUATION_ENABLED:'true'});
  const session='2cf1a098-15d8-45bc-96f1-87f776ec3611';
  const sample={attempt_sequence:1,ts_ms:1,status:'gap',frame_wh:null,detections:null,
    jpeg_sha256:null,local_image_available:false,visibility:'unknown',camera_motion:null,
    quality:{stability:'unknown',blur_score:null,occlusion:'unknown'},reason:'capture_failed'};
  const batch={protocol_version:2,session_id:session,generation:1,batch_sequence:1,
    clock_mode:'replay',payload_hash:'0'.repeat(64),samples:[sample]};
  batch.payload_hash=await canonicalObservationBatchHash(batch);
  const route='/v2/observations/camera/route';
  assert.equal((await h.run(batch,{path:route,key:'wrong-key'})).status,401);
  assert.deepEqual(h.lookups,[]);
  const activated=await h.run({protocol_version:2,session_id:session,expected_generation:0},
    {path:'/v2/sessions/camera/route'});
  assert.equal(activated.status,200);
  const accepted=await h.run(batch,{path:route});
  assert.equal(accepted.status,200);
  assert.equal((await accepted.json()).accepted_through,1);
});
