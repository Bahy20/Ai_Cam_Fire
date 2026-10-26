import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {deploymentConfigErrors} from '../src/index.js';

const valid = () => ({vars: {APP_ENV: 'production', DETECTOR_PROVIDER: 'edge', VLM_PROVIDER: 'workers_ai',
  VLM_MODEL: '@cf/meta/llama-4-scout-17b-16e-instruct', EVIDENCE_STORAGE: 'pi'}, ai: {binding:'AI'},
  d1_databases:[{binding:'DB', database_id:'12345678-1234-4234-8234-123456789abc'}]});

test('retired inference profiles cannot be selected by cloud preflight', () => {
  const detector = valid(); detector.vars.DETECTOR_PROVIDER='http'; detector.vars.DETECTOR_URL='https://example.com/detect';
  assert.ok(deploymentConfigErrors(detector).some(e => e.startsWith('DETECTOR_PROVIDER')));
  for (const provider of ['modal','http','local']) {
    const vlm = valid(); vlm.vars.VLM_PROVIDER=provider; vlm.vars.VLM_URL='https://example.com/analyze';
    assert.ok(deploymentConfigErrors(vlm).some(e => e.startsWith('VLM_PROVIDER')));
  }
});

test('retired frame route never calls a detector even with stale valid external configuration', async t => {
  t.mock.method(globalThis,'fetch', async()=>assert.fail('retired detector must not run'));
  const response = await worker.fetch(new Request('https://worker/frame/camera/test',{method:'POST',body:'{bad'}),{
    APP_ENV:'development',DETECTOR_PROVIDER:'http',DETECTOR_URL:'https://example.com/detect',
    CAMERA_DO:{idFromName:()=>assert.fail('retired path must not dispatch')},
  },{});
  assert.equal(response.status,409);
  assert.equal((await response.json()).error,'edge_observation_required');
});
