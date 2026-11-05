import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { app, homeOwnedElsewhere } from "../src/server/app";
import type { HqConfig } from "../src/server/config";
import { getDbAt, type Db, type RunRow, type TaskRow } from "../src/server/db";
import type { Engine, RunEvent, RunInput } from "../src/server/engine";
import { INTERRUPTED_SUMMARY, recoverInterruptedRuns, releaseOrphanTasks, wakeAgents } from "../src/server/runner";
import { makeHome, waitForRun } from "./helpers";

const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const done: RunEvent = { type: "end", status: "done", reason: "success", summary: "ok", usage, costUsd: 0 };

function twoAgents(overrides: Partial<HqConfig> = {}): HqConfig {
  const base = { role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"] };
  return makeHome(overrides, {
    name: "demo",
    targetRepo: "../demo-project",
    agents: [
      { id: "scout", name: "Scout", ...base },
      { id: "writer", name: "Writer", ...base },
    ],
  });
}

function engine(seen: RunInput[]): Engine {
  return {
    name: "claude",
    async *run(input) {
      seen.push(input);
      yield done;
    },
  };
}

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

function addRun(db: Db, agent: string, status: RunRow["status"], startedAt: string): number {
  return Number(
    db
      .prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at, reason) VALUES ('demo', ?, 'claude', 'x', ?, ?, 'message')")
      .run(agent, status, startedAt).lastInsertRowid,
  );
}

function addTask(db: Db, agent: string, source: TaskRow["source"], status: TaskRow["status"], runId: number | null, createdAt: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO tasks (room, agent_id, source, text, status, run_id, from_room, from_agent, created_at, updated_at)
         VALUES ('demo', ?, ?, 'Do it.', ?, ?, 'demo', 'scout', ?, ?)`,
      )
      .run(agent, source, status, runId, createdAt, createdAt).lastInsertRowid,
  );
}

const task = (db: Db, id: number) => db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow;
const runsOf = (db: Db, agent: string) => db.prepare("SELECT * FROM runs WHERE agent_id = ? ORDER BY id").all(agent) as RunRow[];

test("at startup, the runs left running are cancelled and their tasks given back: the mailbox to the queue, the instruction blocked", () => {
  const config = twoAgents();
  const db = getDbAt(config.dbPath);
  const interrupted = addRun(db, "writer", "running", at(5));
  const message = addTask(db, "writer", "message", "in_progress", interrupted, at(6));
  const instruction = addTask(db, "writer", "manual", "in_progress", interrupted, at(5));
  // A task still in progress on a run that failed (the incident's tasks), and one without a run.
  const failed = addRun(db, "scout", "failed", at(20));
  const stuck = addTask(db, "scout", "message", "in_progress", failed, at(21));
  const orphan = addTask(db, "scout", "message", "in_progress", null, at(21));
  assert.deepEqual(recoverInterruptedRuns(db), { runs: 1, requeued: 3, blocked: 1 });

  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(interrupted) as RunRow;
  assert.equal(run.status, "cancelled");
  assert.equal(run.summary, INTERRUPTED_SUMMARY);
  assert.deepEqual([task(db, message).status, task(db, message).run_id], ["pending", null]);
  assert.equal(task(db, instruction).status, "blocked");
  assert.equal(task(db, instruction).note, INTERRUPTED_SUMMARY);
  assert.equal(task(db, stuck).status, "pending");
  assert.equal(task(db, orphan).status, "pending");
  // A second pass finds nothing more.
  assert.deepEqual(releaseOrphanTasks(db), { requeued: 0, blocked: 0 });
});

test("a task given back by an interrupted run wakes its agent once; a second interruption or a failure leaves it for the next run", async () => {
  const config = twoAgents();
  const db = getDbAt(config.dbPath);
  const seen: RunInput[] = [];
  const deps = { config, engine: engine(seen), send: async () => true };

  // Interrupted once: woken again.
  const once = addTask(db, "writer", "message", "pending", null, at(10));
  addRun(db, "writer", "cancelled", at(9));
  const started = wakeAgents(config, db, deps);
  assert.deepEqual(started.map((r) => [r.agent_id, r.reason]), [["writer", "message"]]);
  await waitForRun(db, started[0]!.id);
  assert.equal(task(db, once).status, "done");

  // Interrupted twice (the resumed run was interrupted too): it waits for the agent's next run, no loop.
  const twice = addTask(db, "scout", "message", "pending", null, at(10));
  addRun(db, "scout", "cancelled", at(9));
  addRun(db, "scout", "cancelled", at(8));
  assert.deepEqual(wakeAgents(config, db, deps), []);
  assert.equal(task(db, twice).status, "pending");
});

test("a task given back by a failed run still does not wake its agent again", () => {
  const config = twoAgents();
  const db = getDbAt(config.dbPath);
  addTask(db, "writer", "message", "pending", null, at(10));
  addRun(db, "writer", "failed", at(9));
  assert.deepEqual(wakeAgents(config, db, { config, engine: engine([]) }), []);
});

test("app() recovers the runs only when this process owns the home: a second MyHQ on the same home leaves them alone", () => {
  const config = twoAgents();
  const db = getDbAt(config.dbPath);
  const run = addRun(db, "writer", "running", at(1));
  const held = addTask(db, "writer", "message", "in_progress", run, at(2));
  // Another live process (the parent of this test) holds the home.
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(path.join(config.dataDir, "app.lock"), String(process.ppid));
  const saved = { home: process.env.MYHQ_HOME, bin: process.env.HQ_CLAUDE_BIN };
  process.env.MYHQ_HOME = config.home;
  process.env.HQ_CLAUDE_BIN = config.claudeBin;
  try {
    app();
  } finally {
    if (saved.home === undefined) delete process.env.MYHQ_HOME;
    else process.env.MYHQ_HOME = saved.home;
    if (saved.bin === undefined) delete process.env.HQ_CLAUDE_BIN;
    else process.env.HQ_CLAUDE_BIN = saved.bin;
  }
  assert.equal(homeOwnedElsewhere(config.dbPath), true);
  assert.equal((db.prepare("SELECT status FROM runs WHERE id = ?").get(run) as RunRow).status, "running");
  assert.equal(task(db, held).status, "in_progress");
  assert.equal(runsOf(db, "writer").length, 1);
});

test("app() takes the home when its lock is free or left by a dead process, and recovers the runs", () => {
  const config = twoAgents();
  const db = getDbAt(config.dbPath);
  const run = addRun(db, "writer", "running", at(1));
  const held = addTask(db, "writer", "message", "in_progress", run, at(2));
  fs.mkdirSync(config.dataDir, { recursive: true });
  // A pid that no process has (the lock of a process killed outright).
  fs.writeFileSync(path.join(config.dataDir, "app.lock"), "999999");
  const saved = { home: process.env.MYHQ_HOME, bin: process.env.HQ_CLAUDE_BIN };
  process.env.MYHQ_HOME = config.home;
  process.env.HQ_CLAUDE_BIN = config.claudeBin;
  try {
    app();
  } finally {
    if (saved.home === undefined) delete process.env.MYHQ_HOME;
    else process.env.MYHQ_HOME = saved.home;
    if (saved.bin === undefined) delete process.env.HQ_CLAUDE_BIN;
    else process.env.HQ_CLAUDE_BIN = saved.bin;
  }
  assert.equal(homeOwnedElsewhere(config.dbPath), false);
  assert.equal(fs.readFileSync(path.join(config.dataDir, "app.lock"), "utf8"), String(process.pid));
  assert.equal((db.prepare("SELECT status FROM runs WHERE id = ?").get(run) as RunRow).status, "cancelled");
  assert.equal(task(db, held).status, "pending");
});
