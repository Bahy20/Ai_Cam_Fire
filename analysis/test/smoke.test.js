import test from 'node:test';
import assert from 'node:assert/strict';
import {Coordinator} from '../src/coordinator.js';
import {Store} from '../src/store.js';

function setup({fail=false,visible=false,interval=400}={}) {
  let time=100000,calls=0;
  const store=new Store(':memory:');
  const scout={analyze:async(frames,{purpose})=>{
    calls++;assert.equal(purpose,'scene');if(fail)throw new Error('scout_timeout');
    return {raw:{contract_version:3,observations:frames.map(f=>({frame_ids:[f.frame_id],kind:visible?'smoke_visible':'unknown',description:visible?'A plume of smoke rises beside the wall.':'The room and furniture are visible with no identifiable plume.'})),
      hypothesis:{ignition_source:'unknown',ignition_tool:'unknown',fuel_type:'unknown',confidence:'low',action_frame_ids:[],ignition_frame_id:null},scene_assertions:[],tool_assertions:[]},mode:'fresh'};
  }};
  const c=new Coordinator({cameraId:'smoke-test',store,scout,now:()=>time});
  const put=(i,conf=.051)=>{time=100000+i*interval;return c.accept({ts_ms:time,frame_wh:[640,480],visibility:'adequate',camera_motion:false,image_b64:'AQI=',detections:conf===null?[]:[{cls:'smoke',conf,bbox_xyxy:[10,10,50,50]}]});};
  return {c,put,store,calls:()=>calls};
}
test('weak smoke is an explicit candidate, not detected smoke or an urgent incident',async()=>{
  const {c,put,store,calls}=setup();
  try{const first=put(0);assert.equal(first.detection.smoke,'candidate');assert.equal(first.priority.level,'pending');
    for(let i=1;i<=8;i++)put(i);await c.drain();assert.equal(calls(),1);
    assert.equal(c.result().priority.level,'pending');assert.equal(c.result().detection.smoke,'candidate');
    assert.equal(put(9,null).priority.level,'pending');
  }finally{c.disconnect();store.close();}
});
test('repeated strong smoke becomes urgent; a gap and one negative cannot clear it',async()=>{
  const {c,put,store}=setup({fail:true});
  try{assert.equal(put(0,.8).priority.level,'pending');for(let i=1;i<=5;i++)put(i,.8);await c.drain();
    assert.equal(c.result().detection.smoke,'detected');assert.equal(c.result().priority.level,'inspect_urgently');
    c.gap();put(20,null);assert.equal(c.result().priority.level,'inspect_urgently');
    for(let i=21;i<=27;i++)put(i,null);assert.equal(c.result().priority.level,'monitor');
  }finally{c.disconnect();store.close();}
});
test('valid Scout smoke evidence escalates a weak smoke-only candidate',async()=>{
  const {c,put,store,calls}=setup({visible:true});
  try{for(let i=0;i<=6;i++)put(i);await c.drain();assert.equal(calls(),1);
    assert.deepEqual(c.result().inference.validation_errors,[]);
    assert.equal(c.result().priority.level,'inspect_urgently');assert.equal(c.result().detection.smoke,'detected');
  }finally{c.disconnect();store.close();}
});
test('failed Scout cannot convert weak smoke into confirmed smoke',async()=>{
  const {c,put,store}=setup({fail:true});
  try{for(let i=0;i<=6;i++)put(i);await c.drain();assert.equal(c.result().priority.level,'pending');
    assert.equal(c.result().detection.smoke,'candidate');assert.equal(c.result().inference.error,'scout_timeout');
  }finally{c.disconnect();store.close();}
});
test('eight negatives at one FPS cannot reopen smoke from historical positives',async()=>{
  const {c,put,store}=setup({fail:true,interval:1000});
  try{for(let i=0;i<6;i++)put(i,.8);await c.drain();
    for(let i=6;i<14;i++)put(i,null);
    assert.equal(c.result().priority.level,'monitor');assert.equal(c.result().incident_id,null);
  }finally{c.disconnect();store.close();}
});
