-- Keep old incident records; separate accepted cause from reviewable analysis.
ALTER TABLE events ADD COLUMN incident_id TEXT;
ALTER TABLE events ADD COLUMN analysis_json TEXT;
ALTER TABLE events ADD COLUMN operator_priority TEXT;
CREATE INDEX IF NOT EXISTS idx_events_incident ON events (incident_id);
