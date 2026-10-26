import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import worker, * as workerModule from '../src/index.js';

// Build guard kept here because this task owns only this new test file and the
// Worker/config files. It reads non-secret configuration only, never .dev.vars,
// environment credentials or Cloudflare APIs. Runtime guards validate secrets.
if (process.argv.includes('--preflight')) {
  const scope = process.argv[process.argv.indexOf('--preflight') + 1];
  const cloud = config();
  const selected = scope === 'root' ? cloud : cloud.env?.[scope];
  const errors = selected ? workerModule.deploymentConfigErrors(selected) : ['unknown cloud environment'];
  if (errors.length) {
    console.error(`Deployment preflight blocked (${scope}):\n${errors.join('\n')}`);
    process.exit(1);
  }
  console.log(`Offline configuration preflight passed (${scope}); remote resources and secret values are not verified.`);
  process.exit(0);
}

test('Wrangler cloud builds invoke offline preflight and declare required secrets', () => {
  const cloud = config();
  assert.equal(cloud.build?.command, 'node test/cloud-config.test.js --preflight root');
  assert.equal(cloud.env.production.build.command, 'node test/cloud-config.test.js --preflight production');
  for (const scope of [cloud, cloud.env.production]) {
    assert.deepEqual(scope.secrets.required, ['INGEST_API_KEY']);
  }
  assert.equal(config('wrangler.dev.jsonc').build, undefined, 'local emulation must not require cloud IDs');
  for (const scope of ['root', 'production', 'typo']) {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--preflight', scope],
      {encoding: 'utf8'});
    const selected = scope === 'root' ? cloud : cloud.env?.[scope];
    const errors = selected ? workerModule.deploymentConfigErrors(selected) : ['unknown cloud environment'];
    assert.equal(result.status, errors.length ? 1 : 0);
    if (errors.length) {
      assert.match(result.stderr, /Deployment preflight blocked/);
      for (const error of errors) assert.ok(result.stderr.includes(error));
    } else {
      assert.match(result.stdout, /Offline configuration preflight passed/);
    }
  }
});

function harness(overrides = {}) {
  const dispatches = [];
  const env = {
    APP_ENV: 'production', INGEST_API_KEY: 'test-ingest-key', DETECTOR_PROVIDER: 'edge',
    CAMERA_DO: { idFromName: name => name, get: name => ({fetch: async request => {
      dispatches.push({name, url: request.url});
      return Response.json({alert: 'idle', hits: 0, published: []});
    }}) },
    ...overrides,
  };
  return {env, dispatches, run: (path = '/ingest/camera/route', key = 'test-ingest-key', body = {}) =>
    worker.fetch(new Request(`https://worker${path}`, {method: 'POST',
      headers: key === null ? {} : {'x-api-key': key}, body: JSON.stringify(body)}), env, {})};
}

test('missing and blank ingest auth fail closed outside explicit development without dispatch', async () => {
  for (const APP_ENV of ['production', undefined, '', 'dev', 'Development']) {
    for (const INGEST_API_KEY of [undefined, '', '  ', 42]) {
      const h = harness({APP_ENV, INGEST_API_KEY});
      const response = await h.run();
      assert.equal(response.status, 503, `${APP_ENV}: blank auth must not enable dev mode`);
      assert.deepEqual(await response.json(), {error: 'server_misconfigured'});
      assert.deepEqual(h.dispatches, []);
    }
  }
});

test('only explicit development allows missing ingest auth; configured keys still protect local routes', async () => {
  const h = harness({APP_ENV: 'development', INGEST_API_KEY: ''});
  assert.equal((await h.run(undefined, null)).status, 200);
  h.env.INGEST_API_KEY = 'test-ingest-key';
  for (const key of [null, '', 'wrong']) assert.equal((await h.run(undefined, key)).status, 401);
  assert.equal((await h.run()).status, 200);
  assert.equal(h.dispatches.length, 2);
});


const vlmModel = '@cf/meta/llama-4-scout-17b-16e-instruct';
function edgeCloudConfig() {
  return {vars: {APP_ENV: 'production', DETECTOR_PROVIDER: 'edge', VLM_PROVIDER: 'workers_ai', VLM_MODEL: vlmModel},
    ai: {binding: 'AI'}, secrets: {required: ['INGEST_API_KEY']},
    d1_databases: [{binding: 'DB', database_id: '12345678-1234-4234-8234-123456789abc'}]};
}

test('edge and Workers AI preflight needs no outgoing URLs or inference secrets', () => {
  const {deploymentConfigErrors} = workerModule;
  const supplied = edgeCloudConfig();
  assert.deepEqual(deploymentConfigErrors(supplied), []);
  for (const [mutate, field] of [
    [c => { c.d1_databases[0].database_id = '<SUPPLY_EXISTING_D1_DATABASE_ID>'; }, 'DB.database_id'],
    [c => { c.d1_databases[0].database_id = '00000000-0000-0000-0000-000000000000'; }, 'DB.database_id'],
    [c => { c.vars.APP_ENV = 'development'; }, 'APP_ENV'],
    [c => { c.vars.DETECTOR_PROVIDER = ''; }, 'DETECTOR_PROVIDER'],
    [c => { c.vars.DETECTOR_PROVIDER = 'typo'; }, 'DETECTOR_PROVIDER'],
    [c => { c.vars.VLM_PROVIDER = ''; }, 'VLM_PROVIDER'],
    [c => { delete c.ai; }, 'ai.binding'],
    [c => { c.ai.binding = 'WRONG'; }, 'ai.binding'],
    [c => { delete c.vars.VLM_MODEL; }, 'VLM_MODEL'],
    [c => { c.vars.VLM_MODEL = '  '; }, 'VLM_MODEL'],
  ]) {
    const invalid = structuredClone(supplied);
    mutate(invalid);
    assert.ok(deploymentConfigErrors(invalid).some(error => error.startsWith(field)), field);
  }
});

function config(name = 'wrangler.jsonc') {
  const source = readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
  // Strip comments without damaging quoted URLs. These configs use no trailing commas.
  return JSON.parse(source.replace(/("(?:\\.|[^"\\])*")|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
    (match, quoted) => quoted ?? ''));
}

test('cloud config declares production vars and bindings explicitly, with no local inference defaults', () => {
  const cloud = config();
  assert.equal(cloud.environments, undefined);
  assert.ok(cloud.env?.production, 'Wrangler uses env.production');
  for (const scope of [cloud, cloud.env.production]) {
    assert.equal(scope.vars.APP_ENV, 'production');
    assert.equal(scope.vars.DETECTOR_PROVIDER, 'edge');
    assert.equal(scope.vars.VLM_PROVIDER, 'workers_ai');
    assert.equal(scope.vars.VLM_MODEL, vlmModel);
    assert.equal(scope.vars.HANDHELD_PRIORITY_ENABLED, 'false', 'lighter downgrade remains disabled until validation gates pass');
    assert.equal(scope.vars.HANDHELD_MODEL_SHA256, '', 'no unreviewed optional model is trusted by default');
    assert.equal(scope.vars.SCOUT_HANDHELD_PRIORITY_ENABLED, 'false', 'Scout advisory remains opt-in and off by default');
    assert.equal(scope.vars.SCOUT_HANDHELD_LIVE_TEST_ENABLED, 'false', 'live lighter test remains development-only and off by default');
    assert.equal(scope.vars.DETECTOR_URL, undefined);
    assert.equal(scope.vars.VLM_URL, undefined);
    for (const name of ['INGEST_API_KEY', 'DETECTOR_API_KEY', 'VLM_API_KEY']) {
      assert.equal(scope.vars[name], undefined, 'secrets must not be checked into vars');
    }
    assert.deepEqual(scope.durable_objects.bindings, [{name: 'CAMERA_DO', class_name: 'CameraDO'}]);
    assert.equal(scope.r2_buckets, undefined);
    assert.equal(scope.vars.EVIDENCE_STORAGE, 'pi');
    assert.equal(scope.d1_databases[0].binding, 'DB');
    assert.equal(scope.d1_databases[0].database_id, '048371ca-9b5d-485d-b09b-e2426a859ade', 'preserve the existing D1 identity');
    assert.equal(scope.vars.EVIDENCE_STORAGE, 'pi', 'incident evidence is retained on the Pi');
    assert.deepEqual(scope.ai, {binding: 'AI'});
    assert.deepEqual(workerModule.deploymentConfigErrors(scope), []);
  }
  const local = config('wrangler.dev.jsonc');
  assert.equal(local.vars.APP_ENV, 'development');
  assert.equal(local.vars.DETECTOR_PROVIDER, 'edge');
  assert.equal(local.vars.VLM_PROVIDER, 'workers_ai');
  assert.equal(local.vars.VLM_MODEL, vlmModel);
  assert.equal(local.vars.SCOUT_HANDHELD_LIVE_TEST_ENABLED, 'false');
  assert.equal(local.vars.DETECTOR_URL, undefined);
  assert.equal(local.vars.VLM_URL, undefined);
  assert.equal(local.ai, undefined, 'pure local emulation must not connect to paid remote AI');
  assert.equal(local.d1_databases[0].database_id, undefined, 'local emulation needs no fabricated remote ID');
});

test('remote-AI development profile keeps live lighter test disabled unless explicitly enabled for a test camera',()=>{
  const aiDev=config('wrangler.ai-dev.jsonc');
  assert.equal(aiDev.vars.APP_ENV,'development');
  assert.equal(aiDev.vars.VLM_EVALUATION_MODE,'false');
  assert.equal(aiDev.vars.SCOUT_HANDHELD_PRIORITY_ENABLED,'false');
  assert.equal(aiDev.vars.SCOUT_HANDHELD_LIVE_TEST_ENABLED,'false');
  assert.deepEqual(aiDev.ai,{binding:'AI',remote:true});
});
