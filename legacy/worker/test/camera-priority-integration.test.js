import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { CameraDO } from '../src/camera-do.js';

function harness(contexts) {
  const db = new DatabaseSync(':memory:');
  for (const name of ['0001_init.sql', '0002_analysis.sql', '0003_event_keys.sql']) {
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
  const jobs = [], events = [], queries = [];
  const camera = new CameraDO({storage: {}, waitUntil: job => jobs.push(job),
    getWebSockets: () => [{send: value => events.push(...[JSON.parse(value)].flat())}]}, {
    EVIDENCE_STORAGE: 'pi', CAMERA_CONTEXTS_JSON: contexts,
    DB: {prepare: sql => {queries.push(sql); return {bind: (...params) => ({
      run: async () => db.prepare(sql).run(...params),
    })};}},
  });
  return {camera, db, jobs, events, queries};
}
const reviewedAt = Date.now() - 5000;
const reviewed = {reviewed: true, reviewed_by: 'test operator', reviewed_at_ms: reviewedAt,
  occupied_area: true, known_hazards: ['electrical'], critical_zones: ['emergency_exit']};
const observation = ts => ({camera_id: 'cam', ts_ms: ts, frame_wh: [100,80],
  detections: [{cls: 'fire', conf: 0.8, bbox_xyxy: [0,0,20,20]}]});

test('actual CameraDO uses reviewed configuration for event, snapshot and persisted operator priority', async () => {
  const {camera, db, jobs, events, queries} = harness(JSON.stringify({cam: reviewed}));
  try {
    for (let i = 1; i <= 5; i++) {
      const response = await camera.fetch(new Request('https://do/cam', {method: 'POST',
        body: JSON.stringify({...observation(reviewedAt + i * 1000), site_context: {occupied_area: false}})}));
      assert.equal(response.status, 200);
    }
    await Promise.all(jobs);
    const confirmation = events.find(event => event.type === 'fire_confirmed');
    assert.equal(confirmation.response_priority, 'escalate');
    assert.equal(confirmation.context_status, 'reviewed');
    assert.notEqual(confirmation.assessment_quality, 'invalid');
    assert.equal(confirmation.hazard_level, 'unknown');
    assert.equal(Object.hasOwn(confirmation, 'site_context'), false, 'private reviewed context is an input, not public evidence');
    assert.equal(Object.hasOwn(confirmation, 'now_ms'), false, 'policy clock remains server-internal');
    assert.equal(camera.snapshot().response_priority, 'escalate');
    assert.equal(Object.hasOwn(camera.snapshot(), 'now_ms'), false, 'snapshot does not expose policy clock metadata');
    const cause = events.find(event => event.type === 'cause_update');
    assert.equal(cause.response_priority, 'escalate');
    assert.equal(confirmation.incident_id, cause.incident_id, 'detection and investigation share one incident identity');
    const row = db.prepare('SELECT * FROM events').get();
    assert.equal(row.operator_priority, 'escalate');
    const saved = JSON.parse(row.analysis_json);
    assert.equal(saved.response_priority, 'escalate');
    assert.equal(saved.priority_assessment.context_status, 'reviewed');
    assert.equal(saved.cause.ignition_source, 'unknown');
    assert.equal(queries.some(query => /SELECT context_json/.test(query)), false,
      'the retired raw D1 context loader must not compete with reviewed environment configuration');
  } finally {db.close();}
});

test('actual growing-footprint escalation requires explicit stationary camera and adequate visibility', async () => {
  for (const motion of [false, null]) {
    const {camera, db, jobs, events} = harness(undefined);
    try {
      for (let i = 1; i <= 5; i++) {
        camera.ingest({...observation(i * 1000), visibility: 'adequate', camera_motion: motion,
          site_context: reviewed, response_priority: 'escalate',
          detections: [{cls: 'fire', conf: 0.8, bbox_xyxy: [0,0,10 * i,20]}]}, 'cam');
      }
      await Promise.all(jobs);
      const event = events.find(value => value.type === 'fire_confirmed');
      assert.equal(event.visual_activity, 'growing');
      assert.equal(event.response_priority, motion === false ? 'escalate' : 'inspect_urgently');
      assert.equal(event.context_status, 'missing', 'uploaded context has no authority');
      assert.equal(event.assessment_quality, motion === false ? 'supported' : 'limited');
      assert.equal(event.hazard_level, 'unknown');
    } finally {db.close();}
  }
});
