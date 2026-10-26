import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,writeFile,readFile,mkdir} from 'node:fs/promises';
import fs,{existsSync,statSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store,EVENT_RETENTION_MS} from '../src/store.js';
import {VlmCoordinator} from '../src/vlm-coordinator.js';

const live=(level='monitor',extra={})=>({mode:'live',priority:{level,reason:'scene_clear'},
  detection:{state:'idle',fire:'not_detected',smoke:'not_detected'},incident_id:null,
  incident_history:{model_hazard:false,clear_evidence_current:false},view:{status:'available_for_analysis'},
  native_stream:{state:'streaming',startup_elapsed_ms:0},...extra});
const jpeg=(ts,bytes=20)=>({ts_ms:ts,frame_id:`frame-${ts}`,image_b64:Buffer.alloc(bytes,ts%256).toString('base64')});
// Windows lists nested entries with backslashes; compare with forward slashes on every platform.
const files=async dir=>existsSync(dir)?(await readdir(dir,{recursive:true})).map(p=>p.replaceAll('\\','/')).sort():[];

test('periodic live publishes insert events only on significant changes and heartbeats',()=>{
  let clock=1000000;const store=new Store(':memory:',{now:()=>clock});
  try {
    store.start('live','cam','live');
    for(let i=0;i<100;i++){clock+=100;store.save('live',live('monitor',{emitted_at_ms:clock}),'active',i%2?'tick':'frame');}
    assert.equal(store.timeline('live').length,1);
    // The sessions row still holds the latest result.
    assert.equal(JSON.parse(store.db.prepare('SELECT result FROM sessions WHERE id=?').get('live').result).emitted_at_ms,clock);
    clock+=100;store.save('live',live('inspect_urgently'),'active','tick');
    clock+=100;store.save('live',live('inspect_urgently'),'active','native_result');
    assert.deepEqual(store.timeline('live').map(e=>e.priority.level),['monitor','inspect_urgently']);
    clock+=29000;store.save('live',live('inspect_urgently'),'active','native_state');
    assert.equal(store.timeline('live').length,2);
    clock+=2000;store.save('live',live('inspect_urgently'),'active','tick'); // >30 s since the last event
    assert.equal(store.timeline('live').length,3);
    store.save('live',live('inspect_urgently'),'active','assessment'); // non-periodic triggers always record
    store.save('live',live('inspect_urgently'),'disconnected','disconnect');
    assert.equal(store.timeline('live').length,5);
    store.start('upload','cam','recorded');
    for(let i=0;i<10;i++){clock+=100;store.save('upload',{...live(),mode:'recorded'},'active',i%2?'tick':'frame');}
    assert.equal(store.timeline('upload').length,10);
    // Callers without a trigger (legacy coordinator, tests) keep one event per save.
    store.start('legacy','cam','live');store.save('legacy',live());store.save('legacy',live());
    assert.equal(store.timeline('legacy').length,2);
  } finally {store.close();}
});

test('the live coordinator passes its trigger so steady frames and ticks share one event',()=>{
  let clock=100000;const store=new Store(':memory:',{now:()=>clock});
  const c=new VlmCoordinator({cameraId:'cam',sessionId:'steady',store,streaming:true,now:()=>clock});
  try {
    for(let i=0;i<100;i++){clock+=200;c.accept({ts_ms:clock,frame_wh:[640,480],visibility:'unknown',camera_motion:null,image_b64:'AQI='});c.tick();}
    assert.equal(store.timeline('steady').length,1);
    for(let i=0;i<10;i++){clock+=200;c.accept({ts_ms:clock,frame_wh:[640,480],visibility:'degraded',camera_motion:null,image_b64:'AQI='});}
    assert.equal(store.timeline('steady').length,2); // a dark view re-publishes a gap per frame
    c.disconnect();
    assert.equal(store.timeline('steady').at(-1).view.status,'unavailable');assert.equal(store.timeline('steady').length,3);
  } finally {store.close();}
});

test('each distinct gap reason in one unavailable stretch records its own event',()=>{
  let clock=1000;const store=new Store(':memory:',{now:()=>clock});
  try {
    store.start('dark','cam','live');
    const gap=reason=>live('unknown',{view:{status:'unavailable',reason}});
    for(const reason of ['observation_gap','observation_gap','view_degraded_or_moving','view_degraded_or_moving','invalid_frame','invalid_frame'])
      {clock+=100;store.save('dark',gap(reason),'active','gap');}
    assert.deepEqual(store.timeline('dark').map(e=>e.view.reason),['observation_gap','view_degraded_or_moving','invalid_frame']);
  } finally {store.close();}
});

test('prune deletes through the timestamp indexes, not by walking event_session',()=>{
  const store=new Store(':memory:');
  try {
    store.start('live','cam','live');for(let i=0;i<50;i++){store.save('live',live());store.inference('live',{n:i});}
    const sql=[],prepare=store.db.prepare.bind(store.db);store.db.prepare=text=>{sql.push(text);return prepare(text);};
    store.prune();
    const plans=sql.filter(text=>text.startsWith('DELETE')).map(text=>prepare(`EXPLAIN QUERY PLAN ${text}`).all(0).map(row=>row.detail).join('; '));
    assert.equal(plans.length,2);
    assert.match(plans[0],/SEARCH events USING (COVERING )?INDEX event_ts \(ts<\?\)/);assert.doesNotMatch(plans[0],/event_session/);
    assert.match(plans[1],/SEARCH inferences USING (COVERING )?INDEX inference_ts \(ts<\?\)/);
  } finally {store.close();}
});

test('a startup prune that leaves a large freelist vacuums once into incremental mode; later prunes return pages',async()=>{
  const root=await mkdtemp(join(tmpdir(),'fireguard-vacuum-'));let clock=1000000,store;
  const pragma=name=>Object.values(store.db.prepare(`PRAGMA ${name}`).get())[0];
  const fill=()=>{for(let i=0;i<200;i++)store.save('live',live('monitor',{pad:'x'.repeat(4000),n:i}));};
  try {
    const path=join(root,'fireguard.sqlite');
    store=new Store(path,{now:()=>clock});store.start('live','cam','live');fill();store.close();
    clock+=EVENT_RETENTION_MS+1;store=new Store(path,{now:()=>clock});
    assert.equal(pragma('auto_vacuum'),0,'below the 64 MiB default the file is not rewritten');assert.ok(pragma('freelist_count')>200);
    store.close();const bloated=statSync(path).size;
    store=new Store(path,{now:()=>clock,vacuumThreshold:256*1024});
    assert.equal(pragma('auto_vacuum'),2);assert.equal(pragma('freelist_count'),0);assert.ok(statSync(path).size<bloated/4);
    assert.equal(store.timeline('live').length,0);assert.ok(store.previous('cam'));
    fill();clock+=EVENT_RETENTION_MS+1;assert.equal(store.prune().events,200);assert.equal(pragma('freelist_count'),0);
  } finally {store?.close();await rm(root,{recursive:true,force:true});}
});

test('prune drops old live events and inferences but keeps recorded history, sessions and reviews',async()=>{
  const root=await mkdtemp(join(tmpdir(),'fireguard-prune-'));let clock=1000000,store,reopened;
  try {
    const path=join(root,'fireguard.sqlite');store=new Store(path,{now:()=>clock});
    store.start('live','cam','live');store.start('upload','cam','recorded');
    store.save('live',live());store.inference('live',{n:1});store.review('live',{action:'false_alarm'});
    store.save('upload',{...live(),mode:'recorded'});store.inference('upload',{n:2});
    clock+=EVENT_RETENTION_MS+1;store.save('live',live('inspect_urgently'));store.inference('live',{n:3});
    assert.deepEqual(store.prune(),{events:1,inferences:1});
    assert.deepEqual(store.timeline('live').map(e=>e.priority.level),['inspect_urgently']);
    assert.deepEqual(store.inferences('live'),[{n:3}]);
    assert.equal(store.timeline('upload').length,1);assert.deepEqual(store.inferences('upload'),[{n:2}]);
    assert.equal(store.reviews('live').length,1);assert.ok(store.previous('cam'));
    assert.deepEqual(store.prune({maxAgeMs:0}),{events:0,inferences:0}); // ts<now only
    store.close();store=null;
    clock+=EVENT_RETENTION_MS+1;reopened=new Store(path,{now:()=>clock}); // the constructor prunes once
    assert.equal(reopened.timeline('live').length,0);assert.equal(reopened.inferences('live').length,0);
    assert.equal(reopened.timeline('upload').length,1);assert.equal(reopened.reviews('live').length,1);
  } finally {store?.close();reopened?.close();await rm(root,{recursive:true,force:true});}
});

test('evidence over the cap evicts oldest non-hazard frames first and keeps hazard sessions',async()=>{
  const root=await mkdtemp(join(tmpdir(),'fireguard-evict-'));let store,reopened;
  try {
    const path=join(root,'fireguard.sqlite'),evidence=join(root,'evidence');
    store=new Store(path,{evidenceLimit:100});
    for(const [id,hazard] of [['hazard',true],['calm',false],['current',false]]){
      store.start(id,'cam','live');store.save(id,live('monitor',{incident_history:{model_hazard:hazard}}));
    }
    assert.deepEqual(store.archive('hazard',[jpeg(1),jpeg(2)]),{retained:true,frame_ids:['frame-1','frame-2']});
    store.archive('calm',[jpeg(3),jpeg(4)]);store.archive('current',[jpeg(5)]);
    assert.equal(store.evidenceBytes,100); // exactly at the cap is allowed
    assert.deepEqual(store.archive('current',[jpeg(6)]),{retained:true,frame_ids:['frame-6']});
    assert.ok(!existsSync(join(evidence,'calm','frame-3.jpg')));assert.ok(existsSync(join(evidence,'calm','frame-4.jpg')));
    store.archive('current',[jpeg(7)]);
    assert.ok(!existsSync(join(evidence,'calm')),'emptied session folder is removed');
    store.archive('current',[jpeg(8)]); // the writer's own oldest non-hazard frame goes before hazard evidence
    assert.deepEqual(await files(evidence),['current','current/frame-6.jpg','current/frame-7.jpg','current/frame-8.jpg',
      'hazard','hazard/frame-1.jpg','hazard/frame-2.jpg']);
    assert.equal(store.evidenceBytes,100);
    // Once only hazard evidence remains, the oldest frames of other sessions go; the writer's own never do.
    store.save('current',live('inspect_urgently',{incident_history:{model_hazard:true}}));
    assert.deepEqual(store.archive('current',[jpeg(9),jpeg(10)]),{retained:true,frame_ids:['frame-9','frame-10']});
    assert.deepEqual(await files(join(evidence,'hazard')),[]);assert.ok(!existsSync(join(evidence,'hazard')));
    assert.equal(store.evidenceBytes,100);
    // With only the writer's own hazard evidence left, nothing is deleted and the new frame is refused.
    assert.deepEqual(store.archive('current',[jpeg(6),jpeg(11)]),{retained:false,reason:'evidence_storage_limit',frame_ids:['frame-6']});
    assert.deepEqual(store.archive('current',[jpeg(12,101)]),{retained:false,reason:'evidence_storage_limit',frame_ids:[]});
    assert.equal((await files(join(evidence,'current'))).length,5);
    store.close();store=null;
    reopened=new Store(path,{evidenceLimit:100});assert.equal(reopened.evidenceBytes,100); // index rebuilt from disk
    reopened.start('other','cam','live');
    assert.equal(reopened.archive('other',[jpeg(13)]).reason,'evidence_storage_limit','a routine writer cannot evict hazard evidence');
    reopened.save('other',live('inspect_urgently',{incident_history:{model_hazard:true}}));
    assert.equal(reopened.archive('other',[jpeg(13)]).retained,true);
    assert.ok(!existsSync(join(evidence,'current','frame-6.jpg')),'oldest file evicted after restart');
    assert.equal(reopened.evidenceBytes,100);
  } finally {store?.close();reopened?.close();await rm(root,{recursive:true,force:true});}
});

test('frames named in one archive call are never evicted to make room for each other',async()=>{
  const root=await mkdtemp(join(tmpdir(),'fireguard-keep-'));let store;
  try {
    store=new Store(join(root,'fireguard.sqlite'),{evidenceLimit:40});store.start('solo','cam','live');
    store.archive('solo',[jpeg(1),jpeg(2)]);
    assert.deepEqual(store.archive('solo',[jpeg(1),jpeg(3)]),{retained:true,frame_ids:['frame-1','frame-3']});
    assert.deepEqual(await files(join(root,'evidence','solo')),['frame-1.jpg','frame-3.jpg']);
    assert.deepEqual(store.archive('solo',[jpeg(1),jpeg(3),jpeg(4)]),{retained:false,reason:'evidence_storage_limit',frame_ids:['frame-1','frame-3']});
    assert.deepEqual(await files(join(root,'evidence','solo')),['frame-1.jpg','frame-3.jpg']);assert.equal(store.evidenceBytes,40);
  } finally {store?.close();await rm(root,{recursive:true,force:true});}
});

test('archive writes atomically and a restart discards interrupted temporary files',async()=>{
  const root=await mkdtemp(join(tmpdir(),'fireguard-atomic-'));let store,reopened;
  try {
    const path=join(root,'fireguard.sqlite'),folder=join(root,'evidence','s');
    store=new Store(path);store.start('s','cam','live');
    assert.equal(store.archive('s',[jpeg(1,7),jpeg(2,9)]).retained,true);
    assert.deepEqual(await files(folder),['frame-1.jpg','frame-2.jpg']);
    assert.deepEqual(await readFile(join(folder,'frame-2.jpg')),Buffer.alloc(9,2));
    store.close();store=null;
    await writeFile(join(folder,'frame-3.jpg.tmp'),Buffer.alloc(50));
    reopened=new Store(path);
    assert.equal(reopened.evidenceBytes,16);assert.deepEqual(await files(folder),['frame-1.jpg','frame-2.jpg']);
  } finally {store?.close();reopened?.close();await rm(root,{recursive:true,force:true});}
});

test('hazard, latest-hazard and reviewed evidence outlives routine writers; only a protected writer evicts it',async()=>{
  const root=await mkdtemp(join(tmpdir(),'fireguard-protect-'));let store;
  try {
    const evidence=join(root,'evidence');store=new Store(join(root,'fireguard.sqlite'),{evidenceLimit:100});
    const review={incident_id:'i1',action:'false_alarm',actor:'service',reviewed_at_ms:1,last_hazard:null};
    for(const [id,history] of [['hazard',{model_hazard:true}],['reviewed',{model_hazard:false,last_review:review}],
      ['latest',{model_hazard:false,latest_hazard:{ts_ms:1,frame_id:'frame-1'}}],['logged',{model_hazard:false}],['routine',{model_hazard:false}]]) {
      store.start(id,'cam','live');store.save(id,live('monitor',{incident_history:history}));
    }
    store.review('reviewed',review);store.review('logged',review); // an alert_reviews row alone also protects
    ['hazard','reviewed','latest','logged','routine'].forEach((id,i)=>store.archive(id,[jpeg(i+1)]));
    assert.equal(store.evidenceBytes,100);
    assert.deepEqual(store.archive('routine',[jpeg(6)]),{retained:true,frame_ids:['frame-6']}); // its own frame-5 goes
    // Only protected frames remain besides the call's own: a routine writer is refused instead of evicting them.
    assert.deepEqual(store.archive('routine',[jpeg(6),jpeg(7)]),{retained:false,reason:'evidence_storage_limit',frame_ids:['frame-6']});
    assert.deepEqual((await files(evidence)).filter(f=>f.endsWith('.jpg')),
      ['hazard/frame-1.jpg','latest/frame-3.jpg','logged/frame-4.jpg','reviewed/frame-2.jpg','routine/frame-6.jpg']);
    // A protected writer (here reviewed, model_hazard false) takes unprotected frames first, then other sessions' protected ones.
    assert.equal(store.archive('reviewed',[jpeg(8)]).retained,true);assert.ok(!existsSync(join(evidence,'routine')));
    assert.equal(store.archive('hazard',[jpeg(9)]).retained,true);assert.ok(!existsSync(join(evidence,'reviewed','frame-2.jpg')));
    assert.ok(existsSync(join(evidence,'hazard','frame-1.jpg')),'a writer never evicts its own protected frames');
    assert.equal(store.evidenceBytes,100);
  } finally {store?.close();await rm(root,{recursive:true,force:true});}
});

test('a frame that cannot be deleted is skipped, the eviction plan remade and the byte count kept true',async()=>{
  const root=await mkdtemp(join(tmpdir(),'fireguard-stuck-'));let store;
  try {
    const evidence=join(root,'evidence');store=new Store(join(root,'fireguard.sqlite'),{evidenceLimit:60});
    store.start('old','cam','live');store.start('new','cam','live');store.archive('old',[jpeg(1),jpeg(2),jpeg(3)]);
    // A directory in frame-1's place makes rmSync throw, as a locked file does on Windows.
    await rm(join(evidence,'old','frame-1.jpg'));await mkdir(join(evidence,'old','frame-1.jpg','locked'),{recursive:true});
    assert.deepEqual(store.archive('new',[jpeg(4)]),{retained:true,frame_ids:['frame-4']});
    assert.ok(!existsSync(join(evidence,'old','frame-2.jpg')));assert.ok(existsSync(join(evidence,'old','frame-3.jpg')));
    assert.equal(store.evidenceBytes,60,'the undeletable frame still counts');
    assert.deepEqual(store.archive('new',[jpeg(4),jpeg(5),jpeg(6)]),{retained:false,reason:'evidence_storage_limit',frame_ids:['frame-4','frame-5']});
    assert.deepEqual((await files(evidence)).filter(f=>f.endsWith('.jpg')),['new/frame-4.jpg','new/frame-5.jpg','old/frame-1.jpg']);
    assert.equal(store.evidenceBytes,60);
  } finally {store?.close();await rm(root,{recursive:true,force:true});}
});

test('on Windows a refused rename is retried three times before the frame is given up',async()=>{
  const root=await mkdtemp(join(tmpdir(),'fireguard-rename-'));let store,calls=0;
  const original=fs.renameSync,platform=process.platform,as=value=>Object.defineProperty(process,'platform',{value,configurable:true});
  try {
    const folder=join(root,'evidence','s');store=new Store(join(root,'fireguard.sqlite'));store.start('s','cam','live');
    fs.renameSync=(...args)=>{if(++calls<=2)throw Object.assign(new Error('busy'),{code:'EBUSY'});return original(...args);};syncBuiltinESMExports();
    as('win32');assert.deepEqual(store.archive('s',[jpeg(1)]),{retained:true,frame_ids:['frame-1']});assert.equal(calls,3);
    calls=-10;assert.deepEqual(store.archive('s',[jpeg(2)]),{retained:false,reason:'evidence_storage_failed',frame_ids:[]});
    assert.equal(calls,-6,'one attempt and three retries');
    as('linux');calls=-10;assert.equal(store.archive('s',[jpeg(3)]).reason,'evidence_storage_failed');assert.equal(calls,-9,'no retry elsewhere');
    assert.deepEqual(await files(folder),['frame-1.jpg']);assert.equal(store.evidenceBytes,20);
  } finally {
    fs.renameSync=original;syncBuiltinESMExports();as(platform);store?.close();await rm(root,{recursive:true,force:true});
  }
});
test('a copied-forward last_review does not protect a session; a just-latched writer can evict as protected',async()=>{
  const root=await mkdtemp(join(tmpdir(),'fireguard-protect-hint-'));let store;
  try {
    store=new Store(join(root,'fireguard.sqlite'),{evidenceLimit:60});
    const review={incident_id:'i1',action:'false_alarm',actor:'service',reviewed_at_ms:1,last_hazard:null};
    for(const [id,history] of [['hazard',{model_hazard:true}],['carried',{model_hazard:false,last_review:review}],['writer',{model_hazard:false}]]) {
      store.start(id,'cam','live');store.save(id,live('monitor',{incident_history:history}));
    }
    store.archive('hazard',[jpeg(1)]);store.archive('carried',[jpeg(2)]);store.archive('writer',[jpeg(3)]);
    // The carried-forward review is routine evidence: a routine writer evicts it first.
    assert.deepEqual(store.archive('writer',[jpeg(4)]),{retained:true,frame_ids:['frame-4']});
    assert.equal(existsSync(join(root,'evidence','carried','frame-2.jpg')),false);
    assert.equal(existsSync(join(root,'evidence','hazard','frame-1.jpg')),true);
    // Only hazard and the writer's own current frames remain: a routine writer is refused, a just-latched one is not.
    assert.equal(store.archive('writer',[jpeg(3),jpeg(4),jpeg(5)]).retained,false);
    assert.deepEqual(store.archive('writer',[jpeg(3),jpeg(4),jpeg(5)],{protect:true}),{retained:true,frame_ids:['frame-3','frame-4','frame-5']});
    assert.equal(existsSync(join(root,'evidence','hazard','frame-1.jpg')),false);
  }finally{store?.close();await rm(root,{recursive:true,force:true});}
});
