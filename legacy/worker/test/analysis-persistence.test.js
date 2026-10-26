import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync,readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { CameraDO } from '../src/camera-do.js';
const migration=new URL('../migrations/0002_analysis.sql',import.meta.url);

test('actual event persistence retains hypotheses and evidence metadata without promoting them into the accepted cause',async()=>{
  assert.ok(existsSync(migration),'analysis migration must exist');
  const db=new DatabaseSync(':memory:');
  try {
    db.exec(readFileSync(new URL('../migrations/0001_init.sql',import.meta.url),'utf8'));
    db.exec(readFileSync(migration,'utf8'));
    db.exec(readFileSync(new URL('../migrations/0003_event_keys.sql',import.meta.url),'utf8'));
    const c=new CameraDO({storage:{},getWebSockets:()=>[]},{DB:{prepare:sql=>({bind:(...params)=>({run:async()=>db.prepare(sql).run(...params)})})}});
    c.cameraId='cam';
    const cause={ignition_source:'unknown',probable_cause:'unknown',confidence:'low',cause_status:'unverified',
      model_hypothesis:{ignition_source:'human',grounding_status:'unsupported'},requires_human_review:true};
    const frames=[{frame_id:'frame-1000',ts_ms:1000,roles:['recent'],pre_ignition_verified:false}];
    await c.recordEvent(1000,cause,null,{incident_id:'cam:1000:1',evidence_manifest:frames,response_priority:'inspect_urgently'});
    const row=db.prepare('SELECT * FROM events').get();
    assert.ok(row,'the actual INSERT must succeed on migrated SQLite');
    assert.equal(row.cause,'unknown');
    assert.equal(row.snapshot_key,null);
    assert.equal(row.incident_id,'cam:1000:1');
    assert.equal(row.operator_priority,'inspect_urgently');
    assert.equal(JSON.parse(row.analysis_json).response_priority,'inspect_urgently');
    const persisted=JSON.parse(row.analysis_json);
    assert.equal(persisted.cause.model_hypothesis.ignition_source,'human');
    assert.deepEqual(persisted.evidence_manifest,frames);
    assert.equal(JSON.stringify(persisted).includes('jpeg_b64'),false);
  }finally{db.close();}
});
