import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CameraDO } from '../src/camera-do.js';
import worker from '../src/index.js';

function backend() {
  const db=new DatabaseSync(':memory:');let alarm=null,active;
  const storage={sql:{exec(sql,...args) {
    const stmt=db.prepare(sql);const rows=stmt.columns().length?stmt.all(...args):(stmt.run(...args),[]);
    return {toArray:()=>rows};
  }},transactionSync(fn) {db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}
    catch(error){db.exec('ROLLBACK');throw error;}},getAlarm:async()=>alarm,setAlarm:async value=>{alarm=value;},sync:async()=>{}};
  const env={APP_ENV:'development',EVIDENCE_STORAGE:'pi',CAMERA_DO:{idFromName:id=>id,get:()=>({fetch:req=>active.fetch(req)})}};
  const restart=()=>active=new CameraDO({storage,getWebSockets:()=>[],waitUntil:()=>{}},env);
  restart();
  const request=(route,body)=>worker.fetch(new Request('https://worker'+route,{method:body===undefined?'GET':'POST',
    headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env,{});
  return {db,storage,env,restart,request,camera:()=>active,alarm:()=>alarm};
}

test('an outbox alarm is not created or moved when no durable work is pending',async t=>{
  let now=1700000000000;t.mock.method(Date,'now',()=>now);const store=backend();
  try {
    await store.camera().armOutboxRetry();assert.equal(store.alarm(),null);
    now+=1000;await store.camera().armOutboxRetry();assert.equal(store.alarm(),null);
  } finally {store.db.close();}
});

test('public heartbeat receipt survives restart and the shared alarm persists exactly one offline transition',async t=>{
  let now=1700000000000;t.mock.method(Date,'now',()=>now);const store=backend();
  const heartbeat={camera_id:'cam',heartbeat_id:'12345678-1234-4234-8234-123456789abc',sent_at_ms:now,status:'ok'};
  try {
    const sent=await store.request('/heartbeat/camera/cam',heartbeat);assert.equal(sent.status,200);
    assert.equal((await sent.json()).health.status,'online');
    const initial=await(await store.request('/health/camera/cam')).json();
    assert.equal(initial.last_seen_ms,now);assert.equal(store.alarm(),now+60000);
    now+=10000;store.restart();
    assert.equal((await(await store.request('/health/camera/cam')).json()).last_seen_ms,initial.last_seen_ms);
    assert.equal((await(await store.request('/heartbeat/camera/cam',heartbeat)).json()).accepted,false);
    now+=50001;await store.camera().alarm();await store.camera().alarm();
    const health=await(await store.request('/health/camera/cam')).json();assert.equal(health.status,'offline');
    const history=await(await store.request('/health-events/camera/cam')).json();
    assert.deepEqual(history.events.map(event=>event.status),['offline','online']);
    assert.equal(store.camera().lastObservationTs,null,'device heartbeats never become camera/fire evidence');
    assert.equal(store.camera().alert,'idle');assert.equal(store.camera().cause,null);
  } finally {store.db.close();}
});
