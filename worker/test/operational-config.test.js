import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const jsonc=path=>JSON.parse(readFileSync(new URL(path,import.meta.url),'utf8').replace(/^\s*\/\/.*$/gm,''));

test('operator controls are explicitly disabled in all default profiles until Access identities are independently configured',()=>{
  const production=jsonc('../wrangler.jsonc');
  for(const config of [production,production.env.production,jsonc('../wrangler.dev.jsonc'),jsonc('../wrangler.ai-dev.jsonc')]) {
    assert.equal(config.vars.OPERATOR_ACCESS_ISSUER,'');assert.equal(config.vars.OPERATOR_ACCESS_AUD,'');
    assert.deepEqual(JSON.parse(config.vars.OPERATOR_POLICY_JSON),{});
  }
});

test('default Worker tests avoid unbounded host-parallel processes',()=>{
  const manifest=jsonc('../package.json');assert.match(manifest.scripts.test,/--test-concurrency=1(?:\s|$)/);
});
