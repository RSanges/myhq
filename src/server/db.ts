import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type Db = Database.Database;

export const RUN_STATUSES = ["running", "done", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "revise"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const TASK_STATUSES = ["pending", "in_progress", "done", "blocked"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Where a task comes from: a run's own instruction, a message, a revision, an approved item, a chat request. */
export const TASK_SOURCES = ["manual", "message", "revise", "approval", "chat"] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];

export const EVENT_TYPES = ["start", "text", "tool_call", "tool_result", "end"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const FIRING_OUTCOMES = ["started", "skipped_busy", "skipped_cap", "skipped_unarmed", "error"] as const;
export type FiringOutcome = (typeof FIRING_OUTCOMES)[number];

export type FiringRow = {
  id: number;
  room: string;
  agent_id: string;
  cron: string;
  task: string | null;
  scheduled_at: string;
  outcome: FiringOutcome;
  run_id: number | null;
  detail: string | null;
  created_at: string;
};

export type RunRow = {
  id: number;
  room: string;
  agent_id: string;
  engine: string;
  task: string;
  status: RunStatus;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cost_usd: number;
  started_at: string;
  ended_at: string | null;
  summary: string | null;
  session_id: string | null;
  /** Why the run was started (`mail`, `approval`, `message`...), null for a run started by hand or a routine. */
  reason: string | null;
};

export type EventRow = {
  id: number;
  run_id: number;
  room: string;
  agent_id: string;
  type: EventType;
  data: string;
  created_at: string;
};

export type MessageRow = {
  id: number;
  room: string;
  from_agent: string;
  to_agent: string;
  text: string;
  run_id: number | null;
  created_at: string;
};

export type TaskRow = {
  id: number;
  room: string;
  agent_id: string;
  source: TaskSource;
  ref_id: number | null;
  text: string;
  status: TaskStatus;
  note: string | null;
  run_id: number | null;
  created_at: string;
  updated_at: string;
};

export type ApprovalRow = {
  id: number;
  room: string;
  agent_id: string;
  run_id: number | null;
  type: string;
  title: string;
  body: string;
  payload: string;
  status: ApprovalStatus;
  decision_note: string | null;
  /** JSON array of annotations (see annotations.ts) given with a revise or reject decision. */
  annotations: string;
  decided_at: string | null;
  seen_by_agent_at: string | null;
  notified_at: string | null;
  created_at: string;
};

export type ChangeRow = {
  seq: number;
  entity: "run" | "event" | "message" | "approval";
  entity_id: number;
};

const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(", ");

/**
 * Ordered SQL migrations. Each one runs once, inside a transaction, and is
 * recorded in `schema_migrations`. Never edit a migration that has shipped:
 * add a new one.
 */
const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS rooms (
  name TEXT PRIMARY KEY,
  target_repo TEXT NOT NULL,
  synced_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  room TEXT NOT NULL REFERENCES rooms(name) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  model TEXT NOT NULL,
  role_path TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (room, id)
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  engine TEXT NOT NULL,
  task TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (${list(RUN_STATUSES)})),
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  summary TEXT,
  session_id TEXT
);
CREATE INDEX IF NOT EXISTS runs_agent ON runs (room, agent_id, status);
CREATE INDEX IF NOT EXISTS runs_started ON runs (started_at);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  room TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (${list(EVENT_TYPES)})),
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_run ON events (run_id);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  text TEXT NOT NULL,
  run_id INTEGER REFERENCES runs(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('manual', 'message', 'revise')),
  ref_id INTEGER,
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (${list(TASK_STATUSES)})),
  note TEXT,
  run_id INTEGER REFERENCES runs(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_agent ON tasks (room, agent_id, status);

CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  run_id INTEGER REFERENCES runs(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN (${list(APPROVAL_STATUSES)})),
  decision_note TEXT,
  decided_at TEXT,
  seen_by_agent_at TEXT,
  notified_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS approvals_status ON approvals (status);
CREATE INDEX IF NOT EXISTS approvals_agent ON approvals (room, agent_id);

CREATE TABLE IF NOT EXISTS memories (
  room TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (room, agent_id, key)
);

-- One row per change the UI follows, written by triggers so that changes made
-- by other processes (the HQ MCP server) reach the live feed too.
CREATE TABLE IF NOT EXISTS changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL CHECK (entity IN ('run', 'event', 'message', 'approval')),
  entity_id INTEGER NOT NULL
);

CREATE TRIGGER IF NOT EXISTS runs_changed_insert AFTER INSERT ON runs
BEGIN INSERT INTO changes (entity, entity_id) VALUES ('run', NEW.id); END;
CREATE TRIGGER IF NOT EXISTS runs_changed_update AFTER UPDATE OF status ON runs
BEGIN INSERT INTO changes (entity, entity_id) VALUES ('run', NEW.id); END;
CREATE TRIGGER IF NOT EXISTS events_changed_insert AFTER INSERT ON events
BEGIN INSERT INTO changes (entity, entity_id) VALUES ('event', NEW.id); END;
CREATE TRIGGER IF NOT EXISTS messages_changed_insert AFTER INSERT ON messages
BEGIN INSERT INTO changes (entity, entity_id) VALUES ('message', NEW.id); END;
CREATE TRIGGER IF NOT EXISTS approvals_changed_insert AFTER INSERT ON approvals
BEGIN INSERT INTO changes (entity, entity_id) VALUES ('approval', NEW.id); END;
CREATE TRIGGER IF NOT EXISTS approvals_changed_update AFTER UPDATE OF status ON approvals
BEGIN INSERT INTO changes (entity, entity_id) VALUES ('approval', NEW.id); END;
`,
  },
  {
    version: 2,
    sql: `
-- Armed state of an agent's routines: NULL until changed from the interface
-- or the assistant, in which case room.json's "armed" applies.
ALTER TABLE agents ADD COLUMN armed INTEGER;

-- One row per routine that came due: what the scheduler did with it.
CREATE TABLE IF NOT EXISTS routine_firings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  cron TEXT NOT NULL,
  task TEXT,
  scheduled_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN (${list(FIRING_OUTCOMES)})),
  run_id INTEGER REFERENCES runs(id),
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS routine_firings_agent ON routine_firings (room, agent_id);
`,
  },
  {
    version: 3,
    sql: `
-- Why a run was started (POST /api/runs "reason", or MyHQ's own wake-ups).
ALTER TABLE runs ADD COLUMN reason TEXT;
`,
  },
  {
    version: 4,
    sql: `
-- Tasks may come from an approved item (agents[].onApproval): SQLite cannot
-- widen a CHECK constraint, so the table is rebuilt with the same rows.
CREATE TABLE tasks_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN (${list(TASK_SOURCES)})),
  ref_id INTEGER,
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (${list(TASK_STATUSES)})),
  note TEXT,
  run_id INTEGER REFERENCES runs(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO tasks_new (id, room, agent_id, source, ref_id, text, status, note, run_id, created_at, updated_at)
  SELECT id, room, agent_id, source, ref_id, text, status, note, run_id, created_at, updated_at FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;
CREATE INDEX IF NOT EXISTS tasks_agent ON tasks (room, agent_id, status);
`,
  },
  {
    version: 5,
    sql: `
-- Tasks may come from a request written by the assistant's chat (assistant.json
-- chat.requests): same rebuild as above, with the widened list.
CREATE TABLE tasks_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN (${list(TASK_SOURCES)})),
  ref_id INTEGER,
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (${list(TASK_STATUSES)})),
  note TEXT,
  run_id INTEGER REFERENCES runs(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO tasks_new (id, room, agent_id, source, ref_id, text, status, note, run_id, created_at, updated_at)
  SELECT id, room, agent_id, source, ref_id, text, status, note, run_id, created_at, updated_at FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;
CREATE INDEX IF NOT EXISTS tasks_agent ON tasks (room, agent_id, status);
`,
  },
  {
    version: 6,
    sql: `
-- One row per turn of the assistant's chat, which is not a run (no lock, no
-- daily cap) but is metered like one.
CREATE TABLE IF NOT EXISTS chat_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  engine TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('done', 'failed')),
  reason TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  tools TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_turns_started ON chat_turns (started_at);
`,
  },
  {
    version: 7,
    sql: `
-- The assistant's conversation as MyHQ keeps it (any engine): the user's
-- messages, the chat's replies, and what the bot sent on its own (alerts,
-- informational items, run summaries such as a brief). /new empties it.
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'bot')),
  kind TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`,
  },
  {
    version: 8,
    sql: `
-- The conversation is shared by every channel (Telegram, the desk's panel):
-- each message says where it was exchanged, and a message the user addressed
-- to an agent from the desk keeps its target (JSON {"room","agent"}). The
-- messages that exist were all exchanged on Telegram.
ALTER TABLE chat_messages ADD COLUMN channel TEXT NOT NULL DEFAULT 'telegram';
ALTER TABLE chat_messages ADD COLUMN target TEXT;
`,
  },
  {
    version: 9,
    sql: `
-- A revise or reject decision may carry annotations on passages of the body:
-- a JSON array of { quote, comment, position? }, next to the free note.
ALTER TABLE approvals ADD COLUMN annotations TEXT NOT NULL DEFAULT '[]';
`,
  },
];

function migrate(db: Db): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    db
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((row) => (row as { version: number }).version),
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        migration.version,
        now(),
      );
    }).immediate();
  }
}

/** Opens (and creates on first use) the SQLite database, then migrates it. */
export function openDb(dbPath: string): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

const globalForDb = globalThis as unknown as { __myhqDbs?: Map<string, Db> };

/** One shared connection per database file and per process. */
export function getDbAt(dbPath: string): Db {
  globalForDb.__myhqDbs ??= new Map();
  let db = globalForDb.__myhqDbs.get(dbPath);
  if (!db) {
    db = openDb(dbPath);
    globalForDb.__myhqDbs.set(dbPath, db);
  }
  return db;
}

export function now(): string {
  return new Date().toISOString();
}
