import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { CameraDO } from '../src/camera-do.js';
import { authorizeOperator } from '../src/operator-auth.js';
import { makeOperatorFixture } from './helpers/operator-jwt.js';
import { applyNativeRecovery, nativeRecoveryStatus } from '../src/native-recovery.js';

async function backend() {
  const db=new DatabaseSync(':memory:');
  const storage={sql:{exec(sql,...args){const stmt=db.prepare(sql);
    const rows=stmt.columns().length?stmt.all(...args):(stmt.run(...args),[]);
    return {toArray:()=>rows};}},
    transactionSync(fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}
      catch(error){db.exec('ROLLBACK');throw error;}},sync:async()=>{}};
  const fixture=await makeOperatorFixture();
  const policy=JSON.parse(fixture.env.OPERATOR_POLICY_JSON);
  policy['operator-2']={email:'second@example.test',permissions:['inference:recover'],cameras:['cam']};
  fixture.env.OPERATOR_POLICY_JSON=JSON.stringify(policy);
  const authorize=async(subject='operator-1')=>authorizeOperator(new Request('https://worker/operator',{headers:{
    'cf-access-jwt-assertion':await fixture.sign(subject==='operator-1'?{}:{sub:subject,email:'second@example.test'})}}),
    fixture.env,'inference:recover','cam',{fetcher:fixture.fetcher});
  const create=()=>new CameraDO({storage,getWebSockets:()=>[],waitUntil:()=>{}},{EVIDENCE_STORAGE:'pi'});
  const camera=create();camera.ingest({camera_id:'cam',ts_ms:0,frame_wh:[100,100],detections:[]},'cam');
  camera.analysisJob=1;camera.nativeInferenceInterrupted=true;camera.saveCoordinator();
  const proposal=()=>({request_id:randomUUID(),action:'propose',expected_generation:camera.journal.generation,expected_job_id:1,
    provider_outcome:'completed',provider_reference:'provider-support-ticket-123',
    rationale:'I checked the provider execution record independently; the previous operation completed.'});
  return {db,storage,fixture,authorize,camera,create,proposal};
}

test('one authenticated recovery proposal is durably audited but cannot release an unknown native outcome',async()=>{
  const store=await backend();
  try {
    const body=store.proposal(),principal=await store.authorize();
    const result=applyNativeRecovery(store.camera,principal,body);
    assert.equal(result.idempotent,false);assert.equal(result.audit.action,'propose');
    assert.equal(result.audit.actor_subject,'operator-1');
    assert.equal(result.recovery.required,true);assert.equal(store.camera.nativeInferenceInterrupted,true);
    assert.equal(result.recovery.backend_status_verified_by_application,false);
    assert.equal(store.camera.journal.findRecoveryAudit(body.request_id).request_id,body.request_id);
    assert.equal(nativeRecoveryStatus(store.camera,principal).generation,1);
  } finally {store.db.close();}
});

test('a second scoped operator can attest provider completion and atomically release only the recovered gate',async()=>{
  const store=await backend();
  try {
    const first=await store.authorize(),second=await store.authorize('operator-2'),proposal=store.proposal();
    applyNativeRecovery(store.camera,first,proposal);
    const approval={request_id:randomUUID(),action:'approve',expected_generation:1,expected_job_id:1,
      proposal_id:proposal.request_id,review_reference:'independent-provider-check-456',
      rationale:'I independently verified this provider operation completed and approve releasing the local gate.'};
    let calls=0;store.camera.env.AI={run:async()=>{calls++;return {};}};
    const result=applyNativeRecovery(store.camera,second,approval);
    assert.equal(result.recovery.required,false);assert.equal(result.audit.actor_subject,'operator-2');
    assert.equal(result.audit.proposal_id,proposal.request_id);assert.equal(calls,0,'recovery never automatically dispatches a model');
    assert.equal(store.camera.cause,null);assert.equal(store.camera.alert,'idle');
    const restored=store.create();assert.equal(restored.nativeInferenceInterrupted,false);
    assert.equal(restored.journal.recoveryAudits().records.length,2);
    assert.equal(result.recovery.backend_status_verified_by_application,false,'two attestations are not an API cancellation proof');
  } finally {store.db.close();}
});

test('a lost response can be retried without a new audit or rewriting a later native gate',async()=>{
  const store=await backend();
  try {
    const principal=await store.authorize(),body=store.proposal(),now=Date.now();
    applyNativeRecovery(store.camera,principal,body,{nowMs:now});
    const retry=applyNativeRecovery(store.camera,principal,structuredClone(body),{nowMs:now+1000});
    assert.equal(retry.idempotent,true);assert.equal(store.camera.journal.recoveryAuditCount(),1);
    assert.equal(store.camera.persistenceFailure,false);
    assert.throws(()=>applyNativeRecovery(store.camera,principal,{...body,provider_reference:'different-ticket-reference'}),
      error=>error.code==='native_recovery_request_conflict');
    assert.equal(store.camera.nativeInferenceInterrupted,true);
  } finally {store.db.close();}
});

test('self approval, expired proposals and stale coordinator/job identities cannot release the gate',async()=>{
  const store=await backend();
  try {
    const first=await store.authorize(),second=await store.authorize('operator-2'),body=store.proposal(),now=Date.now();
    applyNativeRecovery(store.camera,first,body,{nowMs:now});
    const approval={request_id:randomUUID(),action:'approve',expected_generation:1,expected_job_id:1,
      proposal_id:body.request_id,review_reference:'second-provider-check-456',rationale:'I independently checked the external provider execution record.'};
    assert.throws(()=>applyNativeRecovery(store.camera,first,approval),error=>error.code==='native_recovery_independent_reviewer_required');
    assert.throws(()=>applyNativeRecovery(store.camera,second,approval,{nowMs:now+900000}),error=>error.code==='native_recovery_proposal_stale');
    assert.throws(()=>applyNativeRecovery(store.camera,first,{...store.proposal(),expected_job_id:2}),error=>error.code==='native_recovery_stale_state');
    const restored=store.create();
    assert.throws(()=>applyNativeRecovery(restored,second,approval),error=>error.code==='native_recovery_stale_state');
    assert.equal(restored.nativeInferenceInterrupted,true);assert.equal(restored.journal.recoveryAuditCount(),1);
  } finally {store.db.close();}
});

test('ordinary/serialized identities, model flags, malformed requests and active work cannot authorize recovery',async()=>{
  const store=await backend();
  try {
    const principal=await store.authorize();
    for(const forged of [null,{},structuredClone(principal),{...principal,reviewed:true}])
      assert.throws(()=>applyNativeRecovery(store.camera,forged,store.proposal()),error=>error.code==='operator_forbidden');
    for(const body of [{...store.proposal(),reviewed:true},{...store.proposal(),expected_generation:'1'},
      {...store.proposal(),provider_outcome:'timeout'},{...store.proposal(),provider_reference:'unknown'},
      {...store.proposal(),request_id:'not-a-uuid'},{...store.proposal(),rationale:''}])
      assert.throws(()=>applyNativeRecovery(store.camera,principal,body),error=>error.code==='native_recovery_invalid_request');
    for(const field of ['nativeInference','analysisActive','pendingAnalysis']) {
      const previous=store.camera[field];store.camera[field]=field==='nativeInference'?new Promise(()=>{}):true;
      assert.throws(()=>applyNativeRecovery(store.camera,principal,store.proposal()),error=>error.code==='native_recovery_work_in_progress');
      store.camera[field]=previous;
    }
    assert.equal(store.camera.nativeInferenceInterrupted,true);assert.equal(store.camera.journal.recoveryAuditCount(),0);
  } finally {store.db.close();}
});

test('failed approval checkpoint cannot release a gate without its immutable audit',async()=>{
  const store=await backend();
  try {
    const first=await store.authorize(),second=await store.authorize('operator-2'),body=store.proposal();
    applyNativeRecovery(store.camera,first,body);
    const exec=store.storage.sql.exec;store.storage.sql.exec=(sql,...args)=>{
      if(sql.startsWith('INSERT INTO fire_native_recovery_audit'))throw new Error('injected disk failure');
      return exec(sql,...args);
    };
    assert.throws(()=>applyNativeRecovery(store.camera,second,{request_id:randomUUID(),action:'approve',expected_generation:1,
      expected_job_id:1,proposal_id:body.request_id,review_reference:'independent-check-456',
      rationale:'I independently checked that the provider operation had completed.'}),error=>error.status===503);
    assert.equal(store.camera.nativeInferenceInterrupted,true);store.storage.sql.exec=exec;
    const restored=store.create();assert.equal(restored.nativeInferenceInterrupted,true);
    assert.equal(restored.journal.recoveryAuditCount(),1);
  } finally {store.db.close();}
});
