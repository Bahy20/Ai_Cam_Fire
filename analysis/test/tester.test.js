import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildServer} from '../src/server.js';
import {once} from 'node:events';
import WebSocket from 'ws';
import {encodeFrame} from '../src/protocol.js';

test('hosted tester login scopes upload results, requires same origin, and keeps service secret private',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fire-tester-'));
  const app=await buildServer({token:'private-service-token',testerCode:'share-code',testerOrigin:'https://test.example',dataDir:dir,
    frameReader:{close(){}},scout:{configured:false}});
  const origin={origin:'https://test.example'};
  try{
    const page=await app.inject('/testing');assert.equal(page.statusCode,200);
    assert.ok(page.body.includes('Live webcam'));assert.ok(!page.body.includes('private-service-token'));assert.ok(!page.body.includes('share-code'));
    assert.equal((await app.inject({method:'POST',url:'/testing/login',payload:{code:'share-code'}})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:'/testing/login',headers:origin,payload:{code:'bad'}})).statusCode,401);
    async function login(){const r=await app.inject({method:'POST',url:'/testing/login',headers:origin,payload:{code:'share-code'}});assert.equal(r.statusCode,200);assert.match(r.headers['set-cookie'],/HttpOnly/);assert.match(r.headers['set-cookie'],/Secure/);return r.headers['set-cookie'].split(';')[0];}
    const cookie=await login(),other=await login();
    const session=(await app.inject({url:'/testing/session',headers:{cookie}})).json();
    app.fireguard.store.job('owned',{status:'complete',tester_id:session.id,result:{priority:{level:'monitor'}}});
    assert.equal((await app.inject({url:'/v1/videos/owned',headers:{cookie}})).statusCode,200);
    assert.equal((await app.inject({url:'/v1/videos/owned',headers:{cookie:other}})).statusCode,404);
    assert.equal((await app.inject({url:'/v1/videos/owned',headers:{cookie:cookie+'tampered'}})).statusCode,401);
    assert.equal((await app.inject({method:'POST',url:'/v1/videos',headers:{cookie,origin:'https://evil.example'}})).statusCode,403);
    assert.equal((await app.inject({url:'/v1/videos/owned',headers:{authorization:'Bearer private-service-token'}})).statusCode,200);
  }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});

test('tester webcam uses same-origin cookie and isolated camera identity',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fire-tester-ws-'));
  const app=await buildServer({token:'service',testerCode:'code',testerOrigin:'https://test.example',dataDir:dir,
    frameReader:{infer:async()=>({frame_wh:[640,480],visibility:'unknown',detections:[]}),close(){}},scout:{configured:false}});
  let socket;
  try{
    const login=await app.inject({method:'POST',url:'/testing/login',headers:{origin:'https://test.example'},payload:{code:'code'}});
    const cookie=login.headers['set-cookie'].split(';')[0];
    await app.listen({host:'127.0.0.1',port:0});
    const url=`ws://127.0.0.1:${app.server.address().port}/v1/live`;
    const blocked=new WebSocket(url,{headers:{cookie,origin:'https://evil.example'}});
    const denied=await new Promise(resolve=>{blocked.on('unexpected-response',(req,res)=>{resolve(res.statusCode);res.resume();blocked.terminate();});blocked.on('error',()=>{});});
    assert.equal(denied,403);
    socket=new WebSocket(url,{headers:{cookie,origin:'https://test.example'}});await once(socket,'open');
    let message=once(socket,'message');socket.send(JSON.stringify({type:'start',camera_id:'someone-elses-camera',session_id:'browser'}));
    assert.equal(JSON.parse((await message)[0]).type,'ready');
    message=once(socket,'message');socket.send(encodeFrame({session_id:'browser',sequence:1,ts_ms:Date.now()},Buffer.from([255,216,255,217])));
    const result=JSON.parse((await message)[0]);assert.match(result.camera_id,/^tester-/);assert.equal(result.detection.fire,'unknown');
  }finally{if(socket){socket.close();await once(socket,'close');}await app.close();await rm(dir,{recursive:true,force:true});}
});
