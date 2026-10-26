import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { InferenceBatchStore, inferenceKey, validateInferenceMetadata, boundedModelCapture,
  providerErrorDiagnostic, SCOUT_MODEL_ID, SCOUT_MAX_REQUEST_NEURONS,
  validateAllowanceSnapshot } from '../src/inference-runtime.js';

function fixture(run, {now} = {}) {
  const db = new DatabaseSync(':memory:');
  const storage = {sql: {exec(query, ...args) {
    const stmt = db.prepare(query);
    const rows = stmt.columns().length ? stmt.all(...args) : (stmt.run(...args), []);
    return {toArray: () => rows};
  }}, transactionSync(callback) {
    db.exec('BEGIN IMMEDIATE');
    try {const value = callback(); db.exec('COMMIT'); return value;} catch (error) {db.exec('ROLLBACK'); throw error;}
  }};
  try {return run(new InferenceBatchStore(storage, {now}));} finally {db.close();}
}
const key = 'a'.repeat(64);
const usage = {prompt_tokens: 10, completion_tokens: 5, total_tokens: 15};
const allowanceAt = at => ({version:1,source:'cloudflare_workers_ai_dashboard',model:SCOUT_MODEL_ID,
  utc_day:new Date(at).toISOString().slice(0,10),remaining_neurons:10000,observed_at_ms:at,usage_through_ms:at});
const config = extra => ({batch_id: 'test-batch', max_calls: 6, diagnostics: true, cache_mode: 'read_write',
  account_snapshot:allowanceAt(Date.now()), ...extra});

test('a current account-wide Cloudflare GraphQL neuron reading is accepted with its own provenance', () => {
  const now = Date.now();
  const snapshot = {...allowanceAt(now), source:'cloudflare_graphql_analytics',
    usage_through_ms:Date.parse(`${new Date(now).toISOString().slice(0,10)}T00:00:00Z`)};
  assert.deepEqual(validateAllowanceSnapshot(snapshot, now), snapshot);
});

test('successful Scout token usage settles its reservation so three clips fit; missing usage remains fully reserved', () => fixture(store => {
  store.configure(config());
  const first = '1'.repeat(64), second = '2'.repeat(64), third = '3'.repeat(64);
  assert.equal(store.reserve(first).mode, 'fresh');
  assert.equal(store.reserve(second).mode, 'fresh');
  assert.equal(store.reserve(third).reason, 'vlm_neuron_budget_exhausted');
  store.complete(first, {raw:'{}', usage:{prompt_tokens:5000,completion_tokens:100,total_tokens:5100}});
  const settled = store.snapshot().neuron_reservations.find(item => item.request_key === first);
  assert.equal(settled.reserved_neurons, SCOUT_MAX_REQUEST_NEURONS);
  assert.ok(settled.settled_neurons < SCOUT_MAX_REQUEST_NEURONS);
  assert.ok(settled.settled_neurons >= 131);
  assert.equal(store.reserve(third).mode, 'fresh');
  store.complete(second, {raw:'{}'});
  assert.equal(store.snapshot().neuron_reservations.find(item => item.request_key === second).reserved_neurons,
    SCOUT_MAX_REQUEST_NEURONS);
}));

test('one durable batch reserves worst-case Scout cost before permitting calls and never refunds timed-out work', () => fixture(store => {
  store.configure(config());
  for (let i=0;i<2;i++) assert.equal(store.reserve(String(i).padStart(64, '0')).mode, 'fresh');
  assert.equal(store.reserve(key).reason, 'vlm_neuron_budget_exhausted');
  assert.equal(store.snapshot().fresh_calls, 2);
  assert.equal(store.snapshot().in_flight, 2);
  assert.throws(() => store.configure(config({batch_id: 'replacement'})), /in_flight/);
  store.complete('0'.repeat(64), {raw: '{}', usage, failed:true});
  assert.equal(store.snapshot().in_flight, 1);
  assert.equal(store.reserve(key).mode, 'skipped');
}));

test('new invocation IDs share the account-day neuron ledger and reset only after UTC rollover', () => {
  let clock = Date.UTC(2026, 9, 19, 12);
  fixture(store => {
    store.configure(config({account_snapshot:allowanceAt(clock - 1)}));
    for (let i = 0; i < 2; i++) {
      const requestKey = String(i + 1).padStart(64, '0');
      assert.equal(store.reserve(requestKey).mode, 'fresh');
      store.complete(requestKey, {raw: '{}', usage});
    }
    store.configure(config({batch_id: 'second-invocation',account_snapshot:allowanceAt(clock - 1)}));
    assert.equal(store.snapshot().fresh_calls, 0);
    assert.equal(store.snapshot().day_fresh_calls, 2);
    assert.equal(store.reserve(key).mode, 'fresh');
    store.complete(key, {raw:'{}',usage});
    clock += 24 * 60 * 60 * 1000;
    store.configure(config({batch_id: 'next-day',account_snapshot:allowanceAt(clock)}));
    assert.equal(store.snapshot().utc_day, new Date(clock).toISOString().slice(0, 10));
    assert.equal(store.snapshot().day_fresh_calls, 0);
    assert.equal(store.reserve(key).mode, 'fresh');
  }, {now: () => clock});
});

test('fresh Scout calls continue past six in one UTC day when the neuron ledger permits them', () => fixture(store => {
  store.configure(config({max_calls: 12}));
  for (let i = 0; i < 7; i++) {
    const requestKey = String(i + 1).padStart(64, '0');
    assert.equal(store.reserve(requestKey).mode, 'fresh');
    store.complete(requestKey, {raw: '{}', usage});
  }
  const status = store.snapshot();
  assert.equal(status.fresh_calls, 7);
  assert.equal(status.day_fresh_calls, 7);
  assert.equal(status.daily_max_calls, null);
}));

test('an unsettled reservation from the prior UTC day blocks fresh work after rollover', () => {
  let clock = Date.UTC(2026, 9, 19, 23, 59);
  fixture(store => {
    store.configure(config({account_snapshot:allowanceAt(clock)}));
    assert.equal(store.reserve(key).mode, 'fresh');
    clock += 2 * 60 * 1000;
    assert.equal(store.reserve('b'.repeat(64)).reason, 'vlm_previous_day_reservation_unresolved');
    assert.equal(store.snapshot().day_fresh_calls, 1);
  }, {now: () => clock});
});

test('cached outputs consume no fresh calls and read-only misses do not call a provider', () => fixture(store => {
  store.configure(config());
  assert.equal(store.reserve(key).mode, 'fresh');
  store.complete(key, {raw: '{"observations":[]}', usage});
  const cached = store.reserve(key);
  assert.equal(cached.mode, 'cached');
  assert.equal(cached.raw, '{"observations":[]}');
  assert.equal(store.snapshot().cached_calls, 1);
  assert.equal(store.snapshot().fresh_calls, 1);
  assert.deepEqual(store.snapshot().usage, usage, 'cached token history must not be billed again');
  const captures = store.snapshot().captures;
  store.configure(config({batch_id: 'offline', cache_mode: 'read_only', captures}));
  assert.equal(store.reserve(key).mode, 'cached');
  assert.equal(store.reserve('b'.repeat(64)).reason, 'vlm_cache_miss');
  assert.equal(store.snapshot().fresh_calls, 0);
}));

test('offline evaluations can reuse captures but missing provider bindings never spend fresh reservations',()=>fixture(store=>{
  store.configure(config());
  assert.equal(store.reserve(key,false,false).reason,'workers_ai_binding_missing');
  assert.equal(store.snapshot().fresh_calls,0);
  assert.equal(store.snapshot().in_flight,0);
}));

test('fresh calls require a current account snapshot and reserve conservative Scout neurons atomically', () => {
  fixture(store => {
    const withoutSnapshot = config(); delete withoutSnapshot.account_snapshot;
    store.configure(withoutSnapshot);
    assert.equal(store.reserve(key).reason, 'vlm_budget_reconciliation_required');
    store.configure(config({batch_id:'reconciled',account_snapshot:{...allowanceAt(Date.now()),remaining_neurons:1000}}));
    assert.equal(store.reserve(key).reason, 'vlm_neuron_budget_exhausted');
    assert.equal(store.snapshot().fresh_calls, 0);
  });
  fixture(store => {
    store.configure(config({batch_id:'free-daily',account_snapshot:allowanceAt(Date.now()-1)}));
    assert.equal(store.reserve(key).mode, 'fresh');
    assert.equal(store.reserve('b'.repeat(64)).mode, 'fresh');
    assert.equal(store.reserve('c'.repeat(64)).reason, 'vlm_neuron_budget_exhausted');
    assert.equal(store.snapshot().neuron_reservations.reduce((sum,item)=>sum+item.reserved_neurons,0),
      2 * SCOUT_MAX_REQUEST_NEURONS);
  });
});

test('allowance snapshots expire and cannot roll their dashboard watermark backward', () => fixture(store => {
  let clock = Date.now();
  const at = allowanceAt(clock);
  at.remaining_neurons = 5000;
  const stale = () => store.reserve('b'.repeat(64)).reason;
  store = new InferenceBatchStore(store.storage,{now:()=>clock});
  store.configure(config({account_snapshot:at}));
  clock += 16 * 60 * 1000;
  assert.equal(stale(), 'vlm_budget_reconciliation_required');
  assert.throws(() => store.configure(config({batch_id:'older-watermark',account_snapshot:{...allowanceAt(clock),
    remaining_neurons:5000,usage_through_ms:at.usage_through_ms-1}})), /allowance_snapshot_not_monotonic/);
  assert.throws(() => store.configure(config({batch_id:'increased-allowance',account_snapshot:{...allowanceAt(clock),
    remaining_neurons:10000}})), /allowance_snapshot_not_monotonic/);
}));

test('duplicate completion cannot free a different running permit or count usage twice', () => fixture(store => {
  store.configure(config());
  store.reserve(key);
  store.complete(key, {raw: '{}', usage});
  assert.throws(() => store.complete(key, {raw:'{}', usage}), /reservation/);
  assert.deepEqual(store.snapshot().usage, usage);
  assert.equal(store.snapshot().in_flight, 0);
}));

test('the durable diagnostic-probe lane admits only one underlying call across different keys and restored stores',()=>fixture(store=>{
  store.configure(config());
  assert.equal(store.reserve(key,true).mode,'fresh');
  const restored=new InferenceBatchStore(store.storage);
  assert.equal(restored.reserve('b'.repeat(64),true).reason,'vlm_inference_still_running');
  assert.equal(restored.snapshot().fresh_calls,1);
  store.complete(key,{raw:'{}',usage});
  assert.equal(restored.reserve('b'.repeat(64),true).mode,'fresh');
}));

test('capture bounds, image redaction and malformed usage never create a reusable truncated response', () => fixture(store => {
  const capture = boundedModelCapture('data:image/jpeg;base64,AAAA ' + 'x'.repeat(40000));
  assert.ok(Buffer.byteLength(capture.raw) <= 32768);
  assert.equal(capture.truncated, true);
  assert.equal(capture.redacted, true);
  assert.ok(!capture.raw.includes('base64,AAAA'));
  store.configure(config()); store.reserve(key);
  store.complete(key, {raw: 'x'.repeat(40000), usage: {prompt_tokens: -1}});
  assert.equal(store.reserve(key).mode, 'fresh');
  assert.deepEqual(store.snapshot().usage, {prompt_tokens:null,completion_tokens:null,total_tokens:null});
}));

test('schema/model/image request differences change cache keys and usage validation is strict', async () => {
  const a = await inferenceKey('scout', {messages:[{content:'one'}],response_format:{type:'json_schema'}});
  for (const [model,request] of [['other',{messages:[{content:'one'}],response_format:{type:'json_schema'}}],
    ['scout',{messages:[{content:'two'}],response_format:{type:'json_schema'}}],
    ['scout',{messages:[{content:'one'}],response_format:{type:'json_object'}}]]) {
    assert.notEqual(await inferenceKey(model,request), a);
  }
  assert.deepEqual(validateInferenceMetadata({mode:'cached',usage}), {mode:'cached',usage});
  for (const value of [{mode:'fresh',usage:{...usage,total_tokens:1}}, {mode:'invented',usage},
    {mode:'fresh',usage,raw:'private'}, {mode:'fresh',usage:{...usage,prompt_tokens:-1}}])
    assert.throws(() => validateInferenceMetadata(value));
});

test('JSON escaped image URIs are redacted and never admitted as reusable captures', () => fixture(store => {
  for (const raw of ['{"echo":"data:image\\/jpeg;base64,AAAA"}', '{"echo":"data:\\u0069mage/jpeg;base64,AAAA"}',
    '{"image_b64":"AAAA"}', '{"nested":{"jpeg_b64":"AAAA"}}']) {
    const capture = boundedModelCapture(raw);
    assert.equal(capture.redacted,true);
    assert.ok(!capture.raw.includes('base64,AAAA'));
    assert.ok(!capture.raw.includes('AAAA'));
    assert.throws(() => store.configure(config({captures:[{key,raw,usage}]})),/capture/);
  }
}));

test('local provider diagnostics retain actionable nested error messages while discarding echoed requests',()=>{
  const error=new Error('8007: '+JSON.stringify({errors:[{message:'unsupported schema parameter',code:7}],messages:[{content:'private prompt'}],authorization:'Bearer private'}));
  assert.equal(providerErrorDiagnostic(error),'8007: 7; unsupported schema parameter');
  assert.ok(!providerErrorDiagnostic(new Error('Error token=private-value https://secret.invalid/path')).includes('private-value'));
});
