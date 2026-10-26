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
  try{await stream.open();assert.equal(attempts,2);assert.ok(states.includes('reconnecting'));assert.equal(stream.ready,true);}
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
