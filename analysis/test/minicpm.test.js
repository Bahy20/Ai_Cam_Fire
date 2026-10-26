import test from 'node:test';
import assert from 'node:assert/strict';
import { MiniCPM,toInvestigation,MINICPM_MODEL,minicpmEnv } from '../src/minicpm.js';
import {qualifyModelInvestigation} from '../shared/investigation.js';
import {lighterSupported} from '../src/vlm-coordinator.js';
import {buildServer} from '../src/server.js';
import {Store} from '../src/store.js';

const frames=[0,1,2].map(i=>({frame_id:`frame-${i}`,ts_ms:1000+i*1000,roles:['recent'],image_b64:'AQI='}));
const rows=()=>frames.map(f=>({frame_id:f.frame_id,flame:'present',smoke:'not_observed',
  burning_material:'not_observed',lighter:'present',flame_relation:'at_tool_tip',occlusion:'not_observed',description:'A visible flame starts at the blue lighter tip.'}));

test('separate frame evidence passes the shared lighter gate; cause stays unknown',()=>{
  const raw=toInvestigation({frames:rows()},frames);
  const q=qualifyModelInvestigation(raw,{frames,source:'modal',model:MINICPM_MODEL});
  assert.deepEqual(q.validation_errors,[]);assert.equal(lighterSupported(q,frames),true);
  assert.equal(raw.hypothesis.ignition_source,'unknown');
  assert.deepEqual(raw.observations.map(o=>o.frame_ids),frames.map(f=>[f.frame_id]));
});
test('secondary burning and smoke take precedence over the lighter',()=>{
  for(const hazard of ['smoke','burning_material']){
    const values=rows();values[2][hazard]='present';
    const raw=toInvestigation({frames:values},frames);
    assert.equal(raw.observations[2].kind,hazard==='smoke'?'smoke_visible':'material_burning');
    const q=qualifyModelInvestigation(raw,{frames,source:'modal',model:MINICPM_MODEL});
    assert.equal(lighterSupported(q,frames),false);
  }
});
test('unknown occlusion is retained and cannot authorize monitoring',()=>{
  const values=rows();values[1].occlusion='uncertain';
  const q=qualifyModelInvestigation(toInvestigation({frames:values},frames),{frames});
  assert.equal(lighterSupported(q,frames),false);
});
test('incomplete, foreign, duplicate, out-of-order and contradictory findings are rejected',()=>{
  const bad=[];
  bad.push({frames:rows().slice(1)});
  for(const patch of [{frame_id:'foreign'},{frame_id:'frame-0'},{flame:'not_observed'},{lighter:'not_observed'},
    {smoke:[]},{occlusion:undefined},{extra:true}]){
    const values=rows();Object.assign(values[1],patch);bad.push({frames:values});
  }
  bad.push({frames:rows().reverse()});bad.push({frames:rows(),extra:true});
  for(const value of bad)assert.throws(()=>toInvestigation(value,frames),/minicpm_invalid/);
});
test('negative visual evidence is not turned into a positive observation',()=>{
  const values=rows().map(v=>({...v,flame:'not_observed',lighter:'not_observed',flame_relation:'not_observed',description:'A keyboard has red illuminated keys.'}));
  assert.ok(toInvestigation({frames:values},frames).observations.every(o=>o.kind==='unknown'));
});
test('adapter reports fresh model identity and rechecks superseded jobs before dispatch',async()=>{
  let calls=0;
  const model=new MiniCPM({requestImpl:async()=>{calls++;return {assessment:{frames:rows()},raw:'model JSON',usage:{output_tokens:88}};}});
  try{
    await assert.rejects(model.analyze(frames,{shouldRun:()=>false}),/minicpm_job_superseded/);
    const result=await model.analyze(frames);
    assert.equal(calls,1);assert.equal(result.model,MINICPM_MODEL);assert.equal(result.source,'modal');
    assert.equal(result.mode,'fresh');assert.equal(result.usage.output_tokens,88);
  }finally{model.close();}
});
test('close aborts active inference and prevents queued remote calls',async()=>{
  let begun,calls=0;const started=new Promise(r=>{begun=r;});
  const model=new MiniCPM({requestImpl:async(args,{signal})=>{calls++;begun();
    return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
  const settled=Promise.allSettled([model.analyze(frames),model.analyze(frames)]);
  await started;model.close();const values=await settled;
  assert.equal(calls,1);assert.ok(values.every(x=>x.status==='rejected'));
});
test('the default server reports MiniCPM, not Scout, without spawning a process for health',async()=>{
  const store=new Store(':memory:');
  const app=await buildServer({token:'test',store,dataDir:process.env.TEMP,frameReader:{close(){}}});
  try{
    const h=(await app.inject({url:'/health'})).json();
    assert.equal(h.vlm_model,MINICPM_MODEL);assert.equal(h.vlm_provider,'modal');assert.equal(h.scout_configured,false);
  }finally{await app.close();store.close();}
});
test('superseding a running scene aborts its remote request',{timeout:1000},async()=>{
  let current=true,started;const begun=new Promise(r=>{started=r;});
  const model=new MiniCPM({requestImpl:async(args,{signal})=>{started();
    return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
  try{
    const result=model.analyze(frames,{shouldRun:()=>current});
    await begun;current=false;
    await assert.rejects(result,/minicpm_job_superseded/);
  }finally{model.close();}
});

test('the MiniCPM bridge keeps Modal settings but drops gateway secrets',()=>{
  const env=minicpmEnv({PATH:'/bin',MODAL_TOKEN_ID:'id',MODAL_TOKEN_SECRET:'s',MODAL_SERVER_URL:'u',FIREGUARD_TOKEN:'t',FIREGUARD_NATIVE_TOKEN:'n',
    FIREGUARD_COOKIE_SECRET:'c',TESTER_ACCESS_CODE:'a',MINICPM_TIMEOUT:'9',UNSET:undefined});
  assert.deepEqual(env,{PATH:'/bin',MODAL_TOKEN_ID:'id',MODAL_TOKEN_SECRET:'s',MODAL_SERVER_URL:'u',MINICPM_TIMEOUT:'9'});
});
