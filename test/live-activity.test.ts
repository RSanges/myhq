import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getDbAt, openDb, type Db } from "../src/server/db";
import {
  backgroundOutputPath,
  journalWaits,
  readActivity,
  readOutputTail,
  toolDetail,
  waitTotals,
} from "../src/server/live-activity";
import type { QueueEntry } from "../src/server/queue";
import { loadHome, syncHome } from "../src/server/rooms";
import { minutesText, quietness, toolText, waitCauseText } from "../src/ui/live-room-model";
import type { LiveTile } from "../src/ui/schemas";
import { makeHome } from "./helpers";

function setup() {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  syncHome(db, loadHome(config.home));
  const runId = Number(
    db
      .prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at) VALUES ('demo', 'scout', 'claude', 't', 'running', ?)")
      .run("2026-01-01T10:00:00.000Z").lastInsertRowid,
  );
  return { config, db, runId };
}

function event(db: Db, runId: number, type: string, data: unknown, at: string) {
  db.prepare("INSERT INTO events (run_id, room, agent_id, type, data, created_at) VALUES (?, 'demo', 'scout', ?, ?, ?)").run(
    runId,
    type,
    JSON.stringify(data),
    at,
  );
}

test("toolDetail: a command's description, a file's name, a pattern, a subagent's description", () => {
  assert.equal(toolDetail("Bash", { command: "uv run pytest -q", description: "Run the tests" }), "Run the tests");
  assert.equal(toolDetail("Bash", { command: "uv run pytest -q" }), "uv run pytest -q");
  assert.equal(toolDetail("Read", { file_path: "C:\\work\\out\\bilan.json" }), "bilan.json");
  assert.equal(toolDetail("Grep", { pattern: "ruban", path: "/x" }), "ruban");
  assert.equal(toolDetail("Agent", { description: "Relecture", prompt: "long" }), "Relecture");
  assert.equal(toolDetail("mcp__hq__hq_items", {}), null);
  assert.ok(toolDetail("Bash", { command: "x".repeat(500) })!.length <= 120);
});

test("backgroundOutputPath: the file the CLI names when a command goes to the background", () => {
  const moved = "....\nCommand did not complete within its 600s timeout and was moved to the background (ID: b79). Output is being written to: C:\\Users\\o\\AppData\\Local\\Temp\\claude\\x\\tasks\\b79.output";
  assert.equal(backgroundOutputPath(moved), "C:\\Users\\o\\AppData\\Local\\Temp\\claude\\x\\tasks\\b79.output");
  assert.equal(backgroundOutputPath("Command running in background with ID: a1. Output is being written to: /tmp/claude/t/a1.output"), "/tmp/claude/t/a1.output");
  assert.equal(backgroundOutputPath("all 82 passed"), null);
});

test("readOutputTail: the last lines of a .output file under the temporary folder only, colours removed", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-tail-"));
  const file = path.join(tmp, "b1.output");
  fs.writeFileSync(file, `${Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n")}\n\u001b[32m[ 73%]\u001b[0m\n\n`);
  const tail = readOutputTail(file, tmp)!;
  assert.equal(tail.text.split("\n").length, 12);
  assert.ok(tail.text.endsWith("[ 73%]"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-out-"));
  const elsewhere = path.join(outside, "b2.output");
  fs.writeFileSync(elsewhere, "secret");
  assert.equal(readOutputTail(elsewhere, tmp), null, "outside the temporary folder");
  fs.writeFileSync(path.join(tmp, "notes.txt"), "x");
  assert.equal(readOutputTail(path.join(tmp, "notes.txt"), tmp), null, "not a .output file");
  assert.equal(readOutputTail("relative/b1.output", tmp), null, "a relative path");
  assert.equal(readOutputTail(path.join(tmp, "missing.output"), tmp), null);
});

test("readActivity: the latest call without a result, when the journal last moved, the latest background command with its output", () => {
  const { db, runId } = setup();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-act-"));
  const output = path.join(tmp, "b79.output");
  fs.writeFileSync(output, "....... [ 73%]\n");
  event(db, runId, "tool_call", { id: "a", name: "Read", input: { file_path: "/w/bilan.json" } }, "2026-01-01T10:01:00.000Z");
  event(db, runId, "tool_result", { toolUseId: "a", isError: false, content: "{}" }, "2026-01-01T10:01:01.000Z");
  event(db, runId, "tool_call", { id: "b", name: "Bash", input: { command: "uv run pytest", description: "Run the tests" } }, "2026-01-01T10:02:00.000Z");
  let activity = readActivity(db, runId, true, tmp);
  assert.deepEqual(activity.current, { tool: "Bash", detail: "Run the tests", at: "2026-01-01T10:02:00.000Z" });
  assert.equal(activity.lastEventAt, "2026-01-01T10:02:00.000Z");
  assert.equal(activity.background, null);

  event(db, runId, "tool_result", { toolUseId: "b", isError: false, content: `....\nmoved to the background (ID: b79). Output is being written to: ${output}` }, "2026-01-01T10:12:00.000Z");
  event(db, runId, "text", { text: "J'attends." }, "2026-01-01T10:12:01.000Z");
  activity = readActivity(db, runId, true, tmp);
  assert.equal(activity.current, null, "the agent thinks: no call open");
  assert.equal(activity.lastEventAt, "2026-01-01T10:12:01.000Z");
  assert.equal(activity.background?.detail, "Run the tests");
  assert.equal(activity.background?.at, "2026-01-01T10:12:00.000Z");
  assert.equal(activity.background?.output, "....... [ 73%]");
  assert.ok(activity.background?.outputAt);

  // A run that ended has nothing in progress.
  const ended = readActivity(db, runId, false, tmp);
  assert.deepEqual(ended, { current: null, lastEventAt: "2026-01-01T10:12:01.000Z", background: null });
});

const entry = (taskId: number, cause: string, agentId = "scout"): QueueEntry => ({
  taskId,
  room: "demo",
  roomLabel: null,
  roomColor: null,
  agentId,
  agentName: agentId,
  subject: null,
  source: "message",
  summary: "s",
  since: "2026-01-01T09:00:00.000Z",
  placed: false,
  cause,
  reason: `waits for ${cause}`,
});

test("journalWaits: a wait opens once, changes cause, and closes when the task leaves the queue", () => {
  const { db } = setup();
  journalWaits(db, [entry(1, "machine")], "2026-01-01T10:00:00.000Z");
  journalWaits(db, [entry(1, "machine")], "2026-01-01T10:00:15.000Z");
  let rows = db.prepare("SELECT task_id, cause, started_at, ended_at FROM task_waits ORDER BY id").all();
  assert.deepEqual(rows, [{ task_id: 1, cause: "machine", started_at: "2026-01-01T10:00:00.000Z", ended_at: null }]);
  journalWaits(db, [entry(1, "behind"), entry(2, "machine")], "2026-01-01T10:10:00.000Z");
  journalWaits(db, [entry(2, "machine")], "2026-01-01T10:20:00.000Z");
  rows = db.prepare("SELECT task_id, cause, started_at, ended_at FROM task_waits ORDER BY id").all();
  assert.deepEqual(rows, [
    { task_id: 1, cause: "machine", started_at: "2026-01-01T10:00:00.000Z", ended_at: "2026-01-01T10:10:00.000Z" },
    { task_id: 1, cause: "behind", started_at: "2026-01-01T10:10:00.000Z", ended_at: "2026-01-01T10:20:00.000Z" },
    { task_id: 2, cause: "machine", started_at: "2026-01-01T10:10:00.000Z", ended_at: null },
  ]);
});

test("waitTotals: overlapping waits of one agent counted once, the open ones up to now, afterRun left out, the window applied", () => {
  const { db } = setup();
  const at = (minute: number) => new Date(Date.parse("2026-01-01T10:00:00.000Z") + minute * 60_000).toISOString();
  journalWaits(db, [entry(1, "machine"), entry(2, "machine"), entry(3, "afterRun", "critic")], at(0));
  journalWaits(db, [entry(2, "machine"), entry(3, "afterRun", "critic")], at(30));
  journalWaits(db, [entry(4, "veto", "critic")], at(60));
  const totals = waitTotals(db, Date.parse(at(0)), Date.parse(at(90)));
  assert.deepEqual(totals, [
    { room: "demo", agentId: "scout", cause: "machine", minutes: 60 },
    { room: "demo", agentId: "critic", cause: "veto", minutes: 30 },
  ]);
  assert.deepEqual(waitTotals(db, Date.parse(at(45)), Date.parse(at(90)))[0], { room: "demo", agentId: "critic", cause: "veto", minutes: 30 });
});

test("migration 36 is idempotent", () => {
  const { config, db } = setup();
  journalWaits(db, [entry(1, "machine")]);
  db.exec("DELETE FROM schema_migrations WHERE version = 36;");
  const reopened = openDb(config.dbPath);
  try {
    assert.equal((reopened.prepare("SELECT COUNT(*) AS n FROM task_waits").get() as { n: number }).n, 1);
  } finally {
    reopened.close();
  }
});

test("the room's words: a tool, a quiet run, a cause, a duration", () => {
  assert.equal(toolText({ tool: "Bash", detail: "Run the tests" }), "Commande : Run the tests");
  assert.equal(toolText({ tool: "mcp__hq__hq_items", detail: null }), "hq_items");
  assert.equal(toolText({ tool: "Mystery", detail: null }), "Mystery");
  assert.equal(waitCauseText("machine"), "mémoire de la machine");
  assert.equal(waitCauseText("whatever"), "autre raison");
  assert.equal(minutesText(45), "45 min");
  assert.equal(minutesText(190), "3 h 10");
  assert.equal(minutesText(120), "2 h");
  const now = Date.parse("2026-01-01T10:20:00.000Z");
  const tile = (lastEventAt: string | null, state: LiveTile["state"] = "working") =>
    ({ state, startedAt: "2026-01-01T10:00:00.000Z", activity: { current: null, lastEventAt, background: null } }) as unknown as LiveTile;
  assert.deepEqual(quietness(tile("2026-01-01T10:18:00.000Z"), now), { minutes: 2, level: "ok" });
  assert.deepEqual(quietness(tile("2026-01-01T10:10:00.000Z"), now), { minutes: 10, level: "warn" });
  assert.deepEqual(quietness(tile(null), now), { minutes: 20, level: "alert" }, "no event yet: from the start");
  assert.equal(quietness(tile("2026-01-01T10:10:00.000Z", "done"), now), null);
  assert.equal(quietness({ state: "working", startedAt: "2026-01-01T10:00:00.000Z" } as unknown as LiveTile, now), null, "an older server");
});
