import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { qualifyModelInvestigation } from '../src/investigation.js';
import { assessResponsePriority } from '../src/rules.js';

function migrate(db, number) {
  const name = ['0001_init.sql', '0002_analysis.sql', '0003_event_keys.sql'][number - 1];
  const url = new URL(`../migrations/${name}`, import.meta.url);
  assert.ok(existsSync(url), `${name} must exist`);
  db.exec(readFileSync(url, 'utf8'));
}
function d1(db, afterRun = () => {}) {
  return { prepare: sql => ({ bind: (...params) => ({ run: async () => {
    const result = db.prepare(sql).run(...params);
    afterRun();
    return result;
  } }) }) };
}

const moduleURL = new URL('../src/incident-store.js', import.meta.url);
const api = existsSync(moduleURL) ? await import(moduleURL) : {};
const confirmation = { cameraId: 'cam', incidentId: 'cam:1000:1', ts: 1000, priority: 'inspect_urgently' };
const frames = [{ frame_id: 'frame-1000', ts_ms: 1000, roles: ['recent'], pre_ignition_verified: false,
  peak_scope: null, frame_wh: [640, 480] }];
function analysis(overrides = {}) {
  return { ...confirmation, jobId: 1, reason: 'initial_confirmation', incident_closed: false,
    cause: qualifyModelInvestigation({ observations: [{ kind: 'flame_visible', frame_ids: ['frame-1000'],
      description: "Visible flame; '); DROP TABLE events; --" }], hypothesis: { ignition_source: 'human',
      ignition_tool: 'lighter', fuel_type: 'wood_paper', confidence: 'high', action_frame_ids: [], ignition_frame_id: 'frame-1000' } }, frames),
    evidence_manifest: frames, ...overrides };
}

test('separate analysis jobs coexist with confirmation and preserve only unverified candidate claims', async () => {
  assert.equal(typeof api.createAnalysisRecord, 'function', 'analysis record factory must exist');
  const db = new DatabaseSync(':memory:');
  try {
    for (const n of [1, 2, 3]) migrate(db, n);
    const priority = assessResponsePriority({ camera_id: 'cam', ts_ms: 1000, detection_status: 'confirmed' });
    const first = api.createAnalysisRecord(analysis({ priority }));
    const second = api.createAnalysisRecord(analysis({ jobId: 'job-2', reason: 'later_measured_peak', incident_closed: true }));
    for (const row of [api.createConfirmationRecord({ ...confirmation, priority }), first, second, first, second]) await api.writeIncidentRecord(d1(db), row);
    const rows = db.prepare('SELECT * FROM events ORDER BY id').all();
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map(row => row.event_key), ['cam:1000:1:confirmation', 'cam:1000:1:analysis:1', 'cam:1000:1:analysis:job-2']);
    for (const row of rows) {
      assert.equal(row.cause, 'unknown');
      assert.equal(row.confidence, 'low');
      assert.equal(row.snapshot_key, null);
    }
    const body = JSON.parse(rows[1].analysis_json);
    assert.equal(body.event_kind, 'analysis');
    assert.equal(body.analysis_status, 'complete');
    assert.equal(body.analysis_job_id, 1);
    assert.equal(body.analysis_reason, 'initial_confirmation');
    assert.equal(body.incident_closed, false);
    assert.equal(body.cause.hypothesis.ignition_source, 'human');
    assert.equal(body.cause.model_claims.provenance, 'untrusted_model_output');
    assert.equal(body.cause.accepted_cause, 'unknown');
    assert.deepEqual(body.evidence_manifest, frames);
    assert.deepEqual(body.priority_assessment, priority);
    assert.equal(body.response_priority, priority.response_priority);
    assert.equal(JSON.parse(rows[2].analysis_json).incident_closed, true);
    assert.equal(JSON.parse(rows[0].analysis_json).analysis_status, 'pending');
    assert.deepEqual(JSON.parse(rows[0].analysis_json).priority_assessment, priority);
  } finally { db.close(); }
});

test('V3 tool assertions survive the bounded persistence codec as untrusted claims', () => {
  const evidence = [1000, 3000, 5000].map(ts_ms => ({frame_id:`frame-${ts_ms}`, ts_ms,
    roles:['recent'], pre_ignition_verified:false, peak_scope:null, frame_wh:[640,480]}));
  const ids = evidence.map(frame => frame.frame_id);
  const raw = {contract_version:3,
    observations:ids.map(frame_id=>({kind:'flame_at_tool',frame_ids:[frame_id],description:'Visible flame at tool tip.'})),
    hypothesis:{ignition_source:'unknown',ignition_tool:'unknown',fuel_type:'unknown',confidence:'low',
      action_frame_ids:[],ignition_frame_id:null}, scene_assertions:[],
    tool_assertions:ids.map(frame_id=>({frame_id,candidate_id:null,tool_type:'lighter',flame_relation:'at_tool_tip',
      secondary_burning:'not_observed',smoke:'not_observed',occlusion:'not_observed'}))};
  const cause=qualifyModelInvestigation(raw,evidence);
  const record=api.createAnalysisRecord(analysis({cause,evidence_manifest:evidence}));
  const body=JSON.parse(record.analysis_json);
  assert.deepEqual(body.cause.model_claims.tool_assertions,raw.tool_assertions);
  assert.equal(body.cause.accepted_cause,'unknown');
  assert.equal(body.cause.scene_assessment.category,'contained_tool_flame');
});

test('analysis persistence retains priority scope so historical monitor output cannot look like a live alert', () => {
  const interval=api.createAnalysisRecord(analysis({priority_scope:'observed_interval'}));
  const live=api.createConfirmationRecord({...confirmation,priority_scope:'live'});
  assert.equal(JSON.parse(interval.analysis_json).priority_scope,'observed_interval');
  assert.equal(JSON.parse(live.analysis_json).priority_scope,'live');
  assert.throws(()=>api.createAnalysisRecord(analysis({priority_scope:'invalid'})),/priority_scope/);
  assert.throws(()=>api.createAnalysisRecord(analysis({priority_scope:'live'})),/priority_scope/);
  assert.throws(()=>api.createConfirmationRecord({...confirmation,priority_scope:'observed_interval'}),/priority_scope/);
});

test('accepted cause/tool/fuel/class cannot be promoted by a source label or review flag', () => {
  for (const source of ['workers_ai', 'human_review', 'reviewed_operator', 'rules_fallback']) {
    for (const [key, value] of Object.entries({ ignition_source: 'human', probable_cause: 'electrical',
      accepted_cause: 'spark', ignition_tool: 'lighter', fuel_type: 'wood_paper', fire_class: 'A',
      recommended_agent: 'water_or_soil_sand', electrical_hazard: 'absent', incompatible_fuel_hazard: 'absent',
      confidence: 'high', hazard_absence_verified: true, requires_human_review: false, require_human_review: false })) {
      const cause = { ...analysis().cause, source, [key]: value };
      assert.throws(() => api.createAnalysisRecord(analysis({ cause })), /cause|unreviewed|accepted|metadata/, `${source}/${key}`);
    }
  }
  const cause = { ignition_source: 'unknown', probable_cause: 'unknown', confidence: 'low', source: 'rules_fallback',
    model_hypothesis: { ignition_source: 'human', grounding_status: 'unsupported' } };
  const body = JSON.parse(api.createAnalysisRecord(analysis({ cause })).analysis_json);
  assert.equal(body.cause.accepted_cause, 'unknown');
  assert.equal(body.cause.requires_human_review, true);
  assert.equal(body.cause.model_hypothesis.ignition_source, 'human');
  assert.equal(cause.accepted_cause, undefined, 'input must not be mutated');
});

test('event identities preserve the actual Pi camera contract, including leading underscores and 128 characters', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    for(const n of [1,2,3]) migrate(db,n);
    for(const cameraId of ['_camera','-camera','_'.repeat(128)]) {
      const incidentId=`${cameraId}:1000:1`;
      const record=api.createConfirmationRecord({...confirmation,cameraId,incidentId});
      await api.writeIncidentRecord(d1(db),record);
      assert.equal(db.prepare('SELECT camera_id FROM events WHERE event_key=?').get(record.event_key).camera_id,cameraId);
    }
  } finally {db.close();}
});

test('record identities, timestamps, job IDs, priorities and completion metadata are bounded', () => {
  for (const [key, values] of Object.entries({ cameraId: ['', 'a'.repeat(129), 'bad id', 'x\u0000'],
    incidentId: ['', 'a'.repeat(257), '../incident'], ts: [-1, NaN, Infinity, 8640000000000001],
    priority: [undefined, null, 1, 'urgent', { response_priority: 'inspect_urgently', config: { secret: true } }] })) {
    for (const value of values) {
      assert.throws(() => api.createConfirmationRecord({ ...confirmation, [key]: value }), /metadata|priority|camera|incident|timestamp/, `${key}=${String(value)}`);
      assert.throws(() => api.createAnalysisRecord(analysis({ [key]: value })), /metadata|priority|camera|incident|timestamp/, `analysis ${key}`);
    }
  }
  for (const [key, values] of Object.entries({ jobId: [undefined, 0, -1, 1.5, {}, 'a'.repeat(81), 'x:analysis:2'],
    reason: [undefined, '', 'a'.repeat(81), 'bad\nreason'], incident_closed: [undefined, 0, 'false'] })) {
    for (const value of values) assert.throws(() => api.createAnalysisRecord(analysis({ [key]: value })), /metadata|job|reason|closed/, key);
  }
});

test('metadata cannot carry images, arbitrary config, invalid JSON values or unbounded structures', () => {
  const cyclic = {}; cyclic.self = cyclic;
  const causes = [null, [], { ...analysis().cause, jpeg_b64: 'image' }, { ...analysis().cause, config: { safe: true } },
    { ...analysis().cause, source: 'bad source' }, { ...analysis().cause, model: 'x'.repeat(161) },
    { ...analysis().cause, reasons: [undefined] }, { ...analysis().cause, reasons: ['x'.repeat(301)] },
    { ...analysis().cause, reasons: Array(9).fill('x') }, { ...analysis().cause, reasons: [NaN] },
    { ...analysis().cause, model_hypothesis: { ignition_source: 'arson' } },
    { ...analysis().cause, model_hypothesis: { ignition_source: 'human', image_b64: 'image' } },
    { ...analysis().cause, hypothesis: cyclic }, { ...analysis().cause, model_claims: { provenance: 'verified' } },
    { ...analysis().cause, reasons: [1n] }, { ...analysis().cause, reasons: [new Date()] },
    { ...analysis().cause, reasons: [() => {}] }, { ...analysis().cause, toJSON: () => ({ ignition_source: 'human' }) }];
  for (const cause of causes) assert.throws(() => api.createAnalysisRecord(analysis({ cause })), /metadata|cause|JSON|bound|field/);
  const manifests = [null, {}, Array(33).fill(frames[0]), [{ ...frames[0], image_b64: 'image' }],
    [{ ...frames[0], snapshot_key: 'not-an-archive' }], [{ ...frames[0], ts_ms: -1 }],
    [{ ...frames[0], roles: ['pre_ignition'] }], [{ ...frames[0], pre_ignition_verified: true }],
    [{ ...frames[0], frame_wh: [0, 1] }], [frames[0], frames[0]], [{ ...frames[0], area_fraction: 2 }]];
  for (const evidence_manifest of manifests) assert.throws(() => api.createAnalysisRecord(analysis({ evidence_manifest })), /manifest|metadata|bound|field/);
  const full = { ...frames[0], fire_evidence: 'strong', smoke_evidence: 'unknown', confidence: 0.8,
    area_px: 100, area_fraction: 0.01, area_reliable: true, visibility: 'unknown' };
  assert.deepEqual(JSON.parse(api.createAnalysisRecord(analysis({ evidence_manifest: [full] })).analysis_json).evidence_manifest, [full]);
  const exact = { ...full, local_ref: {session_id:'2cf1a098-15d8-45bc-96f1-87f776ec3611',
    generation:1,attempt_sequence:7,jpeg_sha256:'a'.repeat(64)} };
  assert.deepEqual(JSON.parse(api.createAnalysisRecord(analysis({ evidence_manifest: [exact] })).analysis_json).evidence_manifest, [exact]);
  for (const local_ref of [{...exact.local_ref,jpeg_sha256:'bad'}, {...exact.local_ref,local_path:'C:/private/image.jpg'}])
    assert.throws(() => api.createAnalysisRecord(analysis({ evidence_manifest: [{...full,local_ref}] })), /local_ref|metadata/);
  const priority = { ...assessResponsePriority(), response_priority: 'escalate', operator_priority: 'monitor' };
  assert.throws(() => api.createConfirmationRecord({ ...confirmation, priority }), /priority|metadata/);
});

test('UTF-8 byte budget bounds aggregate Unicode metadata without silently truncating review claims', async () => {
  const cause = analysis().cause;
  cause.observations = Array.from({ length: 16 }, () => ({ kind: 'flame_visible', frame_ids: ['frame-1000'], description: '🔥'.repeat(300) }));
  cause.model_claims.observations = structuredClone(cause.observations);
  const priority = { response_priority: 'inspect_urgently', limitations: Array(32).fill('🔥'.repeat(300)) };
  assert.throws(() => api.createAnalysisRecord(analysis({ cause, priority })), /JSON byte bounds/);
  const valid = api.createAnalysisRecord(analysis({ cause }));
  assert.ok(Buffer.byteLength(valid.analysis_json, 'utf8') <= 65536);
  const db = new DatabaseSync(':memory:');
  try {
    for (const n of [1, 2, 3]) migrate(db, n);
    await api.writeIncidentRecord(d1(db), valid);
    const body = JSON.parse(db.prepare('SELECT analysis_json FROM events WHERE event_key = ?').get(valid.event_key).analysis_json);
    assert.equal(body.cause.observations[15].description, '🔥'.repeat(300));
  } finally { db.close(); }
  let invoked = false;
  const getter = { ...analysis().cause };
  Object.defineProperty(getter, 'model', { enumerable: true, get() { invoked = true; return 'model'; } });
  assert.throws(() => api.createAnalysisRecord(analysis({ cause: getter })), /JSON accessor|JSON field/);
  assert.equal(invoked, false);
});

test('writer rejects tampered/out-of-contract records before touching the database', async () => {
  const row = api.createConfirmationRecord(confirmation);
  let prepares = 0;
  const DB = { prepare() { prepares++; throw new Error('must not reach DB'); } };
  const body = JSON.parse(row.analysis_json);
  const invalid = [null, {}, { ...row, event_key: 'other:confirmation' }, { ...row, event_kind: 'analysis' },
    { ...row, cause: 'human' }, { ...row, confidence: 'high' }, { ...row, snapshot_key: 'cloud/image' },
    { ...row, operator_priority: 'escalate' }, { ...row, jpeg_b64: 'raw' }, { ...row, analysis_json: '{broken' },
    { ...row, analysis_json: JSON.stringify({ ...body, cause: { ...body.cause, accepted_cause: 'human', source: 'human_review' } }) },
    { ...row, analysis_json: JSON.stringify({ ...body, config: { trusted: true } }) },
    { ...row, analysis_json: JSON.stringify({ ...body, analysis_status: 'complete' }) },
    { ...row, analysis_json: JSON.stringify({ ...body, evidence_manifest: [{ ...frames[0], jpeg_b64: 'raw' }] }) }];
  const interval=api.createAnalysisRecord(analysis({priority_scope:'observed_interval'}));
  const intervalBody=JSON.parse(interval.analysis_json);
  invalid.push({...interval,analysis_json:JSON.stringify({...intervalBody,priority_scope:'live'})});
  for (const bad of invalid) await assert.rejects(api.writeIncidentRecord(DB, bad), /record|metadata|JSON|cause|manifest/);
  assert.equal(prepares, 0);
});

test('writer propagates real SQLite schema and connection failures', async () => {
  const row = api.createConfirmationRecord(confirmation);
  const db = new DatabaseSync(':memory:');
  for (const n of [1, 2]) migrate(db, n);
  await assert.rejects(api.writeIncidentRecord(d1(db), row), /event_key|event_kind/);
  migrate(db, 3);
  db.exec('DROP TABLE events');
  await assert.rejects(api.writeIncidentRecord(d1(db), row), /no such table/);
  db.close();
  await assert.rejects(api.writeIncidentRecord(d1(db), row), /not open|closed/);
  await assert.rejects(api.writeIncidentRecord({ prepare() { throw new Error('prepare failure'); } }, row), /prepare failure/);
  await assert.rejects(api.writeIncidentRecord({ prepare: () => ({ bind() { throw new Error('bind failure'); } }) }, row), /bind failure/);
  await assert.rejects(api.writeIncidentRecord({ prepare: () => ({ bind: () => ({ run: async () =>
    ({ success: false, error: 'D1 rejected write' }) }) }) }, row), /incident record write failed/);
});

test('fractional source timestamps survive the event and manifest SQLite roundtrip', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const n of [1, 2, 3]) migrate(db, n);
    const input = { ...confirmation, ts: 1000.5, incidentId: 'cam:1000.5:1' };
    const row = api.createAnalysisRecord(analysis({ ...input,
      evidence_manifest: [{ ...frames[0], frame_id: 'frame-1000.5', ts_ms: 1000.5 }] }));
    await api.writeIncidentRecord(d1(db), row);
    await api.writeIncidentRecord(d1(db), api.createConfirmationRecord(input));
    const persisted = db.prepare('SELECT * FROM events WHERE event_key = ?').get(row.event_key);
    assert.equal(persisted.ts_ms, 1000.5);
    assert.equal(JSON.parse(persisted.analysis_json).evidence_manifest[0].ts_ms, 1000.5);
  } finally { db.close(); }
});

test('confirmation is a plain pending record with explicitly unknown unreviewed cause', () => {
  assert.equal(typeof api.createConfirmationRecord, 'function', 'confirmation record factory must exist');
  const row = api.createConfirmationRecord(confirmation);
  assert.deepEqual(Object.keys(row).sort(), ['camera_id', 'ts_ms', 'incident_id', 'event_key', 'event_kind', 'cause', 'confidence', 'snapshot_key', 'analysis_json', 'operator_priority'].sort());
  assert.equal(Object.getPrototypeOf(row), Object.prototype);
  assert.equal(row.camera_id, 'cam');
  assert.equal(row.ts_ms, 1000);
  assert.equal(row.incident_id, confirmation.incidentId);
  assert.equal(row.event_key, 'cam:1000:1:confirmation');
  assert.equal(row.event_kind, 'confirmation');
  assert.equal(row.cause, 'unknown');
  assert.equal(row.confidence, 'low');
  assert.equal(row.snapshot_key, null);
  assert.equal(row.operator_priority, 'inspect_urgently');
  const body = JSON.parse(row.analysis_json);
  assert.equal(body.event_kind, 'confirmation');
  assert.equal(body.analysis_status, 'pending');
  assert.equal(body.response_priority, row.operator_priority);
  assert.equal(body.priority_assessment, null);
  assert.deepEqual(body.evidence_manifest, []);
  for (const key of ['ignition_source', 'probable_cause', 'accepted_cause', 'ignition_tool', 'fuel_type', 'fire_class']) assert.equal(body.cause[key], 'unknown');
  assert.equal(body.cause.requires_human_review, true);
  assert.equal(body.cause.hazard_absence_verified, false);
});

test('migrated SQLite keeps legacy NULL rows and an acknowledgement-lost retry inserts only once', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrate(db, 1);
    migrate(db, 2);
    db.exec("INSERT INTO events (camera_id, ts_ms, cause) VALUES ('legacy', 1, 'human'), ('legacy', 2, 'unknown')");
    migrate(db, 3);
    assert.equal(typeof api.writeIncidentRecord, 'function', 'durable writer must exist');
    const row = api.createConfirmationRecord(confirmation);
    await assert.rejects(api.writeIncidentRecord(d1(db, () => { throw new Error('ack lost'); }), row), /ack lost/);
    await api.writeIncidentRecord(d1(db), row);
    const rows = db.prepare('SELECT * FROM events ORDER BY id').all();
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.slice(0, 2).map(row => [row.event_key, row.event_kind, row.cause]), [[null, null, 'human'], [null, null, 'unknown']]);
    for (const key of Object.keys(row)) assert.deepEqual(rows[2][key], row[key]);
    assert.throws(() => db.prepare('INSERT INTO events (camera_id, ts_ms, event_key) VALUES (?, ?, ?)').run('cam', 2, row.event_key), /UNIQUE/);
    assert.throws(() => db.prepare('INSERT INTO events (camera_id, ts_ms, event_kind) VALUES (?, ?, ?)').run('cam', 2, 'made_up'), /CHECK/);
  } finally { db.close(); }
});
