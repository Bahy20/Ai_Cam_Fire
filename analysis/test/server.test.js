import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp,rm,readdir,writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { buildServer,credentials } from '../src/server.js';
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

test('a moving camera frame is not pushed as native evidence and does not gap the view',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fire-motion-native-'));const pushed=[];let clock=100000,motion=false;
  const app=await buildServer({token:'test',dataDir:dir,scout:{configured:false},now:()=>clock,
    frameReader:{infer:async()=>({frame_wh:[640,480],visibility:'unknown',camera_motion:motion}),close(){}},
    nativeStreamFactory:()=>({open:async()=>{},push:frame=>{pushed.push(frame.ts_ms);},close(){}})});
  let socket;try{
    await app.listen({host:'127.0.0.1',port:0});socket=new WebSocket(`ws://127.0.0.1:${app.server.address().port}/v1/live`,{headers:{authorization:'Bearer test'}});
    await once(socket,'open');const ready=once(socket,'message');socket.send(JSON.stringify({type:'start',camera_id:'test-camera',session_id:'motion'}));await ready;
    const send=async(sequence,moving)=>{motion=moving;clock+=400;const message=once(socket,'message');
      socket.send(encodeFrame({session_id:'motion',sequence,ts_ms:clock},Buffer.from([255,216,255,217])));return JSON.parse((await message)[0]);};
    await send(1,false);const moved=await send(2,true);await send(3,false);
    assert.deepEqual(pushed,[100400,101200],'only the steady frames are pushed');assert.equal(moved.view.status,'available_for_analysis');
  }finally{if(socket){socket.close();await once(socket,'close');}await app.close();await rm(dir,{recursive:true,force:true});}
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
    const payload=Buffer.from('--boundary\r\nContent-Disposition: form-data; name="video"; filename="negative.mp4"\r\nContent-Type: video/mp4\r\n\r\n\0\0\0\x18ftypisom\r\n--boundary--\r\n');
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
test('uploads are refused and deleted unless the container signature matches the extension',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fire-signature-'));const store=new Store(':memory:');
  const app=await buildServer({token:'t',dataDir:dir,store,sleep:async()=>{},scout:{configured:false},
    frameReader:{open:async()=>({duration_s:0,frames:0}),next:async()=>({eof:true,decoded_frames:0}),closeVideo:async()=>{},close(){}}});
  const upload=(filename,bytes)=>app.inject({method:'POST',url:'/v1/videos',headers:{authorization:'Bearer t','content-type':'multipart/form-data; boundary=b'},
    payload:Buffer.concat([Buffer.from(`--b\r\nContent-Disposition: form-data; name="video"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      Buffer.from(bytes,'latin1'),Buffer.from('\r\n--b--\r\n')])});
  try{
    for(const [name,bytes] of [['a.mp4','<html>ftyp'],['a.mp4','ftyp'],['a.mp4',''],['a.mov','\0\0\0\x08junkjunk'],
      ['a.avi','RIFF\0\0\0\0WAVEfmt '],['a.avi','\0\0\0\x18ftypisom'],['a.avi','RIFF']]){
      const r=await upload(name,bytes);assert.equal(r.statusCode,415,`${name} ${JSON.stringify(bytes)}`);assert.deepEqual(r.json(),{error:'unsupported_video_format'});
    }
    assert.deepEqual(await readdir(join(dir,'uploads')),[],'refused uploads are deleted');
    for(const [name,bytes] of [['a.mp4','\0\0\0\x18ftypisom'],['a.MOV','\0\0\0\x14ftypqt  '],['a.mov','\0\0\0\x08wide'],['a.mov','\0\0\0\x08mdat'],['a.mp4','\0\0\0\x08moov'],
      ['a.avi','RIFF\x24\0\0\0AVI LIST']]){
      const r=await upload(name,bytes);assert.equal(r.statusCode,202,`${name}: ${r.body}`);await app.fireguard.waitForJobs();
      assert.equal(store.job(r.json().id).status,'complete');
    }
  }finally{await app.close();store.close();await rm(dir,{recursive:true,force:true});}
});
test('native and cookie credentials fall back to the service token unless set separately',()=>{
  const all=value=>({token:value,nativeToken:value,cookieSecret:value});
  assert.deepEqual(credentials({token:'svc'},{}),all('svc'),'a deployment with only FIREGUARD_TOKEN keeps working');
  assert.deepEqual(credentials({},{FIREGUARD_TOKEN:'svc',FIREGUARD_NATIVE_TOKEN:'',FIREGUARD_COOKIE_SECRET:''}),all('svc'),'empty values count as unset');
  assert.deepEqual(credentials({},{FIREGUARD_TOKEN:'svc',FIREGUARD_NATIVE_TOKEN:'gpu',FIREGUARD_COOKIE_SECRET:'jar'}),{token:'svc',nativeToken:'gpu',cookieSecret:'jar'});
  assert.deepEqual(credentials({token:'a',nativeToken:'b',cookieSecret:'c'},{FIREGUARD_TOKEN:'x',FIREGUARD_NATIVE_TOKEN:'y',FIREGUARD_COOKIE_SECRET:'z'}),
    {token:'a',nativeToken:'b',cookieSecret:'c'},'options override the environment');
  assert.throws(()=>credentials({},{FIREGUARD_NATIVE_TOKEN:'gpu',FIREGUARD_COOKIE_SECRET:'jar'}),/FIREGUARD_TOKEN is required/);
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
test('health reports the deployed policy version and build id',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fire-build-')),store=new Store(':memory:'),previous=process.env.FIREGUARD_BUILD_ID;
  delete process.env.FIREGUARD_BUILD_ID;
  const app=await buildServer({token:'test',dataDir:dir,store,frameReader:{close(){}},scout:{configured:false}});
  try{
    let h=(await app.inject({url:'/health'})).json();assert.equal(h.policy_version,'minicpm-only-v5');assert.equal(h.build_id,null);
    process.env.FIREGUARD_BUILD_ID='3f9c2a71be04';h=(await app.inject({url:'/health'})).json();
    assert.equal(h.build_id,'3f9c2a71be04');assert.equal(h.policy_version,'minicpm-only-v5');
  }finally{
    if(previous===undefined)delete process.env.FIREGUARD_BUILD_ID;else process.env.FIREGUARD_BUILD_ID=previous;
    await app.close();store.close();await rm(dir,{recursive:true,force:true});
  }
});

// Live session whose native stream reports `state.smoke` for every forwarded frame.
async function criticalHarness(onCriticalChange) {
  const dir=await mkdtemp(join(tmpdir(),'fire-critical-')),store=new Store(':memory:'),state={clock:100000,smoke:'present',sequence:0};
  const report=(session_id,f)=>({session_id,engine:'minicpm-native-visual',native_chunks:1,source_ts_ms:f.ts_ms,assessment_source_ts_ms:f.ts_ms,text:state.smoke,
    assessment:{frame_id:`frame-${f.ts_ms}`,flame:'not_observed',smoke:state.smoke,burning_material:'not_observed',lighter:'not_observed',
      flame_relation:'not_observed',occlusion:'not_observed',description:state.smoke==='present'?'smoke':'clear'}});
  const app=await buildServer({token:'test',dataDir:dir,store,now:()=>state.clock,onCriticalChange,
    frameReader:{infer:async()=>({frame_wh:[640,480],visibility:'unknown'}),close(){}},scout:{configured:false},
    nativeStreamFactory:({sessionId,onState,onResult})=>({open:async()=>onState('listening'),close(){},push:f=>onResult(report(sessionId,f),f)})});
  await app.listen({host:'127.0.0.1',port:0});
  const ws=new WebSocket(`ws://127.0.0.1:${app.server.address().port}/v1/live`,{headers:{authorization:'Bearer test'}});await once(ws,'open');
  const messages=[];ws.on('message',raw=>messages.push(JSON.parse(raw)));
  const until=async(check,label)=>{for(let i=0;i<400&&!messages.some(check);i++)await new Promise(r=>setTimeout(r,5));assert.ok(messages.some(check),label);};
  ws.send(JSON.stringify({type:'start',camera_id:'cam',session_id:'source'}));await until(x=>x.type==='ready','ready');
  const sid=messages.find(x=>x.type==='ready').assessment_session_id;
  const frame=async()=>{
    state.clock+=500;const ts=state.clock;
    ws.send(encodeFrame({session_id:'source',sequence:++state.sequence,ts_ms:ts},Buffer.from([255,216,255,217])));
    await until(x=>x.trigger==='native_result'&&x.native_stream?.assessment_ts_ms===ts,`native result for ${ts}`);return messages.at(-1);
  };
  const review=last=>app.inject({method:'POST',url:`/v1/live/${sid}/review`,headers:{authorization:'Bearer test'},
    payload:{incident_id:last.incident_id,last_hazard_ts_ms:last.incident_history.latest_hazard.ts_ms,action:'false_alarm'}});
  const close=async()=>{if(ws.readyState===WebSocket.OPEN){ws.close();await once(ws,'close');}await app.close();store.close();await rm(dir,{recursive:true,force:true});};
  return {state,ws,messages,frame,review,close};
}
test('alert-state changes reach onCriticalChange once each, not on every frame',async()=>{
  const calls=[],h=await criticalHarness(result=>{calls.push(result);});
  try{
    await h.frame();
    assert.equal(calls.length,1,'a first smoke report opens an (unconfirmed) incident');
    assert.equal(calls[0].incident_history.model_hazard,false);assert.equal(typeof calls[0].incident_id,'string');
    await h.frame();
    assert.equal(calls.length,2,'the latch is reported exactly once');
    assert.equal(calls[1].incident_history.model_hazard,true);assert.equal(calls[1].incident_id,calls[0].incident_id);
    let last;for(let i=0;i<3;i++)last=await h.frame();
    assert.equal(last.incident_history.model_hazard,true);assert.equal(calls.length,2,'latched hazard refreshes are not critical changes');
    const reviewed=await h.review(last);assert.equal(reviewed.statusCode,200,reviewed.body);
    assert.equal(calls.length,3,'an operator review is reported exactly once');
    assert.equal(calls[2].incident_history.model_hazard,false);assert.equal(calls[2].incident_id,null);
    assert.equal(calls[2].incident_history.last_review.action,'false_alarm');
    h.state.smoke='not_observed';for(let i=0;i<3;i++)await h.frame();
    assert.equal(calls.length,3,'clear frames after the review are not critical changes');
  }finally{await h.close();}
});
test('a throwing or rejecting onCriticalChange hook cannot break the live socket',async()=>{
  let calls=0;const logged=[],error=console.error;console.error=(...args)=>{logged.push(args.join(' '));};
  const h=await criticalHarness(()=>{if(++calls===1)throw new Error('hook_threw');return Promise.reject(new Error('hook_rejected'));});
  try{
    await h.frame();await h.frame();const last=await h.frame();
    assert.equal(calls,2);assert.equal(h.ws.readyState,WebSocket.OPEN);assert.equal(last.incident_history.model_hazard,true);
    assert.ok(!h.messages.some(x=>x.type==='error'),'hook failures must not surface as frame failures');
    await new Promise(r=>setImmediate(r));
    assert.deepEqual(logged.map(line=>line.match(/hook_(threw|rejected)/)?.[0]),['hook_threw','hook_rejected']);
  }finally{console.error=error;await h.close();}
});
test('the store is pruned hourly when it supports pruning, harmlessly otherwise',async t=>{
  t.mock.timers.enable({apis:['setInterval']});
  const dir=await mkdtemp(join(tmpdir(),'fire-prune-'));let pruned=0;const logged=[],error=console.error;
  const app=await buildServer({token:'test',dataDir:dir,store:{prune:()=>{if(++pruned===2)throw new Error('prune_failed');}},frameReader:{close(){}},scout:{configured:false}});
  const plain=await buildServer({token:'test',dataDir:dir,store:{},frameReader:{close(){}},scout:{configured:false}});
  try{
    await app.ready();await plain.ready();console.error=(...args)=>{logged.push(args.join(' '));};
    t.mock.timers.tick(3600000-1);assert.equal(pruned,0);
    t.mock.timers.tick(1);assert.equal(pruned,1);
    t.mock.timers.tick(3600000);assert.equal(pruned,2);assert.equal(logged.length,1);assert.match(logged[0],/prune_failed/);
  }finally{console.error=error;await app.close();await plain.close();t.mock.timers.tick(3600000);assert.equal(pruned,2,'closing stops pruning');
    t.mock.timers.reset();await rm(dir,{recursive:true,force:true});}
});
const jpeg=Buffer.from([255,216,255,217]);
const waitFor=async(check,label,ms=2000)=>{for(const end=Date.now()+ms;Date.now()<end&&!await check();)await new Promise(r=>setTimeout(r,5));assert.ok(await check(),label);};
test('a live socket that stops answering pings is terminated and frees the live slot',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fire-ping-'));const opened=[];
  // 150 ms pings leave room for event-loop stalls on a loaded machine; the assertions below are in ping periods.
  const app=await buildServer({token:'test',dataDir:dir,livePingMs:150,scout:{configured:false},
    frameReader:{infer:async()=>({frame_wh:[640,480],visibility:'unknown'}),close(){}}});
  const start=async(options={})=>{
    const ws=new WebSocket(`ws://127.0.0.1:${app.server.address().port}/v1/live`,{headers:{authorization:'Bearer test'},...options});
    const id=`s${opened.push(ws)}`;await once(ws,'open');const reply=once(ws,'message');
    ws.send(JSON.stringify({type:'start',camera_id:'cam',session_id:id}));assert.equal(JSON.parse((await reply)[0]).type,'ready');return [ws,id];
  };
  const idle=async()=>!(await app.inject('/health')).json().live_active;
  try{
    await app.listen({host:'127.0.0.1',port:0});
    const [silent]=await start({autoPong:false}),started=Date.now();await once(silent,'close');
    assert.ok(Date.now()-started<1000,'terminated after two missed pings');await waitFor(idle,'the dead socket released the live slot');
    const [answering]=await start();await new Promise(r=>setTimeout(r,600));
    assert.equal(answering.readyState,WebSocket.OPEN,'a client that answers pings stays connected while idle');
    answering.close();await once(answering,'close');await waitFor(idle,'slot free');
    // Frames prove liveness too, so a proxy that swallowed pings could not end a stream.
    const [streaming,id]=await start({autoPong:false});let sequence=0;
    const sender=setInterval(()=>streaming.send(encodeFrame({session_id:id,sequence:++sequence,ts_ms:Date.now()},jpeg)),20);
    await new Promise(r=>setTimeout(r,600));clearInterval(sender);assert.equal(streaming.readyState,WebSocket.OPEN);
  }finally{for(const ws of opened)ws.terminate();await app.close();await rm(dir,{recursive:true,force:true});}
});
test('a skewed client clock streams normally: frames carry capture time on the server clock downstream',async()=>{
  for(const skew of [-600000,120000]){ // ten minutes behind, two minutes ahead
    const dir=await mkdtemp(join(tmpdir(),'fire-skew-'));const t0=1760000000000;let clock=t0,socket;const inferred=[],pushed=[],messages=[];
    const app=await buildServer({token:'test',dataDir:dir,now:()=>clock,scout:{configured:false},
      frameReader:{infer:async(image,options)=>{inferred.push(options);return {frame_wh:[640,480],visibility:'unknown'};},close(){}},
      nativeStreamFactory:()=>({open:async()=>{},push:f=>pushed.push([f.sequence,f.ts_ms]),close(){}})});
    try{
      await app.listen({host:'127.0.0.1',port:0});
      socket=new WebSocket(`ws://127.0.0.1:${app.server.address().port}/v1/live`,{headers:{authorization:'Bearer test'}});await once(socket,'open');
      socket.on('message',raw=>messages.push(JSON.parse(raw)));socket.send(JSON.stringify({type:'start',camera_id:'cam',session_id:'skew'}));
      await waitFor(()=>messages.length,'ready');const session=messages[0].assessment_session_id;
      for(let sequence=1;sequence<=3;sequence++){
        clock+=400;socket.send(encodeFrame({session_id:'skew',sequence,ts_ms:clock+skew},jpeg));
        const ts=clock;await waitFor(()=>messages.some(m=>m.type==='result'&&m.source_ts_ms===ts),`result for ${ts}`);
      }
      assert.deepEqual(messages.filter(m=>m.type==='error'),[],`skew ${skew}`);
      assert.deepEqual(inferred,[400,800,1200].map(dt=>({stream:session,ts_ms:t0+dt})));
      assert.deepEqual(pushed,[[1,t0+400],[2,t0+800],[3,t0+1200]],'native evidence keeps the client sequence and the server time');
      // The client clock is still checked against itself: it must increase, and a frame 5 s later than the session's
      // least-delayed one is stale.
      clock+=400;socket.send(encodeFrame({session_id:'skew',sequence:4,ts_ms:t0+1200+skew},jpeg));
      await waitFor(()=>messages.some(m=>m.error==='duplicate_or_reordered_frame'),'reordered client timestamp');
      clock+=6000;socket.send(encodeFrame({session_id:'skew',sequence:5,ts_ms:t0+1201+skew},jpeg));
      await waitFor(()=>messages.some(m=>m.error==='stale_frame'),'stale frame');
      // A burst delayed 4 s in the network keeps its capture times, so it does not look fresh.
      clock=t0+12000;socket.send(encodeFrame({session_id:'skew',sequence:6,ts_ms:t0+12000+skew},jpeg));
      await waitFor(()=>messages.some(m=>m.type==='result'&&m.source_ts_ms===t0+12000),'steady frame');
      clock=t0+17000;
      for(const [sequence,captured] of [[7,13000],[8,13400],[9,13800]]){
        socket.send(encodeFrame({session_id:'skew',sequence,ts_ms:t0+captured+skew},jpeg));
        await waitFor(()=>messages.some(m=>m.type==='result'&&m.source_ts_ms===t0+captured),`delayed ${captured}`);
      }
      const delayed=messages.findLast(m=>m.type==='result');assert.equal(delayed.view.source_frame_age_ms,3200,'the burst shows its real age');
      assert.deepEqual(pushed.slice(3),[[6,t0+12000],[7,t0+13000],[8,t0+13400],[9,t0+13800]]);
    }finally{socket?.terminate();await app.close();await rm(dir,{recursive:true,force:true});}
  }
});
test('live frame failures report the frame reader code, or frame_decode_failure for free text',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fire-reader-code-'));let clock=100000,socket;const messages=[];
  const failures=['invalid_jpeg_or_dimensions','frame_reader_timeout',"'NoneType' object has no attribute 'shape'",`frame_${'x'.repeat(70)}`];
  const app=await buildServer({token:'test',dataDir:dir,now:()=>clock,scout:{configured:false},
    frameReader:{infer:async()=>{throw new Error(failures.shift());},close(){}}});
  try{
    await app.listen({host:'127.0.0.1',port:0});
    socket=new WebSocket(`ws://127.0.0.1:${app.server.address().port}/v1/live`,{headers:{authorization:'Bearer test'}});await once(socket,'open');
    socket.on('message',raw=>messages.push(JSON.parse(raw)));socket.send(JSON.stringify({type:'start',camera_id:'cam',session_id:'codes'}));
    await waitFor(()=>messages.length,'ready');
    for(let sequence=1;sequence<=4;sequence++){
      clock+=400;socket.send(encodeFrame({session_id:'codes',sequence,ts_ms:clock},jpeg));
      await waitFor(()=>messages.filter(m=>m.type==='error').length===sequence,`error ${sequence}`);
    }
    assert.deepEqual(messages.filter(m=>m.type==='error').map(m=>m.error),
      ['invalid_jpeg_or_dimensions','frame_reader_timeout','frame_decode_failure','frame_decode_failure']);
    assert.equal(messages.filter(m=>m.type==='result').at(-1).view.reason,'frame_decode_failure');
  }finally{socket?.terminate();await app.close();await rm(dir,{recursive:true,force:true});}
});
test('upload failures return specific error codes and never wedge the upload slot',{timeout:20000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fire-upload-codes-'));const store=new Store(':memory:'),job=store.job.bind(store);let failStore=false;
  store.job=(id,patch)=>{if(failStore&&patch?.status==='queued')throw new Error('database or disk is full');return job(id,patch);};
  const app=await buildServer({token:'t',dataDir:dir,store,sleep:async()=>{},scout:{configured:false},uploadLimitBytes:64,
    frameReader:{open:async()=>({duration_s:0,frames:0}),next:async()=>({eof:true,decoded_frames:0}),closeVideo:async()=>{},close(){}}});
  const part=(name,filename,body)=>`--b\r\nContent-Disposition: form-data; name="${name}"${filename?`; filename="${filename}"`:''}\r\n\r\n${body}\r\n`;
  const video=part('video','a.mp4','\0\0\0\x18ftypisom')+'--b--\r\n',multipartType='multipart/form-data; boundary=b';
  const upload=async(payload,type=multipartType)=>{const r=await app.inject({method:'POST',url:'/v1/videos',
    headers:{authorization:'Bearer t','content-type':type},payload:Buffer.from(payload,'latin1')});await app.fireguard.waitForJobs();return [r.statusCode,r.json().error];};
  try{
    assert.deepEqual(await upload(part('video','a.mp4','\0\0\0\x18ftypisom'+'x'.repeat(64))+'--b--\r\n'),[413,'video_too_large']);
    assert.deepEqual(await upload('{}','application/json'),[400,'invalid_multipart']);
    assert.deepEqual(await upload(part('note',null,'hi')+video),[400,'invalid_multipart'],'fields are not accepted');
    assert.deepEqual(await upload('--b--\r\n'),[400,'video_required']);
    assert.deepEqual(await upload(part('video','a.txt','text')+'--b--\r\n'),[415,'unsupported_video_format']);
    failStore=true;assert.deepEqual(await upload(video),[500,'video_store_failed'],'a database write failure');failStore=false;
    assert.deepEqual(await readdir(join(dir,'uploads')),[],'the stored file is removed');
    assert.deepEqual(await upload(video),[202,undefined]);
    // A body that ends inside the file part is refused, and the slot is free again for the next upload.
    await app.listen({host:'127.0.0.1',port:0});const truncated=Buffer.from(part('video','a.mp4','\0\0\0\x18ftypisom').slice(0,-2),'latin1');
    const s=net.connect(app.server.address().port,'127.0.0.1');let reply='';s.on('data',d=>{reply+=d;});s.on('error',()=>{});
    s.write(`POST /v1/videos HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer t\r\nContent-Type: ${multipartType}\r\nContent-Length: ${truncated.length}\r\n\r\n`);s.write(truncated);
    await waitFor(()=>reply.includes('invalid_multipart'),'truncated upload refused',6000);s.destroy();
    assert.match(reply,/^HTTP\/1.1 400 /);assert.deepEqual(await upload(video),[202,undefined]);
    await rm(join(dir,'uploads'),{recursive:true});await writeFile(join(dir,'uploads'),'not a directory');
    assert.deepEqual(await upload(video),[500,'video_store_failed'],'a filesystem failure');
  }finally{await app.close();store.close();await rm(dir,{recursive:true,force:true});}
});
test('only uploads get the long request timeout; other requests must still arrive within the normal limit',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fire-request-timeout-'));const store=new Store(':memory:');
  const app=await buildServer({token:'t',dataDir:dir,store,requestTimeoutMs:250,sleep:async()=>{},scout:{configured:false},
    frameReader:{open:async()=>({duration_s:0,frames:0}),next:async()=>({eof:true,decoded_frames:0}),closeVideo:async()=>{},close(){}}});
  // Sends the headers and half the body, then the rest after 400 ms; reports the status line and whether the server
  // closed the connection before the rest was sent.
  const slow=(path,headers,text)=>new Promise(resolve=>{
    const body=Buffer.from(text,'latin1'),s=net.connect(app.server.address().port,'127.0.0.1');let data='',closed=false;
    s.on('data',d=>{data+=d;});s.on('error',()=>{});s.on('close',()=>{closed=true;});
    s.write(`POST ${path} HTTP/1.1\r\nHost: x\r\n${headers}Content-Length: ${body.length}\r\n\r\n`);s.write(body.subarray(0,body.length>>1));
    setTimeout(()=>{const early=closed;if(!s.destroyed)s.write(body.subarray(body.length>>1));
      setTimeout(()=>{s.destroy();resolve({status:data.split('\r\n')[0],early});},300);},400);
  });
  try{
    assert.equal(app.server.requestTimeout,900000,'the server-wide limit fits a 250 MiB upload on a slow uplink');
    await app.listen({host:'127.0.0.1',port:0});
    const review=JSON.stringify({action:'false_alarm',incident_id:'x',last_hazard_ts_ms:null});
    assert.deepEqual(await slow('/v1/live/x/review','Authorization: Bearer t\r\nContent-Type: application/json\r\n',review),{status:'',early:true});
    assert.deepEqual(await slow('/v1/live/x/review','Content-Type: application/json\r\n',review),{status:'HTTP/1.1 401 Unauthorized',early:true},
      'a refused request cannot hold the connection with a slow body');
    const video='--b\r\nContent-Disposition: form-data; name="video"; filename="a.mp4"\r\n\r\n\0\0\0\x18ftypisom\r\n--b--\r\n';
    const multipart='Content-Type: multipart/form-data; boundary=b\r\n';
    assert.deepEqual(await slow('/v1/videos',multipart,video),{status:'HTTP/1.1 401 Unauthorized',early:true},
      'an unauthenticated trickling upload is cut at the normal limit');
    const first=slow('/v1/videos','Authorization: Bearer t\r\n'+multipart,video);await new Promise(r=>setTimeout(r,150));
    assert.deepEqual(await slow('/v1/videos','Authorization: Bearer t\r\n'+multipart,video),{status:'HTTP/1.1 409 Conflict',early:true},
      'an upload refused while the slot is held is cut at the normal limit');
    assert.deepEqual(await first,{status:'HTTP/1.1 202 Accepted',early:false});
    await app.fireguard.waitForJobs();
  }finally{await app.close();store.close();await rm(dir,{recursive:true,force:true});}
});
