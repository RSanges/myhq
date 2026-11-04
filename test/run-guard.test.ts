import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CLAUDE_ENV } from "../src/server/claude-engine";
import { getDbAt, now, type Db, type RunRow, type TaskRow } from "../src/server/db";
import type { Engine, RunEvent, RunInput } from "../src/server/engine";
import { MCP_NOT_CONNECTED, notConnectedServers, startRun, todayLine } from "../src/server/runner";
import { makeHome, waitForRun } from "./helpers";

const usage = { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

function start(status: string): RunEvent {
  return {
    type: "start",
    sessionId: "s",
    model: "haiku",
    tools: [],
    mcpServers: [
      { name: "mail", status: "connected" },
      { name: "hq", status },
    ],
  };
}

/** What a run without its tools did on run 92: text pretending to call tools, then a made-up result. */
const runWithoutTools: RunEvent[] = [
  start("pending"),
  { type: "text", text: "<function_calls>[{\"tool\": \"hq_read_decisions\"}]" },
  { type: "end", status: "done", reason: "success", summary: "An invented recap.", usage, costUsd: 0.01 },
];

const goodRun: RunEvent[] = [
  start("connected"),
  { type: "text", text: "Working." },
  { type: "end", status: "done", reason: "success", summary: "A real recap.", usage, costUsd: 0.02 },
];

/** An engine that plays one script per run, in order; it records what each run got and how far it went. */
function scriptedEngine(scripts: RunEvent[][], seen: RunInput[], yielded: number[]): Engine {
  return {
    name: "claude",
    async *run(input) {
      const index = seen.length;
      seen.push(input);
      yielded[index] = 0;
      for (const event of scripts[index] ?? []) {
        yielded[index]! += 1;
        yield event;
      }
    },
  };
}

async function waitForRunCount(db: Db, count: number, timeoutMs = 3_000): Promise<RunRow[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const runs = db.prepare("SELECT * FROM runs ORDER BY id").all() as RunRow[];
    if (runs.length >= count) return runs;
    if (Date.now() > deadline) throw new Error(`${runs.length} runs after ${timeoutMs} ms, expected ${count}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function eventTypes(db: Db, runId: number): string[] {
  return (db.prepare("SELECT type FROM events WHERE run_id = ? ORDER BY id").all(runId) as { type: string }[]).map(
    (e) => e.type,
  );
}

function queueMessage(db: Db, text: string): number {
  const at = now();
  return Number(
    db
      .prepare(
        "INSERT INTO tasks (room, agent_id, source, text, status, created_at, updated_at) VALUES ('demo', 'scout', 'message', ?, 'pending', ?, ?)",
      )
      .run(text, at, at).lastInsertRowid,
  );
}

test("notConnectedServers names every server of the start event that is not connected", () => {
  assert.deepEqual(notConnectedServers([]), []);
  assert.deepEqual(
    notConnectedServers([
      { name: "hq", status: "connected" },
      { name: "mail", status: "pending" },
      { name: "agenda", status: "failed" },
    ]),
    ["mail (pending)", "agenda (failed)"],
  );
});

test("every claude process waits for its MCP servers before the first turn", () => {
  assert.equal(CLAUDE_ENV.MCP_CONNECTION_NONBLOCKING, "0");
  assert.ok(Number(CLAUDE_ENV.MCP_CONNECT_TIMEOUT_MS) >= 30_000);
});

test("a run whose MCP server is pending at its start is stopped, delivers nothing, and is retried once", async () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const taskId = queueMessage(db, "Answer the landlord.");
  const seen: RunInput[] = [];
  const yielded: number[] = [];
  const sent: string[] = [];
  const first = startRun(
    { room: "demo", agent: "scout", task: "Write the recap.", reason: "routine" },
    {
      config,
      engine: scriptedEngine([runWithoutTools, goodRun], seen, yielded),
      send: async (t) => (sent.push(t), true),
      mcpRetryDelayMs: 20,
    },
  );

  const stopped = await waitForRun(db, first.id);
  assert.equal(stopped.status, "failed");
  assert.match(stopped.summary ?? "", /MCP server not connected: hq \(pending\)/);
  assert.match(stopped.summary ?? "", /Retried once/);
  assert.equal(stopped.cost_usd, 0);
  assert.equal(yielded[0], 1, "the engine is not read past the start event");
  assert.deepEqual(eventTypes(db, first.id), ["start", "end"], "no text, no tool call, no result is kept");
  const end = db.prepare("SELECT data FROM events WHERE run_id = ? AND type = 'end'").get(first.id) as { data: string };
  assert.equal((JSON.parse(end.data) as { reason: string }).reason, MCP_NOT_CONNECTED);

  const [, retry] = await waitForRunCount(db, 2);
  const done = await waitForRun(db, retry!.id);
  assert.equal(done.status, "done");
  assert.equal(done.summary, "A real recap.");
  assert.equal(done.task, "Write the recap.");
  assert.equal(done.reason, "routine");
  assert.match(seen[1]!.prompt, /\[task \d+, message\] Answer the landlord\./, "the retry takes the mailbox back");
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow;
  assert.equal(task.run_id, retry!.id);
  assert.equal(task.status, "done");

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sent.length, 0, "a failure retried with success alerts nobody");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n, 2);
});

test("a second run without its MCP servers stays failed, is not retried again, and is alerted", async () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const seen: RunInput[] = [];
  const yielded: number[] = [];
  const sent: string[] = [];
  const first = startRun(
    { room: "demo", agent: "scout" },
    {
      config,
      engine: scriptedEngine([runWithoutTools, runWithoutTools, goodRun], seen, yielded),
      send: async (t) => (sent.push(t), true),
      mcpRetryDelayMs: 20,
    },
  );
  await waitForRun(db, first.id);
  const [, retry] = await waitForRunCount(db, 2);
  const second = await waitForRun(db, retry!.id);
  assert.equal(second.status, "failed");
  assert.match(second.summary ?? "", /MCP server not connected: hq \(pending\)/);
  assert.match(second.summary ?? "", /no retry/);
  assert.deepEqual(eventTypes(db, second.id), ["start", "end"]);

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n, 2, "one retry, never two");
  assert.equal(sent.length, 1, "only the second failure is alerted");
  assert.match(sent[0]!, new RegExp(`#${second.id}`));
});

test("a retry that cannot start alerts the first failure", async () => {
  const config = makeHome({ maxRunsPerDay: 1 });
  const db = getDbAt(config.dbPath);
  const sent: string[] = [];
  const first = startRun(
    { room: "demo", agent: "scout" },
    {
      config,
      engine: scriptedEngine([runWithoutTools, goodRun], [], []),
      send: async (t) => (sent.push(t), true),
      mcpRetryDelayMs: 20,
    },
  );
  await waitForRun(db, first.id);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, new RegExp(`#${first.id}`));
  assert.match(sent[0]!, /The retry could not start: Daily cap reached/);
});

test("todayLine gives the weekday in full, in the home's language and time zone", () => {
  // 4 November 2026 was a Wednesday.
  const evening = new Date("2026-11-04T18:00:00Z");
  assert.match(todayLine(evening, "Europe/Paris", "fr"), /^Today is mercredi 4 novembre 2026 \(2026-11-04, time zone Europe\/Paris\)\./);
  assert.match(todayLine(evening, "Europe/Paris", "en"), /^Today is Wednesday, November 4, 2026 \(2026-11-04,/);
  // Half past midnight in Paris is already Thursday, while it is still Wednesday in UTC.
  const late = new Date("2026-11-04T23:30:00Z");
  assert.match(todayLine(late, "Europe/Paris", "fr"), /^Today is jeudi 5 novembre 2026 \(2026-11-05,/);
  assert.match(todayLine(late, "UTC", "fr"), /^Today is mercredi 4 novembre 2026 \(2026-11-04,/);
  assert.match(todayLine(evening, "Europe/Paris", "fr"), /never compute them yourself/);
});

test("every run's prompt ends with today's date and weekday, in the home's language", async () => {
  const config = makeHome({ timeZone: "Europe/Paris" });
  fs.writeFileSync(path.join(config.home, "myhq.json"), JSON.stringify({ language: "fr" }));
  const seen: RunInput[] = [];
  const db = getDbAt(config.dbPath);
  const run = startRun({ room: "demo", agent: "scout" }, { config, engine: scriptedEngine([goodRun], seen, []) });
  await waitForRun(db, run.id);
  const expected = todayLine(new Date(), "Europe/Paris", "fr");
  assert.ok(seen[0]!.prompt.endsWith(`\n\n${expected}`), seen[0]!.prompt);
  assert.match(expected, /^Today is (lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche) /);
});
