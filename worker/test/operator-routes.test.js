import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {makeOperatorFixture} from './helpers/operator-jwt.js';
import {durableBackend} from './helpers/durable-backend.js';
import worker from '../src/index.js';

async function incident(store) {
  for(let i=0;i<5;i++) {
    const response=await store.request('/ingest/camera/cam',{body:{camera_id:'cam',ts_ms:i*1000,frame_wh:[100,80],
      detections:[{cls:'fire',conf:.8,bbox_xyxy:[0,0,20,20]}]}});
    assert.equal(response.status,200);
  }
  await store.settle();
  return store.eventDb.prepare("SELECT * FROM events WHERE event_kind='analysis'").get();
}

test('real signed operator review writes and reads an immutable separate attribution through public routes',async t=>{
  const fixture=await makeOperatorFixture();t.mock.method(globalThis,'fetch',fixture.fetcher);
  const store=durableBackend(fixture.env);
  try {
    const target=await incident(store),before=store.eventDb.prepare('SELECT * FROM events ORDER BY id').all();
    const body={request_id:randomUUID(),incident_id:target.incident_id,analysis_event_key:target.event_key,
      expected_revision:0,disposition:'accept',ignition_source:'electrical',ignition_tool:'unknown',
      independent_evidence:{kind:'verified_investigation',reference:'external-case-test-123',
        summary:'Synthetic human-review fixture; this is not evidence about a real fire.'},
      rationale:'This contract test exercises authenticated review; the operator claim is not machine-verified truth.'};
    const response=await store.request('/operator/cameras/cam/reviews',{body,headers:fixture.headers});
    assert.equal(response.status,200);const result=await response.json();
    assert.equal(result.operator_review.subject,'operator-1');assert.equal(result.operator_review.revision,1);
    assert.equal(result.operator_review.factual_correctness_verified,false);
    const read=await store.request(`/operator/cameras/cam/reviews?incident_id=${encodeURIComponent(target.incident_id)}`,{headers:fixture.headers});
    assert.equal(read.status,200);assert.deepEqual((await read.json()).reviews,[result.operator_review]);
    assert.deepEqual(store.eventDb.prepare('SELECT * FROM events ORDER BY id').all(),before);
  } finally {await store.settle();store.close();}
});

test('native recovery reauthorizes original assertions in the coordinator and needs two independently scoped identities',async t=>{
  const fixture=await makeOperatorFixture(),policy=JSON.parse(fixture.env.OPERATOR_POLICY_JSON);
  policy['operator-2']={email:'second@example.test',permissions:['inference:recover'],cameras:['cam']};
  fixture.env.OPERATOR_POLICY_JSON=JSON.stringify(policy);t.mock.method(globalThis,'fetch',fixture.fetcher);
  const store=durableBackend(fixture.env);
  try {
    await incident(store);store.camera().nativeInferenceInterrupted=true;store.camera().saveCoordinator();store.create();
    const read=await store.request('/operator/cameras/cam/recovery',{headers:fixture.headers});assert.equal(read.status,200);
    const {recovery}=await read.json();assert.equal(recovery.required,true);
    const proposal={request_id:randomUUID(),action:'propose',expected_generation:recovery.generation,
      expected_job_id:recovery.analysis_job_id,provider_outcome:'completed',provider_reference:'test-provider-case-123',
      rationale:'Synthetic provider-review fixture; externally verified real-world evidence is required operationally.'};
    const proposed=await store.request('/operator/cameras/cam/recovery',{body:proposal,headers:fixture.headers});assert.equal(proposed.status,200);
    const approval={request_id:randomUUID(),action:'approve',expected_generation:recovery.generation,
      expected_job_id:recovery.analysis_job_id,proposal_id:proposal.request_id,review_reference:'test-independent-check-456',
      rationale:'Synthetic second-operator verification exercises control plumbing, not backend cancellation.'};
    assert.equal((await store.request('/operator/cameras/cam/recovery',{body:approval,headers:fixture.headers})).status,403);
    const second={'cf-access-jwt-assertion':await fixture.sign({sub:'operator-2',email:'second@example.test'})};
    const accepted=await store.request('/operator/cameras/cam/recovery',{body:approval,headers:second});assert.equal(accepted.status,200);
    assert.equal((await accepted.json()).recovery.required,false);
    const history=await store.request('/operator/cameras/cam/recovery-audits',{headers:second});assert.equal(history.status,200);
    assert.equal((await history.json()).records.length,2);
    store.camera().nativeInferenceInterrupted=true;store.camera().saveCoordinator();store.create();
    const retry=await store.request('/operator/cameras/cam/recovery',{body:approval,headers:second});assert.equal(retry.status,200);
    const result=await retry.json();assert.equal(result.idempotent,true);assert.equal(result.recovery.required,true);
  } finally {await store.settle();store.close();}
});

test('ingest credentials, reviewer headers, missing config and cross-site forms grant no operator authority',async t=>{
  const fixture=await makeOperatorFixture();t.mock.method(globalThis,'fetch',fixture.fetcher);
  const store=durableBackend({...fixture.env,INGEST_API_KEY:'test-only-ingress-placeholder'});
  try {
    for(const action of ['reviews','recovery','recovery-audits']) {
      const denied=await store.request(`/operator/cameras/cam/${action}`,{headers:{'x-api-key':'test-only-ingress-placeholder',
        'x-reviewed-by':'operator-1'}});
      assert.equal(denied.status,401);assert.equal(denied.headers.get('cache-control'),'no-store');
    }
    assert.equal((await store.request('/operator/cameras/cam/reviews',{body:{},headers:{...fixture.headers,origin:'https://attacker.test'}})).status,403);
    assert.equal((await store.request('/operator/cameras/cam/reviews',{body:{},headers:{...fixture.headers,'content-type':'text/plain'}})).status,415);
    delete store.env.OPERATOR_ACCESS_ISSUER;
    assert.equal((await store.request('/operator/cameras/cam/reviews',{headers:fixture.headers})).status,503);
    assert.equal(store.eventDb.prepare('SELECT COUNT(*) AS total FROM operator_reviews').get().total,0);
  } finally {store.close();}
});

test('a credential expiring while the public request body arrives cannot commit a human review',async t=>{
  let now=1700000000000;t.mock.method(Date,'now',()=>now);
  const fixture=await makeOperatorFixture();t.mock.method(globalThis,'fetch',fixture.fetcher);
  const store=durableBackend(fixture.env);
  try {
    const target=await incident(store),token=await fixture.sign({exp:Math.floor(now/1000)+1});
    const body={request_id:randomUUID(),incident_id:target.incident_id,analysis_event_key:target.event_key,expected_revision:0,
      disposition:'inconclusive',ignition_source:'unknown',ignition_tool:'unknown',independent_evidence:null,rationale:'Insufficient independent evidence.'};
    const stream=new ReadableStream({pull(controller){now+=2000;controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));controller.close();}},
      {highWaterMark:0});
    const response=await worker.fetch(new Request('https://worker/operator/cameras/cam/reviews',{method:'POST',duplex:'half',body:stream,
      headers:{'content-type':'application/json','cf-access-jwt-assertion':token}}),store.env,{});
    assert.equal(response.status,401);assert.equal(store.eventDb.prepare('SELECT COUNT(*) AS total FROM operator_reviews').get().total,0);
  } finally {await store.settle();store.close();}
});
