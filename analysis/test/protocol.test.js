import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame,decodeFrame } from '../src/protocol.js';
test('wire format carries only source metadata and video bytes',()=>{
  const jpeg=Buffer.from([255,216,255,217]);
  const packet=encodeFrame({session_id:'abc',sequence:1,ts_ms:1000},jpeg);
  assert.deepEqual(decodeFrame(packet),{session_id:'abc',sequence:1,ts_ms:1000,jpeg});
  assert.throws(()=>decodeFrame(encodeFrame({session_id:'abc',sequence:1,ts_ms:1000,detections:[]},jpeg)),/frame_metadata/);
});
test('malformed metadata, extreme size and missing JPEG are rejected',()=>{
  assert.throws(()=>decodeFrame(Buffer.alloc(3)));
  assert.throws(()=>decodeFrame(Buffer.alloc(2*1024*1024+1)));
  assert.throws(()=>decodeFrame(encodeFrame({session_id:'a',sequence:0,ts_ms:1},Buffer.from('bad'))));
});
