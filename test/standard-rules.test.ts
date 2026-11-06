import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { listBlocked } from "../src/server/blocked";
import type { HqConfig } from "../src/server/config";
import { getDbAt, type Db, type RunRow } from "../src/server/db";
import type { Engine, RunEvent, RunInput } from "../src/server/engine";
import { RELAUNCH_REASON } from "../src/server/relaunch-requests";
import { loadHome, syncHome } from "../src/server/rooms";
import { entryRule, STANDARD_REASON, STANDARD_REVIEW_MS, watchStandard } from "../src/server/supervisor";
import { strings } from "../src/ui/strings";
import { makeHome, waitForRun } from "./helpers";

// The rules of the Standard in code: before MyHQ wakes the supervisor, it
// relaunches once what failed for a passing technical reason, hands to the
// owner what it relaunched already, leaves alone what starts again on its own,
// and wakes the supervisor only for the blocks in free text.

const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const ended = (status: "done" | "failed"): RunEvent => ({
  type: "end",
  status,
  reason: status === "done" ? "success" : "error",
  summary: status === "done" ? "ok" : "MCP server not connected: courrier (failed)",
  usage,
  costUsd: 0,
});

function engine(seen: RunInput[] = [], statuses: ("done" | "failed")[] = []): Engine {
  return {
    name: "claude",
    async *run(input) {
      seen.push(input);
      yield ended(statuses.shift() ?? "done");
    },
  };
}

/** Room "demo" with Vigie and Social, room "assistant" with the supervisor. */
function office(overrides: Partial<HqConfig> = {}): { config: HqConfig; db: Db } {
  const base = { role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"] };
  const config = makeHome(overrides, {
    name: "demo",
    targetRepo: "../demo-project",
    agents: [
      { id: "vigie", name: "Vigie", ...base },
      { id: "social", name: "Social", ...base },
    ],
  });
  const dir = path.join(config.home, "rooms", "assistant");
  fs.mkdirSync(path.join(dir, "roles"), { recursive: true });
  fs.writeFileSync(path.join(dir, "roles", "regisseur.md"), "You supervise the Standard.\n");
  fs.writeFileSync(
    path.join(dir, "room.json"),
    JSON.stringify({
      name: "assistant",
      targetRepo: "../vault",
      agents: [{ id: "regisseur", name: "Régisseur", model: "sonnet", supervisor: true, role: "roles/regisseur.md", allowedTools: ["mcp__hq__*"] }],
    }),
  );
  const db = getDbAt(config.dbPath);
  syncHome(db, loadHome(config.home));
  return { config, db };
}

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/** A run of `agent` that ended `status` 10 minutes ago with `summary`, its instruction blocked. */
function endedRun(db: Db, agent: string, status: "failed" | "cancelled", summary: string): number {
  const at = ago(10);
  const runId = Number(
    db
      .prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at, ended_at, summary) VALUES ('demo', ?, 'claude', ?, ?, ?, ?, ?)")
      .run(agent, `Watch the mail of ${agent}.`, status, ago(11), at, summary).lastInsertRowid,
  );
  db.prepare(
    "INSERT INTO tasks (room, agent_id, source, text, status, run_id, created_at, updated_at) VALUES ('demo', ?, 'manual', ?, 'blocked', ?, ?, ?)",
  ).run(agent, `Watch the mail of ${agent}.`, runId, ago(11), at);
  return runId;
}

function blockedTask(db: Db, agent: string, note: string): number {
  const at = ago(30);
  return Number(
    db
      .prepare("INSERT INTO tasks (room, agent_id, source, text, status, note, created_at, updated_at) VALUES ('demo', ?, 'message', 'Post the script.', 'blocked', ?, ?, ?)")
      .run(agent, note, at, at).lastInsertRowid,
  );
}

const runsOf = (db: Db, room: string, agent: string) =>
  db.prepare("SELECT * FROM runs WHERE room = ? AND agent_id = ? ORDER BY id").all(room, agent) as RunRow[];
const entries = (config: HqConfig, db: Db) => listBlocked(db, loadHome(config.home), config);

test("rules: a run stopped for an MCP server not connected is relaunched once by MyHQ, with a note, and the supervisor is not woken", async () => {
  const { config, db } = office();
  const failed = endedRun(db, "vigie", "failed", "MCP server not connected: courrier (failed)");
  assert.equal(watchStandard(config, db, { engine: engine() }), null, "no run of the supervisor");
  const [relaunch] = runsOf(db, "demo", "vigie").filter((run) => run.id !== failed);
  assert.ok(relaunch, "MyHQ relaunched it");
  assert.equal(relaunch.reason, RELAUNCH_REASON);
  await waitForRun(db, relaunch.id);
  assert.equal(runsOf(db, "assistant", "regisseur").length, 0);
  const note = db.prepare("SELECT * FROM blocked_notes ORDER BY id DESC LIMIT 1").get() as { text: string; handed_off: number };
  assert.equal(note.text, strings.deskModules.standard.autoRelaunched(strings.deskModules.standard.transient.mcp!));
  assert.equal(note.handed_off, 0);
  assert.equal(entries(config, db).length, 0, "the relaunch did the work: nothing is stuck");
});

test("rules: an entry MyHQ relaunched that fails again goes to the owner with MyHQ's note; the supervisor is still not woken", async () => {
  const { config, db } = office();
  endedRun(db, "vigie", "cancelled", "Interrupted: MyHQ stopped during the run.");
  assert.equal(watchStandard(config, db, { engine: engine([], ["failed"]) }), null);
  const relaunch = runsOf(db, "demo", "vigie").find((run) => run.reason === RELAUNCH_REASON);
  assert.ok(relaunch);
  await waitForRun(db, relaunch.id);

  const later = new Date(Date.now() + STANDARD_REVIEW_MS + 60_000);
  assert.equal(watchStandard(config, db, { engine: engine() }, later), null);
  const stuck = entries(config, db);
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0]!.handedOff, true);
  assert.equal(stuck[0]!.note?.text, strings.deskModules.standard.secondFailureMyhq);
  assert.equal(stuck[0]!.note?.agentName, "MyHQ");
  assert.equal(runsOf(db, "demo", "vigie").filter((run) => run.reason === RELAUNCH_REASON).length, 1, "relaunched once only");
  assert.equal(runsOf(db, "assistant", "regisseur").length, 0);
});

test("rules: the supervisor is woken for the blocks in free text only, and its task lists only them", async () => {
  const { config, db } = office();
  const free = blockedTask(db, "social", "Le script #39 n'est pas dans la pile, je ne peux pas le poster.");
  const transient = blockedTask(db, "vigie", "SQLITE_BUSY: database is locked");
  const run = watchStandard(config, db, { engine: engine() });
  assert.ok(run);
  assert.equal(run.reason, STANDARD_REASON);
  assert.match(run.task, new RegExp(`\\[task ${free}\\]`));
  assert.doesNotMatch(run.task, new RegExp(`\\[task ${transient}\\]`));
  await waitForRun(db, run.id);
  const relaunch = runsOf(db, "demo", "vigie").find((each) => each.reason === RELAUNCH_REASON);
  assert.ok(relaunch, "the database error was relaunched by MyHQ");
  await waitForRun(db, relaunch.id);
});

test("rules: what starts again on its own (the daily cap) is neither relaunched nor given to the supervisor", () => {
  const { config, db } = office({ maxRunsPerDay: 0 });
  const at = ago(30);
  db.prepare("INSERT INTO tasks (room, agent_id, source, text, status, created_at, updated_at) VALUES ('demo', 'social', 'message', 'Order.', 'pending', ?, ?)").run(at, at);
  const [entry] = entries(config, db);
  assert.equal(entry?.cause, "cap");
  assert.equal(watchStandard(config, db, { engine: engine() }), null);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM supervisor_relaunches").get() as { n: number }).n, 0);
});

test("rules: entryRule reads the cause and the words of the entry", () => {
  const rule = (cause: string, detail: string | null = null) => entryRule({ cause, detail });
  assert.deepEqual(rule("cancelled"), { kind: "relaunch", why: "interrupted" });
  assert.deepEqual(rule("failed", "MCP server not connected: courrier (failed)"), { kind: "relaunch", why: "mcp" });
  assert.deepEqual(rule("blocked", "Le GPU est occupé par un autre rendu."), { kind: "relaunch", why: "gpu" });
  assert.deepEqual(rule("blocked", "DAILY_CAP_REACHED: Daily cap reached"), { kind: "relaunch", why: "cap" });
  assert.deepEqual(rule("failed", "SqliteError: SQLITE_BUSY"), { kind: "relaunch", why: "database" });
  assert.deepEqual(rule("busy"), { kind: "relaunch", why: "busy" });
  for (const cause of ["cap", "resource", "pingPong", "stopping"]) assert.deepEqual(rule(cause), { kind: "wait" });
  assert.deepEqual(rule("failed", "Timed out after 30 minutes (HQ_RUN_TIMEOUT_MINUTES)."), { kind: "supervisor" });
  assert.deepEqual(rule("blocked", "Je n'ai pas le texte de l'item #39."), { kind: "supervisor" });
  assert.deepEqual(rule("hardLimit", "Interrupted at the hard limit"), { kind: "supervisor" });
  assert.deepEqual(rule("stopped"), { kind: "supervisor" });
  assert.deepEqual(rule("notWoken"), { kind: "supervisor" });
});

test("rules: an entry a guard holds back (the agent busy) is relaunched at a later tick, once", async () => {
  const { config, db } = office();
  endedRun(db, "vigie", "failed", "MCP server not connected: courrier (failed)");
  const busy = Number(
    db
      .prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at, resources) VALUES ('demo', 'vigie', 'claude', 't', 'running', ?, '[]')")
      .run(ago(1)).lastInsertRowid,
  );
  assert.equal(watchStandard(config, db, { engine: engine() }), null);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM supervisor_relaunches").get() as { n: number }).n, 0, "nothing counted yet");
  db.prepare("UPDATE runs SET status = 'done', ended_at = ? WHERE id = ?").run(ago(0), busy);
  assert.equal(watchStandard(config, db, { engine: engine() }), null);
  const relaunch = runsOf(db, "demo", "vigie").find((run) => run.reason === RELAUNCH_REASON);
  assert.ok(relaunch);
  await waitForRun(db, relaunch.id);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM supervisor_relaunches").get() as { n: number }).n, 1);
});
