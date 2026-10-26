import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraDO } from '../src/camera-do.js';
import { contextForCamera, isReviewedSiteContext } from '../src/site-context.js';

const observation={camera_id:'cam',ts_ms:1000,frame_wh:[100,80],detections:[]};
test('camera context comes only from reviewed environment configuration, not model, upload or retired D1 JSON', async () => {
  const reviewedAt=Date.now()-2000;
  const trusted={reviewed:true,reviewed_by:'operator',reviewed_at_ms:reviewedAt,
    occupied_area:true,known_hazards:['electrical'],critical_zones:['emergency_exit']};
  let lookups=0;
  const c=new CameraDO({storage:{},getWebSockets:()=>[]}, {
    CAMERA_CONTEXTS_JSON:JSON.stringify({cam:trusted}),
    DB:{prepare:()=>{lookups++;throw new Error('retired context source');}},
  });
  const request=body=>new Request('https://do/cam',{method:'POST',body:JSON.stringify(body)});
  assert.equal((await c.fetch(request({...observation,ts_ms:reviewedAt+1000,site_context:{reviewed:true,reviewed_by:'forged'}}))).status,200);
  assert.deepEqual(c.siteContext,trusted);
  const reference=c.siteContext;
  assert.equal(c.snapshot().context_status,'reviewed');
  assert.equal((await c.fetch(request({...observation,ts_ms:reviewedAt+1100,site_context:{known_hazards:[]}}))).status,200);
  assert.equal(c.siteContext,reference,'retain the privately trusted immutable reference');
  assert.equal(lookups,0,'raw D1 context is not a second authority');
});

test('malformed observations cannot load context; malformed configuration remains missing context, never hazard clearance', async () => {
  const c=new CameraDO({storage:{},getWebSockets:()=>[]}, {CAMERA_CONTEXTS_JSON:'{'});
  const post=body=>new Request('https://do/cam',{method:'POST',body:JSON.stringify(body)});
  assert.equal((await c.fetch(post({...observation,detections:null}))).status,422);
  assert.equal(c.contextCamera,null);
  assert.equal(c.currentObservation,null);
  assert.equal((await c.fetch(post(observation))).status,200);
  assert.equal(c.siteContext,null);
  assert.equal(c.snapshot().context_status,'missing');
  assert.equal(c.snapshot().hazard_level,'unknown');
});

test('source geometry requires a complete expiring review with exact reference and normalized stationary zones', async () => {
  const api = await import('../src/site-context.js');
  const reviewedAt = 1_000;
  const reference = {reviewed:true, reviewed_by:'operator', reviewed_at_ms:reviewedAt,
    review_expires_at_ms:reviewedAt + 30 * 24 * 60 * 60 * 1000,
    context_revision:3, geometry_revision:2,
    reviewed_reference_image_sha256:'a'.repeat(64), reference_dimensions:[640,480],
    crop_rect:[0,0,1,1], expected_flame_use:true, occupied_area:false,
    known_hazards:[], critical_zones:[], source_zones:[{zone_id:'candle-1',source_type:'candle',bbox_normalized:[0.2,0.2,0.6,0.7]}]};
  const context = api.contextForCamera(JSON.stringify({cam:reference}), 'cam');
  assert.ok(context);
  assert.equal(api.isReviewedSourceContext(context,'cam',2_000,2_000),true);
  assert.equal(api.isReviewedSourceContext(context,'cam',2_000,reference.review_expires_at_ms + 1),false);
  assert.equal(api.isReviewedSourceContext(api.contextForCamera(JSON.stringify({cam:{...reference,expected_flame_use:false}}),'cam'),'cam',2_000,2_000),false);
  assert.equal(api.isReviewedSourceContext(context,'other',2_000,2_000),false);

  for (const patch of [
    {context_revision:0}, {geometry_revision:-1}, {review_expires_at_ms:reviewedAt + 30 * 24 * 60 * 60 * 1000 + 1},
    {reviewed_reference_image_sha256:'not-a-hash'}, {reference_dimensions:[0,480]},
    {crop_rect:[0.5,0,0.6,1]}, {source_zones:[]},
    {source_zones:[{zone_id:'moving',source_type:'handheld_tool',bbox_normalized:[0,0,1,1]}]},
    {source_zones:[{zone_id:'bad',source_type:'candle',bbox_normalized:[0.8,0.2,0.2,0.7]}]},
    {source_zones:[{zone_id:'candle-1',source_type:'candle',bbox_normalized:[0.2,0.2,0.6,0.7]},
      {zone_id:'candle-1',source_type:'candle',bbox_normalized:[0.1,0.1,0.3,0.3]}]},
    {geometry_revision:undefined},
  ]) {
    const invalid = {...reference,...patch};
    if (patch.geometry_revision === undefined) delete invalid.geometry_revision;
    assert.equal(api.contextForCamera(JSON.stringify({cam:invalid}),'cam'),null,JSON.stringify(patch));
  }
});

test('legacy expected-flame context remains readable but cannot qualify reviewed geometry', async () => {
  const legacy = contextForCamera(JSON.stringify({cam:{reviewed:true,reviewed_by:'operator',reviewed_at_ms:1,
    occupied_area:false,known_hazards:[],critical_zones:[],expected_flame_use:true}}),'cam');
  assert.ok(legacy);
  assert.equal(isReviewedSiteContext(legacy,'cam',2_000,2_000),true);
  // A camera-wide flag is not a reviewed source zone.
  assert.equal(typeof (await import('../src/site-context.js')).isReviewedSourceContext, 'function');
  assert.equal((await import('../src/site-context.js')).isReviewedSourceContext(legacy,'cam',2_000,2_000),false);
});

test('handheld lighter-use permission is explicit, reviewed, camera-bound, and expires with the policy', async () => {
  const api = await import('../src/site-context.js');
  const policy = {reviewed:true, reviewed_by:'operator', reviewed_at_ms:1_000,
    expected_handheld_flame_use:true, occupied_area:false, known_hazards:[], critical_zones:[]};
  const context = api.contextForCamera(JSON.stringify({cam:policy}), 'cam');
  assert.ok(context);
  assert.equal(api.isReviewedHandheldUseContext(context, 'cam', 2_000, 2_000), true);
  assert.equal(api.isReviewedHandheldUseContext(context, 'other', 2_000, 2_000), false);
  assert.equal(api.isReviewedHandheldUseContext({...context}, 'cam', 2_000, 2_000), false);
  assert.equal(api.isReviewedHandheldUseContext(context, 'cam', 1_000 + api.MAX_SITE_REVIEW_AGE_MS + 1,
    1_000 + api.MAX_SITE_REVIEW_AGE_MS + 1), false);
  for (const raw of [
    {...policy, expected_handheld_flame_use:'true'},
    {...policy, expected_handheld_flame_use:false},
  ]) {
    const parsed = api.contextForCamera(JSON.stringify({cam:raw}), 'cam');
    assert.equal(api.isReviewedHandheldUseContext(parsed, 'cam', 2_000, 2_000), false);
  }
  const withoutPermission = api.contextForCamera(JSON.stringify({cam:{...policy,
    expected_handheld_flame_use:undefined}}), 'cam');
  assert.equal(api.isReviewedHandheldUseContext(withoutPermission, 'cam', 2_000, 2_000), false);
});
