import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {WebSocketServer} from 'ws';
import {NativeStream} from '../src/native-stream.js';

test('transient GPU busy close retries automatically and close cancels further retries',async()=>{
  const {WebSocketServer}=await import('ws');const {once}=await import('node:events');
  const wss=new WebSocketServer({host:'127.0.0.1',port:0});await once(wss,'listening');let attempts=0;const states=[];
  wss.on('connection',ws=>{attempts++;if(attempts===1){ws.close(1013,'previous inference draining');return;}
    ws.on('message',bytes=>{const msg=JSON.parse(bytes);if(msg.type==='start')ws.send(JSON.stringify({type:'native_ready',engine:'minicpm-native-visual',session_id:'retry'}));});});
  const stream=new NativeStream({url:`ws://127.0.0.1:${wss.address().port}`,allowLoopback:true,token:'test',sessionId:'retry',onState:s=>states.push(s),retryDelays:[5,10]});
  try{await stream.open();assert.equal(attempts,2);assert.deepEqual(states,['connecting','listening'],'a retry before the first native_ready is still connecting');assert.equal(stream.ready,true);}
  finally{stream.close();for(const client of wss.clients)client.terminate();await new Promise(resolve=>wss.close(resolve));}
});
test('busy retries are bounded and authentication denial is not retried',async()=>{
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');let attempts=0;
  server.on('connection',ws=>{attempts++;ws.close(1013);});
  const stream=new NativeStream({url:`ws://127.0.0.1:${server.address().port}`,allowLoopback:true,token:'test',sessionId:'bounded',retryDelays:[5,10]});
  try{await assert.rejects(stream.open(),/unavailable/);assert.equal(attempts,3);}
  finally{stream.close();for(const ws of server.clients)ws.terminate();await new Promise(r=>server.close(r));}
  let denied=0;const auth=new WebSocketServer({host:'127.0.0.1',port:0,verifyClient:()=>{denied++;return false;}});await once(auth,'listening');
  const invalid=new NativeStream({url:`ws://127.0.0.1:${auth.address().port}`,allowLoopback:true,token:'bad',sessionId:'auth',retryDelays:[5,10]});
  try{await assert.rejects(invalid.open(),/unavailable/);assert.equal(denied,1);}
  finally{invalid.close();await new Promise(r=>auth.close(r));}
});
test('default recovery covers a previous inference draining for fourteen seconds',{timeout:25000},async()=>{
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');const started=Date.now();
  server.on('connection',ws=>{
    if(Date.now()-started<14000){ws.close(1013,'still draining');return;}
    ws.on('message',()=>ws.send(JSON.stringify({type:'native_ready',engine:'minicpm-native-visual',session_id:'slow-drain'})));
  });
  const stream=new NativeStream({url:`ws://127.0.0.1:${server.address().port}`,allowLoopback:true,token:'test',sessionId:'slow-drain'});
  try{await stream.open();assert.equal(stream.ready,true);}
  finally{stream.close();for(const ws of server.clients)ws.terminate();await new Promise(r=>server.close(r));}
});
import {decodeFrame} from '../src/protocol.js';

test('one persistent upstream WSS carries successive frames and native replies',async()=>{
  const server=new WebSocketServer({port:0});await once(server,'listening');
  let connections=0,received=0;
  server.on('connection',(ws,request)=>{
    connections++;assert.equal(request.headers.authorization,'Bearer service');
    ws.on('message',(data,binary)=>{
      if(!binary){const c=JSON.parse(data);ws.send(JSON.stringify({type:'native_ready',engine:'minicpm-native-duplex',session_id:c.session_id}));}
      else{const f=decodeFrame(data);received++;ws.send(JSON.stringify({type:'native_result',engine:'minicpm-native-duplex',session_id:f.session_id,
        sequence:f.sequence,source_ts_ms:f.ts_ms,native_chunks:received,is_listen:true,text:'',assessment:null}));}
    });
  });
  const replies=[];let done;const finished=new Promise(r=>{done=r;});
  const stream=new NativeStream({url:`ws://127.0.0.1:${server.address().port}`,allowLoopback:true,token:'service',sessionId:'session',
    onResult:r=>{replies.push(r);if(replies.length===2)done();}});
  try{
    await stream.open();const ts=Date.now();
    stream.push({sequence:1,ts_ms:ts,jpeg:Buffer.from([255,216,255,217])});
    stream.push({sequence:2,ts_ms:ts+1,jpeg:Buffer.from([255,216,255,217])});
    await finished;assert.equal(connections,1);assert.equal(received,2);assert.equal(replies[1].native_chunks,2);
  }finally{stream.close();for(const ws of server.clients)ws.terminate();await new Promise(r=>server.close(r));}
});
test('a non-TLS remote model URL is rejected',()=>{
  assert.throws(()=>new NativeStream({url:'http://example.com',token:'service',sessionId:'session'}),/native_url/);
});
// Fake-service helpers: a native_ready for the client's start message and a valid native_result echoing a pushed frame.
const sendReady=(ws,bytes)=>ws.send(JSON.stringify({type:'native_ready',engine:'minicpm-native-visual',session_id:JSON.parse(bytes).session_id}));
const sendResult=(ws,bytes)=>{const f=decodeFrame(bytes);ws.send(JSON.stringify({type:'native_result',engine:'minicpm-native-visual',session_id:f.session_id,
  sequence:f.sequence,source_ts_ms:f.ts_ms,native_chunks:1,is_listen:true,text:'',assessment:null}));};
const frame=sequence=>({sequence,ts_ms:Date.now(),jpeg:Buffer.from([255,216,255,217])});
test('a 1012 session rotation after a delivered result reconnects promptly with a fresh retry budget',async()=>{
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');let attempts=0,rotatedAt=0,done;const states=[],results=[];
  const relistened=new Promise(r=>{done=r;});
  server.on('connection',ws=>{attempts++;if(attempts===1){ws.close(1013,'still draining');return;}
    ws.on('message',(bytes,binary)=>{if(!binary)return sendReady(ws,bytes);sendResult(ws,bytes);rotatedAt=Date.now();ws.close(1012,'session_rotation');});});
  // The delivered result proves the session healthy and refills the budget; without it the rotation would wait on retryDelays[1].
  const stream=new NativeStream({url:`ws://127.0.0.1:${server.address().port}`,allowLoopback:true,token:'test',sessionId:'rotate',retryDelays:[5,3000],
    onResult:r=>results.push(r),onState:s=>{states.push(s);if(s==='unavailable'||s==='listening'&&attempts===3)done(Date.now()-rotatedAt);
      else if(s==='listening')stream.push(frame(1));}});
  try{
    await stream.open();const elapsed=await relistened;
    assert.deepEqual(states,['connecting','listening','reconnecting','listening']);assert.equal(results.length,1);
    assert.equal(attempts,3);assert.equal(stream.ready,true);assert.ok(elapsed<1500,`rotation reconnect took ${elapsed}ms`);
  }finally{stream.close();for(const ws of server.clients)ws.terminate();await new Promise(r=>server.close(r));}
});
test('a service that reaches native_ready but crashes on every first inference stops after retryDelays.length reconnects',async()=>{
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');let attempts=0,sequence=0,done;const states=[],results=[];
  const settled=new Promise(r=>{done=r;});
  server.on('connection',ws=>{attempts++;ws.on('message',(bytes,binary)=>binary?ws.terminate():sendReady(ws,bytes));});
  // A budget refilled by native_ready alone would loop forever; past 5 attempts the test stops waiting and fails on the count.
  const stream=new NativeStream({url:`ws://127.0.0.1:${server.address().port}`,allowLoopback:true,token:'test',sessionId:'crashing',retryDelays:[5,10],
    onResult:r=>results.push(r),onState:s=>{states.push(s);if(s==='unavailable'||attempts>5)done();else if(s==='listening')stream.push(frame(++sequence));}});
  try{
    await stream.open();await settled;await new Promise(r=>setTimeout(r,50));
    assert.equal(attempts,3,'one connection plus one per retry delay, then no more');assert.equal(results.length,0);assert.equal(stream.ready,false);
    assert.deepEqual(states,['connecting','listening','reconnecting','listening','reconnecting','listening','unavailable']);
  }finally{stream.close();for(const ws of server.clients)ws.terminate();await new Promise(r=>server.close(r));}
});
test('transient drops separated by successful sessions never exhaust the retry budget',async()=>{
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');let attempts=0,current=null,sequence=0,done;const states=[],results=[];
  const settled=new Promise(r=>{done=r;});const drops=[ws=>ws.close(1012,'session_rotation'),ws=>ws.close(1013),ws=>ws.terminate()];
  server.on('connection',ws=>{attempts++;current=ws;ws.on('message',(bytes,binary)=>binary?sendResult(ws,bytes):sendReady(ws,bytes));});
  // Each session delivers one result before it is dropped: 6 drops against a budget of 2 retries.
  const stream=new NativeStream({url:`ws://127.0.0.1:${server.address().port}`,allowLoopback:true,token:'test',sessionId:'flaky',retryDelays:[5,10],
    onResult:r=>{results.push(r);if(attempts>6)done();else drops[(attempts-1)%drops.length](current);},
    onState:s=>{states.push(s);if(s==='unavailable')done();else if(s==='listening')stream.push(frame(++sequence));}});
  try{
    await stream.open();await settled;
    assert.equal(states.includes('unavailable'),false);assert.equal(attempts,7);assert.equal(stream.ready,true);assert.equal(results.length,7);
    assert.equal(states.filter(s=>s==='listening').length,7);assert.equal(states.filter(s=>s==='reconnecting').length,6);
  }finally{stream.close();for(const ws of server.clients)ws.terminate();await new Promise(r=>server.close(r));}
});
test('a slow cold-start handshake stays connecting until ready, within a 300 s default deadline',async()=>{
  // The fake service completes each WebSocket handshake 300 ms late, standing in for a cold GPU container.
  const server=new WebSocketServer({host:'127.0.0.1',port:0,verifyClient:(info,done)=>setTimeout(()=>done(true),300)});await once(server,'listening');
  server.on('connection',ws=>ws.on('message',bytes=>sendReady(ws,bytes)));
  const url=`ws://127.0.0.1:${server.address().port}`,states=[],late=[];
  assert.equal(new NativeStream({url,allowLoopback:true,token:'t',sessionId:'default'}).connectTimeoutMs,300000);
  const stream=new NativeStream({url,allowLoopback:true,token:'t',sessionId:'cold',connectTimeoutMs:2000,onState:s=>states.push(s)});
  const expired=new NativeStream({url,allowLoopback:true,token:'t',sessionId:'late',connectTimeoutMs:100,retryDelays:[5],onState:s=>late.push(s)});
  try{
    const opened=stream.open();await new Promise(r=>setTimeout(r,150));assert.deepEqual(states,['connecting']);
    await opened;assert.deepEqual(states,['connecting','listening']);
    await assert.rejects(expired.open(),/native_connect_timeout|native_connection_unavailable/);assert.equal(late.at(-1),'unavailable');
  }finally{stream.close();expired.close();for(const ws of server.clients)ws.terminate();await new Promise(r=>server.close(r));}
});
test('a cold start that answers 503 for longer than the retry budget still connects before the deadline',async()=>{
  const {createServer}=await import('node:http');let refused=0;const wss=new WebSocketServer({noServer:true});
  // The client resets a refused handshake's socket as soon as it reads the 503; an upgrade socket has no error listener of
  // its own, so without one that reset is an uncaught ECONNRESET on a loaded machine.
  const server=createServer();server.on('upgrade',(request,socket,head)=>{socket.on('error',()=>{});
    if(refused<6){refused++;socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n');return;}
    wss.handleUpgrade(request,socket,head,ws=>ws.on('message',bytes=>{if(JSON.parse(bytes).type==='start')
      ws.send(JSON.stringify({type:'native_ready',engine:'minicpm-native-visual',session_id:'cold'}));}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');const states=[];
  const stream=new NativeStream({url:`ws://127.0.0.1:${server.address().port}`,allowLoopback:true,token:'test',sessionId:'cold',retryDelays:[5,10],onState:s=>states.push(s)});
  try{await stream.open();assert.equal(refused,6,'six refusals against a budget of two retries');assert.equal(stream.ready,true);
    assert.deepEqual(states,['connecting','listening'],'a cold start shows connecting, never reconnecting');assert.equal(stream.retries,0);}
  finally{stream.close();for(const ws of wss.clients)ws.terminate();await new Promise(r=>server.close(r));}
  // The deadline still bounds a GPU that never comes up.
  const dead=createServer();dead.on('upgrade',(request,socket)=>socket.on('error',()=>{}).end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n'));
  dead.listen(0,'127.0.0.1');await once(dead,'listening');
  const never=new NativeStream({url:`ws://127.0.0.1:${dead.address().port}`,allowLoopback:true,token:'test',sessionId:'never',retryDelays:[5,10],connectTimeoutMs:200});
  try{await assert.rejects(never.open(),/native_connect_timeout|unavailable/);}finally{never.close();await new Promise(r=>dead.close(r));}
});
test('the first drop after a long cold start reconnects with the full retry budget',async()=>{
  const {createServer}=await import('node:http');let refused=0,connections=0,done;const wss=new WebSocketServer({noServer:true});const states=[];
  const settled=new Promise(r=>{done=r;});
  const server=createServer();server.on('upgrade',(request,socket,head)=>{socket.on('error',()=>{});
    if(refused<6){refused++;socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n');return;}
    wss.handleUpgrade(request,socket,head,ws=>{connections++;ws.on('message',bytes=>{sendReady(ws,bytes);if(connections===1)ws.close(1012,'session_rotation');});});});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const stream=new NativeStream({url:`ws://127.0.0.1:${server.address().port}`,allowLoopback:true,token:'test',sessionId:'cold-drop',retryDelays:[5,10],
    onState:s=>{states.push(s);if(s==='unavailable'||s==='listening'&&connections===2)done();}});
  try{
    await stream.open();await settled;
    assert.deepEqual(states,['connecting','listening','reconnecting','listening']);assert.equal(stream.ready,true);
  }finally{stream.close();for(const ws of wss.clients)ws.terminate();await new Promise(r=>server.close(r));}
});
