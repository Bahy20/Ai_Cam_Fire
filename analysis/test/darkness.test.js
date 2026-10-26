import test from 'node:test';
import assert from 'node:assert/strict';
import {Coordinator} from '../src/coordinator.js';
import {Store} from '../src/store.js';

function setup(){
  let time=100000;const store=new Store(':memory:');
  const c=new Coordinator({cameraId:'lights',store,scout:{},streaming:true,now:()=>time});
  const put=(smoke=false,visibility='unknown',fire=false)=>{time+=400;return c.accept({ts_ms:time,frame_wh:[640,480],visibility,
    detections:[...(smoke?[{cls:'smoke',conf:typeof smoke==='number'?smoke:.8,bbox_xyxy:[10,10,80,80]}]:[]),
      ...(fire?[{cls:'fire',conf:.8,bbox_xyxy:[100,100,130,140]}]:[])]});};
  return {c,store,put};
}
test('quiet unknown-quality frames expire the current smoke claim, preserving unresolved history',()=>{
  const {c,store,put}=setup();
  try{
    for(let i=0;i<8;i++)put(true);
    assert.equal(c.result().priority.level,'inspect_urgently');
    for(let i=0;i<100;i++)put();
    const r=c.result();assert.equal(r.detection.smoke,'not_detected');
    assert.equal(r.detection.smoke_status,'historical');assert.equal(r.incident_history.smoke_confirmed,true);
    assert.equal(r.priority.level,'unknown');assert.equal(r.priority.reason,'historical_signal_unverified');
    assert.ok(r.incident_id,'Unknown visibility cannot resolve the old incident');
  }finally{c.disconnect();store.close();}
});
test('a gap and duplicate timestamps cannot expire a current smoke warning',()=>{
  const {c,store,put}=setup();
  try{
    for(let i=0;i<8;i++)put(true);for(let i=0;i<7;i++)put();c.gap();
    const r=put();
    for(let i=0;i<20;i++)c.accept({ts_ms:r.source_ts_ms,frame_wh:[640,480],visibility:'unknown',detections:[]});
    assert.equal(c.result().priority.level,'inspect_urgently');
    for(let i=0;i<6;i++)put();assert.equal(c.result().priority.level,'inspect_urgently');
    assert.equal(put().priority.reason,'historical_signal_unverified');
  }finally{c.disconnect();store.close();}
});
test('a validated model hazard is never downgraded by quiet unvalidated detector frames',()=>{
  const {c,store,put}=setup();
  try{
    for(let i=0;i<8;i++)put(true);c.hazardLatch=true;
    for(let i=0;i<100;i++)put();
    assert.equal(c.result().priority.level,'inspect_urgently');
  }finally{c.disconnect();store.close();}
});
test('a restored model hazard remains urgent before any valid new frame and through gaps',()=>{
  const {c,store,put}=setup();let next;
  try{
    put();c.incidentId='verified-incident';c.hazardLatch=true;c.disconnect();
    next=new Coordinator({cameraId:'lights',store,scout:{},streaming:true});
    assert.equal(next.result().priority.level,'inspect_urgently');
    next.gap();assert.equal(next.result().priority.level,'inspect_urgently');
  }finally{next?.disconnect();store.close();}
});
test('restart retains smoke history without presenting it as smoke in a new frame',()=>{
  const {c,store,put}=setup();let next;
  try{
    for(let i=0;i<8;i++)put(true);for(let i=0;i<8;i++)put();c.disconnect();
    next=new Coordinator({cameraId:'lights',store,scout:{},streaming:true});
    next.accept({ts_ms:Date.now(),frame_wh:[640,480],visibility:'unknown',detections:[]});
    assert.equal(next.result().detection.smoke,'not_detected');
    assert.equal(next.result().incident_history.smoke_confirmed,true);
  }finally{next?.disconnect();store.close();}
});
test('a silent native stream is not presented as a completed visual assessment',()=>{
  const {c,store,put}=setup();
  try{
    put();c.acceptNative({engine:'minicpm-native-duplex',session_id:c.sessionId,is_listen:true,
      native_chunks:4,text:'',source_ts_ms:c.lastTs});
    assert.equal(c.result().native_stream.assessment_status,'awaiting_report');
  }finally{c.disconnect();store.close();}
});
test('unknown-quality negatives cannot resolve confirmed fire history',()=>{
  const {c,store}=setup();let ts=100000;
  try{
    for(let i=0;i<8;i++)c.accept({ts_ms:ts+=400,frame_wh:[640,480],visibility:'unknown',detections:[{cls:'fire',conf:.8,bbox_xyxy:[10,10,80,80]}]});
    for(let i=0;i<20;i++)c.accept({ts_ms:ts+=400,frame_wh:[640,480],visibility:'unknown',detections:[]});
    assert.ok(c.result().incident_id);assert.equal(c.result().incident_history.fire_confirmed,true);
  }finally{c.disconnect();store.close();}
});
test('a new weak candidate cannot reuse old smoke confirmation after a quiet interval',()=>{
  const {c,store,put}=setup();
  try{
    for(let i=0;i<8;i++)put(true);for(let i=0;i<8;i++)put();
    const r=c.accept({ts_ms:c.lastTs+400,frame_wh:[640,480],visibility:'unknown',detections:[{cls:'smoke',conf:.06,bbox_xyxy:[10,10,80,80]}]});
    assert.equal(r.detection.smoke,'candidate');assert.equal(r.priority.level,'pending');
  }finally{c.disconnect();store.close();}
});
test('reconnect cannot promote historical smoke into a new weak detection',()=>{
  const {c,store,put}=setup();let next;
  try{
    for(let i=0;i<8;i++)put(true);for(let i=0;i<8;i++)put();c.disconnect();
    next=new Coordinator({cameraId:'lights',store,scout:{},streaming:true});
    const r=next.accept({ts_ms:Date.now(),frame_wh:[640,480],visibility:'unknown',detections:[{cls:'smoke',conf:.01,bbox_xyxy:[10,10,80,80]}]});
    assert.equal(r.detection.smoke,'candidate');assert.equal(r.priority.level,'pending');
  }finally{next?.disconnect();store.close();}
});
function nativeRow(c,ts,kind='negative'){
  const row={frame_id:`frame-${ts}`,flame:['lighter','separate'].includes(kind)?'present':kind==='uncertain'?'uncertain':'not_observed',smoke:'not_observed',burning_material:'not_observed',
    lighter:kind==='lighter'?'present':'not_observed',flame_relation:kind==='lighter'?'at_tool_tip':kind==='separate'?'separate':kind==='uncertain'?'uncertain':'not_observed',occlusion:'not_observed',description:'Current visible scene.'};
  c.acceptNative({engine:'minicpm-native-duplex',session_id:c.sessionId,source_ts_ms:ts,assessment_source_ts_ms:ts,
    is_listen:false,text:'',native_chunks:1,assessment:row},{jpeg:Buffer.from([255,216,255,217])});
}
test('three independent negative scene reports turn current detector disagreement into review, never monitor',()=>{
  const {c,store,put}=setup();
  try{
    for(let i=0;i<22;i++){put(true);if(i>=6 && i%6===0)nativeRow(c,c.lastTs);}
    assert.equal(c.result().priority.level,'unknown');assert.equal(c.result().priority.reason,'detector_model_disagreement');
    c.hazardLatch=true;assert.equal(c.result().priority.level,'inspect_urgently');
  }finally{c.disconnect();store.close();}
});
test('a fresh negative scene can monitor when proposals stop, retaining past incident history',()=>{
  const {c,store,put}=setup();
  try{
    for(let i=0;i<8;i++)put(true);
    for(let i=0;i<28;i++){put();if(i>=6 && i%6===0)nativeRow(c,c.lastTs);}
    assert.equal(c.result().priority.level,'monitor');assert.equal(c.result().priority.reason,'no_visual_hazard_observed');
    assert.equal(c.result().incident_history.unresolved,true);
    c.now=()=>c.lastTs+11000;assert.notEqual(c.result().priority.level,'monitor');
  }finally{c.disconnect();store.close();}
});
test('an expired smoke signal cannot veto later supported lighter monitoring',()=>{
  const {c,store,put}=setup();c.expectedLighterUse=true;
  try{
    for(let i=0;i<8;i++)put(true);
    for(let i=0;i<38;i++){
      put(false,'unknown',true);
      if(i>=18 && i%6===0)nativeRow(c,c.lastTs,'lighter');
    }
    assert.equal(c.result().priority.level,'monitor');
  }finally{c.disconnect();store.close();}
});
for(const warning of ['strong_smoke','single_fire','weak_smoke'])test(`a new ${warning} revokes a negative monitoring lease until new independent reports`,()=>{
  const {c,store,put}=setup();
  try{
    for(let i=0;i<22;i++){put();if(i>=6 && i%6===0)nativeRow(c,c.lastTs);}
    assert.equal(c.result().priority.level,'monitor');
    if(warning==='single_fire')put(false,'unknown',true);else put(warning==='weak_smoke'?.06:true);
    assert.notEqual(put().priority.level,'monitor');
    for(let i=0;i<22;i++){put();if(i>=6 && i%6===0)nativeRow(c,c.lastTs);}
    assert.equal(c.result().priority.level,'monitor');
  }finally{c.disconnect();store.close();}
});
test('normal three-second report cadence tolerates timestamp jitter without losing the third frame',()=>{
  let clock=100000;const data=new Store(':memory:');const next=new Coordinator({cameraId:'cadence',store:data,scout:{},streaming:true,now:()=>clock});
  try{
    for(let i=0;i<=20;i++){
      clock=100000+i*334;next.accept({ts_ms:clock,frame_wh:[640,480],visibility:'unknown',detections:[]});
      if([0,9,18].includes(i))nativeRow(next,clock);
    }
    assert.equal(next.nativeFrames.length,3);
    assert.equal(next.result().priority.reason,'no_visual_hazard_observed');
    clock+=4000;assert.equal(next.sceneCurrent(),false,'Oldest supporting evidence still expires at ten seconds');
  }finally{next.disconnect();data.close();}
});
test('fast jittered reports select a real two-second interval rather than truncating to the last three',()=>{
  const store=new Store(':memory:');let time=100000;
  const c=new Coordinator({cameraId:'fast-reports',store,scout:{},streaming:true,now:()=>time});
  try{
    for(let i=0;i<=30;i++){
      time=100000+i*100;c.accept({ts_ms:time,frame_wh:[640,480],visibility:'unknown',detections:[]});
      if(i%10===0)nativeRow(c,100000+i/10*999);
    }
    assert.equal(c.result().priority.reason,'no_visual_hazard_observed');
    const ids=c.result().scene_assessment.frame_ids.map(id=>Number(id.slice(6)));
    assert.equal(ids.length,3);assert.ok(ids.at(-1)-ids[0]>=2000);
  }finally{c.disconnect();store.close();}
});
for(const contradiction of ['separate','uncertain'])test(`interval sampling cannot skip an intervening ${contradiction} flame`,()=>{
  const store=new Store(':memory:');let time=100000;
  const c=new Coordinator({cameraId:'contradiction',store,scout:{},streaming:true,expectedLighterUse:true,now:()=>time});
  try{
    for(let i=0;i<=30;i++){
      time=100000+i*100;c.accept({ts_ms:time,frame_wh:[640,480],visibility:'unknown',detections:[]});
      if(i%10===0)nativeRow(c,100000+i/10*999,i===20?contradiction:'lighter');
    }
    assert.notEqual(c.result().priority.level,'monitor');
    assert.equal(c.scene.lighterEvidence,false);
  }finally{c.disconnect();store.close();}
});
