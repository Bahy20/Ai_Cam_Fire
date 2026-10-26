import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { encodeFrame } from '../src/protocol.js';
import { FrameReader } from '../src/frame-reader.js';

test('native upstream receives quality-checked camera frames without a detector',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fire-native-'));let forwarded=0,closed=false;
  const app=await buildServer({token:'test',dataDir:dir,scout:{configured:true},
    nativeStreamFactory:({onState})=>({open:async()=>{onState('connecting');},push:()=>{forwarded++;},close:()=>{closed=true;}}),
    frameReader:{infer:async()=>({frame_wh:[640,480],visibility:'unknown'}),close(){}},
    detector:{infer:async()=>{throw new Error('YOLO must not run');},close(){}}});
  let socket;
  try{
    await app.listen({host:'127.0.0.1',port:0});
    socket=new WebSocket(`ws://127.0.0.1:${app.server.address().port}/v1/live`,{headers:{authorization:'Bearer test'}});
    await once(socket,'open');let message=once(socket,'message');
    socket.send(JSON.stringify({type:'start',camera_id:'test-camera',session_id:'native-test'}));
    assert.equal(JSON.parse((await message)[0]).type,'ready','capture clients require ready before native status');
    message=once(socket,'message');socket.send(encodeFrame({session_id:'native-test',sequence:1,ts_ms:Date.now()},Buffer.from([255,216,255,217])));
    const result=JSON.parse((await message)[0]);assert.notEqual(result.type,'error');assert.equal(forwarded,1);
    assert.equal(result.detection.source,'minicpm');assert.equal(result.priority.level,'unknown');
  }finally{if(socket){socket.close();await once(socket,'close');}await app.close();assert.equal(closed,true);await rm(dir,{recursive:true,force:true});}
});
test('native evidence is withheld until pixel quality completes and rejects a degraded frame',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fire-quality-native-'));let forwarded=0,release;
  const quality=new Promise(resolve=>{release=resolve;});
  const app=await buildServer({token:'test',dataDir:dir,scout:{configured:false},
    frameReader:{infer:()=>quality,close(){}},
    nativeStreamFactory:()=>({open:async()=>{},push:()=>{forwarded++;},close(){}})});
  let socket;try{
    await app.listen({host:'127.0.0.1',port:0});socket=new WebSocket(`ws://127.0.0.1:${app.server.address().port}/v1/live`,{headers:{authorization:'Bearer test'}});
    await once(socket,'open');const ready=once(socket,'message');socket.send(JSON.stringify({type:'start',camera_id:'test-camera',session_id:'quality'}));await ready;
    socket.send(encodeFrame({session_id:'quality',sequence:1,ts_ms:Date.now()},Buffer.from([255,216,255,217])));
    await new Promise(r=>setTimeout(r,25));assert.equal(forwarded,0,'unmeasured images must not enter native evidence');
    release({frame_wh:[640,480],visibility:'degraded'});await new Promise(r=>setTimeout(r,25));assert.equal(forwarded,0);
  }finally{release({frame_wh:[640,480],visibility:'degraded'});if(socket){socket.close();await once(socket,'close');}await app.close();await rm(dir,{recursive:true,force:true});}
});

test('shutdown saves cancelled inference from an already disconnected live session',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fire-drain-'));let clock=100000,cancel,called,session;
  const started=new Promise(resolve=>{called=resolve;});let saved=false;
  const scout={configured:true,analyze:()=>new Promise((resolve,reject)=>{cancel=()=>reject(new Error('scout_stopped'));called();}),close(){cancel?.();}};
  const app=await buildServer({token:'test',dataDir:dir,now:()=>clock,scout,
    frameReader:{infer:async()=>({frame_wh:[640,480],visibility:'unknown',detections:[{cls:'fire',conf:.8,bbox_xyxy:[10,10,25,30]}]}),close(){}},
    beforeStoreClose:async store=>{saved=store.inferences(session).length===1;}});
  await app.listen({host:'127.0.0.1',port:0});
  const socket=new WebSocket(`ws://127.0.0.1:${app.server.address().port}/v1/live`,{headers:{authorization:'Bearer test'}});
  try {
    await once(socket,'open');let message=once(socket,'message');
    socket.send(JSON.stringify({type:'start',camera_id:'test-camera',session_id:'abc'}));
    session=JSON.parse((await message)[0]).assessment_session_id;
    for(let i=0;i<7;i++){
      clock=100000+i*400;message=once(socket,'message');
      socket.send(encodeFrame({session_id:'abc',sequence:i+1,ts_ms:clock},Buffer.from([255,216,255,217])));
      await message;
    }
    await started;socket.close();await once(socket,'close');
    await app.close();assert.equal(saved,true);
  } finally{socket.terminate();await app.close();await rm(dir,{recursive:true,force:true});}
});

test('shutdown checkpoints after jobs finish and before the owned database closes',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fire-shutdown-'));let checked=false;
  const app=await buildServer({token:'test',dataDir:dir,
    frameReader:{close(){}},scout:{configured:false},beforeStoreClose:async store=>{
      assert.equal(store.job('saved').status,'complete');checked=true;
    }});
  app.fireguard.store.job('saved',{status:'complete'});
  try{await app.ready();await app.close();assert.equal(checked,true);}
  finally{await rm(dir,{recursive:true,force:true});}
});

test('authenticated live frames yield results; metadata-only detections cannot enter',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fire-server-'));
  const store=new Store(':memory:');let clock=100000;
  const app=await buildServer({token:'test-secret',dataDir:dir,store,now:()=>clock,
    frameReader:{infer:async()=>({frame_wh:[640,480],visibility:'unknown',detections:[]}),close(){}},scout:{configured:false}});
  await app.listen({host:'127.0.0.1',port:0});
  const url=`ws://127.0.0.1:${app.server.address().port}/v1/live`;
  const socket=new WebSocket(url,{headers:{authorization:'Bearer test-secret'}});
  try {
    await once(socket,'open');
    let message=once(socket,'message');socket.send(JSON.stringify({type:'start',camera_id:'cam',session_id:'abc'}));
    assert.equal(JSON.parse((await message)[0]).type,'ready');
    message=once(socket,'message');socket.send(encodeFrame({session_id:'abc',sequence:1,ts_ms:clock},Buffer.from([255,216,255,217])));
    assert.equal(JSON.parse((await message)[0]).priority.level,'unknown');
    message=once(socket,'message');socket.send(JSON.stringify({detections:[{cls:'fire'}]}));
    assert.equal(JSON.parse((await message)[0]).type,'error');
  } finally{socket.close();await once(socket,'close');await app.close();store.close();await rm(dir,{recursive:true,force:true});}
});
test('uploads without model evidence remain unknown and expose a timeline',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fire-upload-'));const store=new Store(':memory:');let i=0;
  const app=await buildServer({token:'test-secret',dataDir:dir,store,sleep:async()=>{},
    frameReader:{open:async()=>({duration_s:1,frames:3}),next:async()=>i<3?{ts_ms:i++*400,image_b64:'AQI='}:{eof:true,decoded_frames:3},
      infer:async()=>({frame_wh:[640,480],visibility:'unknown',detections:[]}),closeVideo:async()=>{},close(){}},scout:{configured:false}});
  try {
    assert.equal((await app.inject({url:'/v1/videos/nope'})).statusCode,401);
    const payload=Buffer.from('--boundary\r\nContent-Disposition: form-data; name="video"; filename="negative.mp4"\r\nContent-Type: video/mp4\r\n\r\nvideo\r\n--boundary--\r\n');
    const upload=await app.inject({method:'POST',url:'/v1/videos?camera_id=cam',headers:{authorization:'Bearer test-secret',
      'content-type':'multipart/form-data; boundary=boundary'},payload});
    assert.equal(upload.statusCode,202,upload.body);const {id}=upload.json();
    await app.fireguard.waitForJobs();
    const result=(await app.inject({url:`/v1/videos/${id}`,headers:{authorization:'Bearer test-secret'}})).json();
    assert.equal(result.status,'complete');assert.equal(result.result.detection.fire,'unknown');
    assert.equal(result.result.priority.level,'unknown');assert.ok(result.timeline.length>=3);
    assert.deepEqual(result.inferences,[]);
  } finally{await app.close();store.close();await rm(dir,{recursive:true,force:true});}
});
test('health shows a crash-looping frame reader through restarts and the last failure, not availability',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fire-health-'));const store=new Store(':memory:');
  const frameReader=new FrameReader({spawn:(cmd,args,opts)=>spawn(process.execPath,['-e','process.exit(3)'],opts),restartDelayMs:0}),exited=once(frameReader.child,'exit');
  const app=await buildServer({token:'test',dataDir:dir,store,frameReader,scout:{configured:false}});
  const stub=await buildServer({token:'test',dataDir:dir,store,frameReader:{close(){}},scout:{configured:false}});
  try{
    let h=(await stub.inject({url:'/health'})).json();
    assert.equal(h.frame_reader_available,true);assert.equal(h.frame_reader_restarts,0);assert.equal(h.frame_reader_last_failure,null);
    await exited;h=(await app.inject({url:'/health'})).json();
    assert.equal(h.frame_reader_available,true,'a dead worker is replaced on demand, so the reader stays available');
    assert.equal(typeof h.frame_reader_restarts,'number');assert.equal(h.frame_reader_restarts,0);
    assert.equal(h.frame_reader_last_failure.code,'frame_reader_exited');assert.equal(typeof h.frame_reader_last_failure.at_ms,'number');
    for(const restarts of [1,2]){
      await assert.rejects(frameReader.warmup(),{message:/^frame_reader_(exited|pipe_failed)$/});
      h=(await app.inject({url:'/health'})).json();assert.equal(h.frame_reader_restarts,restarts);assert.equal(h.frame_reader_available,true);
    }
    assert.match(h.frame_reader_last_failure.code,/^frame_reader_(exited|pipe_failed)$/);
  }finally{await app.close();await stub.close();store.close();await rm(dir,{recursive:true,force:true});}
  assert.equal(frameReader.closed,true);
});
