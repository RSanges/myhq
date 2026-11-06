import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { openDb, type Db } from "../src/server/db";

/** Columns and index of approval_files, the way both migration paths must leave them. */
function approvalFilesSchema(db: Db | Database.Database) {
  return {
    columns: db.prepare("SELECT name, type, \"notnull\", pk FROM pragma_table_info('approval_files')").all(),
    index: db.prepare("SELECT name FROM pragma_index_list('approval_files')").all(),
    indexColumns: db.prepare("SELECT name FROM pragma_index_info('approval_files_approval')").all(),
  };
}

function versions(db: Db | Database.Database): number[] {
  return (db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: number }[]).map(
    (row) => row.version,
  );
}

function tempDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "myhq-migration14-")), "hq.db");
}

/** A database as it is after the real migrations, then put back at version 13 without the table of 14 (the later ones run again, idempotent). */
function databaseOfService(file: string): void {
  const db = openDb(file);
  db.exec("DROP TABLE approval_files; DELETE FROM schema_migrations WHERE version >= 14;");
  db.close();
}

const REFERENCE = (() => {
  const file = tempDb();
  const db = openDb(file);
  const schema = approvalFilesSchema(db);
  db.close();
  return schema;
})();

test("migration 14: a new database goes through 13 then 14 and has the table once", () => {
  const db = openDb(tempDb());
  assert.deepEqual(versions(db), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual(approvalFilesSchema(db), REFERENCE);
  assert.equal(REFERENCE.columns.length, 8);
  assert.deepEqual(REFERENCE.index, [{ name: "approval_files_approval" }]);
  db.close();
});

test("migration 14: the database in service (version 13 without the table) gets the same schema", () => {
  const file = tempDb();
  databaseOfService(file);
  const raw = new Database(file);
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'approval_files'").get() as { n: number }).n, 0);
  assert.equal(Math.max(...versions(raw)), 13);
  raw.close();

  const db = openDb(file);
  assert.equal(Math.max(...versions(db)), 17, "and the later ones");
  assert.deepEqual(approvalFilesSchema(db), REFERENCE);
  db.close();
});

test("migration 14: the abandoned draft of 13 (tasks widened with 'need') gets the table and nothing else changes", () => {
  const file = tempDb();
  databaseOfService(file);
  // The draft's work: tasks rebuilt with 'need' in the constraint of source, and some rows.
  const raw = new Database(file);
  const at = "2026-11-01T08:00:00.000Z";
  raw.exec(`
    CREATE TABLE tasks_draft (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('manual', 'message', 'revise', 'approval', 'chat', 'need')),
      ref_id INTEGER,
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'done', 'blocked')),
      note TEXT,
      run_id INTEGER REFERENCES runs(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      from_room TEXT,
      from_agent TEXT
    );
    DROP TABLE tasks;
    ALTER TABLE tasks_draft RENAME TO tasks;
  `);
  raw.prepare(
    "INSERT INTO tasks (room, agent_id, source, text, status, created_at, updated_at) VALUES ('demo', 'scout', 'need', 'a need', 'pending', ?, ?)",
  ).run(at, at);
  const tasksBefore = raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'tasks'").get() as { sql: string };
  const tablesBefore = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
  raw.close();

  const db = openDb(file);
  assert.deepEqual(approvalFilesSchema(db), REFERENCE);
  // The draft's tasks table is as it was, rows included.
  assert.deepEqual(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'tasks'").get(), tasksBefore);
  assert.deepEqual(db.prepare("SELECT source, text FROM tasks").all(), [{ source: "need", text: "a need" }]);
  // The only table that appeared is approval_files.
  const tablesAfter = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
  assert.deepEqual(
    tablesAfter.filter((t) => !(tablesBefore as { name: string }[]).some((b) => b.name === (t as { name: string }).name)),
    [{ name: "approval_files" }],
  );
  db.close();
});

test("migration 14: it is a no-op when the table and its rows already exist", () => {
  const file = tempDb();
  const db = openDb(file);
  db.prepare(
    "INSERT INTO approval_files (approval_id, name, mime, size, sha256, created_at) VALUES (1, 'a.png', 'image/png', 3, 'x', '2026-11-01T08:00:00.000Z')",
  ).run();
  db.exec("DELETE FROM schema_migrations WHERE version = 14;");
  db.close();

  const again = openDb(file);
  assert.equal(Math.max(...versions(again)), 17, "and the later ones");
  assert.deepEqual(again.prepare("SELECT name FROM approval_files").all(), [{ name: "a.png" }]);
  assert.deepEqual(approvalFilesSchema(again), REFERENCE);
  again.close();
});
