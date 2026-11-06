import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { getDbAt, now, type TaskRow } from "../src/server/db";
import type { Engine, RunEvent, RunInput } from "../src/server/engine";
import { parsePrepareOutput, type PrepareInput } from "../src/server/prepare";
import { loadHome } from "../src/server/rooms";
import { PREPARE_SKIPPED, PREPARED_HEADING, runsToday, SKIPPED_SUMMARY, startRun, wakeAgents } from "../src/server/runner";
import { makeHome, waitForRun } from "./helpers";

const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

const doneEvents: RunEvent[] = [
  { type: "start", sessionId: "s-1", model: "haiku", tools: [], mcpServers: [] },
  { type: "text", text: "Done." },
  { type: "end", status: "done", reason: "success", summary: "Done.", usage, costUsd: 0.01 },
];

function fakeEngine(seen: RunInput[], events: RunEvent[] = doneEvents): Engine {
  return {
    name: "claude",
    async *run(input) {
      seen.push(input);
      for (const event of events) yield event;
    },
  };
}

type AgentExtra = Record<string, unknown>;

/** A home whose one agent ("scout", haiku) has these extra room.json fields, and these files in the home. */
function homeWith(extra: AgentExtra, files: Record<string, string> = {}) {
  const config = makeHome(
    {},
    {
      name: "demo",
      targetRepo: "../demo-project",
      agents: [{ id: "scout", name: "Scout", role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"], ...extra }],
    },
  );
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(config.home, name), content);
  return config;
}

/** A prepare script that saves its stdin to stdin.json in the home and prints `answer`. */
function gate(answer: unknown): string {
  return [
    'import fs from "node:fs";',
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => (input += chunk));",
    "process.stdin.on('end', () => {",
    "  fs.writeFileSync('stdin.json', input);",
    `  process.stdout.write(${JSON.stringify(JSON.stringify(answer))});`,
    "});",
  ].join("\n");
}

const prepare = (file: string, timeoutSeconds?: number) => ({
  prepare: { command: [process.execPath, file], ...(timeoutSeconds ? { timeoutSeconds } : {}) },
});

// --- room.json -------------------------------------------------------------------

test("room.json accepts effort, modelFor, prepare and cacheTtl, and refuses wrong values", () => {
  const config = homeWith({ effort: "low", modelFor: { message: "sonnet" }, cacheTtl: "5m", ...prepare("gate.mjs", 5) });
  const agent = loadHome(config.home).rooms[0]!.agents[0]!;
  assert.equal(agent.effort, "low");
  assert.deepEqual(agent.modelFor, { message: "sonnet" });
  assert.equal(agent.cacheTtl, "5m");
  assert.deepEqual(agent.prepare, { command: [process.execPath, "gate.mjs"], timeoutMs: 5_000 });
  assert.equal(loadHome(homeWith({ prepare: { command: ["node", "x.mjs"] } }).home).rooms[0]!.agents[0]!.prepare!.timeoutMs, 60_000);

  for (const wrong of [{ effort: "huge" }, { modelFor: { message: "gpt" } }, { cacheTtl: "10m" }, { prepare: { command: [] } }]) {
    const home = loadHome(homeWith(wrong).home);
    assert.equal(home.rooms.length, 0, JSON.stringify(wrong));
    assert.equal(home.invalid.length, 1);
  }
});

// --- effort, modelFor, cacheTtl ----------------------------------------------------

test("effort and cacheTtl reach the engine; left out, nothing is passed", async () => {
  const seen: RunInput[] = [];
  const config = homeWith({ effort: "low", cacheTtl: "5m" });
  await waitForRun(getDbAt(config.dbPath), startRun({ room: "demo", agent: "scout" }, { config, engine: fakeEngine(seen) }).id);
  assert.equal(seen[0]!.effort, "low");
  assert.equal(seen[0]!.cacheTtl, "5m");

  const plain = makeHome();
  await waitForRun(getDbAt(plain.dbPath), startRun({ room: "demo", agent: "scout" }, { config: plain, engine: fakeEngine(seen) }).id);
  assert.equal(seen[1]!.effort, undefined);
  assert.equal(seen[1]!.cacheTtl, undefined);
});

test("modelFor picks the model by the motive of the run", async () => {
  const seen: RunInput[] = [];
  const config = homeWith({ model: "opus", modelFor: { message: "sonnet", routine: "haiku" } });
  const db = getDbAt(config.dbPath);
  const engine = fakeEngine(seen);
  // A manual run (no reason): the agent's model.
  await waitForRun(db, startRun({ room: "demo", agent: "scout", task: "By hand." }, { config, engine }).id);
  // A routine (routines.ts passes the motive), then a run woken by a message.
  await waitForRun(db, startRun({ room: "demo", agent: "scout" }, { config, engine, motive: "routine" }).id);
  await waitForRun(db, startRun({ room: "demo", agent: "scout", reason: "message" }, { config, engine }).id);
  // Another reason: the agent's model.
  await waitForRun(db, startRun({ room: "demo", agent: "scout", reason: "mail" }, { config, engine }).id);
  assert.deepEqual(
    seen.map((input) => input.model),
    ["opus", "haiku", "sonnet", "opus"],
  );
});

test("a run woken by a message gets the model of the message motive, not the motive of the run that woke it", async () => {
  const seen: RunInput[] = [];
  const config = homeWith({ model: "opus", modelFor: { message: "sonnet", routine: "haiku" } });
  const db = getDbAt(config.dbPath);
  await waitForRun(db, startRun({ room: "demo", agent: "scout" }, { config, engine: fakeEngine(seen), motive: "routine" }).id);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const at = now();
  db.prepare(
    "INSERT INTO tasks (room, agent_id, source, text, status, from_room, from_agent, created_at, updated_at) VALUES ('demo', 'scout', 'message', 'Hello', 'pending', 'other', 'bob', ?, ?)",
  ).run(at, at);
  const [woken] = wakeAgents(config, db, { engine: fakeEngine(seen), motive: "routine" });
  assert.ok(woken);
  await waitForRun(db, woken.id);
  assert.equal(seen[1]!.model, "sonnet");
});

// --- prepare -----------------------------------------------------------------------

test("prepare run false: the turn is skipped, visible, free, and its tasks are closed with the reason", async () => {
  const seen: RunInput[] = [];
  const sent: string[] = [];
  const config = homeWith({ notifyRuns: "summary", ...prepare("gate.mjs") }, { "gate.mjs": gate({ run: false, reason: "No new sign-up yesterday." }) });
  const db = getDbAt(config.dbPath);
  const at = now();
  db.prepare(
    "INSERT INTO tasks (room, agent_id, source, text, status, from_room, from_agent, created_at, updated_at) VALUES ('demo', 'scout', 'message', 'Any news?', 'pending', 'demo', 'lead', ?, ?)",
  ).run(at, at);
  const run = startRun(
    { room: "demo", agent: "scout", task: "Morning alert.\nDetails below." },
    { config, engine: fakeEngine(seen), send: async (text) => (sent.push(text), true) },
  );
  const finished = await waitForRun(db, run.id);
  assert.equal(seen.length, 0, "no model turn");
  assert.equal(finished.status, "done");
  assert.equal(finished.cost_usd, 0);
  assert.equal(finished.input_tokens + finished.output_tokens, 0);
  assert.equal(finished.summary, `${SKIPPED_SUMMARY} No new sign-up yesterday.`);
  const end = db.prepare("SELECT data FROM events WHERE run_id = ? AND type = 'end'").get(run.id) as { data: string };
  assert.equal((JSON.parse(end.data) as { reason: string }).reason, PREPARE_SKIPPED);
  const tasks = db.prepare("SELECT * FROM tasks WHERE run_id = ? ORDER BY id").all(run.id) as TaskRow[];
  assert.equal(tasks.length, 2);
  for (const task of tasks) {
    assert.equal(task.status, "done");
    assert.equal(task.note, "No new sign-up yesterday.");
  }
  assert.deepEqual(sent, [], "a skipped turn delivers nothing");

  const stdin = JSON.parse(fs.readFileSync(path.join(config.home, "stdin.json"), "utf8")) as PrepareInput;
  assert.equal(stdin.room, "demo");
  assert.equal(stdin.agent, "scout");
  assert.equal(stdin.motive, "manual");
  assert.equal(stdin.task!.title, "Morning alert.");
  assert.equal(stdin.task!.body, "Morning alert.\nDetails below.");
  assert.deepEqual(stdin.messages, [{ from: "demo/lead", text: "Any news?", expects: null }]);
  assert.equal(stdin.lastRunAt, null);
  assert.ok(!Number.isNaN(Date.parse(stdin.now)));
});

test("prepare context, model and effort apply to that run only; lastRunAt is the last run that ended well", async () => {
  const seen: RunInput[] = [];
  const config = homeWith(
    { effort: "high", ...prepare("gate.mjs") },
    { "gate.mjs": gate({ run: true, context: "Two new sign-ups: Ana, Bo.", model: "sonnet", effort: "low" }) },
  );
  const db = getDbAt(config.dbPath);
  const first = await waitForRun(db, startRun({ room: "demo", agent: "scout" }, { config, engine: fakeEngine(seen) }).id);
  const input = seen[0]!;
  assert.equal(input.model, "sonnet");
  assert.equal(input.effort, "low");
  assert.match(input.prompt, new RegExp(`${PREPARED_HEADING}\\n\\nTwo new sign-ups: Ana, Bo\\.\\n\\nToday is `));

  await waitForRun(db, startRun({ room: "demo", agent: "scout" }, { config, engine: fakeEngine(seen) }).id);
  const stdin = JSON.parse(fs.readFileSync(path.join(config.home, "stdin.json"), "utf8")) as PrepareInput;
  assert.equal(stdin.lastRunAt, first.started_at);
  assert.equal(stdin.task!.body, "Do the routine work described in your role.");
});

test("prepare fails open: a non-zero exit, a timeout or an invalid answer run the turn normally", async () => {
  const cases: Record<string, string> = {
    "exit.mjs": "process.exit(3);",
    "slow.mjs": "setTimeout(() => {}, 10_000);",
    "junk.mjs": "process.stdout.write('not json');",
    "shape.mjs": "process.stdout.write(JSON.stringify({ run: 'maybe' }));",
  };
  for (const [file, script] of Object.entries(cases)) {
    const seen: RunInput[] = [];
    const config = homeWith(prepare(file, 0.5), { [file]: script });
    const db = getDbAt(config.dbPath);
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args.join(" "));
    try {
      const run = await waitForRun(db, startRun({ room: "demo", agent: "scout" }, { config, engine: fakeEngine(seen) }).id);
      assert.equal(run.status, "done", file);
    } finally {
      console.error = original;
    }
    assert.equal(seen.length, 1, `${file}: the turn runs`);
    assert.equal(seen[0]!.model, "haiku");
    assert.ok(!seen[0]!.prompt.includes(PREPARED_HEADING), file);
    assert.ok(
      errors.some((line) => String(line).includes("prepare command of demo/scout failed")),
      `${file}: the failure is logged`,
    );
    if (file === "slow.mjs") assert.ok(errors.some((line) => String(line).includes("timed out")));
  }
});

test("a prepare command that cannot start fails open too", async () => {
  const seen: RunInput[] = [];
  const config = homeWith({ prepare: { command: ["no-such-program-in-tests"] } });
  const original = console.error;
  console.error = () => undefined;
  try {
    await waitForRun(getDbAt(config.dbPath), startRun({ room: "demo", agent: "scout" }, { config, engine: fakeEngine(seen) }).id);
  } finally {
    console.error = original;
  }
  assert.equal(seen.length, 1);
});

test("the prepare answer is read strictly", () => {
  assert.deepEqual(parsePrepareOutput('{"run":false,"reason":"nothing"}'), { kind: "skip", reason: "nothing" });
  assert.deepEqual(parsePrepareOutput('{"run":true}\n'), { kind: "run", context: null, model: null, effort: null });
  assert.equal(parsePrepareOutput('{"run":false}').kind, "error");
  assert.equal(parsePrepareOutput('{"run":true,"model":"gpt"}').kind, "error");
  assert.equal(parsePrepareOutput('{"run":true,"effort":"huge"}').kind, "error");
  assert.equal(parsePrepareOutput("").kind, "error");
});

test("a skipped turn does not count in the daily cap, nor alerts it, and stays in the list of runs", async () => {
  const seen: RunInput[] = [];
  const sent: string[] = [];
  const config = homeWith({ ...prepare("gate.mjs") }, { "gate.mjs": gate({ run: false, reason: "Nothing new." }) });
  config.maxRunsPerDay = 1;
  const db = getDbAt(config.dbPath);
  const send = async (text: string) => (sent.push(text), true);
  for (let i = 0; i < 3; i++) {
    const run = startRun({ room: "demo", agent: "scout" }, { config, engine: fakeEngine(seen), send });
    assert.equal((await waitForRun(db, run.id)).status, "done");
  }
  assert.equal(runsToday(db), 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n, 3, "the skipped runs are listed");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(sent, [], "no cap alert");
  assert.equal(seen.length, 0);
});
