CREATE TABLE store_info (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE experiences (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  experience_key TEXT NOT NULL,
  UNIQUE(conversation_id, experience_key)
) STRICT;

CREATE TABLE source_events (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  experience_key TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('companion_text','companion_voice_text','companion_voice_transcript')),
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  original_text TEXT NOT NULL CHECK(length(trim(original_text)) > 0),
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE(conversation_id, message_id)
) STRICT;

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK(length(trim(title)) > 0),
  summary TEXT NOT NULL CHECK(length(trim(summary)) > 0),
  kind TEXT NOT NULL CHECK(kind IN ('user_fact','shared_event')),
  created_at TEXT NOT NULL,
  anchor_at TEXT NOT NULL,
  anchor_experience INTEGER NOT NULL CHECK(anchor_experience >= 0),
  base_strength REAL NOT NULL DEFAULT 1.0 CHECK(base_strength > 0 AND base_strength <= 1),
  auto_retained INTEGER NOT NULL DEFAULT 0 CHECK(auto_retained IN (0,1)),
  user_retained INTEGER NOT NULL DEFAULT 0 CHECK(user_retained IN (0,1)),
  auto_suppressed INTEGER NOT NULL DEFAULT 0 CHECK(auto_suppressed IN (0,1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded')),
  superseded_by TEXT REFERENCES memories(id),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  CHECK(auto_suppressed = 0 OR auto_retained = 0),
  CHECK((status = 'active' AND superseded_by IS NULL) OR
        (status = 'superseded' AND superseded_by IS NOT NULL AND superseded_by != id))
) STRICT;

CREATE TABLE memory_sources (
  memory_id TEXT NOT NULL REFERENCES memories(id),
  event_id TEXT NOT NULL REFERENCES source_events(id),
  PRIMARY KEY(memory_id, event_id)
) STRICT;

CREATE TABLE decisions (
  id INTEGER PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories(id),
  actor TEXT NOT NULL CHECK(actor IN ('auto','user')),
  action TEXT NOT NULL CHECK(action IN ('classify','retain','release','supersede')),
  reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
  created_at TEXT NOT NULL,
  revision INTEGER NOT NULL
) STRICT;

CREATE INDEX memories_state ON memories(status, created_at);
CREATE INDEX source_events_time ON source_events(occurred_at);
CREATE INDEX memory_sources_event ON memory_sources(event_id);

-- Original inputs are evidence. Corrections create new events/versions.
CREATE TRIGGER immutable_source_update BEFORE UPDATE ON source_events
BEGIN SELECT RAISE(ABORT, 'Original source events cannot be overwritten'); END;
CREATE TRIGGER immutable_decision_update BEFORE UPDATE ON decisions
BEGIN SELECT RAISE(ABORT, 'Decision history cannot be overwritten'); END;
