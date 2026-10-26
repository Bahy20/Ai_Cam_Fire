-- fire-guard schema
CREATE TABLE IF NOT EXISTS cameras (
  camera_id TEXT PRIMARY KEY,
  location TEXT,
  context_json TEXT,           -- {"in_kitchen": true, "near_electrical_panel": true}
  homography_json TEXT,        -- pixel -> floor x/y calibration (design doc §1)
  last_seen_ms INTEGER,
  created_ms INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  camera_id TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  cause TEXT,
  confidence TEXT,
  snapshot_key TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_cam_ts ON events (camera_id, ts_ms);
