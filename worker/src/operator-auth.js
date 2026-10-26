// Operator credentials are independent of camera ingress credentials.
export class OperatorError extends Error {
  constructor(status, code) {
    super(code);
    this.name = 'OperatorError';
    this.status = status;
    this.code = code;
  }
}

// The WeakMap is only an in-isolate capability brand, never a credential cache.
// Principals cannot cross serialization/DO boundaries; reauthorize the original
// assertion in the receiving isolate instead of trusting forwarded actor JSON.
const principals = new WeakMap();
const invalid = () => new OperatorError(401, 'operator_auth_invalid');
function decode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw invalid();
  const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
  const canonical = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (canonical !== value) throw invalid();
  return bytes;
}
const parse = value => JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(decode(value)));

export function requireOperatorPrincipal(principal, permission, cameraId) {
  const grant = principals.get(principal);
  if (!grant || !permissions.has(permission) || !validCamera(cameraId) ||
    !grant.policy.permissions.includes(permission) ||
    !(grant.policy.cameras.includes(cameraId) || grant.policy.cameras.includes('*'))) {
    throw new OperatorError(403, 'operator_forbidden');
  }
  const now=Math.floor(Date.now()/1000);
  if (!Number.isSafeInteger(now) || now<grant.notBefore || now>=grant.expiresAt) {
    principals.delete(principal); // An expired capability cannot revive on clock rollback.
    throw invalid();
  }
  return grant.identity;
}

const permissions = new Set(['cause:review', 'inference:recover']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const boundedText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\s\x00-\x1f\x7f]/.test(value);
const validEmail = value => boundedText(value, 254) && /^[^@]+@[^@]+\.[^@]+$/.test(value);
const validCamera = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const boundedList = (value, max, validate) => Array.isArray(value) && value.length <= max &&
  value.every(validate) && new Set(value).size === value.length;

function configuration(env) {
  try {
    const issuer = env?.OPERATOR_ACCESS_ISSUER;
    if (typeof issuer !== 'string' || !/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(issuer) ||
      !boundedText(env.OPERATOR_ACCESS_AUD, 256) || typeof env.OPERATOR_POLICY_JSON !== 'string' ||
      env.OPERATOR_POLICY_JSON.length > 65536) throw new Error();
    const policy = JSON.parse(env.OPERATOR_POLICY_JSON);
    if (!record(policy) || Object.keys(policy).length > 256) throw new Error();
    for (const [subject, rule] of Object.entries(policy)) {
      if (!boundedText(subject, 256) || !record(rule) || !validEmail(rule.email) ||
        !boundedList(rule.permissions, 2, value => permissions.has(value)) ||
        !boundedList(rule.cameras, 256, value => validCamera(value) || value === '*') ||
        (rule.cameras.includes('*') && rule.cameras.length !== 1)) throw new Error();
    }
    return {issuer, audience: env.OPERATOR_ACCESS_AUD, policy};
  } catch {
    throw new OperatorError(503, 'operator_auth_unconfigured');
  }
}

function validateClaims(claims, issuer, audience, nowMs) {
  const numericDate = value => Number.isSafeInteger(value) && value >= 0;
  const audiences = typeof claims?.aud === 'string' ? [claims.aud] : claims?.aud;
  const now = Math.floor(nowMs / 1000);
  if (!record(claims) || !Number.isSafeInteger(nowMs) || nowMs < 0 || claims.iss !== issuer ||
    !boundedList(audiences, 16, value => boundedText(value, 256)) || !audiences.includes(audience) ||
    !numericDate(claims.exp) || !numericDate(claims.iat) || claims.exp <= now || claims.iat > now || claims.iat >= claims.exp ||
    (claims.nbf !== undefined && (!numericDate(claims.nbf) || claims.nbf > now || claims.nbf >= claims.exp)) ||
    !boundedText(claims.sub, 256) || !validEmail(claims.email) || claims.type !== 'app' ||
    Object.hasOwn(claims, 'common_name') || Object.hasOwn(claims, 'service_token_id')) throw invalid();
}

async function loadKeys(issuer, fetcher) {
  const controller = new AbortController();
  let reader;
  let response;
  let timer;
  const cancel = () => {
    controller.abort();
    if (reader) void reader.cancel().catch(() => {});
    else if (response?.body) void response.body.cancel().catch(() => {});
  };
  const operation = async () => {
    response = await fetcher(`${issuer}/cdn-cgi/access/certs`, {
      method: 'GET', redirect: 'manual', credentials: 'omit', headers: {accept: 'application/json'},
      signal: controller.signal,
    });
    if (controller.signal.aborted) {
      if (response?.body) void response.body.cancel().catch(() => {});
      throw new Error();
    }
    const length = response.headers.get('content-length');
    if (response.status !== 200 || response.redirected || (response.url && response.url !== `${issuer}/cdn-cgi/access/certs`) ||
      (length !== null && (!/^\d+$/.test(length) || Number(length) > 65536)) || !response.body) throw new Error();
    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', {fatal: true});
    let bytes = 0;
    let text = '';
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 65536) throw new Error();
      text += decoder.decode(value, {stream: true});
    }
    text += decoder.decode();
    return JSON.parse(text);
  };
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { reject(new Error()); cancel(); }, 2000);
    });
    return await Promise.race([operation(), deadline]);
  } catch {
    throw new OperatorError(503, 'operator_auth_unavailable');
  } finally {
    clearTimeout(timer);
    cancel();
  }
}

async function verificationKey(jwks, kid) {
  let selected;
  try {
    if (!record(jwks) || !Array.isArray(jwks.keys) || jwks.keys.length < 1 || jwks.keys.length > 16) throw new Error();
    const seen = new Set();
    for (const key of jwks.keys) {
      if (!record(key) || !boundedText(key.kid, 256) || seen.has(key.kid) || key.kty !== 'RSA' ||
        key.alg !== 'RS256' || key.use !== 'sig' || key.e !== 'AQAB' ||
        (key.key_ops !== undefined && (!Array.isArray(key.key_ops) || key.key_ops.length !== 1 || key.key_ops[0] !== 'verify')) ||
        ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'].some(name => Object.hasOwn(key, name))) throw new Error();
      const modulus = decode(key.n);
      if (modulus.length < 256 || modulus.length > 512 || modulus[0] < 128) throw new Error();
      seen.add(key.kid);
      if (key.kid === kid) selected = key;
    }
  } catch {
    throw new OperatorError(503, 'operator_auth_unavailable');
  }
  if (!selected) throw invalid();
  try {
    return await crypto.subtle.importKey('jwk', {kty: 'RSA', n: selected.n, e: selected.e, alg: 'RS256', use: 'sig'},
      {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'}, false, ['verify']);
  } catch {
    throw new OperatorError(503, 'operator_auth_unavailable');
  }
}

export async function authorizeOperator(request, env, permission, cameraId, {fetcher = fetch, nowMs = Date.now()} = {}) {
  const {issuer, audience, policy} = configuration(env);
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) throw new OperatorError(401, 'operator_auth_required');
  let headerPart, claimPart, signaturePart, header, claims;
  try {
    if (token.length > 16384) throw invalid();
    const parts = token.split('.');
    if (parts.length !== 3) throw invalid();
    [headerPart, claimPart, signaturePart] = parts;
    header = parse(headerPart);
    claims = parse(claimPart);
    decode(signaturePart);
    if (!record(header) || header.alg !== 'RS256' || !boundedText(header.kid, 256) ||
      (header.typ !== undefined && header.typ !== 'JWT') ||
      Object.keys(header).some(name => !['alg', 'kid', 'typ'].includes(name))) throw invalid();
  } catch {
    throw invalid();
  }
  validateClaims(claims, issuer, audience, nowMs);
  const jwks = await loadKeys(issuer, fetcher);
  const key = await verificationKey(jwks, header.kid);
  try {
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decode(signaturePart),
      new TextEncoder().encode(`${headerPart}.${claimPart}`))) throw invalid();
  } catch {
    throw invalid();
  }
  // JWKS retrieval and signature verification can outlive a nearly expired
  // assertion. Authority is checked at completion, not just before those awaits.
  validateClaims(claims, issuer, audience, Date.now());
  const rule = Object.hasOwn(policy, claims.sub) ? policy[claims.sub] : null;
  if (!rule || rule.email !== claims.email) throw new OperatorError(403, 'operator_forbidden');
  const identity = Object.freeze({subject: claims.sub, email: claims.email});
  principals.set(identity, {identity, policy: rule,expiresAt:claims.exp,notBefore:Math.max(claims.iat,claims.nbf??0)});
  return requireOperatorPrincipal(identity, permission, cameraId);
}
