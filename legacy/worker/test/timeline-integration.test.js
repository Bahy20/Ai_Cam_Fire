import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraDO } from '../src/camera-do.js';
import { SCOUT_TEST_MODEL, testInferenceEnvironment } from './test-inference-budget.js';

const jpeg = Buffer.from([255,216,255,192,0,17,8,0,80,0,100,3,1,17,0,2,17,0,3,17,0,255,217]).toString('base64');
function harness() {
  const jobs = [], events = [];
  const c = new CameraDO({storage: {get: async () => null}, waitUntil: job => jobs.push(job),
    getWebSockets: () => [{send: raw => events.push(...[JSON.parse(raw)].flat())}]}, testInferenceEnvironment({
      EVIDENCE_STORAGE: 'pi', DB: {prepare: () => ({bind: () => ({run: async () => {}})})},
  }));
  return {c, jobs, events};
}
async function upload(c, ts, width) {
  const response = await c.fetch(new Request('https://do/cam/snapshot', {method: 'POST',
    body: JSON.stringify({ts_ms: ts, snap_b64: jpeg})}));
  assert.equal(response.status, 200);
  c.ingest({camera_id: 'cam',ts_ms: ts,frame_wh:[100,80],edge_observation:true,
    detections: width === null ? [] : [{cls:'fire',conf:0.8,bbox_xyxy:[0,0,width,60]}]}, 'cam');
}

test('native Workers AI receives every selected image with actual frame identifiers and timestamp roles', async () => {
  const {c,jobs} = harness();
  let request;
  c.env.VLM_PROVIDER='workers_ai'; c.env.VLM_MODEL=SCOUT_TEST_MODEL;
  c.env.AI={run: async (_model,input)=>{request=input; return {response:'{}'};}};
  for (const [i,width] of [null,null,10,50,30,20,10].entries()) await upload(c,(i+1)*1000,width);
  await Promise.all(jobs);
  const content=request.messages[0].content;
  assert.ok(content.filter(part=>part.type==='image_url').length>=4, 'selected timeline must reach the actual binding');
  const text=content.filter(part=>part.type==='text').map(part=>part.text).join('\n');
  assert.match(text,/frame-3000/);
  assert.match(text,/frame-4000/);
  assert.match(text,/observations/);
  assert.match(text,/action_frame_ids/);
});

test('actual confirmation sends chronological timeline including onset context and pre-confirmation peak', async () => {
  const {c,jobs,events} = harness();
  let selected;
  c.analyzeCause = async input => {selected = input.frames; return {ignition_source:'unknown', confidence:'low'};};
  for (const [i,width] of [null,null,10,50,30,20,10].entries()) await upload(c, (i+1)*1000, width);
  await Promise.all(jobs);
  assert.equal(c.alert, 'confirmed');
  assert.ok(Array.isArray(selected), 'actual caller must use the timeline, not only oldest + confirmation');
  assert.ok(selected.length >= 4 && selected.length <= 6);
  assert.deepEqual(selected.map(f=>f.ts_ms), [...selected.map(f=>f.ts_ms)].sort((a,b)=>a-b));
  assert.ok(selected.some(f=>f.ts_ms===3000 && f.roles.includes('onset')));
  assert.ok(selected.some(f=>f.ts_ms===4000 && f.roles.includes('peak')));
  assert.ok(selected.some(f=>f.ts_ms===7000 && f.roles.includes('recent')));
  assert.ok(selected.every(f=>f.frame_id===`frame-${f.ts_ms}` && f.pre_ignition_verified===false && f.image_b64 === jpeg));
  const event=events.find(e=>e.type==='cause_update');
  assert.equal(event.evidence_manifest.length, selected.length);
  assert.equal(JSON.stringify(event).includes('jpeg_b64'), false, 'events contain metadata, not image bytes');
});
