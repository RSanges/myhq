import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type Db = Database.Database;

export const RUN_STATUSES = ["running", "done", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * `pending` waits for a decision (approved, rejected, revise). `unseen` and
 * `seen` belong to the informational items (`notifyTypes`): they wait for a
 * look, not a decision, and `seen` is where they end up (see approvals.ts).
 */
export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "revise", "unseen", "seen"] as const;
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
  /** JSON array of the shared resources (agents[].resources) the run holds while it runs. */
  resources: string;
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
  /** Room of the recipient when it is not the sender's (a shared room, or the room that ordered), null otherwise. */
  to_room: string | null;
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
  /** For a message: the room and the agent that sent it (the requester of an order to a shared room). */
  from_room: string | null;
  from_agent: string | null;
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
  /** JSON array of the decisions this item had before its last one (see decision-history.ts). */
  decision_history: string;
  decided_at: string | null;
  seen_by_agent_at: string | null;
  notified_at: string | null;
  /** The room that ordered the item from a shared room: it shows in that room's pile. Null: the agent's own room. */
  for_room: string | null;
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
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'revise')),
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
  {
    version: 10,
    sql: `
-- An approved, rejected or revised item can be sent back for a revision: the
-- decision it had is kept here, a JSON array of { decision, note, annotations,
-- decidedAt }, oldest first.
ALTER TABLE approvals ADD COLUMN decision_history TEXT NOT NULL DEFAULT '[]';
`,
  },
  {
    version: 11,
    sql: `
-- Informational items (notifyTypes) no longer vanish: they wait on the desk as
-- 'unseen' until the user marks them 'seen'. SQLite cannot widen a CHECK
-- constraint, so the table is rebuilt with the same rows (the items that were
-- born approved keep their status), then its indexes and triggers come back.
CREATE TABLE approvals_new (
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
  created_at TEXT NOT NULL,
  annotations TEXT NOT NULL DEFAULT '[]',
  decision_history TEXT NOT NULL DEFAULT '[]'
);
INSERT INTO approvals_new (id, room, agent_id, run_id, type, title, body, payload, status, decision_note, decided_at,
    seen_by_agent_at, notified_at, created_at, annotations, decision_history)
  SELECT id, room, agent_id, run_id, type, title, body, payload, status, decision_note, decided_at,
    seen_by_agent_at, notified_at, created_at, annotations, decision_history FROM approvals;
DROP TABLE approvals;
ALTER TABLE approvals_new RENAME TO approvals;
CREATE INDEX IF NOT EXISTS approvals_status ON approvals (status);
CREATE INDEX IF NOT EXISTS approvals_agent ON approvals (room, agent_id);
CREATE TRIGGER IF NOT EXISTS approvals_changed_insert AFTER INSERT ON approvals
BEGIN INSERT INTO changes (entity, entity_id) VALUES ('approval', NEW.id); END;
CREATE TRIGGER IF NOT EXISTS approvals_changed_update AFTER UPDATE OF status ON approvals
BEGIN INSERT INTO changes (entity, entity_id) VALUES ('approval', NEW.id); END;
`,
  },
  {
    version: 12,
    sql: `
-- Shared studio rooms (room.json "shared"): every room may order from them.
ALTER TABLE rooms ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;
-- A message may go to an agent of another room (a shared one, or the room
-- that ordered): its room, NULL when it is the sender's.
ALTER TABLE messages ADD COLUMN to_room TEXT;
-- A task given by a message keeps who sent it, so that a studio may answer
-- the agent that ordered from it.
ALTER TABLE tasks ADD COLUMN from_room TEXT;
ALTER TABLE tasks ADD COLUMN from_agent TEXT;
-- An item a shared room delivers to the room that ordered it (hq_submit
-- forRoom): it shows in that room's pile, its decisions go back to its agent.
ALTER TABLE approvals ADD COLUMN for_room TEXT;
-- The shared resources a run holds (agents[].resources): two runs holding a
-- common one never run at once.
ALTER TABLE runs ADD COLUMN resources TEXT NOT NULL DEFAULT '[]';
`,
  },
  {
    version: 13,
    sql: `
-- Files joined to an item (hq_submit attachments): a copy of each one lives in
-- data/attachments/<approval_id>/<id><ext>. No foreign key, so that a rebuild
-- of approvals (as in migration 11) never cascades onto the files.
CREATE TABLE approval_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  caption TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX approval_files_approval ON approval_files (approval_id);
`,
  },
  {
    version: 14,
    sql: `
-- The same table as migration 13, written to be idempotent. The database in
-- service reached version 13 through an abandoned draft of that migration (it
-- only widened the tasks.source constraint), so the real migration 13 never ran
-- there and the table is missing. A new database has it from 13 and this
-- changes nothing; the one in service gets it here. Nothing else is touched.
CREATE TABLE IF NOT EXISTS approval_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  caption TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS approval_files_approval ON approval_files (approval_id);
`,
  },
  {
    version: 15,
    sql: `
-- When the owner last opened the page of a desk object (/bureau/<id>): the
-- sources that count what is unread (summaries, chat) only count what came
-- after it. One row per object id of myhq.json's desk block.
CREATE TABLE IF NOT EXISTS desk_seen (
  object_id TEXT PRIMARY KEY,
  seen_at TEXT NOT NULL
);
`,
  },
  {
    version: 16,
    sql: `
-- The supervisor of the Standard (docs/architecture.md, "The supervisor").
-- Every statement is idempotent, as the migrations after 14 must be.
-- The supervisors of the home, mirrored from room.json by syncHome, so that
-- the HQ MCP server, which only reads the database, knows who may use the
-- supervisor's tools.
CREATE TABLE IF NOT EXISTS supervisors (
  room TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (room, agent_id)
);
-- A supervisor's word on an entry of the Standard (hq_blocked_note), one row
-- per task of the entry: what it did, or what the owner is expected to do
-- (handed_off = 1, the entry is handed to the owner).
CREATE TABLE IF NOT EXISTS blocked_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  room TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  run_id INTEGER,
  text TEXT NOT NULL,
  handed_off INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS blocked_notes_task ON blocked_notes (task_id);
-- A relaunch asked by a supervisor (hq_relaunch): the HQ MCP server puts the
-- tasks back to pending and records it, the app starts the run
-- (handled_at, run_id, or the code of what held it back in waiting).
CREATE TABLE IF NOT EXISTS supervisor_relaunches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_kind TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  room TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_ids TEXT NOT NULL,
  by_room TEXT NOT NULL,
  by_agent TEXT NOT NULL,
  by_run INTEGER,
  created_at TEXT NOT NULL,
  handled_at TEXT,
  run_id INTEGER,
  waiting TEXT
);
-- The tasks of the Standard already given to the supervisor by a wake-up.
CREATE TABLE IF NOT EXISTS standard_announced (
  task_id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL,
  announced_at TEXT NOT NULL
);
`,
  },
  {
    version: 17,
    sql: `
-- The deadlines of a run (docs/architecture.md, "Long runs"), one row per run,
-- written by the runner at its start. Idempotent, as the migrations after 14.
-- deadline_at: when the runner looks at the run again (the soft deadline,
-- pushed by a check, a slice or hq_run_extend); hard_deadline_at: the run is
-- always interrupted then. check_asked_at: a check of the supervisor waits for
-- its decision. The stop_* columns: hq_run_stop, applied by the app.
CREATE TABLE IF NOT EXISTS run_deadlines (
  run_id INTEGER PRIMARY KEY,
  budget_usd REAL NOT NULL,
  deadline_at TEXT NOT NULL,
  hard_deadline_at TEXT NOT NULL,
  extensions INTEGER NOT NULL DEFAULT 0,
  checks INTEGER NOT NULL DEFAULT 0,
  slices INTEGER NOT NULL DEFAULT 0,
  check_asked_at TEXT,
  check_run_id INTEGER,
  note_task_id INTEGER,
  stop_reason TEXT,
  stop_room TEXT,
  stop_agent TEXT,
  stop_requested_at TEXT,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    version: 18,
    sql: `
-- The portier and the approvals MyHQ executes itself (docs/architecture.md,
-- "The portier" and "Executing an approved item"). Idempotent, as the
-- migrations after 14.
-- One row per message task whose wake MyHQ decided on: what its sender
-- expects (the expects of hq_message: reply, action, none; null when not said)
-- and the portier's verdict that covers it (portier_verdicts.id).
CREATE TABLE IF NOT EXISTS message_wake (
  task_id INTEGER PRIMARY KEY,
  expects TEXT,
  verdict_id INTEGER
);
-- Every call of the portier: the messages it read (task_ids, JSON), wake or
-- skip with its reason, what it cost, and the error of a call that failed
-- open (verdict wake).
CREATE TABLE IF NOT EXISTS portier_verdicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_ids TEXT NOT NULL,
  verdict TEXT NOT NULL,
  reason TEXT NOT NULL,
  model TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS portier_verdicts_created ON portier_verdicts (created_at);
-- The messages an item asks MyHQ to deliver when it is approved (hq_submit
-- onApprove, JSON array of { room, agent, text }), and when they were.
CREATE TABLE IF NOT EXISTS approval_relays (
  approval_id INTEGER PRIMARY KEY,
  messages TEXT NOT NULL,
  delivered_at TEXT
);
-- The approval command of an agent (onApproval "command") run for an item:
-- ok = 1 and its note when it executed the item, else the error that sent
-- the item back to the agent as a task.
CREATE TABLE IF NOT EXISTS approval_commands (
  approval_id INTEGER PRIMARY KEY,
  ok INTEGER,
  note TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
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

/**
 * How long a connection waits for another one's write lock before SQLITE_BUSY.
 * Several processes write to the same file (the app, one HQ MCP server per
 * run), and every write is short. The wait only applies when a statement
 * starts without a transaction or with BEGIN IMMEDIATE: a deferred transaction
 * that reads first and writes next fails at once when another connection
 * wrote in between, so every transaction that writes after a read is
 * `.immediate()`.
 */
export const BUSY_TIMEOUT_MS = 10_000;

/** Opens (and creates on first use) the SQLite database, then migrates it. */
export function openDb(dbPath: string): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  // First, so that even switching the journal mode waits for a busy file.
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.pragma("journal_mode = WAL");
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
