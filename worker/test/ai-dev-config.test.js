import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const source = new URL('../wrangler.ai-dev.jsonc', import.meta.url);
test('real Workers AI development is explicit opt-in while D1 stays local and R2 is absent', () => {
  assert.ok(existsSync(source), 'an explicit remote-AI development config must exist');
  const config = JSON.parse(readFileSync(source, 'utf8'));
  assert.equal(config.vars.APP_ENV, 'development');
  assert.equal(config.vars.DETECTOR_PROVIDER, 'edge');
  assert.equal(config.vars.VLM_PROVIDER, 'workers_ai');
  assert.equal(config.vars.VLM_MODEL, '@cf/meta/llama-4-scout-17b-16e-instruct');
  assert.deepEqual(config.ai, { binding: 'AI', remote: true });
  assert.equal(config.vars.VLM_TIMEOUT_MS, '30000');
  assert.equal(config.r2_buckets, undefined);
  assert.equal(config.vars.EVIDENCE_STORAGE, 'pi');
  for (const binding of config.d1_databases) {
    assert.notEqual(binding.remote, true, 'AI tests must not write production evidence/databases');
  }
  assert.equal(config.triggers, undefined);
});

test('default npm development is offline and the unsupported heartbeat cron is not enabled', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.scripts.dev, 'node ../scripts/wrangler.mjs dev --config wrangler.dev.jsonc');
  assert.equal(manifest.scripts['dev:ai'], 'node ../scripts/wrangler.mjs dev --config wrangler.ai-dev.jsonc');
  const cloud = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
    .replace(/("(?:\\.|[^"\\])*")|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, (match, quoted) => quoted ?? ''));
  for (const scope of [cloud, cloud.env.production]) assert.equal(scope.triggers, undefined);
  assert.equal(existsSync(new URL('../src/scheduled.js', import.meta.url)), false,
    'no offline-alarm producer without a heartbeat contract');
});
