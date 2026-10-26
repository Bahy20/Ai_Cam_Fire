import test from 'node:test';
import assert from 'node:assert/strict';

const api = await import('../src/operator-auth.js').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const {makeOperatorFixture} = await import('./helpers/operator-jwt.js');
const fixture = await makeOperatorFixture();
const request = (headers = {}) => new Request('https://worker/review/cam', {headers});
function isError(status, code) {
  return error => error instanceof api.OperatorError && error.status === status && error.code === code && error.message === code;
}

test('only a bounded canonical RS256 assertion header is accepted', async () => {
  for (const headers of [{}, {'x-api-key': 'ingest', 'x-reviewer': 'operator@example.test'},
    {cookie: `CF_Authorization=${fixture.headers['cf-access-jwt-assertion']}`}]) {
    await assert.rejects(api.authorizeOperator(request(headers), fixture.env, 'cause:review', 'cam'),
      isError(401, 'operator_auth_required'));
  }
  const badHeaders = [{alg: 'none'}, {alg: 'HS256'}, {alg: 'RS512'}, {kid: ''}, {kid: 'x'.repeat(257)},
    {kid: 1}, {crit: ['unknown'], unknown: true}, {b64: false}, {typ: 'at+jwt'}, {jku: 'https://evil.test/keys'},
    {jwk: {kty: 'RSA'}}, {x5u: 'https://evil.test/cert'}];
  const malformed = ['x'.repeat(16385), 'x.y.z', 'a.b.c.d', '..', `${fixture.headers['cf-access-jwt-assertion']}=`,
    ...await Promise.all(badHeaders.map(header => fixture.sign({}, header)))];
  for (const token of malformed) {
    await assert.rejects(api.authorizeOperator(request({'cf-access-jwt-assertion': token}), fixture.env, 'cause:review', 'cam',
      {fetcher: () => assert.fail('malformed token must not fetch')}), isError(401, 'operator_auth_invalid'));
  }
});

test('signed tokens must have valid human application claims and current time bounds', async t => {
  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000);
  const cases = [
    ['expired', {exp: now}], ['future nbf', {nbf: now + 1}], ['future iat', {iat: now + 1}],
    ['missing exp', {exp: undefined}], ['string exp', {exp: String(now + 60)}], ['fractional exp', {exp: now + 0.5}],
    ['missing iat', {iat: undefined}], ['negative iat', {iat: -1}], ['invalid nbf', {nbf: 'yesterday'}],
    ['wrong audience', {aud: ['other']}], ['malformed audience', {aud: [fixture.env.OPERATOR_ACCESS_AUD, 2]}],
    ['empty audience', {aud: []}], ['wrong issuer', {iss: 'https://evil.cloudflareaccess.com'}],
    ['missing subject', {sub: undefined}], ['oversized subject', {sub: 'a'.repeat(257)}], ['object subject', {sub: {id: 'operator-1'}}],
    ['missing email', {email: undefined}], ['invalid email', {email: 'operator'}],
    ['service token', {type: 'service'}], ['missing token type', {type: undefined}],
    ['service-token identity', {common_name: 'service-token'}], ['service-token id', {service_token_id: 'secret-id'}],
  ];
  for (const [name, claims] of cases) await t.test(name, async () => {
    const token = await fixture.sign(claims);
    await assert.rejects(api.authorizeOperator(request({'cf-access-jwt-assertion': token}), fixture.env, 'cause:review', 'cam',
      {fetcher: fixture.fetcher, nowMs}), isError(401, 'operator_auth_invalid'));
  });
});

test('policy grants are bound to verified subject, exact email, permission and camera', async t => {
  const limitedPolicy = {'operator-1': {email: 'operator@example.test', permissions: ['cause:review'], cameras: ['cam']}};
  const env = {...fixture.env, OPERATOR_POLICY_JSON: JSON.stringify(limitedPolicy)};
  for (const [name, claims, overrides, permission, camera] of [
    ['unlisted subject', {sub: 'not-listed'}, {}, 'cause:review', 'cam'],
    ['prototype subject', {sub: 'constructor'}, {}, 'cause:review', 'cam'],
    ['email mismatch', {email: 'other@example.test'}, {}, 'cause:review', 'cam'],
    ['email case mismatch', {email: 'Operator@example.test'}, {}, 'cause:review', 'cam'],
    ['revoked subject', {}, {OPERATOR_POLICY_JSON: '{}'}, 'cause:review', 'cam'],
    ['missing permission', {}, {}, 'inference:recover', 'cam'],
    ['unknown permission', {}, {}, 'admin', 'cam'],
    ['different camera', {}, {}, 'cause:review', 'other'],
    ['wildcard request', {}, {}, 'cause:review', '*'],
  ]) await t.test(name, async () => {
    await assert.rejects(api.authorizeOperator(request({'cf-access-jwt-assertion': await fixture.sign(claims)}),
      {...env, ...overrides}, permission, camera, {fetcher: fixture.fetcher}), isError(403, 'operator_forbidden'));
  });
  const principal = await api.authorizeOperator(request(fixture.headers), env, 'cause:review', 'cam', {fetcher: fixture.fetcher});
  for (const forged of [null, undefined, 1, {}, {...principal}, JSON.parse(JSON.stringify(principal)), structuredClone(principal), Object.create(principal)]) {
    assert.throws(() => api.requireOperatorPrincipal(forged, 'cause:review', 'cam'), isError(403, 'operator_forbidden'));
  }
  assert.throws(() => api.requireOperatorPrincipal(principal, 'inference:recover', 'cam'), isError(403, 'operator_forbidden'));
  assert.throws(() => api.requireOperatorPrincipal(principal, 'cause:review', 'other'), isError(403, 'operator_forbidden'));
  const wildcard = {...env, OPERATOR_POLICY_JSON: JSON.stringify({'operator-1': {...limitedPolicy['operator-1'], cameras: ['*']}})};
  assert.equal((await api.authorizeOperator(request(fixture.headers), wildcard, 'cause:review', 'another-camera',
    {fetcher: fixture.fetcher})).subject, 'operator-1');
});

test('JWKS transport rejects redirects, network errors and oversized streamed responses without leaking errors', async t => {
  const options = {fetcher: fixture.fetcher};
  const body = await (await fixture.fetcher(`${fixture.issuer}/cdn-cgi/access/certs`, {
    method: 'GET', redirect: 'manual', credentials: 'omit', signal: new AbortController().signal,
  })).text();
  const cases = [
    ['redirect', () => new Response(null, {status: 302, headers: {location: 'https://evil.test/keys'}})],
    ['HTTP failure', () => new Response('upstream failure', {status: 500})],
    ['malformed JSON', () => new Response('{')],
    ['network error', () => { throw new Error('private upstream error must not escape'); }],
    ['oversized declared length', () => new Response(body, {headers: {'content-length': '65537'}})],
  ];
  for (const [name, fetcher] of cases) await t.test(name, async () => {
    await assert.rejects(api.authorizeOperator(request(fixture.headers), fixture.env, 'cause:review', 'cam',
      {...options, fetcher}), isError(503, 'operator_auth_unavailable'));
  });
  let cancelled = false;
  let chunks = 0;
  const stream = new ReadableStream({pull(controller) {
    // Leave unread data after the limit (streams may prefetch one chunk).
    if (chunks++ < 5) controller.enqueue(new Uint8Array(32768));
    else controller.close();
  }, cancel() { cancelled = true; }});
  await assert.rejects(api.authorizeOperator(request(fixture.headers), fixture.env, 'cause:review', 'cam',
    {fetcher: async () => new Response(stream, {headers: {'content-length': '1'}})}), isError(503, 'operator_auth_unavailable'));
  assert.equal(cancelled, true, 'oversized streams must be cancelled');
});

test('JWKS deadline bounds both fetch and streamed body even when transport ignores abort', async t => {
  for (const phase of ['fetch', 'body']) await t.test(phase, async () => {
    let timer;
    let signal;
    let cancelled = false;
    const fetcher = async (url, options) => {
      signal = options.signal;
      const response = await fixture.fetcher(url, options);
      const text = await response.text();
      if (phase === 'fetch') return new Promise(resolve => { timer = setTimeout(() => resolve(new Response(text)), 4000); });
      return new Response(new ReadableStream({start(controller) {
        timer = setTimeout(() => { controller.enqueue(new TextEncoder().encode(text)); controller.close(); }, 4000);
      }, cancel() { cancelled = true; clearTimeout(timer); }}));
    };
    const start = performance.now();
    try {
      await assert.rejects(api.authorizeOperator(request(fixture.headers), fixture.env, 'cause:review', 'cam', {fetcher}),
        isError(503, 'operator_auth_unavailable'));
      assert.ok(performance.now() - start < 3500, 'deadline must not wait for a stalled transport');
      assert.equal(signal.aborted, true);
      if (phase === 'body') assert.equal(cancelled, true);
    } finally { clearTimeout(timer); }
  });
});

test('only an unambiguous bounded public RS256 JWKS may select a verification key', async t => {
  const source = await (await fixture.fetcher(`${fixture.issuer}/cdn-cgi/access/certs`, {
    method: 'GET', redirect: 'manual', credentials: 'omit', signal: new AbortController().signal,
  })).json();
  const key = source.keys[0];
  const malformed = [null, {}, {keys: []}, {keys: [null]}, {keys: Array(17).fill(key)}, {keys: [key, key]},
    ...[{kty: 'oct'}, {alg: 'HS256'}, {use: 'enc'}, {key_ops: ['sign']}, {n: 'AQAB'}, {e: 'AA'},
      {d: 'private'}, {p: 'private'}, {kid: 1}].map(overrides => ({keys: [{...key, ...overrides}]}))];
  for (const [i, jwks] of malformed.entries()) await t.test(`invalid key set ${i}`, async () => {
    await assert.rejects(api.authorizeOperator(request(fixture.headers), fixture.env, 'cause:review', 'cam',
      {fetcher: async () => Response.json(jwks)}), isError(503, 'operator_auth_unavailable'));
  });
  await assert.rejects(api.authorizeOperator(request({'cf-access-jwt-assertion': await fixture.sign({}, {kid: 'unknown'})}),
    fixture.env, 'cause:review', 'cam', {fetcher: fixture.fetcher}), isError(401, 'operator_auth_invalid'));
});

test('forged signatures and payload edits cannot create an authenticated principal', async () => {
  const other = await makeOperatorFixture();
  const [head, payload, sig] = fixture.headers['cf-access-jwt-assertion'].split('.');
  const changed = Buffer.from(sig, 'base64url');
  changed[0] ^= 1;
  const editedClaims = {...JSON.parse(Buffer.from(payload, 'base64url').toString()), email: 'attacker@example.test'};
  const tokens = [other.headers['cf-access-jwt-assertion'], `${head}.${payload}.${changed.toString('base64url')}`,
    `${head}.${Buffer.from(JSON.stringify(editedClaims)).toString('base64url')}.${sig}`];
  for (const token of tokens) await assert.rejects(api.authorizeOperator(request({'cf-access-jwt-assertion': token}),
    fixture.env, 'cause:review', 'cam', {fetcher: fixture.fetcher}), isError(401, 'operator_auth_invalid'));
});

test('operator authorization fails closed without configuration, including development', async () => {
  assert.equal(typeof api.authorizeOperator, 'function', 'operator verifier must exist');
  for (const env of [{}, {APP_ENV: 'development', INGEST_API_KEY: 'ingest'}]) {
    await assert.rejects(api.authorizeOperator(request({'x-api-key': 'ingest'}), env, 'cause:review', 'cam'),
      isError(503, 'operator_auth_unconfigured'));
  }
});

test('a real Access RS256 JWT produces a frozen privately branded operator identity', async () => {
  const principal = await api.authorizeOperator(request({...fixture.headers, 'x-api-key': 'never-forward', cookie: 'secret'}),
    fixture.env, 'cause:review', 'cam', {fetcher: fixture.fetcher});
  assert.deepEqual(principal, {subject: 'operator-1', email: 'operator@example.test'});
  assert.equal(Object.isFrozen(principal), true);
  const identity = api.requireOperatorPrincipal(principal, 'cause:review', 'cam');
  assert.deepEqual(identity, principal);
  assert.equal(Object.isFrozen(identity), true);
});

test('malformed issuer, audience and policy configuration fail closed before network access', async () => {
  const invalid = [
    ...['http://team.cloudflareaccess.com', 'https://team.cloudflareaccess.com/', 'https://team.cloudflareaccess.com:443',
      'https://user@team.cloudflareaccess.com', 'https://team.cloudflareaccess.com?x', 'https://team.cloudflareaccess.com#x',
      'https://team.cloudflareaccess.com/../', 'https://team.evil.test', 'https://a.b.cloudflareaccess.com',
      `https://${'x'.repeat(64)}.cloudflareaccess.com`].map(OPERATOR_ACCESS_ISSUER => ({OPERATOR_ACCESS_ISSUER})),
    ...['', ' ', 'a'.repeat(257), ['aud']].map(OPERATOR_ACCESS_AUD => ({OPERATOR_ACCESS_AUD})),
    ...['{', 'null', '[]', '1', 'x'.repeat(65537), JSON.stringify({'operator-1': {email: 'bad', permissions: ['cause:review'], cameras: ['cam']}}),
      JSON.stringify({'operator-1': {email: 'operator@example.test', permissions: ['admin'], cameras: ['cam']}}),
      JSON.stringify({'operator-1': {email: 'operator@example.test', permissions: ['cause:review'], cameras: ['*', 'cam']}}),
      JSON.stringify({'operator-1': {email: 'operator@example.test', permissions: ['cause:review'], cameras: 'cam'}})]
      .map(OPERATOR_POLICY_JSON => ({OPERATOR_POLICY_JSON})),
  ];
  for (const overrides of invalid) {
    await assert.rejects(api.authorizeOperator(request(fixture.headers), {...fixture.env, ...overrides}, 'cause:review', 'cam',
      {fetcher: () => assert.fail('invalid configuration must not fetch')}), isError(503, 'operator_auth_unconfigured'));
  }
});

test('an assertion expiring during awaited JWKS verification cannot create operator authority',async t=>{
  let now=1700000000000;t.mock.method(Date,'now',()=>now);
  const token=await fixture.sign({exp:Math.floor(now/1000)+1});
  await assert.rejects(api.authorizeOperator(request({'cf-access-jwt-assertion':token}),fixture.env,'cause:review','cam',
    {fetcher:async(...args)=>{const response=await fixture.fetcher(...args);now+=2000;return response;}}),isError(401,'operator_auth_invalid'));
});

test('a retained branded principal expires before review/recovery consumption and cannot revive after clock rollback',async t=>{
  let now=1700000000000;t.mock.method(Date,'now',()=>now);
  const token=await fixture.sign({exp:Math.floor(now/1000)+1});
  const principal=await api.authorizeOperator(request({'cf-access-jwt-assertion':token}),fixture.env,'cause:review','cam',{fetcher:fixture.fetcher});
  now+=1000;assert.throws(()=>api.requireOperatorPrincipal(principal,'cause:review','cam'),isError(401,'operator_auth_invalid'));
  now-=1000;assert.throws(()=>api.requireOperatorPrincipal(principal,'inference:recover','cam'),isError(403,'operator_forbidden'));
});
