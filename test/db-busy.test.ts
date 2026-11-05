import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { test } from "node:test";
import { hqReadDecisions, hqSubmit, toolErrorText, type HqContext } from "../src/mcp/tools";
import { BUSY_TIMEOUT_MS, getDbAt, openDb, type Db } from "../src/server/db";
import { makeHome } from "./helpers";

/**
 * Another process (an HQ MCP server, the app) that holds the write lock of the
 * database for `holdMs`, as when a run's tool writes while the app records
 * events. Resolves once the lock is held.
 */
async function holdWriteLock(dbPath: string, holdMs: number): Promise<ChildProcess> {
  const script = `
    const Database = require(${JSON.stringify(require.resolve("better-sqlite3"))});
    const db = new Database(${JSON.stringify(dbPath)});
    db.pragma("busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO memories (room, agent_id, key, value, updated_at) VALUES ('demo', 'other', 'k', 'v', '')").run();
    process.stdout.write("locked\\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${holdMs});
    db.exec("COMMIT");
    db.close();
  `;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("locked")) resolve();
    });
    child.on("exit", (code) => reject(new Error(`the lock holder exited (${code})`)));
  });
  return child;
}

const exited = (child: ChildProcess) =>
  new Promise<void>((resolve) => (child.exitCode !== null ? resolve() : child.once("exit", () => resolve())));

function setup(): { db: Db; ctx: HqContext; dbPath: string } {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const runId = Number(
    db
      .prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at) VALUES ('demo', 'scout', 'claude', 'x', 'running', ?)")
      .run(new Date().toISOString()).lastInsertRowid,
  );
  return { db, dbPath: config.dbPath, ctx: { dbPath: config.dbPath, runId, agentId: "scout", room: "demo" } };
}

function addDecided(db: Db, title: string): number {
  return Number(
    db
      .prepare(
        "INSERT INTO approvals (room, agent_id, type, title, body, status, decided_at, created_at) VALUES ('demo', 'scout', 'social_draft', ?, 'Script.', 'approved', ?, ?)",
      )
      .run(title, new Date().toISOString(), new Date().toISOString()).lastInsertRowid,
  );
}

test("every connection waits for a busy database (WAL, busy timeout set first)", () => {
  const { dbPath } = setup();
  const db = openDb(dbPath);
  assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
  assert.equal(db.pragma("busy_timeout", { simple: true }), BUSY_TIMEOUT_MS);
  db.close();
});

test("the cause of the incident: a deferred read-then-write transaction fails at once while another process writes, whatever the busy timeout", async () => {
  const { db, dbPath } = setup();
  addDecided(db, "Reel");
  const child = await holdWriteLock(dbPath, 800);
  const started = Date.now();
  let caught: unknown;
  try {
    // hq_read_decisions as it was: select the decisions, then mark them seen.
    db.transaction(() => {
      db.prepare("SELECT * FROM approvals WHERE seen_by_agent_at IS NULL").all();
      db.prepare("UPDATE approvals SET seen_by_agent_at = ? WHERE seen_by_agent_at IS NULL").run("now");
    })();
  } catch (error) {
    caught = error;
  }
  await exited(child);
  assert.ok(caught instanceof Error && caught.name === "SqliteError", "SQLITE_BUSY");
  assert.match((caught as Error & { code: string }).code, /^SQLITE_BUSY/);
  assert.equal(caught.message, "database is locked");
  assert.ok(Date.now() - started < BUSY_TIMEOUT_MS / 2, "it did not wait for the busy timeout");
  // The error an agent gets is explicit: no empty result.
  const text = toolErrorText(caught);
  assert.match(text, /^Error: the office database is busy \(SQLITE_BUSY/);
  assert.match(text, /Nothing was read or written: this is not an empty result/);
  assert.match(text, /do not submit anything a second time/);
});

test("hq_read_decisions waits for the other process and returns the decisions", async () => {
  const { db, ctx, dbPath } = setup();
  const id = addDecided(db, "Reel");
  const child = await holdWriteLock(dbPath, 500);
  const read = hqReadDecisions(db, ctx);
  await exited(child);
  assert.deepEqual(
    read.decisions.map((d) => [d.approvalId, d.decision]),
    [[id, "approved"]],
  );
  assert.deepEqual(hqReadDecisions(db, ctx).decisions, [], "each decision is given once");
});

test("a tool error that is not the database keeps its message", () => {
  assert.equal(toolErrorText(new Error('Unknown agent "x" in room "demo".')), 'Error: Unknown agent "x" in room "demo".');
  const other = Object.assign(new Error("no such table: nope"), { name: "SqliteError", code: "SQLITE_ERROR" });
  assert.match(toolErrorText(other), /^Error: office database error \(SQLITE_ERROR: no such table: nope\)\. Nothing was read or written/);
});

test("hq_submit gives back the existing item for the same content still waiting or approved in the last 24 hours", () => {
  const { db, ctx } = setup();
  const item = { type: "social_draft", title: "Reel: opening", body: "The script." };
  const first = hqSubmit(db, ctx, item);
  assert.deepEqual(first, { approvalId: first.approvalId, status: "pending" });
  const again = hqSubmit(db, ctx, { ...item, body: "The script.\n" });
  assert.equal(again.approvalId, first.approvalId);
  assert.equal(again.duplicate, true);
  assert.equal(again.status, "pending");
  assert.match(again.note ?? "", new RegExp(`#${first.approvalId}`));
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM approvals").get() as { n: number }).n, 1);

  // Approved an hour ago: still the same item.
  db.prepare("UPDATE approvals SET status = 'approved', decided_at = ? WHERE id = ?").run(
    new Date(Date.now() - 3_600_000).toISOString(),
    first.approvalId,
  );
  assert.deepEqual([hqSubmit(db, ctx, item).approvalId, hqSubmit(db, ctx, item).status], [first.approvalId, "approved"]);

  // Another body, another title, another agent: new items.
  assert.notEqual(hqSubmit(db, ctx, { ...item, body: "Another script." }).approvalId, first.approvalId);
  assert.notEqual(hqSubmit(db, ctx, { ...item, title: "Reel: second" }).approvalId, first.approvalId);
  assert.notEqual(hqSubmit(db, { ...ctx, agentId: "writer" }, item).approvalId, first.approvalId);
});

test("hq_submit takes the same content again once the earlier item is rejected, sent back, or approved more than 24 hours ago", () => {
  const { db, ctx } = setup();
  const item = { type: "social_draft", title: "Reel", body: "The script." };
  for (const [status, hoursAgo] of [["rejected", 1], ["revise", 1], ["approved", 30]] as const) {
    const earlier = hqSubmit(db, ctx, item);
    assert.equal(earlier.duplicate, undefined);
    db.prepare("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?").run(
      status,
      new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
      earlier.approvalId,
    );
  }
  assert.equal(hqSubmit(db, ctx, item).duplicate, undefined);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM approvals").get() as { n: number }).n, 4);
});
