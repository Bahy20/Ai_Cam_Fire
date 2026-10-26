import test from 'node:test';
import assert from 'node:assert/strict';
import { Coordinator } from '../src/coordinator.js';
import { Store } from '../src/store.js';

export function reply(frames, kind='lighter') {
  return {contract_version:3, observations:frames.map(f=>({frame_ids:[f.frame_id],
    kind:kind==='lighter'?'flame_at_tool':'material_burning',description:kind==='lighter'?'Flame at lighter tip.':'Other material is burning.'})),
    hypothesis:{ignition_source:'unknown',ignition_tool:'unknown',fuel_type:'unknown',confidence:'low',action_frame_ids:[],ignition_frame_id:null},
    scene_assertions:[],tool_assertions:frames.map(f=>({frame_id:f.frame_id,candidate_id:null,tool_type:'lighter',
      flame_relation:'at_tool_tip',secondary_burning:kind==='lighter'?'not_observed':'present',smoke:'not_observed',occlusion:'not_observed'}))};
}
function setup(options={}) {
  let time=100000;
  const store=new Store(':memory:');
  const scout={analyze:async frames=>({raw:reply(frames),mode:'fresh',usage:{total_tokens:12}}),...options.scout};
  const c=new Coordinator({cameraId:'test-camera',sessionId:'session-a',mode:'live',store,scout,
    expectedLighterUse:true,now:()=>time,...options});
  const put=(i,extra={})=>{time=100000+i*400;return c.accept({ts_ms:time,frame_wh:[640,480],
    detections:[{cls:'fire',conf:.8,bbox_xyxy:[10,10,25,30]}],image_b64:'AQI=',...extra});};
  return {c,put,store,setTime:t=>{time=t;}};
}

test('a scene-only provider gets three real rolling frames and retains its provider identity',async()=>{
  let request;
  const {c,put,store}=setup({scout:{sceneOnly:true,model:'MiniCPM',source:'modal',analyze:async(frames,options)=>{
    request={frames,options};return {raw:reply(frames),model:'MiniCPM',revision:'pinned',source:'modal',mode:'fresh'};
  }}});
  try{
    for(let i=0;i<=6;i++)put(i);await c.drain();
    assert.equal(request.options.purpose,'scene');assert.equal(request.frames.length,3);
    assert.equal(c.result().inference.source,'modal');assert.equal(c.result().inference.revision,'pinned');
    assert.equal(c.result().cause.status,'unknown');
    assert.equal(c.result().scene_assessment.observations[0].kind,'flame_at_tool');
  }finally{c.disconnect();store.close();}
});

test('native live feeds bypass batch analysis and use three independently bound reports',async()=>{
  let calls=0;const {c,put,store}=setup({streaming:true,scout:{analyze:async()=>{calls++;throw new Error('batch must not run');}}});
  try{
    for(const i of [0,3,6]){
      put(i);const ts=c.lastTs;
      c.acceptNative({engine:'minicpm-native-duplex',session_id:c.sessionId,sequence:i+1,source_ts_ms:ts,
        assessment_source_ts_ms:ts,native_chunks:i+1,is_listen:false,text:'[1,0,0,1,1,0]',end_of_turn:true,frame_wh:[640,480],
        assessment:{frame_id:`frame-${ts}`,flame:'present',smoke:'not_observed',burning_material:'not_observed',lighter:'present',
          flame_relation:'at_tool_tip',occlusion:'not_observed',description:'A lighter-tip flame is visible.'}},
        {jpeg:Buffer.from([255,216,255,217])});
    }
    await c.drain();assert.equal(calls,0);assert.equal(c.result().priority.level,'monitor');
    assert.equal(c.result().inference.engine,'minicpm-native-duplex');
    c.acceptNativeState('unavailable');assert.notEqual(c.scene?.failed,true);
  }finally{c.disconnect();store.close();}
});

for(const reset of ['gap','fire_clear','smoke_clear'])test(`native evidence cannot cross ${reset}`,()=>{
  const {c,put,setTime,store}=setup({streaming:true});
  const emit=ts=>c.acceptNative({engine:'minicpm-native-duplex',session_id:c.sessionId,
    source_ts_ms:ts,assessment_source_ts_ms:ts,native_chunks:1,is_listen:false,
    assessment:{frame_id:`frame-${ts}`,flame:reset==='smoke_clear'&&ts===102400?'not_observed':'present',
      smoke:'not_observed',burning_material:'not_observed',lighter:'present',
      flame_relation:reset==='smoke_clear'&&ts===102400?'not_observed':'at_tool_tip',
      occlusion:'not_observed',description:'Visible tool assessment.'}},
    {jpeg:Buffer.from([255,216,255,217])});
  try{
    if(reset==='gap'){
      put(0);emit(100000);setTime(100400);c.gap();put(2);
    }else{
      const detections=reset==='smoke_clear'?[{cls:'smoke',conf:.8,bbox_xyxy:[1,1,40,40]}]:undefined;
      for(let i=0;i<=6;i++)put(i,{visibility:'adequate',...(detections?{detections}:{})});
      emit(102400);
      for(let i=7;i<=14;i++)put(i,{visibility:'adequate',detections:[]});
      assert.equal(c.nativeFrames.length,0);
    }
    const barrier=c.lastTs;
    emit(reset==='gap'?100000:102400);
    assert.equal(c.nativeFrames.length,0,'delayed evidence from the previous generation must be rejected');
    assert.equal(c.native.assessment,null);
    for(const ts of [barrier+1000,barrier+2000]){
      setTime(ts);c.accept({ts_ms:ts,frame_wh:[640,480],detections:[{cls:'fire',conf:.8,bbox_xyxy:[10,10,25,30]}]});emit(ts);
    }
    assert.notEqual(c.result().priority.level,'monitor','two new reports cannot reuse the old third report');
  }finally{c.disconnect();store.close();}
});
test('pending never means low; valid multiframe lighter becomes monitor and cause stays unknown',async()=>{
  const {c,put,store}=setup();
  assert.equal(put(0).priority.level,'pending');
  for(let i=1;i<=6;i++) put(i);
  await c.drain();
  assert.equal(c.result().priority.level,'monitor');
  assert.equal(c.result().detection.fire,'detected');
  assert.equal(c.result().cause.status,'unknown');
  assert.equal(c.result().inference.mode,'fresh');
  c.disconnect();store.close();
});
test('smoke invalidates monitoring immediately; later lighter result cannot erase hazard latch',async()=>{
  const {c,put,store}=setup();
  for(let i=0;i<=6;i++) put(i);await c.drain();
  const smoke={detections:[{cls:'fire',conf:.8,bbox_xyxy:[10,10,25,30]},{cls:'smoke',conf:.4,bbox_xyxy:[1,1,50,50]}]};
  assert.equal(put(7,smoke).priority.level,'inspect_urgently');
  assert.notEqual(put(8).priority.level,'monitor'); // renewed evidence is required
  c.disconnect();store.close();
});

test('a weak smoke candidate in a fresh validated lighter scene requests reassessment without urgency',async()=>{
  const {c,put,store}=setup();
  try{for(let i=0;i<=6;i++)put(i);await c.drain();
    const result=put(7,{detections:[{cls:'fire',conf:.8,bbox_xyxy:[10,10,25,30]},
      {cls:'smoke',conf:.051,bbox_xyxy:[1,1,50,50]}]});
    assert.equal(result.detection.smoke,'candidate');assert.equal(result.priority.level,'pending');
  }finally{c.disconnect();store.close();}
});
test('validated material burning latches urgency despite a later lighter-only assessment',async()=>{
  let calls=0;
  const {c,put,store}=setup({scout:{analyze:async frames=>({raw:reply(frames,calls++?'lighter':'material'),mode:'fresh'})}});
  for(let i=0;i<45;i++){put(i);await c.drain();}
  assert.equal(c.result().priority.level,'inspect_urgently');c.disconnect();store.close();
});
test('continuous detector smoke still permits cause investigation without permitting monitor',async()=>{
  let calls=0;
  const {c,put,store}=setup({scout:{analyze:async frames=>{calls++;return {raw:reply(frames,'material'),mode:'fresh'};}}});
  for(let i=0;i<25;i++) {put(i,{detections:[{cls:'fire',conf:.8,bbox_xyxy:[1,1,10,10]},
    {cls:'smoke',conf:.4,bbox_xyxy:[20,20,40,40]}]});await c.drain();}
  assert.ok(calls>0);assert.equal(c.result().priority.level,'inspect_urgently');
  assert.ok(c.result().cause.observations.length);c.disconnect();store.close();
});
test('HTTP result exposes a corroborated lighter-to-material sequence as an unverified cause hypothesis',async()=>{
  const {c,put,store}=setup({mode:'recorded',scout:{analyze:async frames=>{
    const [before,tool,burning]=[frames[0],frames[1],frames.at(-1)];
    return {raw:{contract_version:3,observations:[
      {frame_ids:[before.frame_id],kind:'hand_near_fuel',description:'A hand holds an object beside dry tinder.'},
      {frame_ids:[tool.frame_id],kind:'flame_at_tool',description:'Flame appears at the tip of the handheld lighter.'},
      {frame_ids:[burning.frame_id],kind:'material_burning',description:'The dry tinder burns separately from the lighter.'}],
      hypothesis:{ignition_source:'human',ignition_tool:'lighter',fuel_type:'dry_organic',confidence:'medium',
        action_frame_ids:[before.frame_id],ignition_frame_id:tool.frame_id},
      scene_assertions:[],tool_assertions:[{frame_id:tool.frame_id,candidate_id:null,tool_type:'lighter',
        flame_relation:'at_tool_tip',secondary_burning:'not_observed',smoke:'not_observed',occlusion:'not_observed'}]},mode:'fresh'};
  }}});
  for(let i=0;i<=6;i++)put(i);
  await c.drain();
  const result=c.result();
  assert.deepEqual(result.inference.validation_errors,[]);
  assert.equal(result.cause.hypothesis.status,'insufficient_evidence');
  assert.equal(result.cause.status,'hypothesis');
  assert.equal(result.cause.verified_cause,'unknown');
  assert.deepEqual(result.cause.supporting_frame_ids,
    [result.cause.observations[0].frame_ids[0],result.cause.observations[1].frame_ids[0],result.cause.observations[2].frame_ids[0]]);
  c.disconnect();store.close();
});
test('a nearby person and burning grass do not become a human ignition claim',async()=>{
  const {c,put,store}=setup({mode:'recorded',scout:{analyze:async frames=>({raw:{contract_version:3,
    observations:[{frame_ids:[frames[0].frame_id],kind:'person_present',description:'A person stands near the lawn.'},
      {frame_ids:[frames.at(-1).frame_id],kind:'flame_visible',description:'Flame is visible on dry grass.'}],
    hypothesis:{ignition_source:'unknown',ignition_tool:'unknown',fuel_type:'unknown',confidence:'low',action_frame_ids:[],ignition_frame_id:null},
    scene_assertions:[],tool_assertions:[]},mode:'fresh'})}});
  for(let i=0;i<=6;i++)put(i);
  await c.drain();
  const result=c.result();
  assert.equal(result.cause.status,'unknown');
  assert.equal(result.cause.verified_cause,'unknown');
  assert.equal(result.cause.supporting_frame_ids.length,0);
  assert.ok(result.cause.observations.some(o=>o.description.includes('dry grass')));
  c.disconnect();store.close();
});
test('a model guess of a human lighter without a linked tool-to-material sequence stays unknown',async()=>{
  const {c,put,store}=setup({mode:'recorded',scout:{analyze:async frames=>({raw:{contract_version:3,
    observations:[{frame_ids:[frames[0].frame_id],kind:'person_present',description:'A person walks beside the scene.'},
      {frame_ids:[frames.at(-1).frame_id],kind:'material_burning',description:'Dry grass is burning on the ground.'}],
    hypothesis:{ignition_source:'human',ignition_tool:'lighter',fuel_type:'dry_organic',confidence:'low',
      action_frame_ids:[],ignition_frame_id:null},scene_assertions:[],tool_assertions:[]},mode:'fresh'})}});
  for(let i=0;i<=6;i++)put(i);
  await c.drain();
  assert.equal(c.result().cause.status,'unknown');
  assert.equal(c.result().cause.verified_cause,'unknown');
  c.disconnect();store.close();
});
test('EOF drains one coalesced current scene after a slow initial call',async()=>{
  let resolve,calls=0;
  const {c,put,store}=setup({mode:'recorded',scout:{analyze:frames=>{
    calls++;if(calls===1)return new Promise(r=>{resolve=()=>r({raw:reply(frames),mode:'fresh'});});
    return Promise.resolve({raw:reply(frames),mode:'fresh'});
  }}});
  for(let i=0;i<=6;i++)put(i);await Promise.resolve();
  for(let i=7;i<=26;i++)put(i);
  const finish=c.finish();resolve();await finish;
  assert.equal(calls,2);assert.equal(c.result().priority.level,'monitor');
  assert.equal(c.result().evidence.scene_end_ts_ms,110400);c.disconnect();store.close();
});
test('EOF reassesses recent lighter evidence even when the final frame is negative',async()=>{
  let resolveFirst;const purposes=[];
  const {c,put,store}=setup({mode:'recorded',scout:{analyze:(frames,{purpose})=>{
    purposes.push(purpose);
    if(purposes.length===1)return new Promise(resolve=>{resolveFirst=()=>resolve({raw:reply(frames),mode:'fresh'});});
    return Promise.resolve({raw:reply(frames),mode:'fresh'});
  }}});
  for(let i=0;i<=6;i++)put(i);await Promise.resolve();
  for(let i=7;i<=26;i++)put(i);
  put(27,{detections:[]});
  const finished=c.finish();resolveFirst();await finished;
  assert.deepEqual(purposes,['cause','scene']);
  assert.equal(c.result().priority.level,'monitor');
  assert.equal(c.result().inference.purpose,'scene');c.disconnect();store.close();
});
test('failed first cause call gives the next attempt to scene assessment',async()=>{
  const purposes=[];
  const {c,put,store}=setup({mode:'recorded',scout:{analyze:async(frames,{purpose})=>{
    purposes.push(purpose);
    if(purposes.length===1)throw new Error('scout_timeout');
    return {raw:reply(frames),mode:'fresh'};
  }}});
  for(let i=0;i<=6;i++)put(i);await c.drain();
  for(let i=7;i<=26;i++)put(i);
  await c.finish();
  assert.deepEqual(purposes,['cause','scene']);
  assert.equal(c.result().priority.level,'monitor');c.disconnect();store.close();
});
test('EOF retains a fresh supported lighter scene without a redundant final call',async()=>{
  let calls=0;
  const {c,put,setTime,store}=setup({mode:'recorded',scout:{analyze:async frames=>{
    calls++;return {raw:reply(frames),mode:'fresh'};
  }}});
  for(let i=0;i<=26;i++){put(i);await c.drain();}
  put(27,{detections:[]});
  assert.equal(c.result().priority.level,'monitor');
  const before=calls;setTime(125000);
  await c.finish();
  assert.equal(calls,before);
  assert.equal(c.result().priority.level,'monitor');c.disconnect();store.close();
});
test('deadline starts once; missing context and malformed responses cannot monitor',async()=>{
  const {c,put,setTime,store}=setup({expectedLighterUse:false,scout:{analyze:async()=>({raw:{bad:true},mode:'fresh'})}});
  for(let i=0;i<=6;i++) put(i);await c.drain();
  assert.equal(c.result().priority.level,'inspect_urgently');
  assert.ok(c.result().inference.validation_errors.length);
  setTime(140000);c.tick();
  assert.notEqual(c.result().priority.level,'monitor');c.disconnect();store.close();
});
test('old async results cannot overwrite a disconnected session',async()=>{
  let resolve;
  const {c,put,store}=setup({scout:{analyze:frames=>new Promise(r=>{resolve=()=>r({raw:reply(frames),mode:'fresh'});})}});
  for(let i=0;i<=6;i++) put(i);
  await Promise.resolve();c.disconnect();resolve();await c.drain();
  assert.equal(c.result().priority.level,'unknown');store.close();
});
test('inference continues beyond two scene calls with no more than one in flight',async()=>{
  let calls=0,inflight=0,max=0;
  const {c,put,store}=setup({scout:{analyze:async frames=>{calls++;inflight++;max=Math.max(max,inflight);await Promise.resolve();inflight--;return {raw:reply(frames),mode:'fresh'};}}});
  for(let i=0;i<55;i++){put(i);await c.drain();}
  assert.ok(calls>=3);assert.equal(max,1);c.disconnect();store.close();
});
test('aged scene and missing observations cannot remain monitor',async()=>{
  const {c,put,setTime,store}=setup();for(let i=0;i<=6;i++)put(i);await c.drain();
  setTime(109000);c.tick();assert.equal(c.result().priority.level,'inspect_urgently');
  c.disconnect();store.close();
});
test('negative observations need no inference and are not a claim of safety',()=>{
  const {c,put,store}=setup();const result=put(0,{detections:[]});
  assert.equal(result.detection.fire,'not_detected');assert.equal(result.priority.level,'monitor');
  assert.equal(result.cause.status,'not_applicable');assert.equal(result.inference,null);
  c.disconnect();store.close();
});

test('a confirmed mixed fire and smoke episode clears after eight valid negatives',async()=>{
  const {c,put,store}=setup();
  try{
    for(let i=0;i<=6;i++)put(i,{visibility:'adequate',detections:[{cls:'fire',conf:.8,bbox_xyxy:[10,10,25,30]},
      {cls:'smoke',conf:.8,bbox_xyxy:[50,50,80,80]}]});
    await c.drain();assert.equal(c.result().priority.level,'inspect_urgently');
    for(let i=7;i<=14;i++)put(i,{visibility:'adequate',detections:[]});
    assert.equal(c.result().priority.level,'monitor');assert.equal(c.result().incident_id,null);
  }finally{c.disconnect();store.close();}
});

test('smoke after an unconfirmed fire watch does not leave a permanent fire incident',async()=>{
  const {c,put,store}=setup();
  try{
    put(0);put(1);
    for(let i=2;i<=30;i++)put(i,{visibility:'adequate',detections:[{cls:'smoke',conf:.8,bbox_xyxy:[50,50,80,80]}]});
    await c.drain();
    for(let i=31;i<=38;i++)put(i,{visibility:'adequate',detections:[]});
    assert.equal(c.result().priority.level,'monitor');assert.equal(c.result().incident_id,null);
  }finally{c.disconnect();store.close();}
});
test('supporting frame expiry cannot be extended by an unrelated recent image',async()=>{
  const {c,put,setTime,store}=setup({scout:{analyze:async frames=>({raw:reply(frames.slice(0,3)),mode:'fresh'})}});
  for(let i=0;i<=6;i++)put(i);await c.drain();
  // Not enough time span among the first three frames: a newer image cannot qualify it.
  assert.notEqual(c.result().priority.level,'monitor');
  c.disconnect();store.close();
});
test('degraded image or camera motion must revoke an otherwise valid lighter result',async()=>{
  const {c,put,store}=setup();for(let i=0;i<=6;i++)put(i);await c.drain();
  assert.equal(put(7,{visibility:'degraded'}).priority.level,'inspect_urgently');
  c.disconnect();store.close();
});

test('view failures expose quality reasons and recover on the next valid observation',()=>{
  const {c,put,store}=setup();
  try{
    const failed=put(0,{visibility:'degraded',metrics:{quality_reasons:['uniform_extreme_luminance']}});
    assert.equal(failed.view.reason,'view_degraded_or_moving');
    assert.deepEqual(failed.view.quality_reasons,['uniform_extreme_luminance']);
    const next=put(1,{detections:[],visibility:'unknown'});
    assert.equal(next.view.status,'available_for_detection');assert.equal(next.view.reason,null);
    assert.deepEqual(next.view.quality_reasons,[]);
  }finally{c.disconnect();store.close();}
});
test('restart preserves confirmed incident but never restores a monitor lease',async()=>{
  const {c,put,store}=setup();for(let i=0;i<=6;i++)put(i);await c.drain();c.disconnect();
  const next=new Coordinator({cameraId:'test-camera',sessionId:'session-b',store,scout:{},expectedLighterUse:true});
  assert.equal(next.lifecycle.alert,'confirmed');assert.notEqual(next.result().priority.level,'monitor');next.disconnect();store.close();
});
