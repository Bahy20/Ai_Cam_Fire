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

// Several tester-enabled servers, each with its own data directory, closed together.
async function testerServers(...configs){
  const dirs=[],apps=[];
  for(const options of configs){const dir=await mkdtemp(join(tmpdir(),'fire-tester-'));dirs.push(dir);
    apps.push(await buildServer({token:'service',testerCode:'code',testerOrigin:'https://test.example',dataDir:dir,frameReader:{close(){}},scout:{configured:false},...options}));}
  return {apps,close:async()=>{for(const app of apps)await app.close();for(const dir of dirs)await rm(dir,{recursive:true,force:true});}};
}
const login=(app,{code='wrong',ip='10.0.0.1',origin='https://test.example',headers={}}={})=>
  app.inject({method:'POST',url:'/testing/login',remoteAddress:ip,headers:{origin,...headers},payload:{code}});

test('tester cookies are signed with the cookie secret, which is not a service credential',async()=>{
  const {apps:[a,b,c],close}=await testerServers({token:'one',cookieSecret:'jar'},{token:'two',cookieSecret:'jar'},{token:'one'});
  try{
    const cookie=(await login(a,{code:'code'})).headers['set-cookie'].split(';')[0];
    assert.equal((await b.inject({url:'/testing/session',headers:{cookie}})).statusCode,200,'same cookie secret, different service token');
    assert.equal((await c.inject({url:'/testing/session',headers:{cookie}})).statusCode,401,'the service token alone cannot verify it');
    assert.equal((await a.inject({url:'/v1/videos/x',headers:{authorization:'Bearer jar'}})).statusCode,401,'the cookie secret is not a bearer');
    const legacy=(await login(c,{code:'code'})).headers['set-cookie'].split(';')[0];
    assert.equal((await c.inject({url:'/testing/session',headers:{cookie:legacy}})).statusCode,200,'without a cookie secret the service token signs');
  }finally{await close();}
});

test('a tester origin setting with a trailing slash or path still matches the browser Origin',async()=>{
  const {apps:[slash,path],close}=await testerServers({testerOrigin:'https://x.example/'},{testerOrigin:'https://x.example/app/'});
  try{
    for(const app of [slash,path]){
      assert.match((await app.inject('/testing')).headers['content-security-policy'],/connect-src 'self' wss:\/\/x\.example;/);
      assert.equal((await login(app,{code:'code',origin:'https://x.example'})).statusCode,200);
      assert.equal((await login(app,{code:'code',origin:'https://x.example/'})).statusCode,403);
      assert.equal((await login(app,{code:'code',origin:'https://evil.example'})).statusCode,403);
    }
  }finally{await close();}
});

test('tester login lockout is per client, behind a global ceiling, and expires after a minute',async()=>{
  let clock=1000000;const {apps:[app,proxied],close}=await testerServers({now:()=>clock},{now:()=>clock,trustProxy:true});
  try{
    // Without trustProxy, X-Forwarded-For cannot dodge the per-client limit.
    for(let i=0;i<20;i++)assert.equal((await login(app,{headers:{'x-forwarded-for':`198.51.100.${i}`}})).statusCode,401);
    assert.equal((await login(app)).statusCode,429);assert.equal((await login(app,{code:'code'})).statusCode,429,'a locked-out client cannot sign in');
    assert.equal((await login(app,{ip:'10.0.0.2'})).statusCode,401,'another client is not locked out');
    assert.equal((await login(app,{ip:'10.0.0.2',code:'code'})).statusCode,200);
    for(let i=0;i<179;i++)assert.equal((await login(app,{ip:`10.1.${i%10}.1`})).statusCode,401);
    assert.equal((await login(app,{ip:'10.2.0.1',code:'code'})).statusCode,429,'200 failures a minute stop every client');
    clock+=60000;
    assert.equal((await login(app,{code:'code'})).statusCode,200,'the lockout expires');
    assert.equal((await login(app,{ip:'10.2.0.1'})).statusCode,401);
    // With trustProxy, clients behind one proxy address are told apart by the last X-Forwarded-For entry, which the
    // proxy appends; a spoofed earlier entry does not dodge the limit.
    const via=(client,spoof)=>({ip:'10.0.0.9',headers:{'x-forwarded-for':spoof?`${spoof}, ${client}`:client}});
    for(let i=0;i<20;i++)assert.equal((await login(proxied,via('203.0.113.1',`198.51.100.${i}`))).statusCode,401);
    assert.equal((await login(proxied,via('203.0.113.1'))).statusCode,429);
    assert.equal((await login(proxied,{...via('203.0.113.1','198.51.100.99'),code:'code'})).statusCode,429,'a spoofed first entry is ignored');
    assert.equal((await login(proxied,{...via('203.0.113.2'),code:'code'})).statusCode,200,'a different forwarded client is not locked out');
    assert.equal((await login(proxied,{ip:'10.0.0.9',code:'code'})).statusCode,200,'no header falls back to the socket address');
  }finally{await close();}
});
// A lighter flame at its tip: a lighter allowance or a hazard setting changes its priority, so it shows which policy applied.
const lighter=ts=>({frame_id:`frame-${ts}`,flame:'present',smoke:'not_observed',burning_material:'not_observed',lighter:'present',
  flame_relation:'at_tool_tip',occlusion:'not_observed',description:'A lighter flame at its tip.'});
const lighterScene={
  frameReader:(()=>{let ts=0;return {infer:async()=>({frame_wh:[640,480],visibility:'unknown'}),open:async()=>{ts=0;return {duration_s:4,frames:5};},
    next:async()=>ts<=4000?{ts_ms:(ts+=1000)-1000,image_b64:'AQI='}:{eof:true,decoded_frames:5},closeVideo:async()=>{},close(){}};})(),
  scout:{configured:true,analyze:async frames=>({mode:'fresh',assessment:{frames:frames.map(f=>lighter(f.ts_ms))}})},
  nativeStreamFactory:({sessionId,onState,onResult})=>({open:async()=>onState('listening'),close(){},push:f=>onResult({session_id:sessionId,
    engine:'minicpm-native-visual',native_chunks:1,source_ts_ms:f.ts_ms,assessment_source_ts_ms:f.ts_ms,text:'lighter',assessment:lighter(f.ts_ms)},f)})};
// Priority reason of the first native report in a live session, opened with a tester cookie or the service bearer.
async function livePolicy(app,headers){
  const ws=new WebSocket(`ws://127.0.0.1:${app.server.address().port}/v1/live`,{headers});await once(ws,'open');const messages=[];
  ws.on('message',raw=>messages.push(JSON.parse(raw)));ws.send(JSON.stringify({type:'start',camera_id:'test-camera',session_id:'policy'}));
  const until=async check=>{for(let i=0;i<400&&!messages.some(check);i++)await new Promise(r=>setTimeout(r,5));return messages.find(check);};
  await until(x=>x.type==='ready');ws.send(encodeFrame({session_id:'policy',sequence:1,ts_ms:Date.now()},Buffer.from([255,216,255,217])));
  const result=await until(x=>x.trigger==='native_result');ws.close();await once(ws,'close');
  for(let i=0;i<100&&(await app.inject('/health')).json().live_active;i++)await new Promise(r=>setTimeout(r,10));
  return result?.priority.reason;
}
async function uploadPolicy(app,cookie){
  const payload=Buffer.from('--b\r\nContent-Disposition: form-data; name="video"; filename="a.mp4"\r\n\r\n\0\0\0\x18ftypisom\r\n--b--\r\n','latin1');
  const r=await app.inject({method:'POST',url:'/v1/videos',headers:{cookie,origin:'https://test.example','content-type':'multipart/form-data; boundary=b'},payload});
  assert.equal(r.statusCode,202,r.body);await app.fireguard.waitForJobs();
  return (await app.inject({url:`/v1/videos/${r.json().id}`,headers:{cookie}})).json().result.priority.reason;
}
test('testers have their own policy id: a lighter is low priority for everyone unless cameras are listed',async()=>{
  const cases=[[{},'lighter_evidence_pending','contained_lighter'],
    [{expectedCameraIds:['test-camera'],hazardCameraIds:['test-camera']},'uncontained_flame','uncontained_flame'],
    [{expectedCameraIds:['tester']},'lighter_evidence_pending','contained_lighter'],
    [{hazardCameraIds:['tester']},'reviewed_site_hazard','reviewed_site_hazard']];
  const {apps,close}=await testerServers(...cases.map(([policy])=>({...lighterScene,...policy,sleep:async()=>{}})));
  try{
    for(const [i,app] of apps.entries()){
      const [policy,live,upload]=cases[i],label=JSON.stringify(policy);await app.listen({host:'127.0.0.1',port:0});
      const cookie=(await login(app,{code:'code'})).headers['set-cookie'].split(';')[0];
      assert.equal(await livePolicy(app,{cookie,origin:'https://test.example'}),live,`tester live ${label}`);
      assert.equal(await uploadPolicy(app,cookie),upload,`tester upload ${label}`);
    }
    assert.equal(await livePolicy(apps[1],{authorization:'Bearer service'}),'reviewed_site_hazard','the operator test-camera keeps its own policy');
  }finally{await close();}
});
