import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CoordinatorJournal } from '../src/coordinator-journal.js';
import { randomUUID } from 'node:crypto';

function backend() {
  const db = new DatabaseSync(':memory:');
  const storage = {sql:{exec(query,...args) {
    const statement=db.prepare(query);
    const rows=statement.columns().length ? statement.all(...args) : (statement.run(...args),[]);
    return {toArray:()=>rows};
  }},transactionSync(callback) {
    db.exec('BEGIN IMMEDIATE');
    try {const result=callback();db.exec('COMMIT');return result;}
    catch(error) {db.exec('ROLLBACK');throw error;}
  }};
  const journal=new CoordinatorJournal(storage);
  journal.claim({native_inference_interrupted:true},value=>value);
  return {db,storage,journal};
}
const proposal=()=>({request_id:'12345678-1234-4234-8234-123456789abc',action:'propose',camera_id:'cam',
  generation:1,analysis_job_id:1,proposal_id:null,provider_outcome:'completed',
  provider_reference:'provider-support-ticket-123',review_reference:null,
  rationale:'Provider support independently checked that the old operation completed.',
  actor_subject:'operator-1',actor_email:'operator@example.test',decided_at_ms:1700000000000});

test('native recovery audit and checkpoint commit together and read back without reconstructing authority',()=>{
  const store=backend();
  try {
    const record=proposal();
    store.journal.commit({native_inference_interrupted:true},[],record);
    assert.deepEqual(store.journal.findRecoveryAudit(record.request_id),record);
    assert.equal(store.journal.recoveryAudits().records.length,1);
    const restored=new CoordinatorJournal(store.storage);
    restored.claim({},value=>value);
    assert.deepEqual(restored.findRecoveryAudit(record.request_id),record);
    assert.equal(JSON.stringify(record).includes('cf-access'),false);
  } finally {store.db.close();}
});

test('lost-ack recovery retries preserve the immutable decision and cannot rewind its checkpoint',()=>{
  const store=backend();
  try {
    const record=proposal();
    store.journal.commit({native_inference_interrupted:false},[],record);
    store.journal.commit({native_inference_interrupted:true},[],structuredClone(record));
    assert.deepEqual(JSON.parse(store.db.prepare('SELECT checkpoint_json FROM fire_coordinator_checkpoint').get().checkpoint_json),
      {native_inference_interrupted:false});
    assert.equal(store.journal.recoveryAudits().records.length,1);
    assert.throws(()=>store.journal.commit({bad:true},[],{...record,actor_subject:'different-operator'}),/native_recovery_conflict/);
    assert.equal(store.journal.findRecoveryAudit(record.request_id).actor_subject,'operator-1');
  } finally {store.db.close();}
});

test('native audit capacity is explicit and never evicts prior operator decisions',()=>{
  const store=backend();
  try {
    for(let i=0;i<1024;i++) store.journal.commit({sequence:i},[],{...proposal(),request_id:randomUUID()});
    assert.equal(store.journal.recoveryAuditCount(),1024);
    assert.throws(()=>store.journal.commit({sequence:1024},[],{...proposal(),request_id:randomUUID()}),/native_recovery_audit_full/);
    assert.equal(store.journal.recoveryAuditCount(),1024);
    assert.equal(JSON.parse(store.db.prepare('SELECT checkpoint_json FROM fire_coordinator_checkpoint').get().checkpoint_json).sequence,1023);
    const first=store.journal.recoveryAudits({limit:100});
    assert.equal(first.records.length,100);assert.equal(first.has_more,true);
    assert.ok(Number.isSafeInteger(first.next_before_row_id));
    const second=store.journal.recoveryAudits({limit:100,beforeRowId:first.next_before_row_id});
    const firstIds=new Set(first.records.map(record=>record.request_id));
    assert.equal(second.records.some(record=>firstIds.has(record.request_id)),false);
  } finally {store.db.close();}
});

test('failed native audit insertion rolls back the proposed checkpoint release',()=>{
  const store=backend();
  try {
    const exec=store.storage.sql.exec;
    store.storage.sql.exec=(query,...args)=>{
      if(query.startsWith('INSERT INTO fire_native_recovery_audit'))throw new Error('injected disk failure');
      return exec(query,...args);
    };
    assert.throws(()=>store.journal.commit({native_inference_interrupted:false},[],proposal()),/injected disk failure/);
    assert.deepEqual(JSON.parse(store.db.prepare('SELECT checkpoint_json FROM fire_coordinator_checkpoint').get().checkpoint_json),
      {native_inference_interrupted:true});
    assert.equal(store.journal.findRecoveryAudit(proposal().request_id),null);
  } finally {store.db.close();}
});

test('native audit rejects malformed metadata and stale lifetimes without touching the checkpoint',()=>{
  const store=backend();
  try {
    for(const invalid of [{...proposal(),image_b64:'not-metadata'}, {...proposal(),actor_subject:''},
      {...proposal(),generation:NaN},{...proposal(),request_id:'not-a-uuid'},{...proposal(),rationale:'\nunsafe'}]) {
      assert.throws(()=>store.journal.commit({bad:true},[],invalid),/invalid_native_recovery_record/);
    }
    const next=new CoordinatorJournal(store.storage);next.claim({},value=>value);
    assert.throws(()=>store.journal.commit({bad:true},[],proposal()),/stale_coordinator_instance/);
    assert.equal(next.recoveryAudits().records.length,0);
  } finally {store.db.close();}
});
