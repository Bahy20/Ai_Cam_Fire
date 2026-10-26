import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {validateAllowanceSnapshot} from '../../worker/src/inference-runtime.js';

const maxCacheBytes = 512 * 1024;
function validateCaptures(captures) {
  if (!Array.isArray(captures) || captures.length > 12 ||
    captures.some(item => typeof item?.key !== 'string' || !/^[a-f0-9]{64}$/.test(item.key) ||
      typeof item.raw !== 'string' || Buffer.byteLength(item.raw) > 32768 ||
      item.reusable === false || item.truncated === true || item.redacted === true) ||
    new Set(captures.map(item => item.key)).size !== captures.length ||
    Buffer.byteLength(JSON.stringify(captures)) > maxCacheBytes) throw new Error('invalid_inference_cache');
  return captures;
}
export function loadInferenceCache(file) {
  if (!fs.existsSync(file)) return [];
  if (fs.statSync(file).size > maxCacheBytes) throw new Error('invalid_inference_cache: file too large');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (stored.version !== 1) throw new Error('invalid_inference_cache: unsupported version');
  return validateCaptures(stored.captures);
}
export function loadAllowanceSnapshot(file, nowMs = Date.now()) {
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  return validateAllowanceSnapshot(snapshot, nowMs);
}
export function saveInferenceCache(file, captures) {
  if (!Array.isArray(captures)) throw new Error('invalid_inference_cache');
  captures = captures.filter(item => item.reusable !== false && item.truncated !== true && item.redacted !== true);
  validateCaptures(captures);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const serialized = JSON.stringify({version: 1,
      provenance: 'Captured provider responses for exact-request development replay; not labels or independent quality evidence.',
      captures}, null, 2);
    if (Buffer.byteLength(serialized) > maxCacheBytes) throw new Error('invalid_inference_cache: file too large');
    fs.writeFileSync(temporary, serialized, {flag: 'wx', mode: 0o600});
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function validateInferenceBatch(status, expected) {
  if (!status || status.batch_id !== expected.batch_id || status.max_calls !== expected.max_calls ||
    !['fresh_calls', 'cached_calls', 'skipped_calls', 'in_flight'].every(key => Number.isSafeInteger(status[key]) && status[key] >= 0) ||
    status.fresh_calls > status.max_calls || status.daily_max_calls !== null ||
    !Number.isSafeInteger(status.day_fresh_calls) || status.day_fresh_calls < 0 ||
    typeof status.utc_day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(status.utc_day)) throw new Error('invalid_inference_batch');
  return status;
}
export function remainingInferenceCalls(status) {
  validateInferenceBatch(status, {batch_id: status?.batch_id, max_calls: status?.max_calls});
  return Math.max(0, status.max_calls - status.fresh_calls);
}
export async function configureInferenceBatch(origin, headers, batch) {
  const response = await fetch(new URL('/dev/inference-batch', origin), {method: 'POST',
    headers: {...headers, 'content-type': 'application/json'}, body: JSON.stringify(batch),
    redirect: 'manual', signal: AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error(`inference_batch_unavailable: ${response.status}; no replay started`);
  return validateInferenceBatch(await response.json(), batch);
}
export async function readInferenceBatch(origin, headers, expected) {
  const response = await fetch(new URL('/dev/inference-batch', origin), {headers,
    redirect: 'manual', signal: AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error(`inference_batch_read_failed: ${response.status}`);
  return validateInferenceBatch(await response.json(), expected);
}

export async function stableSourceTime(video) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(path.resolve(video))) hash.update(chunk);
  // Same media produces the same source clock for exact prompt caching. This is
  // a replay anchor, never a claim about when footage was originally recorded.
  return 1700000000000 + Number.parseInt(hash.digest('hex').slice(0, 10), 16);
}
