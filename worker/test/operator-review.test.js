import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createAnalysisRecord, createConfirmationRecord, writeIncidentRecord } from '../src/incident-store.js';

import { authorizeOperator } from '../src/operator-auth.js';
import { makeOperatorFixture } from './helpers/operator-jwt.js';
const moduleURL = new URL('../src/operator-review.js', import.meta.url);
const api = existsSync(moduleURL) ? await import(moduleURL) : {};
const fixturePromise = makeOperatorFixture();
async function principal(fixture = null, headers = null) {
  fixture ??= await fixturePromise;
  headers ??= fixture.headers;
  return authorizeOperator(new Request('https://example.test/operator/cameras/cam/reviews', { headers }), fixture.env, 'cause:review', 'cam', { fetcher: fixture.fetcher });
}
const body = (overrides = {}) => ({ request_id: '00000000-0000-4000-8000-000000000001', incident_id: incidentId,
  analysis_event_key: eventKey, expected_revision: 0, disposition: 'accept', ignition_source: 'human_activity',
  ignition_tool: 'lighter', independent_evidence: { kind: 'onsite_inspection', reference: 'inspection-42', summary: 'Signed inspection describes the ignition source' },
  rationale: 'Inspection report supports this operator attestation', ...overrides });
const migrationURL = new URL('../migrations/0004_operator_reviews.sql', import.meta.url);
const incidentId = 'cam:1000:1';
const eventKey = `${incidentId}:analysis:1`;
function database() {
  const db = new DatabaseSync(':memory:');
  for (const name of ['0001_init.sql', '0002_analysis.sql', '0003_event_keys.sql']) {
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
  return db;
}
// Execute every statement against SQLite, only adapting D1's result envelope.
function d1(db, { beforeRun = () => {}, afterRun = () => {}, afterFirst = () => {} } = {}) {
  return { prepare(sql) {
    const bound = params => ({
      async first() { const row = db.prepare(sql).get(...params) ?? null; afterFirst(sql, row); return row; },
      async all() { return { success: true, results: db.prepare(sql).all(...params) }; },
      async run() { await beforeRun(sql); const result = db.prepare(sql).run(...params); afterRun(sql, result); return { success: true, meta: { changes: result.changes } }; },
    });
    return { ...bound([]), bind: (...params) => bound(params) };
  } };
}
function racingD1(db) {
  let arrivals = 0;
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  return d1(db, { async beforeRun(sql) {
    if (!/INSERT INTO operator_reviews/.test(sql)) return;
    if (++arrivals === 2) release();
    await ready;
  } });
}
async function seed(db, { cameraId = 'cam', incident = incidentId, confirmation = true, analysis = true } = {}) {
  const args = { cameraId, incidentId: incident, ts: 1000, priority: 'inspect_urgently' };
  if (confirmation) await writeIncidentRecord(d1(db), createConfirmationRecord(args));
  if (analysis) await writeIncidentRecord(d1(db), createAnalysisRecord({ ...args, jobId: 1, cause: {}, evidence_manifest: [], reason: 'initial_confirmation', incident_closed: false }));
}

function rawReview(db, { request = '00000000-0000-4000-8000-000000000001', revision = 1, key = eventKey } = {}) {
  return db.prepare(`INSERT INTO operator_reviews
    (request_id, camera_id, incident_id, analysis_event_key, revision, expected_revision,
     subject, email, created_ms, disposition, ignition_source, ignition_tool,
     independent_evidence_json, rationale, payload_json, payload_hash)
    VALUES (?, 'cam', ?, ?, ?, ?, 'operator-1', 'reviewer@example.test', 1000,
      'accept', 'human_activity', 'lighter', ?, 'Onsite findings', '{}', ?)`)
    .run(request, incidentId, key, revision, revision - 1,
      JSON.stringify({ kind: 'onsite_inspection', reference: 'inspection-42', summary: 'Signed inspection record' }), 'a'.repeat(64));
}

test('independent evidence kinds and bounded Unicode text remain literal bound claims rather than SQL or model promotion', async () => {
  const db = database();
  const who = await principal();
  try {
    db.exec(readFileSync(migrationURL, 'utf8')); await seed(db);
    const original = db.prepare('SELECT * FROM events ORDER BY id').all();
    let revision = 0;
    for (const [kind, source] of [['onsite_inspection', 'human_activity'], ['independent_recording', 'electrical'], ['verified_investigation', 'other']]) {
      const value = body({ request_id: `00000000-0000-4000-8000-${String(revision + 1).padStart(12, '0')}`, expected_revision: revision,
        ignition_source: source, ignition_tool: 'unknown', rationale: "Inspection: '); DROP TABLE events; --",
        independent_evidence: { kind, reference: '🔥'.repeat(512), summary: '🔥'.repeat(2000) } });
      const result = await api.submitCauseReview(d1(db), who, 'cam', value);
      assert.deepEqual(result.operator_review.independent_evidence, value.independent_evidence);
      assert.equal(result.operator_review.rationale, value.rationale);
      assert.equal(result.operator_review.ignition_source, source);
      revision++;
    }
    assert.deepEqual(db.prepare('SELECT * FROM events ORDER BY id').all(), original);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM operator_reviews').get().n, 3);
  } finally { db.close(); }
});

test('forged serialized cloned and unauthorized principals cannot read or write reviewer data', async () => {
  const who = await principal();
  let prepares = 0;
  const untouched = { prepare() { prepares++; throw new Error('unauthorized SQL'); } };
  for (const forged of [null, undefined, {}, { subject: 'operator-1', email: 'operator@example.test' }, { ...who }, structuredClone(who), JSON.parse(JSON.stringify(who))]) {
    await assert.rejects(api.submitCauseReview(untouched, forged, 'cam', body()), error => error.status === 401 || error.status === 403);
    await assert.rejects(api.listCauseReviews(untouched, forged, 'cam', incidentId), error => error.status === 401 || error.status === 403);
  }
  const otherPermissionFixture = await makeOperatorFixture({ permissions: ['inference:recover'] });
  const otherPermission = await authorizeOperator(new Request('https://example.test/operator', { headers: otherPermissionFixture.headers }),
    otherPermissionFixture.env, 'inference:recover', 'cam', { fetcher: otherPermissionFixture.fetcher });
  await assert.rejects(api.submitCauseReview(untouched, otherPermission, 'cam', body()), error => error.status === 403);
  await assert.rejects(api.listCauseReviews(untouched, otherPermission, 'cam', incidentId), error => error.status === 403);
  await assert.rejects(api.submitCauseReview(untouched, who, 'other-camera', body()), error => error.status === 403);
  await assert.rejects(api.listCauseReviews(untouched, who, 'other-camera', incidentId), error => error.status === 403);
  assert.equal(prepares, 0);
});

test('failed D1 writes and missing committed readbacks cannot be reported as success', async () => {
  const who = await principal();
  const db = database();
  try {
    db.exec(readFileSync(migrationURL, 'utf8')); await seed(db);
    const base = d1(db);
    const rejectedDB = { prepare(sql) {
      if (/INSERT INTO operator_reviews/.test(sql)) return { bind: () => ({ run: async () => ({ success: false, error: 'unavailable' }) }) };
      return base.prepare(sql);
    } };
    await assert.rejects(api.submitCauseReview(rejectedDB, who, 'cam', body()), error => error.status === 503 && error.code === 'review_write_failed');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM operator_reviews').get().n, 0);
    const hiddenReadback = { prepare(sql) {
      const statement = base.prepare(sql);
      if (!/SELECT \* FROM operator_reviews WHERE request_id/.test(sql)) return statement;
      return { bind(...params) { const bound = statement.bind(...params); return { ...bound, async first() { await bound.first(); return null; } }; } };
    } };
    await assert.rejects(api.submitCauseReview(hiddenReadback, who, 'cam', body()), error => error.status === 503 && error.code === 'review_readback_failed');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM operator_reviews').get().n, 1);
    assert.equal((await api.submitCauseReview(base, who, 'cam', body())).idempotent, true);
  } finally { db.close(); }
});

test('later reject and inconclusive reviews supersede acceptance without changing any historical row', async () => {
  assert.equal(typeof api.listCauseReviews, 'function', 'review history API must exist');
  const db = database();
  try {
    db.exec(readFileSync(migrationURL, 'utf8')); await seed(db);
    const who = await principal();
    const first = await api.submitCauseReview(d1(db), who, 'cam', body());
    const initialRow = db.prepare('SELECT * FROM operator_reviews WHERE revision=1').get();
    await api.submitCauseReview(d1(db), who, 'cam', body({ request_id: '00000000-0000-4000-8000-000000000002', expected_revision: 1,
      disposition: 'reject', ignition_source: 'unknown', ignition_tool: 'unknown', independent_evidence: null }));
    await api.submitCauseReview(d1(db), who, 'cam', body({ request_id: '00000000-0000-4000-8000-000000000003', expected_revision: 2,
      disposition: 'inconclusive', ignition_source: 'unknown', ignition_tool: 'unknown', independent_evidence: null }));
    const history = await api.listCauseReviews(d1(db), who, 'cam', incidentId);
    assert.deepEqual(history.reviews.map(row => row.disposition), ['inconclusive', 'reject', 'accept']);
    assert.equal(history.latest_revision, 3);
    assert.equal(history.has_more, false);
    assert.equal(history.next_before_revision, null);
    assert.deepEqual(history.reviews[2], first.operator_review);
    assert.deepEqual(db.prepare('SELECT * FROM operator_reviews WHERE revision=1').get(), initialRow);
    const page = await api.listCauseReviews(d1(db), who, 'cam', incidentId, { limit: 2 });
    assert.deepEqual(page.reviews.map(row => row.revision), [3, 2]);
    assert.equal(page.latest_revision, 3); assert.equal(page.has_more, true); assert.equal(page.next_before_revision, 2);
    const rest = await api.listCauseReviews(d1(db), who, 'cam', incidentId, { limit: 2, beforeRevision: page.next_before_revision });
    assert.deepEqual(rest.reviews.map(row => row.revision), [1]);
    assert.equal(rest.latest_revision, 3); assert.equal(rest.has_more, false); assert.equal(rest.next_before_revision, null);
    await seed(db, { incident: 'cam:2000:1' });
    assert.deepEqual(await api.listCauseReviews(d1(db), who, 'cam', 'cam:2000:1'), { reviews: [], latest_revision: 0, has_more: false, next_before_revision: null });
    await assert.rejects(api.listCauseReviews(d1(db), who, 'cam', 'cam:missing:1'), error => error.status === 404 && error.code === 'review_target_not_found');
    for (const options of [{ limit: 0 }, { limit: 101 }, { limit: '2' }, { limit: 1.5 }, { beforeRevision: 0 }, { beforeRevision: '2' }, { beforeRevision: Infinity }]) {
      await assert.rejects(api.listCauseReviews(d1(db), who, 'cam', incidentId, options), error => error.status === 400);
    }
    assert.equal(db.prepare('SELECT cause FROM events WHERE event_key=?').get(eventKey).cause, 'unknown');
  } finally { db.close(); }
});

test('lost acknowledgements and canonical-key-order retries return the same committed review only once', async () => {
  const db = database();
  try {
    db.exec(readFileSync(migrationURL, 'utf8')); await seed(db);
    const who = await principal();
    const lostAck = d1(db, { afterRun(sql) { if (/INSERT INTO operator_reviews/.test(sql)) throw new Error('ack lost'); } });
    await assert.rejects(api.submitCauseReview(lostAck, who, 'cam', body(), { nowMs: 1234 }), /ack lost/);
    const reversed = Object.fromEntries(Object.entries(body()).reverse());
    reversed.independent_evidence = Object.fromEntries(Object.entries(reversed.independent_evidence).reverse());
    const retry = await api.submitCauseReview(d1(db), who, 'cam', reversed, { nowMs: 9999 });
    assert.equal(retry.idempotent, true);
    assert.equal(retry.operator_review.created_ms, 1234);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM operator_reviews').get().n, 1);
    const stored = db.prepare('SELECT * FROM operator_reviews').get();
    assert.match(stored.payload_hash, /^[a-f0-9]{64}$/);
    assert.equal(stored.payload_hash, Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stored.payload_json))).toString('hex'));
    const DB = racingD1(db);
    const simultaneous = await Promise.all([
      api.submitCauseReview(DB, who, 'cam', body({ request_id: '00000000-0000-4000-8000-000000000002', expected_revision: 1 })),
      api.submitCauseReview(DB, who, 'cam', body({ request_id: '00000000-0000-4000-8000-000000000002', expected_revision: 1 })),
    ]);
    assert.deepEqual(simultaneous.map(row => row.idempotent).sort(), [false, true]);
    assert.deepEqual(simultaneous[0].operator_review, simultaneous[1].operator_review);
  } finally { db.close(); }
});

test('a request ID cannot be reused with any changed claim actor or target', async () => {
  const fixture = await makeOperatorFixture({ cameras: ['cam', 'cam2'] });
  const who = await principal(fixture);
  const secondFixture = { ...fixture, env: { ...fixture.env, OPERATOR_POLICY_JSON: JSON.stringify({
    ...JSON.parse(fixture.env.OPERATOR_POLICY_JSON), 'operator-2': { email: 'second@example.test', permissions: ['cause:review'], cameras: ['cam', 'cam2'] },
  }) } };
  const second = await principal(secondFixture, { 'cf-access-jwt-assertion': await fixture.sign({ sub: 'operator-2', email: 'second@example.test' }) });
  const db = database();
  try {
    db.exec(readFileSync(migrationURL, 'utf8')); await seed(db); await seed(db, { cameraId: 'cam2', incident: 'cam2:1000:1' });
    await api.submitCauseReview(d1(db), who, 'cam', body());
    const changed = [body({ expected_revision: 1 }), body({ ignition_source: 'electrical' }), body({ ignition_tool: 'unknown' }), body({ rationale: 'Different rationale' }),
      ...Object.entries({ kind: 'verified_investigation', reference: 'another-record', summary: 'Different summary' }).map(([key, value]) => body({ independent_evidence: { ...body().independent_evidence, [key]: value } })),
      body({ disposition: 'reject', ignition_source: 'unknown', ignition_tool: 'unknown', independent_evidence: null }),
      body({ analysis_event_key: `${incidentId}:analysis:2` }), body({ incident_id: 'cam:other:1' })];
    for (const value of changed) await assert.rejects(api.submitCauseReview(d1(db), who, 'cam', value), error => error.status === 409 && error.code === 'review_request_conflict');
    await assert.rejects(api.submitCauseReview(d1(db), second, 'cam', body()), error => error.status === 409 && error.code === 'review_request_conflict');
    await assert.rejects(api.submitCauseReview(d1(db), who, 'cam2', body()), error => error.status === 409 && error.code === 'review_request_conflict');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM operator_reviews').get().n, 1);
  } finally { db.close(); }
});

test('concurrent request ID reuse across different targets is a controlled conflict', async () => {
  const fixture = await makeOperatorFixture({ cameras: ['cam', 'cam2'] });
  const who = await principal(fixture);
  const db = database();
  try {
    db.exec(readFileSync(migrationURL, 'utf8')); await seed(db); await seed(db, { cameraId: 'cam2', incident: 'cam2:1000:1' });
    const DB = racingD1(db);
    const outcomes = await Promise.allSettled([
      api.submitCauseReview(DB, who, 'cam', body()),
      api.submitCauseReview(DB, who, 'cam2', body({ incident_id: 'cam2:1000:1', analysis_event_key: 'cam2:1000:1:analysis:1' })),
    ]);
    assert.equal(outcomes.filter(row => row.status === 'fulfilled').length, 1);
    const conflict = outcomes.find(row => row.status === 'rejected').reason;
    assert.equal(conflict.status, 409); assert.equal(conflict.code, 'review_request_conflict');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM operator_reviews').get().n, 1);
  } finally { db.close(); }
});

test('concurrent requests atomically compete for one incident revision', async () => {
  const db = database();
  try {
    db.exec(readFileSync(migrationURL, 'utf8')); await seed(db);
    const who = await principal();
    const DB = racingD1(db);
    const outcomes = await Promise.allSettled([
      api.submitCauseReview(DB, who, 'cam', body()),
      api.submitCauseReview(DB, who, 'cam', body({ request_id: '00000000-0000-4000-8000-000000000002' })),
    ]);
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = outcomes.find(result => result.status === 'rejected');
    assert.equal(rejected.reason.status, 409);
    assert.equal(rejected.reason.code, 'review_revision_conflict');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM operator_reviews').get().n, 1);
    await writeIncidentRecord(d1(db), createAnalysisRecord({ cameraId: 'cam', incidentId, ts: 1001, priority: 'inspect_urgently',
      jobId: 2, cause: {}, evidence_manifest: [], reason: 'later_measured_peak', incident_closed: false }));
    await assert.rejects(api.submitCauseReview(d1(db), who, 'cam', body({ request_id: '00000000-0000-4000-8000-000000000003', analysis_event_key: `${incidentId}:analysis:2` })),
      error => error.status === 409 && error.code === 'review_revision_conflict');
    const next = await api.submitCauseReview(d1(db), who, 'cam', body({ request_id: '00000000-0000-4000-8000-000000000003', expected_revision: 1, analysis_event_key: `${incidentId}:analysis:2` }));
    assert.equal(next.operator_review.revision, 2);
  } finally { db.close(); }
});

test('reviews require exact camera incident analysis identity plus durable confirmation', async () => {
  const fixture = await makeOperatorFixture({ cameras: ['cam', 'cam2'] });
  const who = await principal(fixture);
  for (const scenario of ['missing_analysis', 'missing_confirmation', 'confirmation_key', 'wrong_incident', 'wrong_camera', 'missing_event']) {
    const db = database();
    try {
      db.exec(readFileSync(migrationURL, 'utf8'));
      await seed(db, { confirmation: scenario !== 'missing_confirmation', analysis: scenario !== 'missing_analysis' });
      await seed(db, { cameraId: 'cam2', incident: 'cam2:1000:1' });
      let value = body();
      let cameraId = 'cam';
      if (scenario === 'confirmation_key') value.analysis_event_key = `${incidentId}:confirmation`;
      if (scenario === 'wrong_incident') value.incident_id = 'cam:other:1';
      if (scenario === 'wrong_camera') cameraId = 'cam2';
      if (scenario === 'missing_event') value.analysis_event_key = `${incidentId}:analysis:missing`;
      await assert.rejects(api.submitCauseReview(d1(db), who, cameraId, value), error => error.status === 404 && error.code === 'review_target_not_found', scenario);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM operator_reviews').get().n, 0);
    } finally { db.close(); }
  }
});

test('strict bounded review DTO rejects unsupported evidence, causal intent, safety claims and silent coercion before SQL', async () => {
  const who = await principal();
  let prepares = 0;
  const untouched = { prepare() { prepares++; throw new Error('unexpected SQL'); } };
  const invalid = [null, [], {}, { ...body(), subject: 'spoofed' }, { ...body(), email: 'spoofed' },
    ...['fuel_type', 'fire_class', 'recommended_agent', 'hazard_absence_verified', 'accepted_cause', 'model_claims', 'evidence_refs', 'frame_ids', 'source'].map(key => ({ ...body(), [key]: 'forbidden' }))];
  for (const [key, values] of Object.entries({
    request_id: ['', '00000000-0000-1000-8000-000000000001', '00000000-0000-4000-7000-000000000001', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', '00000000-0000-4000-8000-000000000001 '],
    incident_id: ['', 'x'.repeat(257), '../incident', ' cam:1000:1', 'cam:1000:1\n'],
    analysis_event_key: ['', 'x'.repeat(513), 'a/b', 'key\u0000'],
    expected_revision: [-1, 0.5, '0', NaN, Infinity, Number.MAX_SAFE_INTEGER],
    disposition: ['approved', 'arson', null], ignition_source: ['human', 'arson', 'intentional', 'unknown', null],
    ignition_tool: ['', ' ', 'x'.repeat(121), 'tool\u0000', 7, '\ud800'],
    independent_evidence: [null, [], {}, { kind: 'uploaded_frame', reference: 'frame-1', summary: 'Visible person' },
      { kind: 'model_assertion', reference: 'model', summary: 'High confidence' },
      { kind: 'onsite_inspection', reference: '', summary: 'Report' },
      { kind: 'onsite_inspection', reference: 'x'.repeat(513), summary: 'Report' },
      { kind: 'onsite_inspection', reference: 'report', summary: 'x'.repeat(2001) },
      { ...body().independent_evidence, model_verified: true }],
    rationale: ['', ' ', 'x'.repeat(2001), 'bad\u0000', 1],
  })) for (const value of values) invalid.push({ ...body(), [key]: value });
  for (const key of Object.keys(body())) { const missing = body(); delete missing[key]; invalid.push(missing); }
  for (const disposition of ['reject', 'inconclusive']) {
    invalid.push(body({ disposition, ignition_source: 'electrical' }));
    invalid.push(body({ disposition, ignition_source: 'unknown', ignition_tool: 'lighter' }));
  }
  let accessorInvoked = false;
  const accessor = body(); Object.defineProperty(accessor, 'rationale', { enumerable: true, get() { accessorInvoked = true; return 'report'; } });
  invalid.push(accessor, { ...body(), toJSON() { return body(); } });
  const hidden = body(); Object.defineProperty(hidden, 'hidden', { value: 'secret' }); invalid.push(hidden);
  const symbol = body(); symbol[Symbol('secret')] = 'value'; invalid.push(symbol);
  for (const value of invalid) await assert.rejects(api.submitCauseReview(untouched, who, 'cam', value), error => error.status === 400 && error.code === 'review_invalid_request');
  for (const camera of ['', 'bad.camera', 'x'.repeat(129), 'cam\n']) await assert.rejects(api.submitCauseReview(untouched, who, camera, body()), error => [400, 403].includes(error.status));
  for (const nowMs of [-1, Infinity, NaN, 1.5, 8640000000000001]) await assert.rejects(api.submitCauseReview(untouched, who, 'cam', body(), { nowMs }), error => error.status === 400);
  assert.equal(accessorInvoked, false);
  assert.equal(prepares, 0);
});

test('authenticated acceptance is read back separately without changing model events or claiming factual verification', async () => {
  assert.equal(typeof api.submitCauseReview, 'function', 'review submission must exist');
  const db = database();
  try {
    db.exec(readFileSync(migrationURL, 'utf8'));
    await seed(db);
    const events = db.prepare('SELECT * FROM events ORDER BY id').all();
    let readback = false;
    const result = await api.submitCauseReview(d1(db, { afterFirst(sql, row) { if (row?.request_id === body().request_id) readback = true; } }), await principal(), 'cam', body(), { nowMs: 1234 });
    assert.equal(readback, true, 'must read exact committed row before success');
    assert.equal(result.idempotent, false);
    assert.equal(result.operator_review.revision, 1);
    assert.equal(result.operator_review.subject, 'operator-1');
    assert.equal(result.operator_review.email, 'operator@example.test');
    assert.equal(result.operator_review.created_ms, 1234);
    assert.equal(result.operator_review.ignition_source, 'human_activity');
    assert.deepEqual(result.operator_review.independent_evidence, body().independent_evidence);
    assert.equal(result.operator_review.provenance, 'operator_attestation');
    assert.equal(result.operator_review.factual_correctness_verified, false);
    assert.deepEqual(db.prepare('SELECT * FROM events ORDER BY id').all(), events);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM operator_reviews').get().n, 1);
  } finally { db.close(); }
});

test('new migration preserves old events and makes review history append-only with exact targets', async () => {
  assert.ok(existsSync(migrationURL), 'review migration must exist');
  const db = database();
  try {
    await seed(db);
    const events = db.prepare('SELECT * FROM events ORDER BY id').all();
    db.exec(readFileSync(migrationURL, 'utf8'));
    rawReview(db);
    rawReview(db, { request: '00000000-0000-4000-8000-000000000002', revision: 2 });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM operator_reviews').get().n, 2);
    assert.throws(() => db.exec("UPDATE operator_reviews SET rationale='rewritten'"), /immutable|append.only/i);
    assert.throws(() => db.exec('DELETE FROM operator_reviews'), /immutable|append.only/i);
    assert.throws(() => db.exec(`INSERT OR REPLACE INTO operator_reviews
      SELECT request_id, camera_id, incident_id, analysis_event_key, 3, 2, subject, email, created_ms,
        disposition, ignition_source, ignition_tool, independent_evidence_json, rationale, payload_json, payload_hash
      FROM operator_reviews WHERE revision = 1`), /immutable|request|append.only/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM operator_reviews').get().n, 2);
    assert.throws(() => rawReview(db, { request: '00000000-0000-4000-8000-000000000003', revision: 4 }), /revision/i);
    assert.throws(() => rawReview(db, { request: '00000000-0000-4000-8000-000000000003', revision: 3, key: `${incidentId}:confirmation` }), /target|analysis/i);
    assert.deepEqual(db.prepare('SELECT * FROM events ORDER BY id').all(), events);
  } finally { db.close(); }
});
