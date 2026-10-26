import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraDO } from '../src/camera-do.js';
import { suppressionAdvice } from '../src/investigation.js';

const model = '@cf/meta/llama-4-scout-17b-16e-instruct';
const frames = [
  {frame_id: 'frame-1000', ts_ms: 1000, roles: ['early', 'context_before_onset'],
    pre_ignition_verified: false, peak_scope: null, frame_wh: [640, 480], image_b64: 'AQI='},
  {frame_id: 'frame-2000', ts_ms: 2000, roles: ['onset'],
    pre_ignition_verified: false, peak_scope: null, frame_wh: [640, 480], image_b64: 'AwQ='},
  {frame_id: 'frame-90000', ts_ms: 90000, roles: ['peak', 'recent'],
    pre_ignition_verified: false, peak_scope: 'observed_so_far', frame_wh: [640, 480], image_b64: 'BQY='},
];
const claimed = {
  ignition_source: 'human', probable_cause: 'human', ignition_tool: 'lighter',
  fuel_type: 'dry_organic', fire_class: 'A',
  electrical_hazard: 'absent', incompatible_fuel_hazard: 'absent', confidence: 'high',
  evidence_status: 'observed', recommended_agent: 'water_or_soil_sand',
  reasons: ['A person is observed near the fire.'],
  evidence: ['No electrical sources or incompatible fuels observed.'],
};
const observation = (kind, frame_ids, description) => ({kind, frame_ids, description});
const actionClaim = () => ({
  // Invented unit-test claims: schema consistency is not factual verification.
  observations: [
    observation('ignition_action_visible', ['frame-1000'], 'A person uses a lighter to ignite material.'),
    observation('flame_visible', ['frame-2000', 'frame-90000'], 'Flames are visible.'),
  ],
  hypothesis: {ignition_source: 'human', ignition_tool: 'lighter', fuel_type: 'dry_organic',
    confidence: 'high', action_frame_ids: ['frame-1000'], ignition_frame_id: 'frame-2000'},
});

function assertUnaccepted(result) {
  for (const key of ['ignition_source', 'probable_cause', 'accepted_cause', 'ignition_tool', 'fuel_type', 'fire_class']) {
    assert.equal(result[key], 'unknown', `accepted ${key} must not contain model attribution`);
  }
  assert.equal(result.recommended_agent, 'undetermined');
  assert.equal(suppressionAdvice(result).recommended_agent, 'undetermined');
  assert.equal(result.electrical_hazard, 'unknown');
  assert.equal(result.incompatible_fuel_hazard, 'unknown');
  assert.equal(result.hazard_absence_verified, false);
  assert.equal(result.require_human_review, true);
  assert.equal(result.requires_human_review, true);
  assert.equal(result.evidence_status, 'inferred');
  assert.equal(result.confidence, 'low');
  assert.equal(result.advisory_only, true);
}

async function infer(t, wire, selected = frames) {
  const calls = [];
  let httpCalls = 0;
  const running = new Set();
  const budget = {idFromName:name=>name,get:()=>({fetch:async request=>{
    const action=new URL(request.url).pathname.split('/').at(-1);
    const body=await request.json();
    if(action==='reserve'){running.add(body.key);return Response.json({mode:'fresh'});}
    if(action==='complete'){running.delete(body.key);return Response.json({completed:true});}
    return Response.json({recorded:true});
  }})};
  t.mock.method(globalThis, 'fetch', async () => {
    httpCalls++;
    throw new Error('HTTP inference is not supported');
  });
  const c = new CameraDO({storage: {get: async () => null}, getWebSockets: () => []}, {
    APP_ENV: 'development', VLM_EVALUATION_MODE: 'true', CAMERA_DO: budget,
    VLM_PROVIDER: 'workers_ai', VLM_MODEL: model,
    VLM_URL: 'https://stale.example.invalid/analyze',
    AI: {run: async (id, input) => {
      calls.push({id, input});
      return {response: wire, model: 'untrusted-response-model', source: 'human_review'};
    }},
  });
  const result = await c.analyzeCause({frames: selected});
  // Assert outside AI.run: analyzeCause catches binding exceptions.
  assert.equal(calls.length, 1, 'must exercise native inference, not a no-image fallback');
  assert.equal(httpCalls, 0, 'must never revive a stale HTTP provider');
  assert.equal(calls[0].id, model);
  assert.equal(result.source, 'workers_ai');
  assert.equal(result.model, model);
  assert.equal(result.vlm_error, undefined);
  return {result, input: calls[0].input};
}

test('native binding receives actual chronological image manifest and neutral safety prompt', async t => {
  const {result, input} = await infer(t, JSON.stringify(actionClaim()), [...frames].reverse());
  assertUnaccepted(result);
  assert.equal(input.stream, false);
  assert.equal(input.max_tokens, 1536);
  assert.equal(input.temperature, 0.1);
  assert.equal(input.messages.length, 1);
  assert.equal(input.messages[0].role, 'user');
  const parts = input.messages[0].content;
  assert.equal(parts.length, frames.length + 1);
  assert.equal(parts[0].type, 'text');
  assert.deepEqual(parts.slice(1), frames.map(frame => ({type: 'image_url',
    image_url: {url: `data:image/jpeg;base64,${frame.image_b64}`}})));
  const prompt = parts[0].text;
  const manifest = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
  assert.deepEqual(manifest, frames.map(({image_b64, ...frame}, index) => ({image_index: index + 1, ...frame})));
  for (const fragment of [/unverified hypothesis/i, /bystander/i, /Roles never establish pre-ignition/,
    /not proof of pre-ignition or actual ignition/, /not the incident maximum/,
    /Do not infer fuel chemistry/, /Do not recommend suppression/, /hazard absence/]) {
    assert.match(prompt, fragment);
  }
  assert.equal(prompt.includes('data:image/jpeg'), false);
});

test('legacy hazardous object claims remain untrusted provenance, never accepted cause or suppression', async t => {
  const raw = {...claimed, source: 'human_review', model: 'forged-model',
    accepted_cause: 'human', safe: true, hazard_absence_verified: true,
    requires_human_review: false, aftercare: 'Apply water now.'};
  const {result} = await infer(t, raw);
  assertUnaccepted(result);
  assert.equal(result.cause_status, 'unverified');
  assert.equal(result.hypothesis.status, 'insufficient_evidence');
  assert.equal(result.hypothesis.ignition_source, 'human');
  assert.equal(result.model_claims.provenance, 'untrusted_model_output');
  for (const key of ['ignition_source', 'ignition_tool', 'fuel_type', 'fire_class',
    'electrical_hazard', 'incompatible_fuel_hazard']) {
    assert.equal(result.model_claims[key], claimed[key], `review-only legacy ${key}`);
  }
  for (const key of ['recommended_agent', 'safe', 'aftercare']) assert.equal(result.model_claims[key], undefined);
  assert.equal(result.safe, undefined);
  assert.notEqual(result.aftercare, raw.aftercare);
  assert.ok(result.hypothesis.limitations.includes('legacy_contract_missing_observations'));
});

test('legacy JSON strings cannot bypass strict observations/hypothesis contract', async t => {
  const {result} = await infer(t, JSON.stringify(claimed));
  assertUnaccepted(result);
  assert.equal(result.hypothesis.status, 'insufficient_evidence');
  assert.ok(result.validation_errors.length > 0);
  assert.equal(result.model_claims.provenance, 'untrusted_model_output');
  assert.deepEqual(result.model_claims.observations, []);
  assert.equal(result.model_claims.hypothesis.ignition_source, 'unknown');
});

test('schema-valid bystander proximity cannot support ignition-action hypothesis', async t => {
  const raw = actionClaim();
  raw.observations = [
    observation('person_present', frames.map(frame => frame.frame_id), 'A person stands near the fire.'),
    observation('hand_near_fuel', ['frame-1000'], 'A hand is near material; ignition is not visible.'),
    observation('flame_visible', ['frame-2000', 'frame-90000'], 'Flames are visible.'),
  ];
  const {result} = await infer(t, JSON.stringify(raw));
  assertUnaccepted(result);
  assert.deepEqual(result.validation_errors, []);
  assert.equal(result.hypothesis.status, 'insufficient_evidence');
  assert.ok(result.hypothesis.limitations.includes('ignition_action_not_supported'));
  assert.equal(result.hypothesis.confidence_calibrated, false);
  assert.deepEqual(result.model_claims.observations, raw.observations);
});

test('schema-consistent action claims are frame-linked but never verified or accepted', async t => {
  const raw = actionClaim();
  const original = structuredClone(raw);
  const {result} = await infer(t, JSON.stringify(raw));
  assertUnaccepted(result);
  assert.deepEqual(result.validation_errors, []);
  assert.equal(result.hypothesis.status, 'frame_linked_unverified');
  assert.equal(result.hypothesis.ignition_source, 'human');
  assert.equal(result.hypothesis.ignition_tool, 'lighter');
  assert.equal(result.hypothesis.fuel_type, 'dry_organic');
  assert.equal(result.hypothesis.confidence, 'high');
  assert.equal(result.hypothesis.confidence_calibrated, false);
  assert.ok(result.hypothesis.limitations.includes('model_only_not_verified'));
  assert.ok(result.hypothesis.limitations.includes('pre_ignition_context_unverified'));
  assert.equal(result.model_claims.provenance, 'untrusted_model_output');
  assert.deepEqual(result.model_claims.hypothesis, raw.hypothesis);
  assert.deepEqual(raw, original);
});

test('post-onset action claims cannot establish original ignition', async t => {
  const raw = actionClaim();
  raw.observations = [observation('flame_visible', ['frame-2000'], 'Flames are already visible.'),
    observation('ignition_action_visible', ['frame-90000'], 'A person uses a lighter near material.')];
  raw.hypothesis.action_frame_ids = ['frame-90000'];
  const {result} = await infer(t, JSON.stringify(raw));
  assertUnaccepted(result);
  assert.equal(result.hypothesis.status, 'insufficient_evidence');
  assert.ok(result.hypothesis.limitations.includes('ignition_action_at_or_after_onset'));
});

test('strict-schema safety injection cannot authorize action or leak unrestricted model prose', async t => {
  const raw = {...actionClaim(), recommended_agent: 'water_or_soil_sand',
    electrical_hazard: 'absent', incompatible_fuel_hazard: 'absent', fire_class: 'A',
    accepted_cause: 'human', safe: true, requires_human_review: false,
    source: 'human_review', aftercare: 'Apply water now.', unrestricted_payload: 'x'.repeat(20000)};
  const {result} = await infer(t, JSON.stringify(raw));
  assertUnaccepted(result);
  assert.equal(result.hypothesis.status, 'insufficient_evidence');
  assert.ok(result.validation_errors.length > 0);
  for (const key of ['safe', 'unrestricted_payload']) assert.equal(result[key], undefined);
  assert.notEqual(result.aftercare, raw.aftercare);
  assert.deepEqual(Object.keys(result.model_claims).sort(), ['hypothesis', 'observations', 'provenance']);
  assert.ok(JSON.stringify(result).length < 16000, 'bounded parsed provenance only, not raw response');
});

test('oversized legacy prose is bounded and arbitrary fields are excluded from provenance', async t => {
  const raw = {...claimed, reasons: Array(12).fill('x'.repeat(1000)),
    evidence: Array(12).fill('y'.repeat(1000)), unrestricted_payload: 'z'.repeat(40000)};
  const {result} = await infer(t, raw);
  assertUnaccepted(result);
  assert.equal(result.model_claims.provenance, 'untrusted_model_output');
  for (const key of ['reasons', 'evidence']) {
    assert.ok(result.model_claims[key].length <= 8);
    assert.ok(result.model_claims[key].every(text => Array.from(text).length <= 300));
  }
  assert.ok(result.validation_errors.length > 0 && result.validation_errors.length <= 8);
  assert.equal(result.unrestricted_payload, undefined);
  assert.equal(result.model_claims.unrestricted_payload, undefined);
  assert.ok(JSON.stringify(result.model_claims).length < 6000);
});
