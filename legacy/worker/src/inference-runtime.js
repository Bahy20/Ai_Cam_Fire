// Durable inference accounting. No module-global request state.
const usageKeys = ['prompt_tokens', 'completion_tokens', 'total_tokens'];
const emptyUsage = () => Object.fromEntries(usageKeys.map(key => [key, null]));
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const safeCount = value => Number.isSafeInteger(value) && value >= 0;
const validKey = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const bytes = value => new TextEncoder().encode(value).byteLength;
// A generous per-batch sanity bound limits malformed configurations. The
// account-wide neuron ledger below, not a daily call count, controls spending.
export const MAX_INFERENCE_BATCH_CALLS = 256;
export const WORKERS_AI_FREE_DAILY_NEURONS = 10000;
export const WORKERS_AI_NEURON_BUDGET_FRACTION = 0.8;
export const SCOUT_MODEL_ID = '@cf/meta/llama-4-scout-17b-16e-instruct';
export const SCOUT_MAX_CONTEXT_TOKENS = 131000;
export const SCOUT_MAX_OUTPUT_TOKENS = 1536;
export const SCOUT_NEURONS_PER_MILLION_INPUT_TOKENS = 24545;
export const SCOUT_NEURONS_PER_MILLION_OUTPUT_TOKENS = 77273;
export const SCOUT_NEURON_UNCERTAINTY_MARGIN = 0.1;
export const SCOUT_MAX_REQUEST_NEURONS = Math.ceil(((SCOUT_MAX_CONTEXT_TOKENS *
  SCOUT_NEURONS_PER_MILLION_INPUT_TOKENS + SCOUT_MAX_OUTPUT_TOKENS *
  SCOUT_NEURONS_PER_MILLION_OUTPUT_TOKENS) / 1_000_000) * (1 + SCOUT_NEURON_UNCERTAINTY_MARGIN));
const ALLOWANCE_SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1000;

export function validateAllowanceSnapshot(value, nowMs = Date.now()) {
  const fields = ['version', 'source', 'model', 'utc_day', 'remaining_neurons', 'observed_at_ms', 'usage_through_ms'];
  const dayStart = typeof value?.utc_day === 'string' ? Date.parse(`${value.utc_day}T00:00:00.000Z`) : NaN;
  if (!exact(value, fields) || value.version !== 1 ||
      !['cloudflare_workers_ai_dashboard', 'cloudflare_graphql_analytics'].includes(value.source) ||
      value.model !== SCOUT_MODEL_ID || typeof value.utc_day !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value.utc_day) || !Number.isSafeInteger(dayStart) ||
      new Date(dayStart).toISOString().slice(0, 10) !== value.utc_day ||
      !safeCount(value.remaining_neurons) || value.remaining_neurons > WORKERS_AI_FREE_DAILY_NEURONS ||
      !safeCount(value.observed_at_ms) || !safeCount(value.usage_through_ms) ||
      value.observed_at_ms > 8.64e15 || value.usage_through_ms > 8.64e15 ||
      value.usage_through_ms > value.observed_at_ms || !Number.isSafeInteger(nowMs) ||
      value.observed_at_ms > nowMs || nowMs - value.observed_at_ms > ALLOWANCE_SNAPSHOT_MAX_AGE_MS ||
      new Date(value.observed_at_ms).toISOString().slice(0, 10) !== value.utc_day ||
      new Date(value.usage_through_ms).toISOString().slice(0, 10) !== value.utc_day) {
    throw new Error('invalid_allowance_snapshot');
  }
  return {...value};
}

/** Worst-case model cost under the published Scout context/output limits plus
 * a 10% uncertainty margin. Image tokens are bounded by the same context cap. */
export function estimateMaxNeuronReservation(model, request) {
  if (model !== SCOUT_MODEL_ID || !plain(request) || !Number.isSafeInteger(request.max_tokens) ||
      request.max_tokens < 1 || request.max_tokens > SCOUT_MAX_OUTPUT_TOKENS) return null;
  const outputTokens = request.max_tokens;
  const inputTokens = SCOUT_MAX_CONTEXT_TOKENS;
  const estimate = ((inputTokens * SCOUT_NEURONS_PER_MILLION_INPUT_TOKENS +
    outputTokens * SCOUT_NEURONS_PER_MILLION_OUTPUT_TOKENS) / 1_000_000) *
    (1 + SCOUT_NEURON_UNCERTAINTY_MARGIN);
  return Number.isSafeInteger(Math.ceil(estimate)) ? Math.ceil(estimate) : null;
}

export function normalizeInferenceUsage(value) {
  const usage = emptyUsage();
  if (!plain(value)) return usage;
  for (const key of usageKeys) if (safeCount(value[key])) usage[key] = value[key];
  if (usage.total_tokens !== null && usageKeys.slice(0, 2).some(key => usage[key] !== null && usage[key] > usage.total_tokens))
    return emptyUsage();
  return usage;
}

// Keep the worst-case reservation until a successful response reports complete
// token usage. The 10% margin and 80% account allowance gate remain in force.
function settledNeuronEstimate(usage, maximum) {
  if (!safeCount(usage.prompt_tokens) || usage.prompt_tokens === 0 ||
      !safeCount(usage.completion_tokens) || !safeCount(usage.total_tokens) ||
      usage.prompt_tokens + usage.completion_tokens !== usage.total_tokens ||
      usage.prompt_tokens > SCOUT_MAX_CONTEXT_TOKENS ||
      usage.completion_tokens > SCOUT_MAX_OUTPUT_TOKENS) return null;
  const estimate = Math.ceil(((usage.prompt_tokens * SCOUT_NEURONS_PER_MILLION_INPUT_TOKENS +
    usage.completion_tokens * SCOUT_NEURONS_PER_MILLION_OUTPUT_TOKENS) / 1_000_000) *
    (1 + SCOUT_NEURON_UNCERTAINTY_MARGIN));
  return Number.isSafeInteger(estimate) && estimate > 0 && estimate <= maximum ? estimate : null;
}

export function validateInferenceMetadata(value) {
  if (!exact(value, ['mode', 'usage']) || !['fresh', 'cached', 'skipped'].includes(value.mode) ||
      !exact(value.usage, usageKeys) || !usageKeys.every(key => value.usage[key] === null || safeCount(value.usage[key])) ||
      (value.usage.total_tokens !== null && usageKeys.slice(0, 2).some(key => value.usage[key] !== null && value.usage[key] > value.usage.total_tokens)))
    throw new Error('invalid_inference_metadata');
  return {mode: value.mode, usage: {...value.usage}};
}

export function boundedModelCapture(raw) {
  let value;
  let imageFieldRedacted=false;
  try {value = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);} catch {value = 'null';}
  // Decode valid JSON before redaction: escaped slashes/Unicode must not hide
  // an image URI that a later JSON parser would turn back into a payload.
  try {value = JSON.stringify(JSON.parse(value,(key,item)=>{
    if(/^(?:image_b64|jpeg_b64|snap_b64|images_b64)$/i.test(key)){
      imageFieldRedacted=true;return '[image redacted]';
    }
    return item;
  }));} catch { /* Retain malformed output for diagnostics. */ }
  // A model response is untrusted: never retain an echoed image payload.
  const imagePayload = /data:image(?:\/|\\\/)[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=\\]+/gi;
  const imageField=/((?:"|')(?:(?:image|jpeg|snap|images)_b64)(?:"|')\s*:\s*(?:"|'))[^"']*((?:"|'))/gi;
  const redacted = imageFieldRedacted || imagePayload.test(value) || imageField.test(value);
  value = value.replace(new RegExp(imagePayload.source, 'gi'), '[image redacted]');
  value = value.replace(new RegExp(imageField.source,'gi'),'$1[image redacted]$2');
  const encoded = new TextEncoder().encode(value);
  return {raw: new TextDecoder().decode(encoded.subarray(0, 32768), {stream: encoded.length > 32768}),
    truncated: encoded.length > 32768, redacted};
}

export async function inferenceKey(model, request) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({model, request})));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

export const isEvaluationEnvironment = env => env.APP_ENV === 'development' && env.VLM_EVALUATION_MODE === 'true';
export const isLoopbackRequest = request => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(request.url).hostname);

export function providerErrorDiagnostic(error) {
  let message = typeof error?.message === 'string' ? error.message : 'provider_error';
  const jsonStart=message.indexOf('{');
  if(jsonStart>=0) {
    const selected=[];
    const pick=(value,depth=0)=>{
      if(depth>4 || selected.length>=8)return;
      if(typeof value==='string')selected.push(value.slice(0,500));
      else if(Array.isArray(value))for(const item of value.slice(0,4))pick(item,depth+1);
      else if(plain(value))for(const field of ['code','message','error','detail','errors']){
        if(typeof value[field]==='number')selected.push(String(value[field]));
        else if(Object.hasOwn(value,field))pick(value[field],depth+1);
      }
    };
    try{pick(JSON.parse(message.slice(jsonStart)));}catch{/* Unstructured request bodies stay omitted. */}
    message=message.slice(0,jsonStart)+selected.join('; ');
  }
  // Opt-in local diagnostics only. Never retain echoed requests, URLs, tokens,
  // headers, images or a complete provider error object/stack.
  message = message.split(/\{|Report observations first/i)[0]
    .replace(/https?:\/\/\S+/gi,'[url redacted]')
    .replace(/(?:Bearer|x-api-key|api[_-]?key|token|secret|authorization)\s*[:=]?\s*["']?[^\s,;"']+/gi,'[credential redacted]')
    .replace(/[A-Za-z0-9_+\/=.-]{64,}/g,'[payload redacted]').slice(0,500);
  return message || 'provider_error';
}

/** One named DO owns the batch across every replay camera. Reservations remain
 * spent after errors/timeouts; only settlement removes an in-flight permit. */
export class InferenceBatchStore {
  constructor(storage, {now = () => Date.now()} = {}) {
    if (!storage?.sql?.exec || !storage.transactionSync) throw new Error('vlm_evaluation_unavailable');
    this.storage = storage;
    this.now = now;
    storage.sql.exec('CREATE TABLE IF NOT EXISTS evaluation_batch (id INTEGER PRIMARY KEY CHECK(id = 1), state_json TEXT NOT NULL)');
  }
  today() { return new Date(this.now()).toISOString().slice(0, 10); }
  normalizeLedger(state) {
    if (!state) return null;
    const today = this.today();
    if (typeof state.utc_day !== 'string' || !Number.isSafeInteger(state.day_fresh_calls)) {
      // Old batches did not have an account-day ledger. Charge their whole
      // invocation against today's conservative ceiling rather than resetting it.
      state.utc_day = today;
      state.day_fresh_calls = state.fresh_calls;
    } else if (state.utc_day !== today && !state.running?.length) {
      state.utc_day = today;
      state.day_fresh_calls = 0;
      state.neuron_reservations = [];
      state.account_snapshot = null;
    }
    if (!Array.isArray(state.neuron_reservations)) state.neuron_reservations = [];
    if (!state.account_snapshot) state.account_snapshot = null;
    return state;
  }
  read() {
    const row = this.storage.sql.exec('SELECT state_json FROM evaluation_batch WHERE id = 1').toArray()[0];
    return row ? this.normalizeLedger(JSON.parse(row.state_json)) : null;
  }
  write(state) {
    const json = JSON.stringify(state);
    if (bytes(json) > 512 * 1024) throw new Error('evaluation_state_too_large');
    this.storage.sql.exec('INSERT INTO evaluation_batch (id, state_json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json', json);
  }
  mutate(callback) {
    return this.storage.transactionSync(() => {
      const state = this.read();
      if (!state) throw new Error('vlm_evaluation_unavailable');
      const result = callback(state);
      this.write(state);
      return result;
    });
  }
  configure(input) {
    if (!plain(input) || Object.keys(input).some(key => !['batch_id', 'max_calls', 'diagnostics', 'cache_mode', 'captures', 'account_snapshot'].includes(key)) ||
        typeof input.batch_id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(input.batch_id) ||
        !Number.isSafeInteger(input.max_calls) || input.max_calls < 0 || input.max_calls > MAX_INFERENCE_BATCH_CALLS ||
        typeof input.diagnostics !== 'boolean' || !['off', 'read_write', 'read_only'].includes(input.cache_mode) ||
        (input.captures !== undefined && (!Array.isArray(input.captures) || input.captures.length > 12)))
      throw new Error('invalid_evaluation_batch');
    const captures = (input.captures ?? []).map(capture => {
      if (!plain(capture) || !validKey(capture.key) || typeof capture.raw !== 'string' || bytes(capture.raw) > 32768 ||
          capture.truncated === true || capture.redacted === true) throw new Error('invalid_evaluation_capture');
      const bounded = boundedModelCapture(capture.raw);
      if (bounded.redacted || bounded.truncated) throw new Error('invalid_evaluation_capture');
      return {key: capture.key, ...bounded, usage: normalizeInferenceUsage(capture.usage), reusable: true};
    });
    if (new Set(captures.map(capture => capture.key)).size !== captures.length) throw new Error('duplicate_evaluation_capture');
    const requestedSnapshot = input.account_snapshot === undefined ? null :
      validateAllowanceSnapshot(input.account_snapshot, this.now());
    return this.storage.transactionSync(() => {
      const old = this.read();
      if (old?.batch_id === input.batch_id) {
        if (old.max_calls !== input.max_calls || old.cache_mode !== input.cache_mode || old.capture_diagnostics !== input.diagnostics)
          throw new Error('evaluation_batch_immutable');
        if (requestedSnapshot) {
          if (old.account_snapshot && (requestedSnapshot.utc_day !== old.account_snapshot.utc_day ||
              requestedSnapshot.usage_through_ms < old.account_snapshot.usage_through_ms ||
              requestedSnapshot.observed_at_ms < old.account_snapshot.observed_at_ms ||
              requestedSnapshot.remaining_neurons > old.account_snapshot.remaining_neurons))
            throw new Error('allowance_snapshot_not_monotonic');
          old.account_snapshot = requestedSnapshot;
          this.write(old);
        }
        return this.snapshot();
      }
      if (old?.running.length) throw new Error('evaluation_batch_in_flight');
      if (requestedSnapshot && old?.account_snapshot && requestedSnapshot.utc_day === old.account_snapshot.utc_day &&
          (requestedSnapshot.usage_through_ms < old.account_snapshot.usage_through_ms ||
           requestedSnapshot.observed_at_ms < old.account_snapshot.observed_at_ms ||
           requestedSnapshot.remaining_neurons > old.account_snapshot.remaining_neurons))
        throw new Error('allowance_snapshot_not_monotonic');
      this.write({batch_id: input.batch_id, max_calls: input.max_calls, capture_diagnostics: input.diagnostics,
        cache_mode: input.cache_mode, fresh_calls: 0, cached_calls: 0, skipped_calls: 0, running: [],
        probe_key:null, usage: {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0}, captures, diagnostics: [],
        account_snapshot: requestedSnapshot ?? old?.account_snapshot ?? null,
        neuron_reservations: old?.utc_day === this.today() ? old.neuron_reservations : []});
      const state = this.read();
      state.utc_day = old?.utc_day ?? this.today();
      state.day_fresh_calls = old?.day_fresh_calls ?? 0;
      this.write(state);
      return this.snapshot();
    });
  }
  snapshot() {
    const state = this.read();
    if (!state) throw new Error('vlm_evaluation_unavailable');
    const {running, capture_diagnostics, probe_key, ...publicState} = state;
    return {...publicState, daily_max_calls: null, in_flight: running.length};
  }
  reserve(key, probe = false, allowFresh = true, maxNeurons = SCOUT_MAX_REQUEST_NEURONS) {
    if (!validKey(key)) throw new Error('invalid_evaluation_key');
    return this.mutate(state => {
      const capture = state.cache_mode === 'off' ? null : state.captures.find(item => item.key === key && item.reusable);
      if (capture) {state.cached_calls++; return {mode: 'cached', raw: capture.raw, usage: capture.usage};}
      const snapshot = state.account_snapshot;
      const snapshotValid = snapshot && snapshot.utc_day === this.today() &&
        this.now() - snapshot.observed_at_ms <= ALLOWANCE_SNAPSHOT_MAX_AGE_MS &&
        snapshot.observed_at_ms <= this.now();
      const alreadyReserved = snapshotValid ? state.neuron_reservations.filter(item =>
        item.utc_day === snapshot.utc_day && item.reserved_at_ms >= snapshot.usage_through_ms)
        .reduce((sum, item) => sum + (item.settled_neurons ?? item.reserved_neurons), 0) : 0;
      const reason = state.cache_mode === 'read_only' ? 'vlm_cache_miss' :
        !allowFresh ? 'workers_ai_binding_missing' :
        !Number.isSafeInteger(maxNeurons) || maxNeurons < SCOUT_MAX_REQUEST_NEURONS ? 'vlm_budget_estimate_unavailable' :
        state.utc_day !== this.today() && state.running.length ? 'vlm_previous_day_reservation_unresolved' :
        probe && state.probe_key ? 'vlm_inference_still_running' :
        state.running.includes(key) ? 'vlm_inference_still_running' :
        state.fresh_calls >= state.max_calls ? 'vlm_budget_exhausted' :
        !snapshotValid ? 'vlm_budget_reconciliation_required' :
        alreadyReserved + maxNeurons > Math.floor(snapshot.remaining_neurons * WORKERS_AI_NEURON_BUDGET_FRACTION) ?
          'vlm_neuron_budget_exhausted' : null;
      if (reason) {state.skipped_calls++; return {mode: 'skipped', reason};}
      const reservedAt = this.now();
      state.fresh_calls++; state.day_fresh_calls++; state.running.push(key);
      state.neuron_reservations.push({utc_day: snapshot.utc_day, request_key: key, reserved_neurons: maxNeurons,
        reserved_at_ms: reservedAt});
      if(probe)state.probe_key=key;
      return {mode: 'fresh'};
    });
  }
  complete(key, {raw, usage: providerUsage, failed = false, provider_error} = {}) {
    return this.mutate(state => {
      const index = state.running.indexOf(key);
      if (index === -1) throw new Error('unknown_evaluation_reservation');
      state.running.splice(index, 1);
      if(state.probe_key===key)state.probe_key=null;
      const usage = normalizeInferenceUsage(providerUsage);
      if (!failed) {
        const reservation = state.neuron_reservations.find(item => item.request_key === key &&
          item.utc_day === state.utc_day);
        if (reservation) {
          const settled = settledNeuronEstimate(usage, reservation.reserved_neurons);
          if (settled !== null) reservation.settled_neurons = settled;
        }
      }
      for (const name of usageKeys) {
        const sum = state.usage[name] === null || usage[name] === null ? null : state.usage[name] + usage[name];
        state.usage[name] = sum !== null && safeCount(sum) ? sum : null;
      }
      if (state.cache_mode === 'read_write' || state.capture_diagnostics) {
        const capture = {...boundedModelCapture(raw), key, usage};
        if (state.capture_diagnostics && typeof provider_error === 'string')
          capture.provider_error = providerErrorDiagnostic({message:provider_error});
        capture.reusable = !failed && !capture.truncated && !capture.redacted && capture.raw !== 'null';
        state.captures = [...state.captures.filter(item => item.key !== key), capture].slice(-12);
      }
      return {completed: true};
    });
  }
  annotate(key, validationErrors) {
    return this.mutate(state => {
      if (state.capture_diagnostics) state.diagnostics = [...state.diagnostics,
        {key, validation_errors: (Array.isArray(validationErrors) ? validationErrors : []).slice(0, 8)
          .map(value => String(value).slice(0, 300))}].slice(-12);
      return {recorded: state.capture_diagnostics};
    });
  }
}
