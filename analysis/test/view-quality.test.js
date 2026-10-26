import test from 'node:test';
import assert from 'node:assert/strict';
import {VlmCoordinator,descriptionCheck} from '../src/vlm-coordinator.js';
import {Store} from '../src/store.js';

function setup(options={}){
  let clock=100000;const store=options.store??new Store(':memory:');
  const c=new VlmCoordinator({cameraId:'cam',sessionId:'session',store,streaming:true,now:()=>clock,...options});
  return {c,store,at:ts=>{clock=ts;}};
}
const frame=(ts,extra={})=>({ts_ms:ts,frame_wh:[640,480],visibility:'unknown',camera_motion:null,image_b64:'AQI=',...extra});
const clear={flame:'not_observed',smoke:'not_observed',burning_material:'not_observed',lighter:'not_observed',
  flame_relation:'not_observed',occlusion:'not_observed',description:'A desk with a keyboard.'};
const smoke={...clear,smoke:'present',description:'Grey smoke rises from the bin.'};
const report=(s,ts,row,source=ts)=>s.c.acceptNative({session_id:s.c.sessionId,engine:'minicpm-native-visual',native_chunks:1,
  source_ts_ms:ts,assessment_source_ts_ms:source,assessment:{...row,frame_id:`frame-${source}`},text:'report',elapsed_ms:100},
  {ts_ms:ts,jpeg:Buffer.from('AQI=','base64')});
function native(s,ts,row=clear,extra={}){s.at(ts);s.c.accept(frame(ts,extra));report(s,ts,row);}
const fill=(s,from,to)=>{for(let t=from;t<to;t+=1000){s.at(t);s.c.accept(frame(t));}};
const low={low_detail:true};

test('description negations of a present hazard are contradictions; affirmed, absent or reverse mentions are not',()=>{
  const check=(description,fields={smoke:'present'})=>descriptionCheck({...clear,...fields,description});
  for(const [description,fields,contradicted] of [
    ['No smoke or flame is visible; a keyboard and a dark mousepad on a desk.',undefined,['smoke']],
    ['A dark mousepad on a desk without any smoke.',undefined,['smoke']],
    ['The desk area is smoke-free.',undefined,['smoke']],
    ['There isn’t any visible smoke near the monitor.',undefined,['smoke']],
    ['A desk lamp, free of smoke.',undefined,['smoke']],
    ['There are no signs of fire or smoke.',{smoke:'present',flame:'present',flame_relation:'separate'},['smoke','flame']],
    ['No flame; grey smoke rises from the paper.',undefined,[]],
    ['No one is near the bin and smoke rises from it.',undefined,[]],
    ['No one is near the burning paper.',{burning_material:'present'},[]],
    ['No smoke detector is visible, but grey smoke fills the corner.',undefined,[]],
    ['No thick smoke, no other smoke source and no open flame.',{smoke:'present',flame:'present',flame_relation:'separate'},[]],
    ['There is no fire, only smoke.',undefined,[]],
    ['Smoke rises from the pan without flame.',{smoke:'present',flame:'present',flame_relation:'separate'},['flame']],
    ['Smoke is not visible.',undefined,[]], // A negation after the term is not read: missing a contradiction keeps the evidence.
    ['The smoke has cleared from the room.',{smoke:'not_observed'},[]],
    ['A smoke detector on the ceiling; no flame.',{smoke:'not_observed'},[]],
    ['Thin smoke rises from a smouldering towel.',{smoke:'present',burning_material:'present'},[]]]){
    assert.deepEqual(check(description,fields).contradicted,contradicted,description);
  }
  assert.deepEqual(check('A dark mousepad on a desk.'),{contradicted:[],unsupported:['smoke']});
  assert.deepEqual(check('A candle-shaped object.',{flame:'present',flame_relation:'separate'}),{contradicted:[],unsupported:['flame']});
  assert.deepEqual(check('A desk lamp with a glowing ember on the tray.',{flame:'present',burning_material:'present',flame_relation:'separate'}),
    {contradicted:[],unsupported:[]});
  assert.deepEqual(check('The smoke has cleared.',{smoke:'not_observed'}),{contradicted:[],unsupported:[]},'not_observed fields are never flagged');
});

test('a contradicted smoke report is neither hazard nor clear evidence and is published for counting',()=>{
  const s=setup();try{
    const negated={...smoke,description:'No smoke or flame is visible; a dark mousepad on a desk.'};
    native(s,100000,negated);native(s,101000,negated);native(s,102000,negated);
    let r=s.c.result();
    assert.equal(r.incident_history.model_hazard,false);assert.equal(r.incident_history.hazard_reports,0);
    assert.notEqual(r.priority.reason,'hazard_unconfirmed');assert.equal(r.priority.level,'unknown');assert.equal(r.detection.smoke,'unknown');
    assert.deepEqual(r.inference.description_check,[{frame_id:'frame-102000',contradicted:['smoke'],unsupported:[],low_detail:null}]);
    assert.equal(r.native_stream.assessment.smoke,'present','the raw report stays visible');
    // The tricky sentence keeps its smoke evidence: two reports latch.
    const tricky={...smoke,description:'No flame; grey smoke rises from the paper.'};
    native(s,103000,tricky);native(s,104000,tricky);r=s.c.result();
    assert.equal(r.incident_history.model_hazard,true);assert.deepEqual(r.inference.description_check[0].contradicted,[]);
  }finally{s.store.close();}
});

test('a contradicted report breaks a clear streak, while clear reports that mention cleared smoke release the alert',()=>{
  for(const [last,released] of [[{...smoke,description:'The view is smoke-free.'},false],
    [{...clear,description:'The smoke has cleared; a smoke detector is on the ceiling.'},true]]){
    const s=setup();try{
      native(s,99000,smoke);native(s,100000,smoke);for(let i=1;i<=7;i++)native(s,100000+i*1000);native(s,108000,last);
      const r=s.c.result();
      assert.equal(r.priority.reason==='verified_hazard_unresolved',!released,last.description);
      assert.equal(r.incident_history.clear_observations,released?8:0,last.description);
    }finally{s.store.close();}
  }
});

test('a contradicted flame keeps no relation and cannot become an urgent uncontained flame',()=>{
  const s=setup();try{
    const row={...clear,flame:'present',flame_relation:'separate',description:'No fire or flame is visible on the bench.'};
    for(const ts of [100000,101000,102000])native(s,ts,row);
    const r=s.c.result();assert.equal(r.priority.level,'unknown');assert.equal(r.detection.fire,'unknown');
    assert.equal(r.incident_history.model_hazard,false);
  }finally{s.store.close();}
});

test('an unsupported hazard is recorded but still counts as evidence',()=>{
  const s=setup();try{
    const bare={...smoke,description:'A dark mousepad on a desk.'};
    native(s,100000,bare);native(s,101000,bare);const r=s.c.result();
    assert.equal(r.incident_history.model_hazard,true);assert.equal(r.priority.level,'inspect_urgently');
    assert.deepEqual(r.inference.description_check,[{frame_id:'frame-101000',contradicted:[],unsupported:['smoke'],low_detail:null}]);
  }finally{s.store.close();}
});

test('a hazard pending on a low-detail frame needs a third report within 40 s, and its reason is published',()=>{
  for(const [label,steps,latched] of [
    ['two sharp',s=>{native(s,100000,smoke,{low_detail:false});native(s,101000,smoke,{low_detail:false});},true],
    ['unknown detail',s=>{native(s,100000,smoke);native(s,101000,smoke,{low_detail:'yes'});},true],
    ['two low-detail',s=>{native(s,100000,smoke,low);native(s,101000,smoke,low);},false],
    ['low then sharp',s=>{native(s,100000,smoke,low);native(s,101000,smoke);},false],
    ['sharp then low',s=>{native(s,100000,smoke);native(s,101000,smoke,low);},false],
    ['three low-detail',s=>{native(s,100000,smoke,low);native(s,101000,smoke,low);native(s,102000,smoke,low);},true],
    ['low, sharp, uncertain, sharp',s=>{native(s,100000,smoke,low);native(s,101000,smoke);native(s,102000,{...clear,smoke:'uncertain'});native(s,103000,smoke);},true],
    // A low-detail report stays pending for 40 s, so reports 15 s apart (a slow GPU) still confirm; after 40 s it expires.
    ['slow low-detail',s=>{native(s,100000,smoke,low);fill(s,101000,115000);native(s,115000,smoke,low);fill(s,116000,130000);native(s,130000,smoke,low);},true],
    ['too slow',s=>{native(s,100000,smoke,low);fill(s,101000,121000);native(s,121000,smoke,low);fill(s,122000,142000);native(s,142000,smoke,low);},false],
    ['low expires',s=>{native(s,100000,smoke,low);fill(s,101000,110000);native(s,110000,smoke);fill(s,111000,121000);native(s,121000,smoke);},true]]){
    const s=setup();try{
      steps(s);const r=s.c.result();
      assert.equal(r.incident_history.model_hazard,latched,label);
      assert.equal(r.priority.level,latched?'inspect_urgently':'unknown',label);
      if(!latched){
        assert.equal(r.priority.reason,'hazard_unconfirmed',label);assert.match(r.priority.label,/blurry or grainy/,label);
        assert.equal(r.incident_history.hazard_reports,2,label);assert.equal(r.incident_history.hazard_reports_required,3,label);
        assert.equal(r.detection.smoke,'detected','low-detail evidence is still reported');
      }
    }finally{s.store.close();}
  }
  const s=setup();try{native(s,100000,smoke);const r=s.c.result();
    assert.equal(r.priority.reason,'hazard_unconfirmed');assert.doesNotMatch(r.priority.label,/blurry/);assert.equal(r.incident_history.hazard_reports_required,2);
  }finally{s.store.close();}
});

test('low-detail frames still count as clear evidence and the native lookup uses the report source frame',()=>{
  const s=setup();try{
    native(s,99000,smoke);native(s,100000,smoke);for(let i=1;i<=8;i++)native(s,100000+i*1000,clear,low);
    assert.equal(s.c.result().priority.level,'monitor');assert.equal(s.c.result().incident_history.clear_observations,8);
  }finally{s.store.close();}
  // A native report describes its source frame, which can be older than the latest one: only that frame's flag applies.
  const at=(s,ts,extra)=>{s.at(ts);s.c.accept(frame(ts,extra));};
  const a=setup();try{
    at(a,100000,low);at(a,100500,{low_detail:false});report(a,100500,smoke,100000);
    assert.equal(a.c.result().inference.description_check[0].low_detail,true);
    at(a,101000,{low_detail:false});report(a,101000,smoke);assert.equal(a.c.result().incident_history.model_hazard,false,'low-detail source frame');
  }finally{a.store.close();}
  const b=setup();try{
    at(b,100000,{low_detail:false});at(b,100500,low);report(b,100500,smoke,100000);
    at(b,101000,{low_detail:false});at(b,101500,low);report(b,101500,smoke,101000);
    assert.equal(b.c.result().inference.description_check[0].low_detail,false);
    assert.equal(b.c.result().incident_history.model_hazard,true,'a newer low-detail frame does not apply to an older source');
  }finally{b.store.close();}
  const c=setup();try{
    native(c,100000,smoke,{low_detail:false});at(c,102000,low);report(c,102000,smoke,101800);
    assert.equal(c.c.result().inference.description_check[0].low_detail,null);
    assert.equal(c.c.result().incident_history.model_hazard,true,'a source frame that was never received is not low-detail');
  }finally{c.store.close();}
});

test('sustained camera motion over 2 s gaps the view, while low detail keeps it available for analysis',()=>{
  const s=setup();try{
    for(const ts of [100000,100500,101000,101500,102000]){s.at(ts);s.c.accept(frame(ts,{camera_motion:true,low_detail:true}));}
    assert.equal(s.c.generation,0,'2 s of motion is still skipped samples');assert.equal(s.c.gapReason,undefined);
    s.at(102333);s.c.accept(frame(102333,{camera_motion:true}));
    assert.equal(s.c.result().view.status,'unavailable');assert.equal(s.c.result().view.reason,'view_degraded_or_moving');
    s.at(103000);s.c.accept(frame(103000,{camera_motion:false,low_detail:true,metrics:{quality_reasons:['low_detail_view']}}));
    assert.equal(s.c.result().view.status,'available_for_analysis');assert.deepEqual(s.c.result().view.quality_reasons,['low_detail_view']);
  }finally{s.store.close();}
});
// Native latency 3 s and frames every 333 ms; a moving frame (handheld camera) on every sixth frame.
const handheld=(s,from,windows,row)=>{for(let k=0;k<windows;k++){const base=from+k*3000;
  for(let i=0;i<9;i++){const t=base+i*333;s.at(t);s.c.accept(frame(t,{camera_motion:i%6===5}));}
  s.at(base+3000);report(s,base+3000,row,base);}};
test('intermittent camera motion skips samples without discarding results for the steady frames before it',()=>{
  const s=setup();try{
    s.at(100000);s.c.accept(frame(100000));s.at(100333);s.c.accept(frame(100333,{camera_motion:true}));
    assert.equal(s.c.current.ts_ms,100000,'a moving frame never becomes the current (pushable) frame');
    assert.equal(s.c.generation,0);assert.equal(s.c.images.length,1);assert.equal(s.c.result().view.status,'available_for_analysis');
    handheld(s,100666,2,smoke);
    assert.equal(s.c.result().incident_history.model_hazard,true,'real smoke latches with a handheld camera');
    handheld(s,106666,8,clear);
    assert.equal(s.c.result().incident_history.model_hazard,true,'still awaiting the current clear report');
    s.at(130666);s.c.accept(frame(130666));report(s,130666,clear);
    assert.equal(s.c.result().incident_history.clear_evidence_current,true);
    assert.equal(s.c.result().priority.level,'monitor','eight clear reports release the latch with intermittent motion');
  }finally{s.store.close();}
});
test('recorded uploads with intermittent camera motion still call the model and latch real smoke',async()=>{
  let calls=0;const scout={configured:true,analyze:async frames=>{calls++;return {mode:'fresh',assessment:{frames:frames.map(f=>({...smoke,frame_id:f.frame_id}))}};}};
  const s=setup({streaming:false,mode:'recorded',scout}),moving=new Set();try{
    for(let i=0;i<90;i++){const ts=Math.round(i*1000/3);if(i%6===5)moving.add(`frame-${ts}`);
      s.at(ts);s.c.accept(frame(ts,{camera_motion:i%6===5}));await s.c.drain();}
    const r=await s.c.finish();
    assert.ok(calls>=5,`model calls ${calls}`);assert.equal(r.incident_history.model_hazard,true);assert.equal(r.priority.level,'inspect_urgently');
    assert.ok(s.store.inferences('session').every(i=>i.frame_ids.every(id=>!moving.has(id))),'moving frames are never analyzed');
  }finally{s.store.close();}
});

test('recorded batch inferences store a description check for every analyzed frame',async()=>{
  const scout={configured:true,analyze:async frames=>({mode:'fresh',assessment:{frames:frames.map(f=>({...(f.ts_ms===1000?
    {...smoke,description:'No smoke is visible.'}:clear),frame_id:f.frame_id}))}})};
  const s=setup({streaming:false,mode:'recorded',scout});try{
    s.c.accept(frame(0));s.c.accept(frame(1000,low));s.c.accept(frame(2000,{low_detail:false}));await s.c.drain();await s.c.finish();
    const stored=s.store.inferences('session').find(i=>i.description_check);
    assert.deepEqual(stored.description_check,[{frame_id:'frame-0',contradicted:[],unsupported:[],low_detail:null},
      {frame_id:'frame-1000',contradicted:['smoke'],unsupported:[],low_detail:true},{frame_id:'frame-2000',contradicted:[],unsupported:[],low_detail:false}]);
    assert.equal(s.c.result().incident_history.hazard_reports,0,'the contradicted smoke row is not a pending hazard');
  }finally{s.store.close();}
});
