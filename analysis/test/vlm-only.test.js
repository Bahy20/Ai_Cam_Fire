import test from 'node:test';
import assert from 'node:assert/strict';
import {VlmCoordinator} from '../src/vlm-coordinator.js';
import {Store} from '../src/store.js';
import {MiniCPM} from '../src/minicpm.js';

function setup(options={}){
  let clock=100000;const store=options.store??new Store(':memory:');
  const c=new VlmCoordinator({cameraId:'cam',sessionId:options.sessionId??'session',store,
    streaming:true,expectedLighterUse:true,now:()=>clock,...options});
  return {c,store,at:ts=>{clock=ts;}};
}
const frame=(ts,extra={})=>({ts_ms:ts,frame_wh:[640,480],visibility:'unknown',camera_motion:null,
  image_b64:'AQI=',detections:[],...extra});
const row=(ts,kind='negative')=>({frame_id:`frame-${ts}`,flame:kind==='lighter'||kind==='separate'?'present':'not_observed',
  smoke:kind==='smoke'?'present':'not_observed',burning_material:kind==='material'?'present':'not_observed',
  lighter:kind==='lighter'?'present':'not_observed',flame_relation:kind==='lighter'?'at_tool_tip':kind==='separate'?'separate':'not_observed',
  occlusion:kind==='uncertain'?'uncertain':'not_observed',description:kind});
function native(s,ts,kind='negative',extra={}){
  s.at(ts);s.c.accept(frame(ts,extra));
  s.c.acceptNative({session_id:s.c.sessionId,engine:'minicpm-native-duplex',native_chunks:1,
    source_ts_ms:ts,assessment_source_ts_ms:ts,assessment:row(ts,kind),text:'report',context_tokens:500,elapsed_ms:100},
    {ts_ms:ts,jpeg:Buffer.from('AQI=','base64')});
}

test('no VLM report cannot become a negative or a monitoring result',()=>{
  const s=setup();try{s.c.accept(frame(100000));const r=s.c.result();
    assert.equal(r.priority.level,'unknown');assert.equal(r.detection.fire,'unknown');assert.equal(r.detection.source,'minicpm');
  }finally{s.store.close();}
});
test('live startup and unusable camera frames explain why assessment is unavailable',()=>{
  const s=setup();try{
    s.c.accept(frame(100000));assert.equal(s.c.result().priority.reason,'model_starting');
    assert.match(s.c.result().priority.label,/starting|Starting/);
    assert.equal(s.c.result().native_stream.engine,'minicpm-native-visual');
    assert.equal(s.c.result().native_stream.mode,'native_visual_stream');
    s.at(101000);s.c.accept(frame(101000,{visibility:'degraded',metrics:{quality_reasons:['uniform_extreme_luminance']}}));
    assert.equal(s.c.result().priority.reason,'camera_dark_or_blank');
    assert.match(s.c.result().priority.label,/camera|Camera/);
  }finally{s.store.close();}
});
test('reviewed false alert is audited, rejects old evidence and rearms for fresh hazards',()=>{
  const s=setup();try{
    native(s,100000,'smoke');const alert=s.c.result();native(s,101000,'negative');
    assert.match(s.c.result().priority.label,/earlier|previous/i);
    s.at(102000);s.c.reviewAlert({incident_id:alert.incident_id,last_hazard_ts_ms:100000,action:'false_alarm',actor:'tester'});
    assert.equal(s.c.result().incident_history.model_hazard,false);assert.equal(s.c.result().priority.level,'unknown');
    assert.equal(s.store.reviews(s.c.sessionId)[0].action,'false_alarm');
    native(s,101500,'smoke');assert.equal(s.c.result().incident_history.model_hazard,false,'pre-review findings cannot relatch');
    native(s,103000,'smoke');assert.equal(s.c.result().priority.level,'inspect_urgently');
    assert.notEqual(s.c.result().incident_id,alert.incident_id);
  }finally{s.store.close();}
});
test('an outdated operator review cannot dismiss a newer hazard',()=>{
  const s=setup();try{
    native(s,100000,'smoke');const incident=s.c.result().incident_id;native(s,101000,'material');
    assert.throws(()=>s.c.reviewAlert({incident_id:incident,last_hazard_ts_ms:100000,action:'false_alarm',actor:'tester'}),/alert_updated/);
    assert.equal(s.c.result().incident_history.model_hazard,true);assert.equal(s.store.reviews(s.c.sessionId).length,0);
  }finally{s.store.close();}
});
test('eight consecutive fresh clear observations recover current priority without deleting the incident',()=>{
  const s=setup();try{
    native(s,100000,'smoke');const incident=s.c.result().incident_id;
    for(let i=1;i<=7;i++)native(s,100000+i*1000);
    assert.equal(s.c.result().priority.level,'inspect_urgently');
    native(s,108000);const clear=s.c.result();
    assert.equal(clear.priority.level,'monitor');assert.equal(clear.detection.state,'idle');
    assert.equal(clear.incident_id,incident);assert.equal(clear.incident_history.model_hazard,true);
    assert.equal(clear.incident_history.clear_observations,8);assert.equal(s.store.reviews(s.c.sessionId).length,0);
    native(s,109000,'material');assert.equal(s.c.result().priority.level,'inspect_urgently');
  }finally{s.store.close();}
});
test('gaps, darkness, uncertainty and invalid reports cannot complete automatic recovery',()=>{
  for(const interruption of ['gap','dark','uncertain','invalid']){const s=setup();try{
    native(s,100000,'smoke');for(let i=1;i<=7;i++)native(s,100000+i*1000);
    if(interruption==='gap'){s.at(108000);s.c.gap('capture_gap');}
    if(interruption==='dark')native(s,108000,'negative',{visibility:'degraded'});
    if(interruption==='uncertain')native(s,108000,'uncertain');
    if(interruption==='invalid')s.c.acceptNativeState('invalid_response');
    native(s,109000);assert.equal(s.c.result().priority.level,'inspect_urgently',interruption);
    assert.equal(s.c.result().incident_history.clear_observations,1);
  }finally{s.store.close();}}
});
test('malformed assessment cannot replay old clear evidence after interruption',()=>{
  const s=setup();try{
    native(s,100000,'smoke');for(let i=1;i<=7;i++)native(s,100000+i*1000);
    s.at(108000);s.c.accept(frame(108000));
    const report=ts=>({session_id:s.c.sessionId,engine:'minicpm-native-visual',source_ts_ms:108000,
      assessment_source_ts_ms:ts,assessment:row(ts)});
    s.c.acceptNative({...report(108000),assessment:{...row(108000),smoke:'invalid'}},{jpeg:Buffer.from('AQI=','base64')});
    for(let ts=101000;ts<=107000;ts+=1000)s.c.acceptNative(report(ts),{jpeg:Buffer.from('AQI=','base64')});
    native(s,109000);
    assert.equal(s.c.result().incident_history.clear_observations,1);
    assert.equal(s.c.result().priority.level,'inspect_urgently');
  }finally{s.store.close();}
});

test('missing model observations and stale receipt reset recovery evidence',()=>{
  for(const interrupt of ['model_gap','receipt_stale']){const s=setup();try{
    native(s,100000,'smoke');for(let i=1;i<=7;i++)native(s,100000+i*1000);
    if(interrupt==='model_gap'){
      for(let ts=108000;ts<=113000;ts+=1000){s.at(ts);s.c.accept(frame(ts));}
    }else{s.at(113000);s.c.tick();}
    native(s,114000);
    assert.equal(s.c.result().incident_history.clear_observations,1,interrupt);
    assert.equal(s.c.result().priority.level,'inspect_urgently');
  }finally{s.store.close();}}
});

test('model-only negative reports authorize monitoring without a detector',()=>{
  const s=setup();try{for(const ts of [100000,101000,102000])native(s,ts);
    assert.equal(s.c.result().priority.reason,'no_visual_hazard_observed');assert.equal(s.c.result().detection.smoke,'not_detected');
  }finally{s.store.close();}
});
test('lighter monitoring ignores obsolete detector proposals and timestamps',()=>{
  const s=setup();try{for(const ts of [100000,101000,102000])native(s,ts,'lighter',{
    detections:[{cls:'smoke',conf:.99,bbox_xyxy:[1,1,100,100]}]});
    const r=s.c.result();assert.equal(r.priority.reason,'contained_lighter');assert.equal(r.detection.fire,'detected');
    assert.equal(r.detection.smoke,'not_detected');assert.equal(r.detection.source,'minicpm');
  }finally{s.store.close();}
});
test('a lighter requires reviewed camera policy',()=>{
  const s=setup({expectedLighterUse:false});try{for(const ts of [100000,101000,102000])native(s,ts,'lighter');
    assert.equal(s.c.result().priority.level,'inspect_urgently');
  }finally{s.store.close();}
});
test('a new uncertain or separate report immediately revokes lighter monitoring',()=>{
  for(const kind of ['uncertain','separate']){const s=setup();try{
    for(const ts of [100000,101000,102000])native(s,ts,'lighter');native(s,103000,kind);
    assert.notEqual(s.c.result().priority.level,'monitor');native(s,104000,'lighter');
    assert.notEqual(s.c.result().priority.level,'monitor');
  }finally{s.store.close();}}
});
test('validated smoke/material remains urgent through darkness and reconnect',()=>{
  for(const kind of ['smoke','material']){const s=setup();try{
    native(s,100000,kind);assert.equal(s.c.result().priority.level,'inspect_urgently');
    s.at(101000);s.c.accept(frame(101000,{visibility:'degraded'}));
    assert.equal(s.c.result().priority.level,'inspect_urgently');assert.equal(s.c.result().detection.fire,'unknown');
    s.c.disconnect();const next=setup({store:s.store,sessionId:'reconnected'});
    assert.equal(next.c.result().priority.level,'inspect_urgently');
  }finally{s.store.close();}}
});
test('dark-only, stale, duplicate and pre-gap reports cannot qualify a clear scene',()=>{
  const s=setup();try{
    native(s,100000);native(s,101000);s.c.gap();
    s.c.acceptNative({session_id:s.c.sessionId,engine:'minicpm-native-duplex',assessment:row(100000),
      assessment_source_ts_ms:100000,source_ts_ms:100000},{jpeg:Buffer.from('AQI=','base64')});
    assert.equal(s.c.result().priority.level,'unknown');
    for(const ts of [102000,103000,104000])native(s,ts,'negative',{visibility:'degraded'});
    assert.equal(s.c.result().priority.level,'unknown');
  }finally{s.store.close();}
});
test('YOLO-only historical incidents are not restored as current model hazards',()=>{
  const store=new Store(':memory:');store.start('old','cam','live');
  store.save('old',{incident_id:'old-yolo',detection:{state:'confirmed',smoke_status:'confirmed'},incident_history:{model_hazard:false,smoke_confirmed:true}});
  const s=setup({store});try{
    assert.equal(s.c.result().priority.level,'unknown');
    for(const ts of [100000,101000,102000])native(s,ts,'lighter');
    assert.equal(s.c.result().priority.reason,'contained_lighter');
  }finally{store.close();}
});
test('a stale previously clear scene is unknown, never a fresh negative',()=>{
  const s=setup();try{for(const ts of [100000,101000,102000])native(s,ts);s.at(113000);
    assert.equal(s.c.result().priority.level,'unknown');assert.equal(s.c.result().detection.fire,'unknown');
  }finally{s.store.close();}
});
test('a malformed new native report revokes previous monitoring evidence',()=>{
  const s=setup();try{for(const ts of [100000,101000,102000])native(s,ts);s.at(103000);s.c.accept(frame(103000));
    s.c.acceptNative({session_id:s.c.sessionId,engine:'minicpm-native-duplex',native_chunks:4,
      source_ts_ms:103000,assessment:null,validation_error:'native_unstructured_output'}, {jpeg:Buffer.from('AQI=','base64')});
    assert.equal(s.c.result().priority.level,'unknown');assert.notEqual(s.c.result().native_stream.assessment_status,'current');
  }finally{s.store.close();}
});
test('upstream loss or retry revokes monitoring immediately but preserves validated hazards',()=>{
  for(const state of ['unavailable','reconnecting','invalid_response']){
    const s=setup();try{for(const ts of [100000,101000,102000])native(s,ts);s.c.acceptNativeState(state);
      assert.equal(s.c.result().priority.level,'unknown');assert.equal(s.c.result().detection.fire,'unknown');
    }finally{s.store.close();}
    const h=setup();try{native(h,100000,'material');h.c.acceptNativeState(state);
      assert.equal(h.c.result().priority.level,'inspect_urgently');
    }finally{h.store.close();}
  }
});
test('recorded negative clips are actually analyzed without a detection trigger',async()=>{
  let calls=0;
  const scout=new MiniCPM({requestImpl:async args=>{calls++;return {assessment:{frames:args.frames.map(f=>row(Number(f.frame_id.slice(6))))},raw:'captured',usage:{gpu_inference_ms:10}};}});
  const s=setup({streaming:false,mode:'recorded',scout});try{
    for(const ts of [0,1000,2000]){s.c.accept(frame(ts));await s.c.drain();}
    const r=await s.c.finish();assert.ok(calls>0);assert.equal(r.priority.level,'monitor');
    assert.equal(r.inference.mode,'fresh');assert.equal(r.detection.source,'minicpm');
  }finally{scout.close();s.store.close();}
});
test('a short uploaded clip receives inference without relaxing monitoring evidence',async()=>{
  let calls=0;
  const scout=new MiniCPM({requestImpl:async args=>{calls++;return {assessment:{frames:args.frames.map(f=>row(Number(f.frame_id.slice(6))))},raw:'captured'};}});
  const s=setup({streaming:false,mode:'recorded',scout});try{
    s.c.accept(frame(0));const r=await s.c.finish();assert.equal(calls,1);assert.equal(r.priority.level,'unknown');
    assert.equal(r.detection.fire,'not_detected');
  }finally{scout.close();s.store.close();}
});
