import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CoordinatorJournal } from '../src/coordinator-journal.js';
import { createConfirmationRecord } from '../src/incident-store.js';

function storage(db) {
  return {sql: {exec: (query, ...args) => {
    const stmt = db.prepare(query);
    const rows = stmt.columns().length ? stmt.all(...args) : (stmt.run(...args), []);
    return {toArray: () => rows};
  }}, transactionSync: callback => {
    db.exec('BEGIN IMMEDIATE');
    try {const result = callback(); db.exec('COMMIT'); return result;}
    catch (error) {db.exec('ROLLBACK'); throw error;}
  }};
}
const pending = key => createConfirmationRecord({cameraId:'cam',
  incidentId:key.replace(/:confirmation$/,''),ts:1000,priority:'inspect_urgently'});

test('actual SQLite journal atomically commits checkpoint/outbox, restores them and fences an older lifetime', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const first = new CoordinatorJournal(storage(db));
    assert.equal(first.claim({version: 1, ts: null}, value => value).restored, null);
    first.commit({version: 1, ts: 1000}, [pending('cam:1000:1:confirmation')]);
    const second = new CoordinatorJournal(storage(db));
    const restored = second.claim({version: 1, ts: null}, value => value);
    assert.deepEqual(restored.restored, {version: 1, ts: 1000});
    assert.equal(second.pending().length, 1);
    assert.throws(() => first.commit({version: 1, ts: 2000}), /stale_coordinator_instance/);
    second.ack('cam:1000:1:confirmation');
    assert.deepEqual(second.pending(), []);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fire_coordinator_checkpoint').get().n, 1);
  } finally {db.close();}
});

test('outbox capacity failure cannot commit a newer checkpoint or discard earlier incident records', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const journal = new CoordinatorJournal(storage(db));
    journal.claim({version: 1, ts: null}, value => value);
    const records = Array.from({length: 64}, (_,i) => pending(`cam:1000:${i}:confirmation`));
    journal.commit({version: 1, ts: 1000}, records);
    assert.throws(() => journal.commit({version: 1, ts: 2000}, [pending('cam:2000:65:confirmation')]), /incident_outbox_full/);
    assert.equal(journal.pending().length, 64);
    const checkpoint = JSON.parse(db.prepare('SELECT checkpoint_json FROM fire_coordinator_checkpoint').get().checkpoint_json);
    assert.equal(checkpoint.ts, 1000);
    journal.commit({version: 1, ts: 1001}, records);
    assert.equal(journal.pending().length, 64, 'retries of the exact event keys consume no additional capacity');
  } finally {db.close();}
});

test('malformed or oversized outbox records cannot be committed or restored as trusted event intents', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const journal = new CoordinatorJournal(storage(db));
    journal.claim({version:1,ts:null}, value => value);
    const record = pending('cam:1000:1:confirmation');
    for(const corrupt of [{...record,cause:'human'}, {...record,image_b64:'untrusted'},
      {...record,analysis_json:'x'.repeat(65537)}]) {
      assert.throws(()=>journal.commit({version:1,ts:2000},[corrupt]));
    }
    assert.deepEqual(journal.pending(),[]);
    assert.equal(JSON.parse(db.prepare('SELECT checkpoint_json FROM fire_coordinator_checkpoint').get().checkpoint_json).ts,null);
    db.prepare('INSERT INTO fire_incident_outbox (event_key,record_json) VALUES (?,?)')
      .run(record.event_key,JSON.stringify({...record,analysis_json:'x'.repeat(65537)}));
    assert.throws(()=>journal.pending(),/outbox|bounds|record/i);
  } finally {db.close();}
});
