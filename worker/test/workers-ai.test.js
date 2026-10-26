import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraDO } from '../src/camera-do.js';

const model = '@cf/meta/llama-4-scout-17b-16e-instruct';
const early = {frame_id: 'frame-1', ts_ms: 1, roles: ['early'], pre_ignition_verified: false, peak_scope: null, image_b64: 'AQI='};
const confirmation = {frame_id: 'frame-2', ts_ms: 2, roles: ['onset','peak','recent'], pre_ignition_verified: false, peak_scope: 'observed_so_far', image_b64: 'AwQ='};
function testBudgetBinding() {
  const running = new Set();
  return {idFromName:name=>name,get:()=>({fetch:async request=>{
    const action=new URL(request.url).pathname.split('/').at(-1);
    const body=await request.json();
    if(action==='reserve') {
      if(running.has(body.key))return Response.json({mode:'skipped',reason:'vlm_inference_still_running'});
      running.add(body.key);return Response.json({mode:'fresh'});
    }
    if(action==='complete'){running.delete(body.key);return Response.json({completed:true});}
    return Response.json({recorded:true});
  }})};
}
const camera = env => new CameraDO({ storage: { get: async () => null }, getWebSockets: () => [] },
  {APP_ENV:'development',VLM_EVALUATION_MODE:'true',CAMERA_DO:testBudgetBinding(),...env});
const abstains = result => {
  assert.equal(result.recommended_agent, 'undetermined');
  assert.equal(result.fire_class, 'unknown');
  assert.equal(result.confidence, 'low');
};

test('explicit Workers AI ignores stale HTTP URL and sends bounded chronological vision messages with exact model provenance', async t => {
  let request;
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('stale external endpoint must not be called'); });
  const c = camera({ VLM_PROVIDER: 'workers_ai', VLM_MODEL: model,
    VLM_URL: 'https://stale.modal.run/analyze', AI: { run: async (id, input) => {
      request = input;
      assert.equal(id, model);
      return { response: '{"ignition_source":"unknown"}', model: 'untrusted-model' };
    } } });
  const result = await c.analyzeCause({frames: [early, confirmation]});
  assert.ok(request, 'AI binding is selected');
  assert.equal(request.stream, false);
  assert.equal(request.max_tokens, 1536);
  assert.equal(request.temperature, 0.1);
  assert.equal(request.messages[0].role, 'user');
  const content = request.messages[0].content;
  assert.match(content[0].text, /Roles never establish pre-ignition/);
  assert.deepEqual(content.filter(part => part.type === 'image_url').map(part => part.image_url.url), [
    'data:image/jpeg;base64,AQI=', 'data:image/jpeg;base64,AwQ=',
  ]);
  assert.equal(result.source, 'workers_ai');
  assert.equal(result.model, model);
  abstains(result);
});

test('obsolete provider and missing binding/model abstain before any inference', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ cause: {} }); });
  const base = { VLM_PROVIDER: 'workers_ai', VLM_MODEL: model, AI: {run: async () => { calls++; return {response: '{}'}; }} };
  for (const [override, error] of [
    [{ AI: undefined, VLM_URL: 'https://stale.modal.run' }, 'workers_ai_binding_missing'],
    [{ AI: {} }, 'workers_ai_binding_missing'],
    [{ VLM_MODEL: undefined }, 'vlm_model_missing'],
    [{ VLM_MODEL: '   ' }, 'vlm_model_missing'],
    [{ VLM_PROVIDER: 'typo', VLM_URL: 'https://example.invalid' }, 'invalid_vlm_provider'],
    [{ VLM_PROVIDER: 'modal' }, 'invalid_vlm_provider'],
    [{ VLM_PROVIDER: 'local' }, 'invalid_vlm_provider'],
  ]) {
    const result = await camera({...base, ...override}).analyzeCause({frames: [confirmation]});
    abstains(result);
    assert.equal(result.source, 'rules_fallback');
    assert.equal(result.vlm_error, error, JSON.stringify(override));
  }
  assert.equal(calls, 0);
});

test('a timed-out Pi evidence request does not spend Scout neurons on an older retained pack', async () => {
  let calls = 0;
  const c = camera({VLM_PROVIDER: 'workers_ai', VLM_MODEL: model,
    AI: {run: async () => {calls++; return {response: '{}'};}}});
  const result = await c.analyzeCause({frames: [early, confirmation], evidenceUnavailable: true});
  assert.equal(calls, 0);
  assert.equal(result.source, 'rules_fallback');
  assert.equal(result.vlm_error, 'evidence_unavailable');
  assert.equal(result.inference_metadata.mode, 'skipped');
});

test('Workers AI malformed outputs abstain and prompt forbids invented physical measurements', async () => {
  let wire;
  let prompt;
  const c = camera({VLM_PROVIDER: 'workers_ai', VLM_MODEL: model, AI: {run: async (_id, request) => {
    prompt = request.messages[0].content[0].text;
    return wire;
  }}});
  for (wire of [null, {response: ''}, {response: 'not JSON'}, {response: []},
    {response: '{"recommended_agent":"water_or_soil_sand","safe":true,"physical_size_m":2}'},
    {response: '{"ignition_source":"arson","ignition_tool":"torch"}'}]) {
    const result = await c.analyzeCause({frames: [confirmation]});
    abstains(result);
    assert.equal(result.ignition_source, 'unknown');
    assert.equal(result.safe, undefined);
    assert.equal(result.physical_size_m, undefined);
    assert.equal(result.model, model);
  }
  assert.match(prompt, /Do not infer .*real-world size/);
});

test('binding deadline returns abstention without claiming cancellation and ignores late completion', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const c = camera({ VLM_PROVIDER: 'workers_ai', VLM_MODEL: model, VLM_TIMEOUT_MS: 5,
    AI: {run: () => pending} });
  const guard = setTimeout(() => resolve({response: '{}'}), 100);
  try {
    const result = await c.analyzeCause({frames: [confirmation]});
    abstains(result);
    assert.equal(result.source, 'rules_fallback');
    assert.equal(result.vlm_error, 'vlm_timeout');
    assert.equal(result.model, model);
    resolve({response: '{"ignition_source":"human"}'});
    await Promise.resolve();
    assert.equal(result.ignition_source, 'unknown');
  } finally { clearTimeout(guard); }
});

test('a timed-out native call retains its inference permit until the actual promise settles', async () => {
  let release, calls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const c = camera({VLM_PROVIDER: 'workers_ai', VLM_MODEL: model, VLM_TIMEOUT_MS: 5,
    AI: {run: () => {calls++; return calls === 1 ? pending : Promise.resolve({response: '{}'});}}});
  assert.equal((await c.analyzeCause({frames: [confirmation]})).vlm_error, 'vlm_timeout');
  const blocked = await c.analyzeCause({frames: [confirmation]});
  assert.equal(calls, 1, 'caller timeout is not native cancellation and must not permit overlap');
  assert.equal(blocked.vlm_error, 'vlm_inference_still_running');
  abstains(blocked);
  release({response: '{}'});
  await new Promise(resolve => setImmediate(resolve));
  const next = await c.analyzeCause({frames: [confirmation]});
  assert.equal(calls, 2);
  assert.equal(next.source, 'workers_ai');
});
