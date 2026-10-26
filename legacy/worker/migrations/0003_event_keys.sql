-- Apply once through the migration ledger. Existing NULL identities are preserved.
-- Idempotency is per logical event, not per timestamp or incident alone.
ALTER TABLE events ADD COLUMN event_key TEXT;
ALTER TABLE events ADD COLUMN event_kind TEXT CHECK (event_kind IN ('confirmation', 'analysis'));
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_event_key ON events (event_key);
