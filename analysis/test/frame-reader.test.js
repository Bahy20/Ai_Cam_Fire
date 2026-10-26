import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter,once } from 'node:events';
import { spawn,execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { FrameReader,childEnv } from '../src/frame-reader.js';

const ready={ready:true,mode:'pixel_quality_only'};
const jpeg=python=>execFileSync(python,['-c',"import io,base64,sys;from PIL import Image;b=io.BytesIO();Image.new('RGB',(64,48),(90,120,150)).save(b,'JPEG');sys.stdout.write(base64.b64encode(b.getvalue()).decode())"]).toString();
const counting=(overrides={})=>{const spawned=[];return {spawned,spawn:(cmd,args,opts)=>{const child=(overrides[spawned.length+1]??spawn)(cmd,args,opts);spawned.push(child);return child;}};};
// Stub workers. Only these ever run under a short timeoutMs; the real Python child keeps the 60 s default, so a cold start
// on a loaded machine cannot fail a test. Timing is read from reader.spawnedAt, which is stamped just before each spawn.
const silent=(cmd,args,opts)=>spawn(process.execPath,['-e','process.stdin.resume()'],opts);
const crashing=(cmd,args,opts)=>spawn(process.execPath,['-e','process.exit(3)'],opts);
// In-process worker that answers every request at once: no process start can race its timeout.
const answering=()=>{const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),killed:false,
  kill(){if(!child.killed){child.killed=true;setImmediate(()=>child.emit('exit',null,'SIGTERM'));}return true;}});
  createInterface({input:child.stdin}).on('line',line=>child.stdout.write(JSON.stringify({id:JSON.parse(line).id,result:ready})+'\n'));return child;};

test('a killed worker is replaced on the next request after the restart backoff',async()=>{
  const {spawned,spawn:spawnChild}=counting(),reader=new FrameReader({spawn:spawnChild}),firstAt=reader.spawnedAt;
  try{
    assert.deepEqual(await reader.warmup(),ready);const first=reader.child,image_b64=jpeg(reader.python);
    first.kill();await once(first,'exit');assert.equal(reader.closed,false,'a dead worker is not a closed reader');
    assert.equal(reader.lastFailure.code,'frame_reader_exited');assert.equal(reader.restarts,0,'no respawn until a request needs one');
    const observation=await reader.infer(image_b64);
    assert.deepEqual(observation.frame_wh,[64,48]);assert.ok(observation.visibility);
    assert.equal(spawned.length,2);assert.equal(reader.restarts,1);assert.notEqual(reader.child,first);assert.notEqual(reader.child.pid,first.pid);
    // 10 ms of slack covers timer rounding; a slow first warmup only lengthens the gap.
    const gap=reader.spawnedAt-firstAt;assert.ok(gap>=990,`respawn waited out the 1000 ms backoff (${gap} ms)`);
    assert.deepEqual(await reader.warmup(),ready,'the replacement keeps serving');assert.equal(spawned.length,2);
  }finally{reader.close();for(const child of spawned)child.kill();}
});

test('a stale exit from the replaced worker cannot fail requests on its successor',async()=>{
  const {spawned,spawn:spawnChild}=counting(),reader=new FrameReader({spawn:spawnChild,restartDelayMs:0});
  try{
    assert.deepEqual(await reader.warmup(),ready);const first=reader.child,exited=once(first,'exit');
    first.kill();const pending=reader.warmup();assert.equal(spawned.length,2,'respawned before the old exit arrived');
    await exited;assert.deepEqual(await pending,ready);assert.equal(reader.child,spawned[1]);assert.equal(reader.restarts,1);
  }finally{reader.close();for(const child of spawned)child.kill();}
});

test('a timeout kills only the stalled worker and the next request runs on a fresh one',async()=>{
  const {spawned,spawn:spawnChild}=counting({1:silent,2:answering}),reader=new FrameReader({spawn:spawnChild,timeoutMs:200,restartDelayMs:0});
  try{
    const stalled=reader.child,exited=once(stalled,'exit');
    const results=await Promise.allSettled([reader.warmup(),reader.next()]);
    assert.deepEqual(results.map(r=>r.reason?.message),['frame_reader_timeout','frame_reader_timeout']);
    await exited;assert.equal(reader.closed,false);assert.equal(reader.lastFailure.code,'frame_reader_timeout','the stale exit is not recorded');
    assert.deepEqual(await reader.warmup(),ready);assert.equal(spawned.length,2);assert.notEqual(reader.child,stalled);assert.equal(reader.restarts,1);
  }finally{reader.close();for(const child of spawned)child.kill();}
});

test('requests arriving inside the backoff window wait for the delayed respawn',async()=>{
  const {spawned,spawn:spawnChild}=counting({1:silent,2:answering}),reader=new FrameReader({spawn:spawnChild,timeoutMs:50,restartDelayMs:500}),firstAt=reader.spawnedAt;
  try{
    await assert.rejects(reader.warmup(),{message:'frame_reader_timeout'});
    const pending=reader.warmup();assert.equal(spawned.length,1,'no spawn inside the backoff window');
    assert.deepEqual(await pending,ready);assert.equal(spawned.length,2);
    const gap=reader.spawnedAt-firstAt;assert.ok(gap>=490,`respawned ${gap} ms after the first spawn`);
  }finally{reader.close();for(const child of spawned)child.kill();}
});

test('after close() requests are refused and no worker is spawned',async()=>{
  const {spawned,spawn:spawnChild}=counting(),reader=new FrameReader({spawn:spawnChild,restartDelayMs:60000});
  assert.deepEqual(await reader.warmup(),ready);const first=reader.child;
  first.kill();await once(first,'exit');const queued=reader.warmup();
  reader.close();assert.equal(reader.closed,true);
  await assert.rejects(queued,{message:'frame_reader_closed'});
  await assert.rejects(reader.warmup(),{message:'frame_reader_unavailable'});
  await assert.rejects(reader.infer('AQI='),{message:'frame_reader_unavailable'});
  await delay(50);assert.equal(spawned.length,1);assert.equal(reader.child,null);
  assert.equal(reader.lastFailure.code,'frame_reader_exited','close() is not recorded as a failure');assert.equal(reader.restarts,0);
});

test('a crash loop counts every restart and keeps the last failure while the reader stays open',async()=>{
  const started=Date.now(),{spawned,spawn:spawnChild}=counting({1:crashing,2:crashing,3:crashing,4:answering});
  const reader=new FrameReader({spawn:spawnChild,restartDelayMs:0});
  try{
    assert.equal(reader.restarts,0);assert.equal(reader.lastFailure,null);await once(reader.child,'exit');
    const first=reader.lastFailure;assert.equal(first.code,'frame_reader_exited');assert.ok(first.at_ms>=started&&first.at_ms<=Date.now());
    for(const restarts of [1,2]){
      await assert.rejects(reader.warmup(),{message:/^frame_reader_(exited|pipe_failed)$/});
      assert.equal(reader.restarts,restarts);assert.equal(reader.closed,false,'a crash loop is not a closed reader');
    }
    assert.ok(reader.lastFailure.at_ms>=first.at_ms);
    assert.deepEqual(await reader.warmup(),ready);assert.equal(reader.restarts,3);assert.equal(spawned.length,4);
    assert.match(reader.lastFailure.code,/^frame_reader_(exited|pipe_failed)$/,'recovery keeps the last failure');
  }finally{reader.close();for(const child of spawned)child.kill();}
  const broken=new FrameReader({spawn:()=>{throw new Error('spawn EINVAL');},restartDelayMs:0});
  try{
    assert.equal(broken.lastFailure.code,'frame_reader_start_failed');assert.equal(broken.restarts,0);
    await assert.rejects(broken.warmup(),{message:'frame_reader_start_failed'});assert.equal(broken.restarts,1);assert.equal(broken.closed,false);
  }finally{broken.close();}
});

test('the Python worker environment keeps interpreter variables and drops every credential',async()=>{
  const env={PATH:'/usr/bin',Path:'C:\\Windows',SystemRoot:'C:\\Windows',HOME:'/home/u',LANG:'C.UTF-8',PYTHONPATH:'/app',OMP_NUM_THREADS:'2',TEMP:undefined,
    FIREGUARD_TOKEN:'t',FIREGUARD_NATIVE_TOKEN:'n',FIREGUARD_COOKIE_SECRET:'c',TESTER_ACCESS_CODE:'code',CLOUDFLARE_API_TOKEN:'cf',
    MODAL_TOKEN_SECRET:'m',AWS_ACCESS_KEY_ID:'k',DB_PASSWORD:'p',MINICPM_NATIVE_URL:'wss://gpu.example',TESTER_PUBLIC_ORIGIN:'https://x.example'};
  assert.deepEqual(childEnv(env),{PATH:'/usr/bin',Path:'C:\\Windows',SystemRoot:'C:\\Windows',HOME:'/home/u',LANG:'C.UTF-8',PYTHONPATH:'/app',OMP_NUM_THREADS:'2'});
  const names=['FIREGUARD_TOKEN','TESTER_ACCESS_CODE'],saved=names.map(name=>process.env[name]);
  for(const name of names)process.env[name]='must-not-leak';
  // A worker that reports what it inherited, so the check covers the spawned child itself.
  const report="require('readline').createInterface({input:process.stdin}).on('line',l=>process.stdout.write(JSON.stringify({id:JSON.parse(l).id,"+
    "result:{token:process.env.FIREGUARD_TOKEN??null,code:process.env.TESTER_ACCESS_CODE??null,path:process.env.PATH??null}})+'\\n'))";
  const reader=new FrameReader({spawn:(cmd,args,opts)=>spawn(process.execPath,['-e',report],opts)});
  try{
    assert.ok(childEnv().PATH);assert.equal(childEnv().FIREGUARD_TOKEN,undefined);
    assert.deepEqual(await reader.warmup(),{token:null,code:null,path:process.env.PATH});
  }finally{reader.close();names.forEach((name,i)=>{if(saved[i]===undefined)delete process.env[name];else process.env[name]=saved[i];});}
});
