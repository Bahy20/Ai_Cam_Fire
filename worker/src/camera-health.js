// Device heartbeat only: never observation freshness, fire lifecycle or alert delivery.
export const HEALTH_LIMITS = Object.freeze({requestBytes: 1024, offlineMs: 60000,
  clockSkewMs: 30000, dedupIds: 64, historyEvents: 256, historyPage: 50});
export class CameraHealthError extends Error {
  constructor(code, status = 422) { super(code); this.code = code; this.status = status; }
}
export { CameraHealthError as HealthError };
function storageCall(callback) {
  try { return callback(); }
  catch (error) {
    if (error instanceof CameraHealthError) throw error;
    throw new CameraHealthError('camera_health_storage_failed', 503);
  }
}
function validCamera(cameraId) {
  if (typeof cameraId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(cameraId) || /\s/.test(cameraId))
    throw new CameraHealthError('invalid_camera_identity', 400);
}
function validTime(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000)
    throw new CameraHealthError('invalid_heartbeat_timestamp');
}
function validate(body, cameraId, nowMs) {
  validTime(nowMs);
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).length !== 4 || !['camera_id', 'heartbeat_id', 'sent_at_ms', 'status'].every(k => Object.hasOwn(body, k)))
    throw new CameraHealthError('invalid_heartbeat_body');
  validCamera(body.camera_id);
  if (cameraId !== null && body.camera_id !== cameraId) throw new CameraHealthError('camera_id_mismatch', 400);
  if (typeof body.heartbeat_id !== 'string' || body.heartbeat_id.length !== 36 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(body.heartbeat_id))
    throw new CameraHealthError('invalid_heartbeat_id');
  if (!['ok', 'capture_error', 'inference_error', 'storage_error', 'stalled'].includes(body.status))
    throw new CameraHealthError('invalid_heartbeat_status');
  validTime(body.sent_at_ms);
  if (Math.abs(nowMs - body.sent_at_ms) > HEALTH_LIMITS.clockSkewMs)
    throw new CameraHealthError('heartbeat_timestamp_outside_window');
  if (new TextEncoder().encode(JSON.stringify(body)).byteLength > HEALTH_LIMITS.requestBytes)
    throw new CameraHealthError('heartbeat_body_too_large', 413);
}
// All mutations are synchronous SQL transactions; caller owns generation fencing
// and the DO's one shared alarm. Null camera identity recovers the durable binding.
// Events are immutable while retained: only the newest 256 health transitions
// survive. This is a pollable recent-health log, not incident/evidence retention
// or an external notification outbox. Snapshot reflects timeout without writing;
// call expire() to durably record the transition before publishing it.
export class CameraHealth {
  constructor(storage, cameraId = null) {
    if (cameraId !== null) validCamera(cameraId);
    this.storage = {transactionSync: callback => storageCall(() => storage.transactionSync(callback))};
    this.sql = {exec: (...args) => storageCall(() => {
      const cursor = storage.sql.exec(...args);
      return {toArray: () => storageCall(() => cursor.toArray())};
    })};
    this.sql.exec(`CREATE TABLE IF NOT EXISTS camera_health_binding (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), camera_id TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS camera_health_state (
      camera_id TEXT PRIMARY KEY, status TEXT NOT NULL, reason TEXT,
      last_seen_ms INTEGER, sent_watermark_ms INTEGER, sequence INTEGER NOT NULL,
      heartbeat_ids_json TEXT NOT NULL DEFAULT '[]')`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS camera_health_events (
      camera_id TEXT NOT NULL, sequence INTEGER NOT NULL, status TEXT NOT NULL,
      reason TEXT, at_ms INTEGER NOT NULL, last_seen_ms INTEGER,
      PRIMARY KEY(camera_id, sequence))`);
    this.migrateHeartbeatDedup();
    if (cameraId !== null) this.storage.transactionSync(() => this.bind(cameraId));
  }

  migrateHeartbeatDedup() {
    const columns=this.sql.exec('PRAGMA table_info(camera_health_state)').toArray();
    if (columns.some(column=>column.name==='heartbeat_ids_json')) return;
    this.storage.transactionSync(()=>{
      this.sql.exec("ALTER TABLE camera_health_state ADD COLUMN heartbeat_ids_json TEXT NOT NULL DEFAULT '[]'");
      const legacy=this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        'camera_health_dedup').toArray().length>0;
      const cameraId=this.cameraId;
      if (!legacy || cameraId===null) return;
      const ids=this.sql.exec(`SELECT heartbeat_id FROM camera_health_dedup WHERE camera_id = ?
        ORDER BY sent_at_ms DESC LIMIT ?`,cameraId,HEALTH_LIMITS.dedupIds).toArray()
        .map(row=>row.heartbeat_id).reverse();
      if (ids.length) this.sql.exec('UPDATE camera_health_state SET heartbeat_ids_json = ? WHERE camera_id = ?',
        JSON.stringify(ids),cameraId);
    });
  }

  get cameraId() {
    return this.sql.exec('SELECT camera_id FROM camera_health_binding WHERE singleton = 1').toArray()[0]?.camera_id ?? null;
  }

  bind(cameraId) {
    const existing = this.cameraId;
    if (existing !== null && existing !== cameraId) throw new CameraHealthError('camera_id_mismatch', 400);
    this.sql.exec('INSERT INTO camera_health_binding(singleton, camera_id) VALUES (1, ?) ON CONFLICT(singleton) DO NOTHING', cameraId);
    this.sql.exec(`INSERT INTO camera_health_state
      (camera_id, status, reason, last_seen_ms, sent_watermark_ms, sequence, heartbeat_ids_json)
      VALUES (?, 'unknown', NULL, NULL, NULL, 0, '[]') ON CONFLICT(camera_id) DO NOTHING`, cameraId);
  }

  state() {
    return this.sql.exec('SELECT * FROM camera_health_state WHERE camera_id = ?', this.cameraId).toArray()[0] ??
      {status: 'unknown', reason: null, last_seen_ms: null, sent_watermark_ms: null, sequence: 0};
  }

  receive(body, nowMs = Date.now()) {
    validate(body, this.cameraId, nowMs);
    return this.storage.transactionSync(() => {
      this.bind(body.camera_id);
      let state = this.state();
      let heartbeatIds;
      try { heartbeatIds=JSON.parse(state.heartbeat_ids_json ?? '[]'); }
      catch { throw new CameraHealthError('camera_health_storage_failed',503); }
      if (!Array.isArray(heartbeatIds) || heartbeatIds.length>HEALTH_LIMITS.dedupIds ||
          heartbeatIds.some(id=>typeof id!=='string')) throw new CameraHealthError('camera_health_storage_failed',503);
      const duplicate = heartbeatIds.includes(body.heartbeat_id);
      if (duplicate || (state.sent_watermark_ms !== null && body.sent_at_ms <= state.sent_watermark_ms)) {
        return {accepted: false, duplicate, reason: duplicate ? 'duplicate' : 'out_of_order', health: this.snapshot(nowMs), transition: null, transitions: []};
      }
      const status = body.status === 'ok' ? 'online' : 'degraded';
      const expired = this.expireState(state, nowMs);
      if (expired) state = this.state();
      const reason = body.status === 'ok' ? null : body.status;
      const changed = state.status !== status || state.reason !== reason;
      const sequence = state.sequence + Number(changed);
      heartbeatIds=[...heartbeatIds,body.heartbeat_id].slice(-HEALTH_LIMITS.dedupIds);
      this.sql.exec(`UPDATE camera_health_state SET status = ?, reason = ?, last_seen_ms = ?,
        sent_watermark_ms = ?, sequence = ?, heartbeat_ids_json = ? WHERE camera_id = ?`,
      status, reason, nowMs, body.sent_at_ms, sequence, JSON.stringify(heartbeatIds), this.cameraId);
      if (changed) this.sql.exec(`INSERT INTO camera_health_events
        (camera_id, sequence, status, reason, at_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?, ?)`,
      this.cameraId, sequence, status, reason, nowMs, nowMs);
      this.prune();
      const transitions = expired ? this.history({limit: 2}).events.reverse() : changed ? this.history({limit: 1}).events : [];
      return {accepted: true, duplicate: false, reason: null, health: this.snapshot(nowMs),
        transition: transitions.at(-1) ?? null, transitions};
    });
  }

  expire(nowMs = Date.now()) {
    validTime(nowMs);
    return this.storage.transactionSync(() => {
      const state = this.state();
      const due = this.expireState(state, nowMs);
      if (due) this.prune();
      const transitions = due ? this.history({limit: 1}).events : [];
      return {accepted: due, duplicate: false, health: this.snapshot(nowMs), transition: transitions[0] ?? null, transitions};
    });
  }

  expireState(state, nowMs) {
    const due = state.last_seen_ms !== null && state.status !== 'offline' && nowMs >= state.last_seen_ms + HEALTH_LIMITS.offlineMs;
    if (due) {
      const sequence = state.sequence + 1;
      this.sql.exec(`UPDATE camera_health_state SET status = 'offline', reason = 'heartbeat_timeout', sequence = ? WHERE camera_id = ?`, sequence, this.cameraId);
      this.sql.exec(`INSERT INTO camera_health_events
        (camera_id, sequence, status, reason, at_ms, last_seen_ms) VALUES (?, ?, 'offline', 'heartbeat_timeout', ?, ?)`,
      this.cameraId, sequence, nowMs, state.last_seen_ms);
    }
    return due;
  }

  snapshot(nowMs = Date.now()) {
    const state = this.state();
    const timedOut = state.last_seen_ms !== null && nowMs >= state.last_seen_ms + HEALTH_LIMITS.offlineMs;
    return {camera_id: this.cameraId, status: timedOut ? 'offline' : state.status,
      reason: timedOut ? 'heartbeat_timeout' : state.reason,
      last_seen_ms: state.last_seen_ms, sequence: state.sequence};
  }

  nextDeadline() {
    const state = this.state();
    return state.last_seen_ms === null || state.status === 'offline' ? null : state.last_seen_ms + HEALTH_LIMITS.offlineMs;
  }

  history({limit = 50, beforeSequence = null} = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > HEALTH_LIMITS.historyPage ||
        (beforeSequence !== null && (!Number.isSafeInteger(beforeSequence) || beforeSequence < 1)))
      throw new CameraHealthError('invalid_health_history_pagination', 400);
    const events = this.sql.exec(`SELECT * FROM camera_health_events WHERE camera_id = ?
      AND (? IS NULL OR sequence < ?) ORDER BY sequence DESC LIMIT ?`,
    this.cameraId, beforeSequence, beforeSequence, limit + 1).toArray().map(row => ({type: 'camera_health', ...row}));
    const has_more = events.length > limit;
    if (has_more) events.pop();
    return {events, has_more, before_sequence: has_more ? events.at(-1).sequence : null};
  }

  prune() {
    // Health-only rolling retention. Incident/evidence tables are never accessed.
    this.sql.exec(`DELETE FROM camera_health_events WHERE camera_id = ? AND sequence NOT IN
      (SELECT sequence FROM camera_health_events WHERE camera_id = ? ORDER BY sequence DESC LIMIT ?)`,
    this.cameraId, this.cameraId, HEALTH_LIMITS.historyEvents);
  }
}
