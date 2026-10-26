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
const report=(s,ts,kind='negative')=>s.c.acceptNative({session_id:s.c.sessionId,engine:'minicpm-native-duplex',native_chunks:1,
  source_ts_ms:ts,assessment_source_ts_ms:ts,assessment:row(ts,kind),text:'report',context_tokens:500,elapsed_ms:100},
  {ts_ms:ts,jpeg:Buffer.from('AQI=','base64')});
function native(s,ts,kind='negative',extra={}){s.at(ts);s.c.accept(frame(ts,extra));report(s,ts,kind);}
// Slow model cadence: camera frames every second keep the receipt fresh (no observation gap) between clear reports.
const slowClear=(s,from,step,each=()=>{})=>{for(let i=1;i<=8;i++){const ts=from+i*step;
  for(let t=ts-step+1000;t<ts;t+=1000){s.at(t);s.c.accept(frame(t));}native(s,ts);each(i);}};
// One model report cannot latch a hazard; two corroborating reports ending at ts can.
const confirmed=(s,kind='smoke',ts=100000)=>{native(s,ts-1000,kind);native(s,ts,kind);};
const fill=(s,from,to)=>{for(let t=from;t<to;t+=1000){s.at(t);s.c.accept(frame(t));}};
const invalid=(s,ts)=>{s.at(ts);s.c.accept(frame(ts));s.c.acceptNative({session_id:s.c.sessionId,engine:'minicpm-native-visual',native_chunks:1,
  source_ts_ms:ts,assessment:null,validation_error:'native_unstructured_output'},{jpeg:Buffer.from('AQI=','base64')});};

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
    confirmed(s);const alert=s.c.result();native(s,101000,'negative');
    assert.match(s.c.result().priority.label,/earlier|previous/i);
    s.at(102000);s.c.reviewAlert({incident_id:alert.incident_id,last_hazard_ts_ms:100000,action:'false_alarm',actor:'tester'});
    assert.equal(s.c.result().incident_history.model_hazard,false);assert.equal(s.c.result().priority.level,'unknown');
    assert.equal(s.store.reviews(s.c.sessionId)[0].action,'false_alarm');
    native(s,101200,'smoke');native(s,101500,'smoke');assert.equal(s.c.result().incident_history.model_hazard,false,'pre-review findings cannot relatch');
    native(s,103000,'smoke');assert.equal(s.c.result().incident_history.model_hazard,false,'pre-review findings cannot corroborate');
    native(s,104000,'smoke');assert.equal(s.c.result().priority.level,'inspect_urgently');
    assert.notEqual(s.c.result().incident_id,alert.incident_id);
  }finally{s.store.close();}
});
test('an outdated operator review cannot dismiss a newer hazard',()=>{
  const s=setup();try{
    confirmed(s);const incident=s.c.result().incident_id;native(s,101000,'material');
    assert.throws(()=>s.c.reviewAlert({incident_id:incident,last_hazard_ts_ms:100000,action:'false_alarm',actor:'tester'}),/alert_updated/);
    assert.equal(s.c.result().incident_history.model_hazard,true);assert.equal(s.store.reviews(s.c.sessionId).length,0);
  }finally{s.store.close();}
});
test('eight consecutive fresh clear observations recover current priority without deleting the incident',()=>{
  const s=setup();try{
    confirmed(s);const incident=s.c.result().incident_id;
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
    confirmed(s);for(let i=1;i<=7;i++)native(s,100000+i*1000);
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
    confirmed(s);for(let i=1;i<=7;i++)native(s,100000+i*1000);
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
    confirmed(s);for(let i=1;i<=7;i++)native(s,100000+i*1000);
    if(interrupt==='model_gap'){ // Frames keep arriving but no model report for longer than the 15 s clear gap.
      for(let ts=108000;ts<=122000;ts+=1000){s.at(ts);s.c.accept(frame(ts));}native(s,123000);
    }else{ // Delivery stalls past the receipt bound; source timestamps stay continuous, so no observation gap is involved.
      s.at(113000);s.c.tick();s.at(113500);s.c.accept(frame(108000));report(s,108000);
    }
    assert.equal(s.c.result().incident_history.clear_observations,1,interrupt);
    assert.equal(s.c.result().priority.level,'inspect_urgently');
  }finally{s.store.close();}}
});
test('slow clear reports up to 15 s apart release the latch without hiding incident history',()=>{
  const s=setup();try{
    confirmed(s);const incident=s.c.result().incident_id;
    slowClear(s,100000,8000,i=>{if(i<8)assert.equal(s.c.result().priority.reason,'verified_hazard_unresolved',String(i));});
    const r=s.c.result();
    assert.notEqual(r.priority.reason,'verified_hazard_unresolved');assert.equal(r.priority.policy_version,'minicpm-only-v3');
    assert.equal(r.incident_history.clear_evidence_current,true);assert.equal(r.incident_history.clear_observations,8);
    assert.equal(r.incident_history.model_hazard,true);assert.equal(r.incident_history.latest_hazard.ts_ms,100000);
    assert.equal(r.incident_id,incident);assert.notEqual(r.detection.state,'confirmed');
    for(let t=165000;t<=175000;t+=1000){s.at(t);s.c.accept(frame(t));}
    assert.equal(s.c.result().priority.reason,'verified_hazard_unresolved','a clear report older than 10 s cannot release the alert');
  }finally{s.store.close();}
});
test('clear reports more than 15 s apart never release the latch',()=>{
  const s=setup();try{
    confirmed(s);slowClear(s,100000,16000,i=>{const r=s.c.result();
      assert.equal(r.priority.reason,'verified_hazard_unresolved',String(i));assert.equal(r.incident_history.clear_observations,1,String(i));
      assert.equal(r.incident_history.clear_evidence_current,false,String(i));});
  }finally{s.store.close();}
});
test('a single model smoke report is unconfirmed and never becomes an urgent or persisted alert',()=>{
  const s=setup();try{
    native(s,100000,'smoke');const r=s.c.result();
    assert.equal(r.priority.reason,'hazard_unconfirmed');assert.equal(r.priority.level,'unknown');
    assert.equal(r.detection.smoke,'detected');assert.equal(r.incident_history.model_hazard,false);
    for(let ts=101000;ts<=109000;ts+=1000){native(s,ts);const next=s.c.result();
      assert.notEqual(next.priority.level,'inspect_urgently',String(ts));assert.equal(next.incident_history.model_hazard,false);}
    assert.equal(s.c.result().priority.level,'monitor');
    s.c.disconnect();const next=setup({store:s.store,sessionId:'reconnected'});
    assert.equal(next.c.result().incident_history.model_hazard,false);assert.notEqual(next.c.result().priority.level,'inspect_urgently');
  }finally{s.store.close();}
});
test('a hazard latches on a second report within 20 s unless three clear reports dismiss the first',()=>{
  for(const [kinds,latched] of [[['smoke','smoke'],true],[['smoke','negative','smoke'],true],
    [['material','negative','separate'],true],[['smoke','negative','negative','smoke'],true],
    [['smoke','negative','negative','negative','smoke'],false]]){
    const s=setup(),label=kinds.join(',');try{
      kinds.forEach((kind,i)=>native(s,100000+i*1000,kind));const r=s.c.result();
      assert.equal(r.incident_history.model_hazard,latched,label);
      assert.equal(r.priority.level,latched?'inspect_urgently':'unknown',label);
      if(latched)assert.equal(r.incident_history.latest_hazard.ts_ms,100000+(kinds.length-1)*1000,label);
      else assert.equal(r.priority.reason,'hazard_unconfirmed',label);
    }finally{s.store.close();}
  }
});
test('smoke reports alternating with invalid native reports latch on the second smoke report',()=>{
  const s=setup();try{
    native(s,100000,'smoke');invalid(s,101000);
    assert.equal(s.c.result().incident_history.model_hazard,false);assert.equal(s.c.result().priority.reason,'model_report_invalid');
    native(s,102000,'smoke');const r=s.c.result();
    assert.equal(r.incident_history.model_hazard,true);assert.equal(r.priority.level,'inspect_urgently');
    assert.equal(r.incident_history.latest_hazard.ts_ms,102000);
  }finally{s.store.close();}
});
test('pending hazard reports survive uncertain reports, slow cadence and reconnects but expire after 20 s',()=>{
  for(const [label,steps,latched] of [
    ['uncertain',s=>{native(s,100000,'smoke');native(s,101000,'uncertain');native(s,102000,'uncertain');native(s,103000,'smoke');},103000],
    ['12 s apart',s=>{native(s,100000,'smoke');fill(s,101000,112000);native(s,112000,'smoke');},112000],
    ['reconnect',s=>{native(s,100000,'smoke');s.c.acceptNativeState('reconnecting');s.c.acceptNativeState('listening');native(s,101000,'smoke');},101000],
    ['25 s apart',s=>{native(s,100000,'smoke');fill(s,101000,125000);native(s,125000,'smoke');},null]]){
    const s=setup();try{steps(s);const r=s.c.result();
      assert.equal(r.incident_history.model_hazard,Boolean(latched),label);
      assert.equal(r.priority.reason,latched?'verified_hazard_unresolved':'hazard_unconfirmed',label);
      assert.equal(r.incident_history.latest_hazard?.ts_ms??null,latched,label);
    }finally{s.store.close();}
  }
});
test('a hazard report while latched refreshes the alert so a review of older evidence is rejected',()=>{
  const s=setup();try{
    confirmed(s);const incident=s.c.result().incident_id;
    for(let ts=101000;ts<=105000;ts+=1000)native(s,ts);native(s,106000,'smoke');
    const r=s.c.result();assert.equal(r.incident_history.latest_hazard.ts_ms,106000);assert.equal(r.priority.reason,'verified_hazard_unresolved');
    assert.throws(()=>s.c.reviewAlert({incident_id:incident,last_hazard_ts_ms:100000,action:'false_alarm',actor:'tester'}),/alert_updated_review_again/);
    assert.equal(s.c.result().incident_history.model_hazard,true);assert.equal(s.store.reviews(s.c.sessionId).length,0);
    s.c.reviewAlert({incident_id:incident,last_hazard_ts_ms:106000,action:'false_alarm',actor:'tester'});
    assert.equal(s.c.result().incident_history.model_hazard,false);
  }finally{s.store.close();}
});
test('a rejected non-clear report inside a slow clear streak prevents release',()=>{
  for(const rejected of ['stale','no_image']){const s=setup();try{
    confirmed(s);slowClear(s,100000,8000,i=>{if(i!==4)return;const ts=s.c.lastTs+500,source=rejected==='stale'?ts-11000:ts;
      s.at(ts);s.c.accept(frame(ts));
      s.c.acceptNative({session_id:s.c.sessionId,engine:'minicpm-native-duplex',native_chunks:1,source_ts_ms:ts,assessment_source_ts_ms:source,
        assessment:row(source,'smoke'),text:'report'},rejected==='stale'?{jpeg:Buffer.from('AQI=','base64')}:undefined);});
    const r=s.c.result();
    assert.equal(r.priority.reason,'verified_hazard_unresolved',rejected);assert.equal(r.incident_history.clear_observations,4,rejected);
    assert.equal(r.incident_history.clear_evidence_current,false,rejected);
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
    confirmed(s,kind);assert.equal(s.c.result().priority.level,'inspect_urgently');
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
    const h=setup();try{confirmed(h,'material');h.c.acceptNativeState(state);
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
test('an upload ending on a single unconfirmed smoke report is flagged, while a dismissed one is not',async()=>{
  for(const [smokeTs,level,reason] of [[12000,'inspect_urgently','hazard_unconfirmed_recording'],[1000,'monitor','no_visual_hazard_observed']]){
    const scout={configured:true,analyze:async frames=>({mode:'fresh',assessment:{frames:frames.map(f=>{
      const ts=Number(f.frame_id.slice(6));return row(ts,ts===smokeTs?'smoke':'negative');})}})};
    const s=setup({streaming:false,mode:'recorded',scout});try{
      for(let ts=0;ts<=12000;ts+=1000){s.c.accept(frame(ts));await s.c.drain();}
      if(smokeTs===12000)assert.equal(s.c.result().priority.reason,'hazard_unconfirmed','still processing');
      const r=await s.c.finish();
      assert.equal(r.priority.level,level,String(smokeTs));assert.equal(r.priority.reason,reason,String(smokeTs));
      assert.equal(r.incident_history.model_hazard,false);
    }finally{s.store.close();}
  }
});
