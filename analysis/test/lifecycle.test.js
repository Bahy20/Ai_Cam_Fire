import test from 'node:test';
import assert from 'node:assert/strict';
import { DetectionLifecycle } from '../../worker/src/lifecycle.js';

const frame = (ts, fire = true) => ({ts_ms: ts, detections: fire ? [{cls:'fire',conf:.8}] : []});
test('gap and one negative preserve confirmed; eight distinct negatives clear', () => {
  const state = new DetectionLifecycle();
  for (let i=0;i<5;i++) state.accept(frame(i*333));
  assert.equal(state.alert,'confirmed');
  state.accept(frame(10000,false));
  state.accept(frame(10000,false));
  assert.equal(state.alert,'confirmed');
  for(let i=1;i<7;i++) state.accept(frame(10000+i*333,false));
  assert.equal(state.alert,'confirmed');
  assert.equal(state.accept(frame(12331,false)).transition,'cleared');
});
test('weak positive is not a clearing negative and invalid gaps reset continuity', () => {
  const state=new DetectionLifecycle();
  for(let i=0;i<5;i++) state.accept(frame(i*333));
  for(let i=5;i<12;i++) state.accept(frame(i*333,false));
  state.accept({ts_ms:4000,detections:[{cls:'fire',conf:.05}]});
  state.gap();
  state.accept(frame(4500,false));
  assert.equal(state.alert,'confirmed');
});
test('persistent lane retains existing requirement of 24 samples', () => {
  const state=new DetectionLifecycle();
  for(let i=0;i<23;i++) state.accept({ts_ms:i*333,detections:[{cls:'fire',conf:.1}]});
  assert.equal(state.alert,'watch');
  state.accept({ts_ms:23*333,detections:[{cls:'fire',conf:.1}]});
  assert.equal(state.alert,'confirmed');
});
