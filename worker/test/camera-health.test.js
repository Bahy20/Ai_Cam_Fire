import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const module = await import('../src/camera-health.js').catch(() => ({}));
const { CameraHealth } = module;
function storage(db) {
  return {sql: {exec(query, ...args) {
    const stmt = db.prepare(query);
    const rows = stmt.columns().length ? stmt.all(...args) : (stmt.run(...args), []);
    return {toArray: () => rows};
  }}, transactionSync(callback) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }};
}
const packet = (sent_at_ms = 100000, serial = 1, status = 'ok') => ({
  camera_id: 'Cam_1', heartbeat_id: `00000000-0000-4000-8000-${String(serial).padStart(12, '0')}`,
  sent_at_ms, status,
});
function fixture(fn) {
  const db = new DatabaseSync(':memory:');
  try { assert.equal(typeof CameraHealth, 'function', 'CameraHealth component must exist'); fn(new CameraHealth(storage(db), 'Cam_1'), db); }
  finally { db.close(); }
}

test('duplicates, equal timestamps and reordered packets do not refresh receipt or repeat transitions', () => fixture(health => {
  health.receive(packet(), 100000);
  for (const body of [packet(100001, 1), packet(100000, 2), packet(99999, 3)]) {
    const result = health.receive(body, 110000);
    assert.equal(result.accepted, false);
    assert.deepEqual(result.transitions, []);
    assert.equal(result.health.last_seen_ms, 100000);
  }
  assert.equal(health.receive(packet(110001, 4), 110000).transitions.length, 0);
  assert.equal(health.snapshot(110000).last_seen_ms, 110000);
  assert.equal(health.history().events.length, 1);
}));

test('degradation reasons, one expiry and one recovery are durable across reconstructed lifetimes', () => fixture((health, db) => {
  const first = health.receive(packet(100000, 1, 'storage_error'), 100000);
  assert.equal(first.health.status, 'degraded');
  assert.equal(first.health.reason, 'storage_error');
  assert.equal(health.receive(packet(100001, 2, 'storage_error'), 100010).transitions.length, 0);
  assert.equal(health.receive(packet(100002, 3, 'inference_error'), 100020).transitions.length, 1);
  const restored = new CameraHealth(storage(db), 'Cam_1');
  assert.equal(restored.snapshot(160020).status, 'offline', 'read status reflects elapsed receipt time');
  assert.equal(restored.snapshot(160020).last_seen_ms, 100020);
  assert.equal(restored.history().events.length, 2, 'snapshot is read-only');
  assert.equal(restored.expire(160019).transitions.length, 0);
  assert.equal(restored.expire(160020).transitions.length, 1);
  assert.equal(restored.nextDeadline(), null);
  assert.equal(health.expire(170000).transitions.length, 0);
  assert.equal(health.receive(packet(170000, 4), 170000).transitions.length, 1);
  assert.equal(restored.receive(packet(170001, 5), 170001).transitions.length, 0);
  assert.deepEqual(restored.history().events.map(e => e.status), ['online', 'offline', 'degraded', 'degraded']);
  assert.deepEqual(restored.history().events.map(e => e.sequence), [4, 3, 2, 1]);
}));

test('strict malformed, replayed and future packets cannot mutate health', () => fixture((health, db) => {
  const cases = [null, [], {}, {...packet(), camera_id: 'other'}, {...packet(), status: 'fire'},
    {...packet(), status: 'ok ', jpeg_b64: 'x'.repeat(5000)}, {...packet(), sent_at_ms: true},
    {...packet(), sent_at_ms: 1.5}, {...packet(), sent_at_ms: NaN}, {...packet(), sent_at_ms: 69999},
    {...packet(), sent_at_ms: 130001}, {...packet(), heartbeat_id: 'A0000000-0000-4000-8000-000000000001'},
    {...packet(), heartbeat_id: '00000000-0000-1000-8000-000000000001'}, {...packet(), confidence: .9}];
  for (const body of cases) assert.throws(() => health.receive(body, 100000), /heartbeat|camera|timestamp|body/i);
  for (const id of ['', 'a'.repeat(129), 'cam/1', ' x', 'cäm', 'cam\n'])
    assert.throws(() => new CameraHealth(storage(db), id), /camera/i);
  assert.equal(health.snapshot(100000).status, 'unknown');
  assert.deepEqual(health.history().events, []);
  assert.equal(health.receive(packet(70000), 100000).accepted, true, '30s boundary accepted');
  assert.equal(health.receive(packet(130000, 2), 100000).accepted, true);
}));

test('bounded recent health history and dedup retain watermark without touching incident tables', () => fixture((health, db) => {
  db.exec("CREATE TABLE incident_evidence (jpeg TEXT); INSERT INTO incident_evidence VALUES ('preserve')");
  for (let i = 0; i < 300; i++) health.receive(packet(100000 + i, i + 1, i % 2 ? 'ok' : 'capture_error'), 100000 + i);
  const heartbeatIds=JSON.parse(db.prepare('SELECT heartbeat_ids_json FROM camera_health_state WHERE camera_id = ?').get('Cam_1').heartbeat_ids_json);
  assert.deepEqual(heartbeatIds,Array.from({length:64},(_,index)=>packet(100236+index,index+237).heartbeat_id));
  assert.equal(db.prepare('SELECT count(*) n FROM camera_health_events').get().n, 256);
  const sequences = [];
  let beforeSequence = null;
  do {
    const page = health.history({limit: 50, beforeSequence});
    assert.ok(page.events.length <= 50);
    sequences.push(...page.events.map(e => e.sequence));
    assert.equal(page.before_sequence, page.has_more ? page.events.at(-1).sequence : null);
    beforeSequence = page.before_sequence;
  } while (beforeSequence !== null);
  assert.equal(sequences.length, 256);
  assert.equal(new Set(sequences).size, 256);
  assert.deepEqual([sequences[0], sequences.at(-1)], [300, 45]);
  for (const options of [{limit: 0}, {limit: 51}, {limit: 1.5}, {beforeSequence: '2'}, {beforeSequence: -1}])
    assert.throws(() => health.history(options), /history/i);
  assert.equal(health.receive(packet(100000, 1), 100300).accepted, false, 'evicted ID still fenced by watermark');
  assert.throws(() => health.receive(packet(100000, 1), 200000), /timestamp/);
  assert.equal(db.prepare('SELECT jpeg FROM incident_evidence').get().jpeg, 'preserve');
}));

test('legacy dedup rows migrate into the bounded checkpoint without losing retry identity', () => {
  const db=new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE camera_health_binding (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), camera_id TEXT NOT NULL);
      CREATE TABLE camera_health_state (camera_id TEXT PRIMARY KEY, status TEXT NOT NULL, reason TEXT,
        last_seen_ms INTEGER, sent_watermark_ms INTEGER, sequence INTEGER NOT NULL);
      CREATE TABLE camera_health_dedup (camera_id TEXT NOT NULL, heartbeat_id TEXT NOT NULL, sent_at_ms INTEGER NOT NULL,
        PRIMARY KEY(camera_id, heartbeat_id));
      INSERT INTO camera_health_binding VALUES (1, 'Cam_1');
      INSERT INTO camera_health_state VALUES ('Cam_1', 'online', NULL, 100001, 100001, 1);`);
    db.prepare('INSERT INTO camera_health_dedup VALUES (?, ?, ?)').run('Cam_1',packet(100000,1).heartbeat_id,100000);
    db.prepare('INSERT INTO camera_health_dedup VALUES (?, ?, ?)').run('Cam_1',packet(100001,2).heartbeat_id,100001);

    const restored=new CameraHealth(storage(db));
    const ids=JSON.parse(db.prepare('SELECT heartbeat_ids_json FROM camera_health_state WHERE camera_id = ?').get('Cam_1').heartbeat_ids_json);
    assert.deepEqual(ids,[packet(100000,1).heartbeat_id,packet(100001,2).heartbeat_id]);
    assert.equal(restored.receive(packet(100001,2),100002).duplicate,true);
    assert.equal(restored.receive(packet(100002,3),100002).accepted,true);
    assert.equal(db.prepare('SELECT count(*) n FROM camera_health_dedup').get().n,2,
      'legacy rows remain intact while new heartbeats stop mutating the legacy table');
  } finally {db.close();}
});

test('overdue fresh receipt records offline then recovery even if shared alarm runs late', () => fixture(health => {
  health.receive(packet(), 100000);
  const result = health.receive(packet(170000, 2), 170000);
  assert.deepEqual(result.transitions.map(e => e.status), ['offline', 'online']);
  assert.deepEqual(result.transitions.map(e => e.sequence), [2, 3]);
  assert.equal(result.health.last_seen_ms, 170000);
  assert.equal(health.expire(170001).transitions.length, 0);
}));

test('SQLite rollback never leaves a refreshed receipt without its immutable transition', () => fixture((health, db) => {
  health.receive(packet(), 100000);
  const before = health.snapshot(100000);
  db.exec(`CREATE TRIGGER fail_health BEFORE INSERT ON camera_health_events
    BEGIN SELECT RAISE(ABORT, 'injected_health_failure'); END`);
  assert.throws(() => health.receive(packet(100001, 2, 'stalled'), 100001), error =>
    error instanceof module.CameraHealthError && error.status === 503 && error.code === 'camera_health_storage_failed' && !error.message.includes('injected'));
  assert.deepEqual(health.snapshot(100000), before);
  assert.deepEqual(JSON.parse(db.prepare('SELECT heartbeat_ids_json FROM camera_health_state WHERE camera_id = ?').get('Cam_1').heartbeat_ids_json),
    [packet(100000,1).heartbeat_id]);
  assert.throws(() => health.expire(160000), /camera_health_storage_failed/);
  assert.equal(health.history().events.length, 1);
  db.exec('DROP TRIGGER fail_health');
  assert.equal(health.receive(packet(100001, 2, 'stalled'), 100001).transitions[0].sequence, 2);
}));

test('cold health binding restores without observations and cannot be rebound', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const cold = new CameraHealth(storage(db));
    assert.equal(cold.cameraId, null);
    assert.equal(cold.snapshot(100000).status, 'unknown');
    const result = cold.receive(packet(), 100000);
    assert.equal(cold.cameraId, 'Cam_1');
    assert.equal(result.duplicate, false);
    assert.equal(result.transition.type, 'camera_health');
    assert.equal(result.transition.sequence, 1);
    const restored = new CameraHealth(storage(db));
    assert.equal(restored.cameraId, 'Cam_1');
    assert.equal(restored.receive(packet(), 100001).duplicate, true);
    assert.equal(restored.receive(packet(), 100001).transition, null);
    assert.equal(restored.expire(160000).transition.status, 'offline');
    assert.equal(restored.expire(160000).accepted, false);
    assert.throws(() => new CameraHealth(storage(db), 'Other'), error =>
      error instanceof module.CameraHealthError && error.status === 400 && error.code === 'camera_id_mismatch');
  } finally {db.close();}
});

test('disk reopen preserves receipt deadline and concurrent callers produce exactly one transition per change', async () => {
  const {mkdtempSync, rmSync} = await import('node:fs');
  const {join} = await import('node:path');
  const {tmpdir} = await import('node:os');
  const directory = mkdtempSync(join(tmpdir(), 'health-sqlite-'));
  let db;
  try {
    db = new DatabaseSync(join(directory, 'health.sqlite'));
    new CameraHealth(storage(db), 'Cam_1').receive(packet(), 100000);
    db.close();
    db = new DatabaseSync(join(directory, 'health.sqlite'));
    const restored = new CameraHealth(storage(db));
    assert.equal(restored.nextDeadline(), 160000);
    assert.equal(restored.snapshot(155000).last_seen_ms, 100000);
    const other = new CameraHealth(storage(db));
    const results = await Promise.all(Array.from({length: 20}, (_, i) => Promise.resolve().then(() =>
      (i % 2 ? restored : other).receive(packet(155000, 2, 'capture_error'), 155000))));
    assert.equal(results.filter(r => r.accepted).length, 1);
    assert.equal(restored.history().events.length, 2);
    assert.deepEqual(restored.history().events.map(e => e.sequence), [2, 1]);
    const events = await Promise.all(Array.from({length: 20}, () => Promise.resolve().then(() => restored.expire(215000))));
    assert.equal(events.filter(r => r.transition).length, 1);
    assert.equal(restored.history().events[0].sequence, 3);
  } finally {if (db?.isOpen) db.close(); rmSync(directory, {recursive: true, force: true});}
});

test('unknown before first heartbeat; server receipt time makes one online transition', () => fixture(health => {
  assert.equal(health.snapshot(100000).status, 'unknown');
  assert.equal(health.nextDeadline(), null);
  const result = health.receive(packet(95000), 100000);
  assert.equal(result.accepted, true);
  assert.equal(result.health.status, 'online');
  assert.equal(result.health.last_seen_ms, 100000);
  assert.equal(result.transitions.length, 1);
  assert.equal(result.transitions[0].status, 'online');
  assert.equal(health.nextDeadline(), 160000);
  assert.equal(health.history().events.length, 1);
}));
