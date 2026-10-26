import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalObservationBatchHash, validateObservationBatch, validateSessionActivation} from '../src/observation-batch.js';

const sessionId = '2cf1a098-15d8-45bc-96f1-87f776ec3611';
const sample = (attempt_sequence, ts_ms, patch = {}) => ({
  attempt_sequence, ts_ms, status:'ok', frame_wh:[100,80], detections:[], jpeg_sha256:'a'.repeat(64),
  local_image_available:true, visibility:'unknown', camera_motion:null,
  quality:{stability:'unknown',blur_score:null,occlusion:'unknown'}, reason:null, ...patch,
});
const activation = patch => ({protocol_version:2,session_id:sessionId,expected_generation:0,...patch});
const batch = patch => ({protocol_version:2,session_id:sessionId,generation:1,batch_sequence:1,
  payload_hash:'0'.repeat(64),clock_mode:'live',samples:[sample(1,1000)],...patch});

test('activation contract accepts one versioned compare-and-swap request and rejects extra authority', () => {
  assert.deepEqual(validateSessionActivation(activation()), {protocol_version:2,session_id:sessionId,expected_generation:0});
  for (const body of [activation({expected_generation:-1}), activation({session_id:'edge'}),
    activation({extra:true}), activation({protocol_version:1}), null, []]) {
    assert.throws(() => validateSessionActivation(body), /invalid_session_activation/);
  }
});

test('batch contract validates ordered samples, metadata and explicit gap records', async () => {
  const body = batch({samples:[sample(1,1000),sample(2,1333.5,{status:'gap',frame_wh:null,detections:null,
    jpeg_sha256:null,local_image_available:false,reason:'inference_failed',handheld_candidate:null})]});
  body.payload_hash = await canonicalObservationBatchHash(body);
  assert.deepEqual(validateObservationBatch(body,'cam').samples.map(item=>item.status),['ok','gap']);
});

test('batch hash is canonical across object-key order and binds the whole session/batch identity', async () => {
  const body = batch();
  const expected = await canonicalObservationBatchHash(body);
  const reordered = {samples:body.samples,clock_mode:body.clock_mode,batch_sequence:body.batch_sequence,
    generation:body.generation,session_id:body.session_id,protocol_version:body.protocol_version,payload_hash:'f'.repeat(64)};
  assert.equal(await canonicalObservationBatchHash(reordered), expected);
  assert.notEqual(await canonicalObservationBatchHash({...body,batch_sequence:2}), expected);
});

test('batch rejects stale digest, unordered sequences, invalid gaps, unsafe samples and oversized lists', async () => {
  const body = batch();
  const badDigest = {...body,payload_hash:'f'.repeat(64)};
  assert.notEqual(await canonicalObservationBatchHash(badDigest),badDigest.payload_hash);
  const malformed = [
    {...body,samples:[sample(1,1000),sample(3,1300)]},
    {...body,samples:[sample(1,1000),sample(2,999)]},
    {...body,samples:[sample(1,1000,{jpeg_sha256:'BAD'})]},
    {...body,samples:[sample(1,1000,{status:'gap',frame_wh:null,detections:null,jpeg_sha256:null,local_image_available:false})]},
    {...body,samples:Array.from({length:13},(_,i)=>sample(i+1,1000+i))},
    {...body,unexpected:'field'},
  ];
  for (const candidate of malformed) {
    candidate.payload_hash = await canonicalObservationBatchHash(candidate).catch(()=>candidate.payload_hash);
    assert.throws(()=>validateObservationBatch(candidate,'cam'),/invalid_observation_batch/);
  }
});

test('authenticated V2 batches carry only bounded camera/session/frame-bound handheld candidates', async () => {
  const handheld_candidate={version:1,camera_id:'cam',session_id:sessionId,generation:1,
    candidate_id:'lighter-track-1',model_sha256:'b'.repeat(64),source_ts_ms:2_000,
    frame_ids:['frame-1500','frame-2000'],tool_type:'lighter',flame_relation:'at_tool_tip',
    image_quality:'adequate',fire_region_count:1,smoke_evidence:'not_detected',
    secondary_burning_evidence:'not_detected'};
  const body=batch({samples:[sample(1,2_000,{handheld_candidate})]});
  body.payload_hash=await canonicalObservationBatchHash(body);
  assert.equal(validateObservationBatch(body,'cam').samples[0].handheld_candidate.candidate_id,'lighter-track-1');
  for (const patch of [
    {camera_id:'other'}, {session_id:'123e4567-e89b-42d3-a456-426614174000'}, {generation:2},
    {source_ts_ms:1_900}, {frame_ids:['frame-1500']}, {fire_region_count:65},
    {smoke_evidence:'absent'}, {extra:'client-authority'},
  ]) {
    const malformed=batch({samples:[sample(1,2_000,{handheld_candidate:{...handheld_candidate,...patch}})]});
    malformed.payload_hash=await canonicalObservationBatchHash(malformed);
    assert.throws(()=>validateObservationBatch(malformed,'cam'),/invalid_observation_batch/);
  }
  const foreignBatch=batch({session_id:'123e4567-e89b-42d3-a456-426614174000',
    samples:[sample(1,2_000,{handheld_candidate})]});
  foreignBatch.payload_hash=await canonicalObservationBatchHash(foreignBatch);
  assert.throws(()=>validateObservationBatch(foreignBatch,'cam'),/invalid_observation_batch/);
});

