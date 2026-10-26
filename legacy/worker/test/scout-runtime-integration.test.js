import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import worker from '../src/index.js';
import { CameraDO } from '../src/camera-do.js';
import { InferenceBatchStore } from '../src/inference-runtime.js';
import { SCOUT_MODEL_ID } from '../src/inference-runtime.js';
import { buildInvestigationSchema, buildInvestigationGenerationSchema, buildInvestigationGenerationSchemaV3,
  qualifyModelInvestigation } from '../src/investigation.js';

const model = '@cf/meta/llama-4-scout-17b-16e-instruct';
const frames = [1000,2000].map(ts_ms => ({frame_id:`frame-${ts_ms}`,ts_ms,roles:['recent'],image_b64:'AQI='}));
const response = () => ({observations:[{kind:'flame_at_tool',frame_ids:frames.map(f=>f.frame_id),description:'Flame remains at the tool tip.'}],
  hypothesis:{ignition_source:'unknown',ignition_tool:'unknown',fuel_type:'unknown',confidence:'low',action_frame_ids:[],ignition_frame_id:null},
  scene_assessment:{category:'contained_flame',confidence:'medium',frame_ids:frames.map(f=>f.frame_id),limitations:[]}});
const usage={prompt_tokens:100,completion_tokens:50,total_tokens:150};
const capturedLighterResponse=JSON.parse(readFileSync(fileURLToPath(new URL(
  '../../test_fixtures/scout-v3-lighter-frame-by-frame-response.json',import.meta.url)),'utf8'));
const makeCamera = env => new CameraDO({storage:{},getWebSockets:()=>[]}, {VLM_PROVIDER:'workers_ai',VLM_MODEL:model,...env});

test('Scout generation schema avoids unsupported uniqueItems while application validation still rejects duplicate frame references',()=>{
  assert.ok(!JSON.stringify(buildInvestigationGenerationSchema(frames)).includes('uniqueItems'));
  assert.ok(JSON.stringify(buildInvestigationSchema(frames)).includes('uniqueItems'));
  const raw=response();raw.observations[0].frame_ids=['frame-1000','frame-1000'];
  const qualified=qualifyModelInvestigation(raw,frames);
  assert.ok(qualified.validation_errors.some(error=>error.includes('frame_ids')));
  assert.equal(qualified.scene_assessment.support,'insufficient_evidence');
});

async function withBudget(run) {
  const db = new DatabaseSync(':memory:');
  const storage={sql:{exec(query,...args){const s=db.prepare(query);const rows=s.columns().length?s.all(...args):(s.run(...args),[]);return {toArray:()=>rows};}},transactionSync(fn){db.exec('BEGIN');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};
  const store = new InferenceBatchStore(storage);
  const now=Date.now();
  store.configure({batch_id:'integration',max_calls:1,diagnostics:true,cache_mode:'read_write',account_snapshot:{
    version:1,source:'cloudflare_workers_ai_dashboard',model:SCOUT_MODEL_ID,
    utc_day:new Date(now).toISOString().slice(0,10),remaining_neurons:10000,observed_at_ms:now,usage_through_ms:now}});
  const binding={idFromName:name=>name,get:()=>({fetch:async request=>{
    const action=new URL(request.url).pathname.split('/').at(-1);
    const body=request.method==='POST'?await request.json():{};
    if(new URL(request.url).pathname.startsWith('/__production_inference_budget/')) {
      if(action==='reserve') {store.configure(body.batch);return Response.json(store.reserve(body.key,false,true,body.max_neurons));}
      return Response.json(store.complete(body.key,body));
    }
    const result=action==='reserve'?store.reserve(body.key):action==='complete'?store.complete(body.key,body):action==='annotate'?store.annotate(body.key,body.validation_errors):store.snapshot();
    return Response.json(result);
  }})};
  try {await run({store,binding});} finally {db.close();}
}

test('actual native request carries shared image-bound schema and preserves returned usage',async()=>withBudget(async({binding})=>{
  let request;
  const result=await makeCamera({APP_ENV:'development',VLM_EVALUATION_MODE:'true',CAMERA_DO:binding,
    AI:{run:async(_model,input)=>{request=input;return {response:response(),usage};}}}).analyzeCause({frames});
  assert.deepEqual(request.response_format,{type:'json_schema',json_schema:buildInvestigationGenerationSchemaV3(frames)});
  assert.equal(request.messages[0].content.filter(item=>item.type==='image_url').length,2);
  assert.deepEqual(result.inference_metadata,{mode:'fresh',usage});
  assert.equal(result.scene_assessment.support,'frame_linked_unverified');
}));

test('production inference uses a deterministic budget key and settles a shared neuron reservation',async()=>withBudget(async({store,binding})=>{
  let request,calls=0;
  const now=Date.now();
  const allowance={version:1,source:'cloudflare_workers_ai_dashboard',model:SCOUT_MODEL_ID,
    utc_day:new Date(now).toISOString().slice(0,10),remaining_neurons:10000,observed_at_ms:now,usage_through_ms:now};
  const result=await makeCamera({APP_ENV:'production',CAMERA_DO:binding,VLM_ALLOWANCE_SNAPSHOT_JSON:JSON.stringify(allowance),
    AI:{run:async(_model,input)=>{calls++;request=input;return {response:response(),usage};}}}).analyzeCause({frames});
  assert.equal(calls,1);
  assert.ok(request);
  assert.equal(result.source,'workers_ai');
  assert.equal(result.inference_metadata.mode,'fresh');
  assert.equal(store.snapshot().day_fresh_calls,1);
  assert.equal(store.snapshot().in_flight,0);
  assert.equal(store.snapshot().neuron_reservations.length,1);
}));

test('production refuses fresh inference when account allowance has not been reconciled',async()=>{
  let calls=0;
  const result=await makeCamera({APP_ENV:'production',AI:{run:async()=>{calls++;return {response:response(),usage};}}})
    .analyzeCause({frames});
  assert.equal(calls,0);
  assert.equal(result.vlm_error,'vlm_budget_reconciliation_required');
  assert.equal(result.inference_metadata.mode,'skipped');
});

test('the advertised guided_json transport uses the identical image-bound schema without a second output contract',async()=>withBudget(async({binding})=>{
  let request;
  const result=await makeCamera({APP_ENV:'development',VLM_EVALUATION_MODE:'true',CAMERA_DO:binding,
    VLM_SCHEMA_TRANSPORT:'guided_json',AI:{run:async(_model,input)=>{request=input;return {response:response(),usage};}}}).analyzeCause({frames});
  assert.deepEqual(request.guided_json,buildInvestigationGenerationSchemaV3(frames));
  assert.equal(request.response_format,undefined);
  assert.equal(result.scene_assessment.support,'frame_linked_unverified');
}));

test('separate cameras share a hard budget, cached evaluation reuses raw provider output and diagnostics remain separate',async()=>withBudget(async({store,binding})=>{
  let calls=0;
  const env={APP_ENV:'development',VLM_EVALUATION_MODE:'true',CAMERA_DO:binding,AI:{run:async()=>{calls++;return {response:response(),usage};}}};
  const first=await makeCamera(env).analyzeCause({frames});
  const cached=await makeCamera(env).analyzeCause({frames});
  const denied=await makeCamera(env).analyzeCause({frames:[{...frames[0],image_b64:'AwQ='}]});
  assert.equal(calls,1);
  assert.equal(first.inference_metadata.mode,'fresh');
  assert.equal(cached.inference_metadata.mode,'cached');
  assert.equal(denied.vlm_error,'vlm_budget_exhausted');
  assert.equal(denied.inference_metadata.mode,'skipped');
  assert.deepEqual(store.snapshot().usage,usage);
  assert.equal(store.snapshot().in_flight,0);
  assert.equal(store.snapshot().diagnostics.length,2);
  assert.equal(first.raw,undefined);
  assert.equal(store.snapshot().captures.length,1);
}));

test('development budget APIs are unavailable in production, disabled dev, and nonloopback requests',async()=>{
  for(const [url,env] of [['https://production.example/dev/inference-batch',{APP_ENV:'production'}],
    ['http://127.0.0.1/dev/inference-batch',{APP_ENV:'development'}],
    ['https://tunnel.example/dev/inference-batch',{APP_ENV:'development',VLM_EVALUATION_MODE:'true'}]]){
    const result=await worker.fetch(new Request(url),env,{});
    assert.equal(result.status,404);
  }
});

test('remote evaluation budget is reachable only in authenticated isolated development',async()=>{
  let dispatched=0;
  const binding={idFromName:name=>name,get:()=>({fetch:async()=>{
    dispatched++;return Response.json({batch_id:'remote-evaluation'});
  }})};
  const request=(url,key)=>new Request(url,{headers:key===null?{}:{'x-api-key':key}});
  const url='https://fire-guard-eval-preview.example/dev/inference-batch';
  const remote={APP_ENV:'development',VLM_EVALUATION_MODE:'true',REMOTE_EVALUATION_ENABLED:'true',
    INGEST_API_KEY:'private-evaluation-key',CAMERA_DO:binding};
  for(const [target,env,key] of [
    [url,{...remote,APP_ENV:'production'},'private-evaluation-key'],
    [url,{...remote,REMOTE_EVALUATION_ENABLED:'false'},'private-evaluation-key'],
    [url,{...remote,INGEST_API_KEY:''},'private-evaluation-key'],
    [url,remote,'wrong-key'],
    ['http://fire-guard-eval-preview.example/dev/inference-batch',remote,'private-evaluation-key'],
  ])assert.equal((await worker.fetch(request(target,key),env,{})).status,404);
  assert.equal(dispatched,0);
  const accepted=await worker.fetch(request(url,'private-evaluation-key'),remote,{});
  assert.equal(accepted.status,200);
  assert.deepEqual(await accepted.json(),{batch_id:'remote-evaluation'});
  assert.equal(dispatched,1);
});

test('unversioned Scout prose keeps delayed reassessment urgent and never downgrades newer live state',async t=>{
  t.mock.method(Date,'now',()=>10000);
  let release, selectedIds;
  const tasks=[], events=[];
  const budget={idFromName:name=>name,get:()=>({fetch:async request=>{
    const action=new URL(request.url).pathname.split('/').at(-1);
    const body=await request.json();
    return Response.json(action==='reserve'?{mode:'fresh'}:action==='complete'?{completed:true}:{recorded:true});
  }})};
  const c=new CameraDO({storage:{},getWebSockets:()=>[],waitUntil:task=>tasks.push(task)}, {
    APP_ENV:'development',VLM_EVALUATION_MODE:'true',CAMERA_DO:budget,
    EVIDENCE_STORAGE:'pi',VLM_PROVIDER:'workers_ai',VLM_MODEL:model,
    CAMERA_CONTEXTS_JSON:JSON.stringify({controlled:{reviewed:true,reviewed_by:'test',reviewed_at_ms:0,occupied_area:false,known_hazards:[],critical_zones:[],expected_flame_use:true}}),
    DB:{prepare:()=>({bind:()=>({run:async()=>({success:true})})})},
    AI:{run:async(_model,input)=>{
      selectedIds=input.response_format.json_schema.properties.observations.items.properties.frame_ids.items.enum.slice(-2);
      return new Promise(resolve=>{release=()=>resolve({response:{...response(),
        observations:[{kind:'flame_at_tool',frame_ids:selectedIds,description:'Flame stays at the tool tip.'}],
        scene_assessment:{category:'contained_flame',confidence:'medium',frame_ids:selectedIds,limitations:[]}},usage});});
    }}
  });
  c.broadcast=messages=>events.push(...messages);
  const input=ts=>({ts_ms:ts,frame_wh:[100,80],detections:[{cls:'fire',conf:.8,bbox_xyxy:[0,0,20,20]}]});
  for(const ts of [0,333,666,999,1332]){await c.storeSnapshot(`snap:${ts}`,'AQI=');c.snapshotKeys.add(`snap:${ts}`);c.ingest(input(ts),'controlled');}
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(events.find(event=>event.type==='fire_confirmed').response_priority,'inspect_urgently');
  c.ingest(input(1666),'controlled');
  release();await Promise.all(tasks);
  const interval=events.find(event=>event.type==='cause_update');
  assert.equal(interval.priority_scope,'observed_interval');
  assert.equal(interval.response_priority,'inspect_urgently');
  assert.equal(interval.ts_ms,1332);
  assert.equal(c.snapshot().response_priority,'inspect_urgently');
  assert.equal(c.snapshot().scene_evidence_current,false);
});

test('captured Scout V3 lighter evidence changes only the observed interval priority',async t=>withBudget(async({binding})=>{
  const now=Date.now();
  const timelineStart=now-9_000;
  const tasks=[],events=[];
  const persisted=[];
  const context={reviewed:true,reviewed_by:'test-reviewer',reviewed_at_ms:now-1_000,review_expires_at_ms:now+100_000,
    expected_handheld_flame_use:true,occupied_area:false,known_hazards:[],critical_zones:[]};
  const c=new CameraDO({storage:{},getWebSockets:()=>[],waitUntil:task=>tasks.push(task)}, {
    APP_ENV:'development',VLM_EVALUATION_MODE:'true',SCOUT_HANDHELD_PRIORITY_ENABLED:'true',CAMERA_DO:binding,
    EVIDENCE_STORAGE:'pi',VLM_PROVIDER:'workers_ai',VLM_MODEL:model,
    CAMERA_CONTEXTS_JSON:JSON.stringify({controlled:context}),
    DB:{prepare:sql=>({bind:(...values)=>({run:async()=>{persisted.push({sql,values});return {success:true};}})})},
    AI:{run:async(_model,input)=>{
      const available=input.response_format.json_schema.properties.observations.items.properties.frame_ids.items.enum
        .slice().sort((a,b)=>Number(a.slice(6))-Number(b.slice(6)));
      assert.ok(available.length>=3,'the evidence pack must contain enough current frames');
      const capturedRows=capturedLighterResponse.tool_assertions.slice(-Math.min(4,available.length));
      const tracked=available.slice(-capturedRows.length);
      const remap=new Map(capturedRows.map((row,index)=>[row.frame_id,tracked[index]]));
      return {response:{contract_version:3,
        observations:capturedLighterResponse.observations.filter(item=>item.kind==='flame_at_tool')
          .slice(-tracked.length).map((item,index)=>({...item,frame_ids:[tracked[index]]})),
        hypothesis:structuredClone(capturedLighterResponse.hypothesis),scene_assertions:[],
        tool_assertions:capturedRows.map(row=>({...row,frame_id:remap.get(row.frame_id)}))},
        usage};
    }}
  });
  c.broadcast=messages=>events.push(...messages);
  for(const offset of [1_000,3_000,5_000,7_000,9_000]){
    const ts=timelineStart+offset;
    await c.storeSnapshot(`snap:${ts}`,'AQI=');
    c.snapshotKeys.add(`snap:${ts}`);
    c.ingest({ts_ms:ts,frame_wh:[100,80],detections:[{cls:'fire',conf:.8,bbox_xyxy:[10,10,25,30]}]},'controlled');
  }
  await new Promise(resolve=>setImmediate(resolve));
  await Promise.all(tasks);

  const confirmation=events.find(event=>event.type==='fire_confirmed');
  const interval=events.find(event=>event.type==='cause_update');
  assert.equal(confirmation?.response_priority,'inspect_urgently');
  assert.equal(interval?.priority_scope,'observed_interval');
  assert.equal(interval?.response_priority,'monitor',JSON.stringify(interval));
  assert.equal(interval?.operator_review_required,true);
  assert.equal(interval?.severity,'unknown');
  assert.equal(interval?.cause?.accepted_cause,'unknown');
  assert.equal(interval?.cause?.scene_assessment?.category,'contained_tool_flame');
  assert.deepEqual(interval?.cause?.validation_errors,[]);
  assert.equal(interval?.cause?.hazard_absence_verified,false);
  assert.equal(interval?.cause?.ignition_source,'unknown');
  const savedAnalysis=persisted.find(({values})=>values[4]==='analysis');
  assert.ok(savedAnalysis,'the Scout result must be persisted');
  assert.equal(JSON.parse(savedAnalysis.values[8]).priority_scope,'observed_interval');
  assert.equal(c.snapshot().response_priority,'inspect_urgently',
    'an observed-interval reassessment does not rewrite live incident state');
}));
