import { validateIncidentRecord } from "./incident-store.js";
import { validateRecoveryRecord } from "./recovery-record.js";

// SQLite-backed metadata journal. Images remain transient in the cloud; the Pi
// archive is independent. A lifetime generation fences callbacks from old DOs.
export class CoordinatorJournal {
  constructor(storage) {
    this.storage = storage;
    this.sql = storage.sql;
    this.generation = null;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS fire_coordinator_checkpoint (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      generation INTEGER NOT NULL, checkpoint_json TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS fire_incident_outbox (
      event_key TEXT PRIMARY KEY, record_json TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS fire_native_recovery_audit (
      request_id TEXT PRIMARY KEY, record_json TEXT NOT NULL)`);
  }

  claim(initialCheckpoint, decode) {
    return this.storage.transactionSync(() => {
      const row = this.sql.exec('SELECT generation, checkpoint_json, length(CAST(checkpoint_json AS BLOB)) AS bytes FROM fire_coordinator_checkpoint WHERE singleton = 1').toArray()[0];
      if (row?.bytes > 256 * 1024) throw new Error('coordinator_state_too_large');
      if (row && (!Number.isSafeInteger(row.generation) || row.generation < 1 || row.generation >= Number.MAX_SAFE_INTEGER)) throw new Error('invalid_coordinator_generation');
      const restored = row ? decode(JSON.parse(row.checkpoint_json)) : null;
      this.readPending(); // Validate bounded recovery intents before claiming this lifetime.
      const generation = (row?.generation ?? 0) + 1;
      this.sql.exec(`INSERT INTO fire_coordinator_checkpoint (singleton, generation, checkpoint_json)
        VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET generation = excluded.generation`,
      generation, row?.checkpoint_json ?? JSON.stringify(initialCheckpoint));
      this.generation = generation;
      return {generation, restored};
    });
  }

  assertCurrent() {
    const row = this.sql.exec('SELECT generation FROM fire_coordinator_checkpoint WHERE singleton = 1').toArray()[0];
    if (!this.generation || row?.generation !== this.generation) throw new Error('stale_coordinator_instance');
  }

  commit(checkpoint, records = [], recoveryRecord = null) {
    if (!Array.isArray(records) || records.length > 64) throw new Error("incident_outbox_full");
    for (const record of records) validateIncidentRecord(record);
    if (recoveryRecord) validateRecoveryRecord(recoveryRecord);
    const checkpointJson = JSON.stringify(checkpoint);
    if (new TextEncoder().encode(checkpointJson).length > 256 * 1024) throw new Error("coordinator_state_too_large");
    this.storage.transactionSync(() => {
      this.assertCurrent();
      if (recoveryRecord) {
        const previous = this.findRecoveryAudit(recoveryRecord.request_id);
        if (previous) {
          if (Object.keys(previous).some(key => previous[key] !== recoveryRecord[key]) || records.length) {
            throw new Error('native_recovery_conflict');
          }
          return; // A lost response cannot replay an older checkpoint.
        }
        if (this.recoveryAuditCount() >= 1024) throw new Error('native_recovery_audit_full');
      }
      const keys = new Set(this.sql.exec('SELECT event_key FROM fire_incident_outbox LIMIT 65').toArray().map(row => row.event_key));
      for (const record of records) keys.add(record.event_key);
      if (keys.size > 64) throw new Error('incident_outbox_full');
      this.sql.exec('UPDATE fire_coordinator_checkpoint SET checkpoint_json = ? WHERE singleton = 1', checkpointJson);
      for (const record of records) this.sql.exec(`INSERT INTO fire_incident_outbox (event_key, record_json)
        VALUES (?, ?) ON CONFLICT(event_key) DO NOTHING`, record.event_key, JSON.stringify(record));
      if (recoveryRecord) this.sql.exec('INSERT INTO fire_native_recovery_audit (request_id, record_json) VALUES (?, ?)',
        recoveryRecord.request_id, JSON.stringify(recoveryRecord));
    });
  }

  recoveryAuditCount() {
    this.assertCurrent();
    return this.sql.exec('SELECT COUNT(*) AS count FROM fire_native_recovery_audit').toArray()[0].count;
  }

  findRecoveryAudit(requestId) {
    this.assertCurrent();
    const row = this.sql.exec('SELECT record_json FROM fire_native_recovery_audit WHERE request_id = ?', requestId).toArray()[0];
    return row ? validateRecoveryRecord(JSON.parse(row.record_json)) : null;
  }

  recoveryAudits({limit = 50, beforeRowId = null} = {}) {
    this.assertCurrent();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
        (beforeRowId !== null && (!Number.isSafeInteger(beforeRowId) || beforeRowId < 1))) {
      throw new Error('invalid_native_recovery_page');
    }
    const rows = this.sql.exec('SELECT rowid, record_json FROM fire_native_recovery_audit WHERE (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?',
      beforeRowId, beforeRowId, limit + 1).toArray();
    const visible = rows.slice(0,limit);
    return {records: visible.map(row=>validateRecoveryRecord(JSON.parse(row.record_json))),
      has_more: rows.length > limit, next_before_row_id: rows.length > limit ? visible.at(-1).rowid : null};
  }

  pending() {
    this.assertCurrent();
    return this.readPending();
  }

  readPending() {
    const sizes = this.sql.exec('SELECT event_key, length(CAST(record_json AS BLOB)) AS bytes FROM fire_incident_outbox LIMIT 65').toArray();
    if (sizes.length > 64) throw new Error("incident_outbox_full");
    if (sizes.some(row => row.bytes > 256 * 1024)) throw new Error("incident_outbox_record_bounds");
    return this.sql.exec('SELECT event_key, record_json FROM fire_incident_outbox ORDER BY rowid LIMIT 64').toArray().map(row => {
      const record = JSON.parse(row.record_json);
      validateIncidentRecord(record);
      if (record.event_key !== row.event_key) throw new Error("incident_outbox_record_identity_mismatch");
      return record;
    });
  }

  ack(eventKey) {
    this.storage.transactionSync(() => {
      this.assertCurrent();
      this.sql.exec('DELETE FROM fire_incident_outbox WHERE event_key = ?', eventKey);
    });
  }
}
