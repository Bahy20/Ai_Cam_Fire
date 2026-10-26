import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraDO } from '../src/camera-do.js';
import { SCOUT_TEST_MODEL, testInferenceEnvironment } from './test-inference-budget.js';

const frames = [{frame_id:'frame-1', ts_ms:1, roles:['onset','recent'],
  pre_ignition_verified:false, peak_scope:null, image_b64:'AQID'}];
const ordinary = {fuel_type:'dry_organic', evidence_status:'observed', confidence:'high',
  electrical_hazard:'absent', incompatible_fuel_hazard:'absent'};
const camera = env => new CameraDO({storage:{}, getWebSockets:()=>[]}, testInferenceEnvironment(env));
const native = run => ({VLM_MODEL:SCOUT_TEST_MODEL, AI:{run}});
function assertUnknown(r) {
  assert.equal(r.ignition_source, 'unknown');
  assert.equal(r.probable_cause, 'unknown');
  assert.equal(r.fire_class, 'unknown');
  assert.equal(r.recommended_agent, 'undetermined');
  assert.equal(r.confidence, 'low');
  assert.equal(r.advisory_only, true);
}

test('actual no-snapshot caller abstains even for smoke detections', async () => {
  const result = await camera().analyzeCause({frames:[]});
  assertUnknown(result);
  assert.equal(result.fuel_type, 'unknown');
  assert.equal(result.source, 'rules_only');
});

test('native caller ignores unsupported prose and never authorizes model suppression claims', async () => {
  let wire;
  const c = camera(native(async()=>wire));
  for (wire of [{}, {raw:'A person holds a lighter near grass.'}, {response:null},
    {response:{recommended_agent:'water_or_soil_sand', safe:true}},
    {response:{fuel_type:'invalid', confidence:0.9}}]) assertUnknown(await c.analyzeCause({frames}));
  wire = {response:{...ordinary, recommended_agent:'wet_chemical', aftercare:'wet everything', safe:true, source:'forged'}};
  const r = await c.analyzeCause({frames});
  assertUnknown(r);
  assert.equal(r.model_hypothesis.fuel_type, 'dry_organic');
  assert.equal(r.evidence_status, 'inferred');
  assert.equal(r.hazard_absence_verified, false);
  assert.equal(r.safe, undefined);
  assert.equal(r.source, 'workers_ai');
  assert.ok(!r.aftercare.includes('wet everything'));
});

test('native caller supports strict/fenced JSON or object while refusing unknown hazards', async () => {
  let wire;
  const c = camera(native(async()=>wire));
  for (wire of ['A bystander watches the fire.', '{bad', 'Example: {"ignition_source":"human"}',
    {response:{recommended_agent:'water_or_soil_sand'}}, {response:[]}]) assertUnknown(await c.analyzeCause({frames}));
  for (wire of [JSON.stringify(ordinary), {response:'```json\n'+JSON.stringify(ordinary)+'\n```'}, ordinary, {response:ordinary}]) {
    const r = await c.analyzeCause({frames});
    assertUnknown(r);
    assert.equal(r.electrical_hazard, 'unknown');
    assert.equal(r.requires_human_review, true);
    assert.equal(r.source, 'workers_ai');
  }
});

test('native exceptions do not leak upstream diagnostics and safely fall back', async () => {
  const c = camera(native(async()=>{throw new Error('private-upstream-detail');}));
  const r = await c.analyzeCause({frames});
  assertUnknown(r);
  assert.equal(r.source, 'rules_fallback');
  assert.equal(r.vlm_error, 'vlm_error');
  assert.ok(!JSON.stringify(r).includes('private-upstream-detail'));
});

test('actual enrich publishes and persists accepted unknown rather than contradictory source aliases', async () => {
  for (const source of ['human','unknown']) {
    const events = [], binds = [], jobs = [];
    const c = new CameraDO({storage:{}, waitUntil:p=>jobs.push(p),
      getWebSockets:()=>[{send: text=>events.push(...[JSON.parse(text)].flat())}]}, testInferenceEnvironment({
      EVIDENCE_STORAGE:'pi', ...native(async()=>({response:{ignition_source:source,
        probable_cause:'electrical', evidence_status:'observed', confidence:'high'}})),
      DB:{prepare:sql=>({bind:(...args)=>{
        const columns=sql.match(/INSERT INTO events \(([^)]+)\)/)[1].split(',').map(s=>s.trim());
        binds.push(Object.fromEntries(columns.map((key,i)=>[key,args[i]])));
        return {run:async()=>{}};
      }})},
    }));
    for(let ts=1;ts<=5;ts++) {
      await c.storeSnapshot(`snap:${ts}`, 'AQID'); c.snapshotKeys.add(`snap:${ts}`);
      c.ingest({ts_ms:ts, frame_wh:[100,80], detections:[{cls:'fire',conf:.8,bbox_xyxy:[0,0,10,10]}]},'cam');
    }
    await Promise.all(jobs);
    const cause = events.find(e=>e.type==='cause_update').cause;
    assertUnknown(cause);
    assert.equal(cause.model_hypothesis.ignition_source, source);
    assert.equal(binds[0].cause, 'unknown');
    assert.equal(binds[0].confidence, 'low');
    assert.deepEqual(c.snapshot().cause, cause);
  }
});

