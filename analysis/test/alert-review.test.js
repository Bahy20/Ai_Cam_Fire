import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import WebSocket from 'ws';
import {buildServer} from '../src/server.js';
import {Store} from '../src/store.js';
import {encodeFrame} from '../src/protocol.js';

test('live alert review enforces owner, origin and latest evidence, audits and restarts context',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fire-review-')),store=new Store(':memory:');let streams=0,closed=0,clock=100000;const upstreams=[];
  const app=await buildServer({token:'service',testerCode:'code',testerOrigin:'https://test.example',dataDir:dir,store,now:()=>clock,
    frameReader:{infer:async()=>({frame_wh:[640,480],visibility:'unknown'}),close(){}},scout:{configured:false},
    nativeStreamFactory:({sessionId,onState,onResult})=>{streams++;upstreams.push({onState,onResult});return {open:async()=>onState('listening'),close:()=>closed++,push:f=>onResult({session_id:sessionId,engine:'minicpm-native-visual',native_chunks:1,
      source_ts_ms:f.ts_ms,assessment_source_ts_ms:f.ts_ms,assessment:{frame_id:`frame-${f.ts_ms}`,flame:'not_observed',smoke:'present',burning_material:'not_observed',lighter:'not_observed',flame_relation:'not_observed',occlusion:'not_observed',description:'smoke'},text:'smoke'},f)};}});
  const origin={origin:'https://test.example'};let ws;
  try{
    await app.listen({host:'127.0.0.1',port:0});
    const login=async()=>{const r=await app.inject({method:'POST',url:'/testing/login',headers:origin,payload:{code:'code'}});return r.headers['set-cookie'].split(';')[0];};
    const owner=await login(),other=await login();
    ws=new WebSocket(`ws://127.0.0.1:${app.server.address().port}/v1/live`,{headers:{...origin,cookie:owner}});await once(ws,'open');
    const messages=[];ws.on('message',raw=>messages.push(JSON.parse(raw)));
    ws.send(JSON.stringify({type:'start',camera_id:'cam',session_id:'source'}));
    while(!messages.some(x=>x.type==='ready'))await new Promise(r=>setTimeout(r,5));
    const sid=messages.find(x=>x.type==='ready').assessment_session_id;
    ws.send(encodeFrame({session_id:'source',sequence:1,ts_ms:clock},Buffer.from([255,216,255,217])));
    while(!messages.some(x=>x.incident_history?.model_hazard))await new Promise(r=>setTimeout(r,5));
    const incident=messages.find(x=>x.incident_history?.model_hazard).incident_id,url=`/v1/live/${sid}/review`;
    const payload={incident_id:incident,last_hazard_ts_ms:clock,action:'false_alarm'};
    assert.equal((await app.inject({method:'POST',url,payload})).statusCode,401);
    assert.equal((await app.inject({method:'POST',url,headers:{cookie:owner},payload})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url,headers:{...origin,cookie:other},payload})).statusCode,404);
    assert.equal((await app.inject({method:'POST',url,headers:{...origin,cookie:owner},payload:{...payload,last_hazard_ts_ms:clock-1}})).statusCode,409);
    assert.equal((await app.inject({method:'POST',url,headers:{...origin,cookie:owner},payload:{...payload,extra:true}})).statusCode,400);
    clock+=1000;
    const reviewed=await app.inject({method:'POST',url,headers:{...origin,cookie:owner},payload});
    assert.equal(reviewed.statusCode,200,reviewed.body);assert.equal(reviewed.json().incident_history.model_hazard,false);
    assert.equal(reviewed.json().priority.level,'unknown');assert.equal(store.reviews(sid).length,1);
    assert.equal(streams,2);assert.equal(closed,1);
    upstreams[0].onState('unavailable');
    assert.equal(JSON.parse(store.db.prepare('SELECT result FROM sessions WHERE id=?').get(sid).result).native_stream.state,'listening');
    assert.equal((await app.inject({method:'POST',url,headers:{...origin,cookie:owner},payload})).statusCode,409);
  }finally{if(ws){ws.close();await once(ws,'close');}await app.close();store.close();await rm(dir,{recursive:true,force:true});}
});
