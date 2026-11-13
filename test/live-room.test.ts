import assert from "node:assert/strict";
import { test } from "node:test";
import { getDbAt, openDb } from "../src/server/db";
import { loadHome, syncHome } from "../src/server/rooms";
import { hqStatus } from "../src/mcp/tools";
import { makeHome } from "./helpers";

/** A home with one running run of the scout, its database and the context of its HQ server. */
function runningRun() {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  syncHome(db, loadHome(config.home));
  const runId = Number(
    db
      .prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at) VALUES ('demo', 'scout', 'claude', 't', 'running', ?)")
      .run(new Date().toISOString()).lastInsertRowid,
  );
  const ctx = { dbPath: config.dbPath, runId, agentId: "scout", room: "demo" };
  return { config, db, runId, ctx };
}

const changeCount = (db: ReturnType<typeof getDbAt>) => (db.prepare("SELECT COUNT(*) AS n FROM changes").get() as { n: number }).n;

test("hq_status with waiting: the text is the reason, and the status is marked in run_waits in the same write", () => {
  const { db, ctx } = runningRun();
  const before = changeCount(db);
  const plain = hqStatus(db, ctx, { text: "rend le plan 2" });
  const wait = hqStatus(db, ctx, { text: "attend la carte graphique", waiting: true });
  assert.equal(wait.waiting, true);
  assert.equal(plain.waiting, false);
  const marked = db.prepare("SELECT status_id FROM run_waits").all() as { status_id: number }[];
  const ids = db.prepare("SELECT id, text FROM run_statuses ORDER BY id").all() as { id: number; text: string }[];
  assert.deepEqual(marked.map((row) => row.status_id), [ids[1]!.id]);
  assert.equal(ids[1]!.text, "attend la carte graphique");
  assert.equal(changeCount(db), before, "no run, event, message or item");
});

test("migration 22 is idempotent: applied again, it keeps the tables and their rows", () => {
  const { config, db, ctx } = runningRun();
  hqStatus(db, ctx, { text: "attend", waiting: true });
  db.exec("DELETE FROM schema_migrations WHERE version = 22;");
  const reopened = openDb(config.dbPath);
  try {
    assert.equal((reopened.prepare("SELECT COUNT(*) AS n FROM run_waits").get() as { n: number }).n, 1);
    assert.equal((reopened.prepare("SELECT COUNT(*) AS n FROM run_pins").get() as { n: number }).n, 0);
  } finally {
    reopened.close();
  }
});
