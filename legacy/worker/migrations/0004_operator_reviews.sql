-- Human attestations are separate from immutable model-event metadata.
-- This migration never promotes events.cause or changes analysis_json.
CREATE TABLE operator_reviews (
  request_id TEXT PRIMARY KEY NOT NULL,
  camera_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  analysis_event_key TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0 AND revision = expected_revision + 1),
  subject TEXT NOT NULL,
  email TEXT NOT NULL,
  created_ms INTEGER NOT NULL CHECK (created_ms >= 0),
  disposition TEXT NOT NULL CHECK (disposition IN ('accept', 'reject', 'inconclusive')),
  ignition_source TEXT NOT NULL CHECK (ignition_source IN ('human_activity', 'electrical', 'other', 'unknown')),
  ignition_tool TEXT NOT NULL,
  independent_evidence_json TEXT,
  rationale TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  UNIQUE (camera_id, incident_id, revision),
  FOREIGN KEY (analysis_event_key) REFERENCES events(event_key),
  CHECK ((disposition = 'accept' AND ignition_source <> 'unknown' AND independent_evidence_json IS NOT NULL)
    OR (disposition IN ('reject', 'inconclusive') AND ignition_source = 'unknown' AND ignition_tool = 'unknown'))
);

CREATE TRIGGER operator_reviews_target BEFORE INSERT ON operator_reviews
BEGIN
  -- REPLACE otherwise silently deletes a historical primary-key row even when
  -- recursive delete triggers are disabled (SQLite's default).
  SELECT CASE WHEN EXISTS (SELECT 1 FROM operator_reviews WHERE request_id = NEW.request_id)
    THEN RAISE(ABORT, 'immutable review request already exists') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM events WHERE camera_id = NEW.camera_id AND incident_id = NEW.incident_id
      AND event_key = NEW.analysis_event_key AND event_kind = 'analysis'
  ) OR NOT EXISTS (
    SELECT 1 FROM events WHERE camera_id = NEW.camera_id AND incident_id = NEW.incident_id
      AND event_kind = 'confirmation'
  ) THEN RAISE(ABORT, 'review analysis target or confirmation missing') END;
  SELECT CASE WHEN NEW.expected_revision <> (
    SELECT COALESCE(MAX(revision), 0) FROM operator_reviews
    WHERE camera_id = NEW.camera_id AND incident_id = NEW.incident_id
  ) THEN RAISE(ABORT, 'review revision conflict') END;
END;

CREATE TRIGGER operator_reviews_no_update BEFORE UPDATE ON operator_reviews
BEGIN
  SELECT RAISE(ABORT, 'operator reviews are immutable append-only history');
END;
CREATE TRIGGER operator_reviews_no_delete BEFORE DELETE ON operator_reviews
BEGIN
  SELECT RAISE(ABORT, 'operator reviews are immutable append-only history');
END;
