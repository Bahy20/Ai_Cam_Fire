import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
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
