import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,readdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {snapshotStore,restoreStore} from '../src/snapshot.js';

test('committed WAL results survive snapshot and restore; active jobs become interrupted',async()=>{
  const root=await mkdtemp(join(tmpdir(),'fireguard-snapshot-'));
  let original,restored;
  try {
    const active=join(root,'active'),saved=join(root,'saved'),next=join(root,'next');
    await mkdir(active);await mkdir(saved);
    original=new Store(join(active,'fireguard.sqlite'));
    original.start('session','camera','video');
    original.save('session',{priority:{level:'monitor'}});
    original.job('complete',{status:'complete',result:{value:42}});
    original.job('pending',{status:'running'});
    original.archive('session',[{ts_ms:1,frame_id:'f1',image_b64:Buffer.from('jpeg').toString('base64')}]);
    await snapshotStore(original,saved);
    // A later uncheckpointed change must not leak into the saved database.
    original.job('complete',{result:{value:99}});
    await restoreStore(saved,next);
    restored=new Store(join(next,'fireguard.sqlite'));
    assert.equal(restored.job('complete').result.value,42);
    assert.equal(restored.job('pending').status,'interrupted');
    assert.equal(restored.timeline('session')[0].priority.level,'monitor');
    assert.equal(restored.evidenceBytes,4);
  } finally {original?.close();restored?.close();await rm(root,{recursive:true,force:true});}
});

test('first start without backup creates an empty data directory',async()=>{
  const root=await mkdtemp(join(tmpdir(),'fireguard-new-'));
  try {assert.equal(await restoreStore(join(root,'absent'),join(root,'active')),false);}
  finally{await rm(root,{recursive:true,force:true});}
});

const jpeg=(ts,bytes=4)=>({ts_ms:ts,frame_id:`frame-${ts}`,image_b64:Buffer.alloc(bytes,ts).toString('base64')});
// Windows lists nested entries with backslashes; compare with forward slashes on every platform.
const listing=async dir=>(await readdir(dir,{recursive:true})).map(p=>p.replaceAll('\\','/')).sort();

test('snapshots mirror evidence: evictions propagate, resized copies are repaired and temporary files are skipped',async()=>{
  const root=await mkdtemp(join(tmpdir(),'fireguard-mirror-'));let store,restored;
  try {
    const active=join(root,'active'),saved=join(root,'saved'),evidence=join(saved,'evidence');
    store=new Store(join(active,'fireguard.sqlite'),{evidenceLimit:8});
    store.start('old','cam','live');store.start('new','cam','live');
    store.archive('old',[jpeg(1),jpeg(2)]);
    await snapshotStore(store,saved);
    assert.deepEqual(await listing(evidence),['old','old/frame-1.jpg','old/frame-2.jpg']);
    store.archive('new',[jpeg(3)]); // evicts old/frame-1
    await snapshotStore(store,saved);
    assert.deepEqual(await listing(evidence),['new','new/frame-3.jpg','old','old/frame-2.jpg']);
    store.archive('new',[jpeg(4)]); // evicts old/frame-2 and its folder
    // A truncated copy (e.g. from an interrupted snapshot) is rewritten; in-flight and stale temporaries are not copied.
    await writeFile(join(evidence,'new','frame-3.jpg'),Buffer.alloc(1));
    await writeFile(join(active,'evidence','new','frame-5.jpg.tmp'),Buffer.alloc(3));
    await writeFile(join(evidence,'new','frame-6.jpg.tmp'),Buffer.alloc(3));
    await snapshotStore(store,saved);
    assert.deepEqual(await listing(evidence),['new','new/frame-3.jpg','new/frame-4.jpg']);
    assert.deepEqual(await readFile(join(evidence,'new','frame-3.jpg')),Buffer.alloc(4,3));
    await snapshotStore(store,saved); // idempotent
    assert.deepEqual(await listing(evidence),['new','new/frame-3.jpg','new/frame-4.jpg']);
    store.close();store=null;
    await writeFile(join(evidence,'new','frame-7.jpg.tmp'),Buffer.alloc(3));
    assert.equal(await restoreStore(saved,join(root,'next')),true);
    assert.deepEqual(await listing(join(root,'next','evidence')),['new','new/frame-3.jpg','new/frame-4.jpg']);
    restored=new Store(join(root,'next','fireguard.sqlite'),{evidenceLimit:8});assert.equal(restored.evidenceBytes,8);
  } finally {store?.close();restored?.close();await rm(root,{recursive:true,force:true});}
});
