-- 亲密度点数：独立于既有 relationship_events 三轴引擎。
-- 只记"数了多少条、过了多少天"，不做语义评估。
CREATE TABLE IF NOT EXISTS bond_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  points INTEGER NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT 'acquainted',
  stage_messages INTEGER NOT NULL DEFAULT 0,
  stage_started_at TEXT NOT NULL DEFAULT '',
  last_day TEXT,
  replayed INTEGER NOT NULL DEFAULT 0,
  notice_stage TEXT,
  notice_at TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS letters (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('letter','love')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  signature TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  unlocked_at TEXT
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS letters_stage_unique ON letters(character_id, stage);

CREATE TABLE IF NOT EXISTS bond_log (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  from_stage TEXT,
  to_stage TEXT,
  points INTEGER NOT NULL,
  messages INTEGER NOT NULL,
  detail TEXT
) STRICT;
