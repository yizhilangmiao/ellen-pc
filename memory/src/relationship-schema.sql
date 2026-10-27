-- Additive, scoped by the existing database's checked owner/character identity.
CREATE TABLE IF NOT EXISTS relationship_state (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 revision INTEGER NOT NULL DEFAULT 0,
 legacy_events INTEGER NOT NULL,
 activated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS relationship_events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE REFERENCES source_events(id),
 occurred_at TEXT NOT NULL,
 assessed_at TEXT NOT NULL,
 signature TEXT NOT NULL,
 kind TEXT NOT NULL,
 assessment_json TEXT NOT NULL,
 delta_json TEXT NOT NULL,
 policy_json TEXT NOT NULL,
 before_json TEXT NOT NULL,
 after_json TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS relationship_corrections (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 target_id TEXT NOT NULL UNIQUE REFERENCES relationship_events(id),
 source_id TEXT REFERENCES source_events(id),
 actor TEXT NOT NULL CHECK(actor IN ('user','model')),
 reason TEXT NOT NULL,
 corrected_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS relationship_events_signature ON relationship_events(signature,occurred_at);
CREATE TRIGGER IF NOT EXISTS immutable_relationship_event BEFORE UPDATE ON relationship_events
BEGIN SELECT RAISE(ABORT, 'Relationship event history cannot be overwritten'); END;
CREATE TRIGGER IF NOT EXISTS immutable_relationship_correction BEFORE UPDATE ON relationship_corrections
BEGIN SELECT RAISE(ABORT, 'Relationship corrections cannot be overwritten'); END;
