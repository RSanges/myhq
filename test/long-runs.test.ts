import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { hqRunExtend, hqRunStatus, hqRunStop, type HqContext } from "../src/mcp/tools";
import { listBlocked } from "../src/server/blocked";
import type { HqConfig } from "../src/server/config";
import { getDbAt, type Db, type RunRow, type TaskRow } from "../src/server/db";
import type { Engine, RunEvent, RunInput } from "../src/server/engine";
import { extendRun, LONG_RUN_REASON, readDeadlines, requestStop, runStatus } from "../src/server/long-runs";
import { loadHome, syncHome } from "../src/server/rooms";
import { startRun } from "../src/server/runner";
import { strings } from "../src/ui/strings";
import { makeHome, waitForRun } from "./helpers";

// Long runs: at the soft deadline (HQ_RUN_TIMEOUT_MINUTES) a home with a
// supervisor has the run checked instead of interrupted; the supervisor
// extends it (hq_run_extend) or stops it (hq_run_stop); without its answer the
// run goes on by slices with a note on the Standard; the hard limit always
// interrupts it. The durations are milliseconds here, minutes in service.

const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const end = (status: "done" | "failed", summary: string): RunEvent => ({ type: "end", status, reason: status, summary, usage, costUsd: 0.5 });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SUPERVISOR = { room: "assistant", agentId: "regisseur" };

/** Room "demo" with the builder (and a second agent), room "assistant" with the supervisor when asked. */
function office(overrides: Partial<HqConfig>, withSupervisor = true): { config: HqConfig; db: Db } {
  const base = { role: "roles/scout.md", model: "sonnet", allowedTools: ["mcp__hq__*"] };
  const config = makeHome(overrides, {
    name: "demo",
    targetRepo: "../demo-project",
    agents: [
      { id: "builder", name: "Builder", ...base, maxBudgetUsd: 4 },
      { id: "scout", name: "Scout", ...base },
    ],
  });
  if (withSupervisor) {
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
  }
  const db = getDbAt(config.dbPath);
  syncHome(db, loadHome(config.home));
  return { config, db };
}

type Supervise = (input: RunInput, runId: number) => RunEvent[] | Promise<RunEvent[]>;

/**
 * The builder works until it is released (done) or aborted (failed); the
 * supervisor plays `supervise` with the run its task names, then ends done.
 */
function engine(supervise: Supervise, seen: RunInput[] = []): { engine: Engine; release: () => void } {
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  return {
    release: () => release(),
    engine: {
      name: "claude",
      async *run(input) {
        seen.push(input);
        if (input.agentId === "regisseur") {
          const runId = Number(/Long run to check: run #(\d+)/.exec(input.prompt)?.[1] ?? 0);
          yield { type: "start", sessionId: null, model: "sonnet", tools: [], mcpServers: [] };
          for (const event of await supervise(input, runId)) yield event;
          yield end("done", "checked");
          return;
        }
        yield { type: "start", sessionId: null, model: "claude-sonnet-5-5", tools: [], mcpServers: [] };
        const aborted = new Promise<"aborted">((resolve) => input.signal.addEventListener("abort", () => resolve("aborted"), { once: true }));
        const outcome = await Promise.race([released.then(() => "released" as const), aborted]);
        yield outcome === "released" ? end("done", "built") : end("failed", "run aborted");
      },
    },
  };
}

/** The tool result that follows a supervisor's call: the app wakes (and applies a stop) on it. */
const toolResult: RunEvent = { type: "tool_result", toolUseId: "t1", isError: false, content: "{}" };

const runsOf = (db: Db, agent: string) => db.prepare("SELECT * FROM runs WHERE agent_id = ? ORDER BY id").all(agent) as RunRow[];

async function until(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(10);
  }
}

test("soft deadline without a supervisor: the run is interrupted, as before", async () => {
  const { config, db } = office({ runTimeoutMs: 40 }, false);
  const { engine: fake } = engine(() => []);
  const run = startRun({ room: "demo", agent: "builder", task: "Model the bracket." }, { config, engine: fake, send: async () => true });
  const row = await waitForRun(db, run.id);
  assert.equal(row.status, "failed");
  assert.match(row.summary ?? "", /Timed out after/);
});

test("soft deadline with a supervisor: it is woken to check, and its extension lets the run go on", async () => {
  const { config, db } = office({ runTimeoutMs: 60 });
  const seen: RunInput[] = [];
  const { engine: fake, release } = engine((_input, runId) => {
    extendRun(db, SUPERVISOR, runId, 10);
    return [toolResult];
  }, seen);
  const run = startRun({ room: "demo", agent: "builder", task: "Model the bracket." }, { config, engine: fake, send: async () => true, runCheckWaitMs: 80 });

  await until(() => runsOf(db, "regisseur").length === 1 && runsOf(db, "regisseur")[0]!.status !== "running");
  const check = runsOf(db, "regisseur")[0]!;
  assert.equal(check.reason, LONG_RUN_REASON);
  assert.match(check.task, new RegExp(`^Long run to check: run #${run.id} of demo/builder \\(Builder\\)`));
  assert.match(check.task, /hq_run_status \{ runId: \d+ \}/);

  // Well past the wait for the decision: the run still works.
  await sleep(250);
  assert.equal((db.prepare("SELECT status FROM runs WHERE id = ?").get(run.id) as RunRow).status, "running");
  const deadlines = readDeadlines(db, run.id)!;
  assert.equal(deadlines.extensions, 1);
  assert.equal(deadlines.checks, 1);
  assert.equal(deadlines.slices, 0);
  assert.equal(deadlines.check_asked_at, null);
  assert.ok(Date.parse(deadlines.deadline_at) - Date.now() > 9 * 60_000, "about ten minutes more");

  release();
  const row = await waitForRun(db, run.id);
  assert.equal(row.status, "done");
  assert.equal(runsOf(db, "regisseur").length, 1, "one check only");
});

test("hq_run_stop interrupts the run: failed as a timeout, its tasks given back, the reason on the Standard", async () => {
  const { config, db } = office({ runTimeoutMs: 60 });
  const { engine: fake } = engine((_input, runId) => {
    requestStop(db, SUPERVISOR, runId, "Même appel répété depuis 20 minutes, aucun fichier écrit.");
    return [toolResult];
  });
  const at = new Date().toISOString();
  const mail = Number(
    db
      .prepare("INSERT INTO tasks (room, agent_id, source, text, status, created_at, updated_at) VALUES ('demo', 'builder', 'message', 'Export the STL.', 'pending', ?, ?)")
      .run(at, at).lastInsertRowid,
  );
  const run = startRun({ room: "demo", agent: "builder", task: "Model the bracket." }, { config, engine: fake, send: async () => true, runCheckWaitMs: 500 });
  const row = await waitForRun(db, run.id);
  assert.equal(row.status, "failed");
  assert.match(row.summary ?? "", /^Stopped by Régisseur \(supervisor\) after \d+ minutes: Même appel répété/);

  const tasks = db.prepare("SELECT * FROM tasks WHERE room = 'demo' AND agent_id = 'builder' ORDER BY id").all() as TaskRow[];
  assert.equal(tasks.find((task) => task.id === mail)?.status, "pending");
  assert.equal(tasks.find((task) => task.source === "manual")?.status, "blocked");

  const entry = listBlocked(db, loadHome(config.home), config).find((each) => each.entry === "run" && each.id === run.id);
  assert.equal(
    entry?.reason,
    strings.deskModules.standard.reasons.runStopped(run.id, "Régisseur", "Même appel répété depuis 20 minutes, aucun fichier écrit."),
  );
});

test("the hard limit interrupts the run whatever the extensions", async () => {
  const { config, db } = office({ runTimeoutMs: 60, runHardLimitMs: 400 });
  let extended: ReturnType<typeof extendRun> | null = null;
  const { engine: fake } = engine((_input, runId) => {
    extended = extendRun(db, SUPERVISOR, runId, 60);
    return [toolResult];
  });
  const run = startRun({ room: "demo", agent: "builder", task: "Model the bracket." }, { config, engine: fake, send: async () => true, runCheckWaitMs: 80 });
  const row = await waitForRun(db, run.id);
  assert.equal(row.status, "failed");
  assert.match(row.summary ?? "", /hard limit .*HQ_RUN_HARD_LIMIT_MINUTES.*after 1 extension/);
  assert.equal(extended!.cappedByHardLimit, true);
  assert.equal(extended!.deadlineAt, readDeadlines(db, run.id)!.hard_deadline_at);
  assert.ok(Date.parse(row.ended_at!) - Date.parse(row.started_at) >= 400);

  const entry = listBlocked(db, loadHome(config.home), config).find((each) => each.entry === "run" && each.id === run.id);
  assert.match(entry?.reason ?? "", new RegExp(`^Le tour #${run.id} a été interrompu au plafond`));
  // At the hard limit, no extension is possible any more.
  assert.throws(() => extendRun(db, SUPERVISOR, run.id, 10), /no longer in progress/);
});

test("no answer from the supervisor: the run goes on by slices up to the hard limit, with a note on the Standard", async () => {
  const { config, db } = office({ runTimeoutMs: 60, runHardLimitMs: 700 });
  // The supervisor reads and decides nothing.
  const { engine: fake } = engine(() => []);
  const run = startRun({ room: "demo", agent: "builder", task: "Model the bracket." }, { config, engine: fake, send: async () => true, runCheckWaitMs: 60 });

  await until(() => (readDeadlines(db, run.id)?.slices ?? 0) >= 1);
  assert.equal((db.prepare("SELECT status FROM runs WHERE id = ?").get(run.id) as RunRow).status, "running", "never interrupted for want of an answer");
  const row = await waitForRun(db, run.id);
  assert.equal(row.status, "failed");
  assert.match(row.summary ?? "", /hard limit/);
  assert.ok(Date.parse(row.ended_at!) - Date.parse(row.started_at) >= 700);

  const deadlines = readDeadlines(db, run.id)!;
  assert.ok(deadlines.checks >= 2, "asked again after a slice");
  assert.ok(deadlines.slices >= 2);
  // One note per run, kept up to date: a blocked task of the supervisor, said as MyHQ wrote it.
  const notes = db.prepare("SELECT * FROM tasks WHERE room = 'assistant' AND agent_id = 'regisseur' AND status = 'blocked'").all() as TaskRow[];
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.id, deadlines.note_task_id);
  assert.match(notes[0]!.note ?? "", new RegExp(`^Pas de réponse de Régisseur sur le tour #${run.id} de Builder`));
  const entry = listBlocked(db, loadHome(config.home), config).find((each) => each.entry === "task" && each.id === notes[0]!.id);
  assert.equal(entry?.reason, notes[0]!.note);
});

test("a busy supervisor cannot answer: the slice and the note come at once, the run goes on", async () => {
  const { config, db } = office({ runTimeoutMs: 60 });
  db.prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at) VALUES ('assistant', 'regisseur', 'claude', 'Review', 'running', ?)").run(
    new Date().toISOString(),
  );
  const { engine: fake, release } = engine(() => []);
  const run = startRun({ room: "demo", agent: "builder", task: "Model the bracket." }, { config, engine: fake, send: async () => true, runCheckWaitMs: 5_000 });
  await until(() => (readDeadlines(db, run.id)?.slices ?? 0) === 1);
  const deadlines = readDeadlines(db, run.id)!;
  assert.equal(deadlines.checks, 0, "no check could start");
  assert.notEqual(deadlines.note_task_id, null);
  assert.equal((db.prepare("SELECT status FROM runs WHERE id = ?").get(run.id) as RunRow).status, "running");
  release();
  assert.equal((await waitForRun(db, run.id)).status, "done");
});

test("the supervisor's own long run has nobody to check it: interrupted at the timeout", async () => {
  const { config, db } = office({ runTimeoutMs: 40 });
  const forever: Engine = {
    name: "claude",
    async *run(input) {
      await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
      yield end("failed", "run aborted");
    },
  };
  const run = startRun({ room: "assistant", agent: "regisseur", task: "Review" }, { config, engine: forever, send: async () => true });
  const row = await waitForRun(db, run.id);
  assert.equal(row.status, "failed");
  assert.match(row.summary ?? "", /Timed out after/);
});

/** The context of a run of this agent, as its HQ MCP server reads it. */
function ctxOf(config: HqConfig, db: Db, room: string, agentId: string): HqContext {
  const runId = Number(
    db
      .prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at, ended_at) VALUES (?, ?, 'claude', 't', 'done', ?, ?)")
      .run(room, agentId, new Date().toISOString(), new Date().toISOString()).lastInsertRowid,
  );
  return { dbPath: config.dbPath, runId, agentId, room, home: config.home, appEnv: {} };
}

/** A run in progress for 40 minutes, with its deadlines, as the runner records it. */
function runningRun(db: Db, agent = "builder"): number {
  const started = Date.now() - 40 * 60_000;
  const runId = Number(
    db
      .prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at) VALUES ('demo', ?, 'claude', 'Model the bracket.', 'running', ?)")
      .run(agent, new Date(started).toISOString()).lastInsertRowid,
  );
  db.prepare("INSERT INTO run_deadlines (run_id, budget_usd, deadline_at, hard_deadline_at, updated_at) VALUES (?, 4, ?, ?, ?)").run(
    runId,
    new Date(started + 30 * 60_000).toISOString(),
    new Date(started + 180 * 60_000).toISOString(),
    new Date().toISOString(),
  );
  return runId;
}

test("rights: the run tools are the supervisor's, with their limits", () => {
  const { config, db } = office({});
  const runId = runningRun(db);
  const scout = ctxOf(config, db, "demo", "scout");
  for (const call of [
    () => hqRunStatus(db, scout, { runId }),
    () => hqRunExtend(db, scout, { runId, minutes: 30 }),
    () => hqRunStop(db, scout, { runId, reason: "Stuck." }),
  ]) {
    assert.throws(call, /reserved for the supervisor of the Standard/);
  }
  assert.equal(readDeadlines(db, runId)!.extensions, 0);
  assert.equal(readDeadlines(db, runId)!.stop_requested_at, null);

  const supervisor = ctxOf(config, db, "assistant", "regisseur");
  assert.throws(() => hqRunExtend(db, supervisor, { runId, minutes: 5 }));
  assert.throws(() => hqRunExtend(db, supervisor, { runId, minutes: 61 }));
  const extended = hqRunExtend(db, supervisor, { runId, minutes: 30 });
  assert.equal(extended.extensions, 1);
  assert.equal(extended.cappedByHardLimit, false);
  assert.ok(Math.abs(Date.parse(extended.deadlineAt) - (Date.now() + 30 * 60_000)) < 5_000);
  assert.equal(hqRunExtend(db, supervisor, { runId, minutes: 10 }).deadlineAt, extended.deadlineAt, "never shortened");
  assert.equal(readDeadlines(db, runId)!.extensions, 2);

  // Never its own run, never a run that ended.
  const own = Number(
    db
      .prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at) VALUES ('assistant', 'regisseur', 'claude', 'Review', 'running', ?)")
      .run(new Date().toISOString()).lastInsertRowid,
  );
  db.prepare("INSERT INTO run_deadlines (run_id, budget_usd, deadline_at, hard_deadline_at, updated_at) VALUES (?, 1, ?, ?, ?)").run(
    own,
    new Date().toISOString(),
    new Date(Date.now() + 60_000).toISOString(),
    new Date().toISOString(),
  );
  assert.throws(() => hqRunStop(db, supervisor, { runId: own, reason: "Stuck." }), /yours/);
  assert.throws(() => hqRunExtend(db, supervisor, { runId: supervisor.runId, minutes: 10 }), /no longer in progress/);

  const stop = hqRunStop(db, supervisor, { runId, reason: "Bloqué sur le même appel." });
  assert.equal(stop.stopping, true);
  assert.equal(stop.already, false);
  assert.equal(readDeadlines(db, runId)!.stop_reason, "Bloqué sur le même appel.");
  assert.equal(readDeadlines(db, runId)!.stop_agent, "regisseur");
  assert.equal(hqRunStop(db, supervisor, { runId, reason: "Again." }).already, true);
});

test("hq_run_status: duration, cost against the budget, the latest events and the activity hints", () => {
  const { config, db } = office({});
  const runId = runningRun(db);
  const event = db.prepare("INSERT INTO events (run_id, room, agent_id, type, data, created_at) VALUES (?, 'demo', 'builder', ?, ?, ?)");
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  event.run(runId, "start", JSON.stringify({ sessionId: null, model: "claude-sonnet-5-5", tools: [], mcpServers: [] }), ago(40));
  event.run(runId, "tool_call", JSON.stringify({ id: "a", name: "Read", input: { file_path: "part.scad" } }), ago(39));
  event.run(runId, "tool_call", JSON.stringify({ id: "b", name: "Write", input: { file_path: "part.scad" } }), ago(38));
  for (let i = 0; i < 4; i++) {
    event.run(runId, "tool_call", JSON.stringify({ id: `c${i}`, name: "Bash", input: { command: "openscad -o part.stl part.scad" } }), ago(30 - i));
    event.run(runId, "tool_result", JSON.stringify({ toolUseId: `c${i}`, isError: true, content: "ERROR: Parser error in line 12" }), ago(30 - i));
  }
  // The journal: two model calls, the first one repeated for its second block.
  fs.mkdirSync(config.runsDir, { recursive: true });
  const call = (id: string, input: number, output: number) =>
    JSON.stringify({ type: "assistant", message: { id, content: [], usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 100_000 } } });
  fs.writeFileSync(path.join(config.runsDir, `${runId}.jsonl`), [call("m1", 1_000, 50_000), call("m1", 1_000, 50_000), call("m2", 2_000, 50_000), "not json"].join("\n"));

  const status = runStatus(db, loadHome(config.home), config.runsDir, runId);
  assert.equal(status.run.agentName, "Builder");
  assert.equal(status.run.status, "running");
  assert.equal(status.run.minutes, 40);
  assert.equal(status.run.model, "claude-sonnet-5-5");
  assert.equal(status.deadlines?.extensions, 0);
  assert.deepEqual(status.cost.tokens, { inputTokens: 3_000, outputTokens: 100_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 200_000 });
  assert.equal(status.cost.estimated, true);
  assert.equal(status.cost.budgetUsd, 4);
  // 3000 x 2 + 100000 x 10 + 200000 x 0.2, per million tokens.
  assert.equal(status.cost.usd, 1.046);
  assert.equal(status.cost.shareOfBudget, 0.26);
  assert.equal(status.events.length, 11);
  assert.equal(status.events[0]!.type, "start");
  assert.match(status.events.at(-1)!.detail, /^error: ERROR: Parser error/);
  assert.equal(status.lastEventAt, status.events.at(-1)!.at);
  assert.ok(Math.abs(status.hints.minutesSinceLastEvent - 27) < 0.2);
  assert.equal(status.hints.eventsLast10Minutes, 0);
  assert.equal(status.hints.toolCallsLast10Minutes, 0);
  assert.equal(status.hints.trailingIdenticalCalls, 4);
  assert.deepEqual(status.hints.mostRepeatedCall, { tool: "Bash", input: '{"command":"openscad -o part.stl part.scad"}', count: 4, outOf: 6 });

  // Through the tool, for the supervisor; once the run ended, its real cost.
  db.prepare("UPDATE runs SET status = 'done', ended_at = ?, cost_usd = 1.2, output_tokens = 9 WHERE id = ?").run(ago(20), runId);
  const ended = hqRunStatus(db, ctxOf(config, db, "assistant", "regisseur"), { runId });
  assert.equal(ended.cost.usd, 1.2);
  assert.equal(ended.cost.estimated, false);
  assert.equal(ended.run.minutes, 20);
  assert.throws(() => hqRunStatus(db, ctxOf(config, db, "assistant", "regisseur"), { runId: 9_999 }), /No run #9999/);
});
