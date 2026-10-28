-- Additive runtime extension; the v1 evidence tables and format remain intact.
CREATE TABLE IF NOT EXISTS memory_jobs (
  id TEXT PRIMARY KEY REFERENCES source_events(id),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  lease TEXT, lease_until TEXT, error TEXT,
  finished_at TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS memory_meta (
  memory_id TEXT PRIMARY KEY REFERENCES memories(id),
  subject TEXT NOT NULL CHECK(subject IN ('user','relationship','episode')),
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1)
) STRICT;
CREATE TABLE IF NOT EXISTS memory_vectors (
  memory_id TEXT PRIMARY KEY REFERENCES memories(id),
  model_id TEXT NOT NULL, text_hash TEXT NOT NULL, vector_json TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS memory_recalls (
  memory_id TEXT PRIMARY KEY REFERENCES memories(id),
  experience_sequence INTEGER NOT NULL,
  recalled_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS memory_jobs_due ON memory_jobs(state,available_at);

-- Learned knowledge shares the ordinary decay/retention lifecycle. Keep the
-- original subject constraints and old data intact; this is optional provenance.
CREATE TABLE IF NOT EXISTS memory_learning (
  memory_id TEXT PRIMARY KEY REFERENCES memories(id),
  source_event_id TEXT NOT NULL REFERENCES source_events(id),
  evidence_quote TEXT NOT NULL CHECK(length(trim(evidence_quote)) > 0)
) STRICT;

-- Attachment provenance is separate from the user's literal words. No OCR,
-- video speech or model observation is promoted to a user assertion here.
CREATE TABLE IF NOT EXISTS source_media (
  event_id TEXT PRIMARY KEY REFERENCES source_events(id),
  attachments_json TEXT NOT NULL
) STRICT;

-- Optional fictional character reactions for the reading view. They never
-- become user facts, retrieval summaries or evidence of real events.
CREATE TABLE IF NOT EXISTS memory_notebook (
  memory_id TEXT PRIMARY KEY REFERENCES memories(id),
  reflection TEXT NOT NULL CHECK(length(trim(reflection)) > 0),
  source_event_id TEXT NOT NULL REFERENCES source_events(id)
) STRICT;

-- Rolling per-conversation digest. Deterministic text built from stored
-- events and memories; it never invents facts and is safe to recompute.
CREATE TABLE IF NOT EXISTS conversation_summaries (
  conversation_id TEXT PRIMARY KEY,
  summary TEXT NOT NULL CHECK(length(trim(summary)) > 0),
  covered_events INTEGER NOT NULL CHECK(covered_events >= 1),
  covered_until TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE INDEX IF NOT EXISTS source_events_conversation ON source_events(conversation_id,occurred_at);
