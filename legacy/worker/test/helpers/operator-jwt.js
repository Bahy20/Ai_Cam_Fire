import assert from 'node:assert/strict';

const encode = bytes => Buffer.from(bytes).toString('base64url');
const json = value => encode(new TextEncoder().encode(JSON.stringify(value)));

// Keys stay inside this fixture's closure; no persisted or printed private keys/JWTs.
export async function makeOperatorFixture({permissions = ['cause:review', 'inference:recover'], cameras = ['cam']} = {}) {
  const issuer = 'https://fire-guard-test.cloudflareaccess.com';
  const audience = 'fire-guard-test-audience';
  const pair = await crypto.subtle.generateKey({name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256'}, false, ['sign', 'verify']);
  const key = {...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'fixture-key', alg: 'RS256', use: 'sig'};
  async function sign(claimOverrides = {}, headerOverrides = {}) {
    const now = Math.floor(Date.now() / 1000);
    const claims = {iss: issuer, aud: [audience], sub: 'operator-1', email: 'operator@example.test',
      type: 'app', iat: now - 1, nbf: now - 1, exp: now + 300, ...claimOverrides};
    const unsigned = `${json({alg: 'RS256', kid: key.kid, typ: 'JWT', ...headerOverrides})}.${json(claims)}`;
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(unsigned));
    return `${unsigned}.${encode(signature)}`;
  }
  const env = {OPERATOR_ACCESS_ISSUER: issuer, OPERATOR_ACCESS_AUD: audience,
    OPERATOR_POLICY_JSON: JSON.stringify({'operator-1': {email: 'operator@example.test', permissions, cameras}})};
  const fetcher = async (url, options) => {
    assert.equal(String(url), `${issuer}/cdn-cgi/access/certs`);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, 'omit');
    const sent = new Headers(options.headers);
    for (const name of sent.keys()) assert.equal(name, 'accept', 'no request credentials may be forwarded');
    assert.equal(options.body, undefined);
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({keys: [key]});
  };
  return {env, headers: {'cf-access-jwt-assertion': await sign()}, fetcher, sign, issuer};
}
