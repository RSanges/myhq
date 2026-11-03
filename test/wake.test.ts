import assert from "node:assert/strict";
import { test } from "node:test";
import { hqMessage } from "../src/mcp/tools";
import { decideApproval } from "../src/server/approvals";
import type { HqConfig } from "../src/server/config";
import { getDbAt, type Db, type RunRow, type TaskRow } from "../src/server/db";
import type { Engine, RunEvent, RunInput } from "../src/server/engine";
import { loadHome } from "../src/server/rooms";
import { startRun, WAKE_TASK } from "../src/server/runner";
import { makeHome, waitForRun } from "./helpers";

const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const done: RunEvent = { type: "end", status: "done", reason: "success", summary: "ok", usage, costUsd: 0 };
const failed: RunEvent = { type: "end", status: "failed", reason: "spawn_error", summary: "boom", usage, costUsd: 0 };

/**
 * A home with a scout and a writer (the defaults: woken by a message and by a
 * revision), and a mailer (onApproval: task) that batches its work: it opted
 * out of waking for messages and revisions.
 */
function wakeHome(overrides: Partial<HqConfig> = {}): HqConfig {
  const base = { role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"] };
  return makeHome(overrides, {
    name: "demo",
    targetRepo: "../demo-project",
    agents: [
      { id: "scout", name: "Scout", ...base },
      { id: "mailer", name: "Mailer", ...base, onApproval: "task", onMessage: "queue", onRevise: "queue" },
      { id: "writer", name: "Writer", ...base },
    ],
  });
}

type Script = (input: RunInput) => AsyncIterable<RunEvent>;

/** One engine for every run (wake-ups reuse it), scripted per agent; records each input. */
function engine(scripts: Record<string, Script>, seen: RunInput[]): Engine {
  return {
    name: "claude",
    async *run(input) {
      seen.push(input);
      const script = scripts[input.agentId];
      if (script) yield* script(input);
      else yield done;
    },
  };
}

function addApproval(db: Db, agent: string, title: string): number {
  return Number(
    db
      .prepare(
        "INSERT INTO approvals (room, agent_id, type, title, body, status, created_at) VALUES ('demo', ?, 'mail_reply', ?, 'Hello.', 'pending', ?)",
      )
      .run(agent, title, new Date().toISOString()).lastInsertRowid,
  );
}

const runsOf = (db: Db, agent: string) =>
  db.prepare("SELECT * FROM runs WHERE agent_id = ? ORDER BY id").all(agent) as RunRow[];

const approvalTasks = (db: Db) => db.prepare("SELECT * FROM tasks WHERE source = 'approval'").all() as TaskRow[];

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("room.json: onApproval, onMessage and onRevise are optional, null (the default) unless set, and checked", () => {
  const config = wakeHome();
  const agents = loadHome(config.home).rooms[0]!.agents;
  assert.deepEqual(
    agents.map((a) => [a.id, a.onApproval, a.onMessage, a.onRevise]),
    [
      ["scout", null, null, null],
      ["mailer", "task", "queue", "queue"],
      ["writer", null, null, null],
    ],
  );
  const queued = makeHome(
    {},
    {
      name: "demo",
      targetRepo: "x",
      agents: [
        { id: "scout", name: "S", role: "roles/scout.md", model: "haiku", allowedTools: [], onApproval: "queue", onMessage: "run", onRevise: "run" },
      ],
    },
  );
  const [scout] = loadHome(queued.home).rooms[0]!.agents;
  assert.deepEqual([scout!.onApproval, scout!.onMessage, scout!.onRevise], ["queue", "run", "run"]);
  const bad = makeHome(
    {},
    {
      name: "demo",
      targetRepo: "x",
      agents: [{ id: "scout", name: "S", role: "roles/scout.md", model: "haiku", allowedTools: [], onApproval: "run" }],
    },
  );
  assert.match(loadHome(bad.home).invalid[0]!.error, /onApproval/);
});

test("approving an item of an onApproval agent creates its task and starts a run at once", async () => {
  const config = wakeHome();
  const db = getDbAt(config.dbPath);
  const seen: RunInput[] = [];
  const first = startRun({ room: "demo", agent: "scout" }, { config, engine: engine({}, seen) });
  await waitForRun(db, first.id);
  const id = addApproval(db, "mailer", "Reply to Alice");
  decideApproval(db, id, { decision: "approved" }, config, { engine: engine({}, seen), send: async () => true });

  const [task] = approvalTasks(db);
  assert.ok(task);
  assert.equal(task.agent_id, "mailer");
  assert.equal(task.ref_id, id);
  assert.equal(task.text, `Exécute l'item approuvé n° ${id} : Reply to Alice`);
  const [run] = runsOf(db, "mailer");
  assert.ok(run, "a run of the mailer started at once");
  assert.equal(run.reason, "approval");
  assert.equal(run.task, WAKE_TASK);
  await waitForRun(db, run.id);
  const input = seen.find((i) => i.agentId === "mailer")!;
  assert.ok(input.prompt.includes(`[task ${task.id}, approval] Exécute l'item approuvé n° ${id} : Reply to Alice`));
  assert.equal((db.prepare("SELECT status FROM tasks WHERE id = ?").get(task.id) as TaskRow).status, "done");
});

test("one task per approval, and none for another decision or an agent without onApproval", async () => {
  const config = wakeHome();
  const db = getDbAt(config.dbPath);
  const seen: RunInput[] = [];
  const first = startRun({ room: "demo", agent: "scout" }, { config, engine: engine({}, seen) });
  await waitForRun(db, first.id);
  decideApproval(db, addApproval(db, "scout", "A reply"), { decision: "approved" }, config, { engine: engine({}, seen) });
  const rejected = addApproval(db, "mailer", "No");
  decideApproval(db, rejected, { decision: "rejected", note: "no" }, config, { engine: engine({}, seen) });
  assert.equal(approvalTasks(db).length, 0);
  assert.equal(runsOf(db, "scout").length, 1);
  assert.equal(runsOf(db, "mailer").length, 0);
});

test("an approval while the agent is busy waits, then wakes it once its run ends", async () => {
  const config = wakeHome();
  const db = getDbAt(config.dbPath);
  const seen: RunInput[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  const scripts: Record<string, Script> = {
    mailer: async function* () {
      if (calls++ === 0) await gate;
      yield done;
    },
  };
  const deps = { config, engine: engine(scripts, seen), send: async () => true };
  const busy = startRun({ room: "demo", agent: "mailer" }, deps);
  await sleep(5);
  const id = addApproval(db, "mailer", "Reply to Bob");
  decideApproval(db, id, { decision: "approved" }, config, deps);
  assert.equal(runsOf(db, "mailer").length, 1, "no second run while the lock is held");
  assert.equal(approvalTasks(db)[0]!.status, "pending");

  release();
  await waitForRun(db, busy.id);
  await until(() => runsOf(db, "mailer").length === 2);
  const woken = runsOf(db, "mailer")[1]!;
  assert.equal(woken.reason, "approval");
  await waitForRun(db, woken.id);
  assert.ok(seen[1]!.prompt.includes(`Exécute l'item approuvé n° ${id} : Reply to Bob`));
  await sleep(50);
  assert.equal(runsOf(db, "mailer").length, 2, "woken once");
});

test("with the daily cap reached, the task waits for the next run", async () => {
  const config = wakeHome({ maxRunsPerDay: 1 });
  const db = getDbAt(config.dbPath);
  const seen: RunInput[] = [];
  const first = startRun({ room: "demo", agent: "scout" }, { config, engine: engine({}, seen) });
  await waitForRun(db, first.id);
  decideApproval(db, addApproval(db, "mailer", "Capped"), { decision: "approved" }, config, { engine: engine({}, seen) });
  assert.equal(runsOf(db, "mailer").length, 0);
  assert.equal(approvalTasks(db)[0]!.status, "pending");
});

test("an hq_message starts the run of its recipient at once; an agent that opted out only queues it", async () => {
  const config = wakeHome();
  const db = getDbAt(config.dbPath);
  const seen: RunInput[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const scripts: Record<string, Script> = {
    scout: async function* (input) {
      const ctx = { dbPath: config.dbPath, runId: input.runId, agentId: "scout", room: "demo" };
      hqMessage(db, ctx, { to: "writer", text: "Draft the post." });
      hqMessage(db, ctx, { to: "mailer", text: "FYI." });
      yield { type: "tool_call", id: "t1", name: "mcp__hq__hq_message", input: {} };
      yield { type: "tool_result", toolUseId: "t1", isError: false, content: "{}" };
      await gate;
      yield done;
    },
  };
  const run = startRun({ room: "demo", agent: "scout" }, { config, engine: engine(scripts, seen), send: async () => true });
  // The writer starts while the scout's run is still going (on the tool result).
  await until(() => runsOf(db, "writer").length === 1);
  assert.equal((db.prepare("SELECT status FROM runs WHERE id = ?").get(run.id) as RunRow).status, "running");
  const writerRun = runsOf(db, "writer")[0]!;
  assert.equal(writerRun.reason, "message");
  await waitForRun(db, writerRun.id);
  release();
  await waitForRun(db, run.id);
  assert.match(seen.find((i) => i.agentId === "writer")!.prompt, /\[task \d+, message\] Message from scout: Draft the post\./);
  await sleep(50);
  assert.equal(runsOf(db, "writer").length, 1);
  assert.equal(runsOf(db, "mailer").length, 0, "the mailer opted out of waking on messages");
  const waiting = db.prepare("SELECT * FROM tasks WHERE agent_id = 'mailer' AND status = 'pending'").all() as TaskRow[];
  assert.equal(waiting.length, 1);
});

test("a woken run that fails is not woken again in a loop", async () => {
  const config = wakeHome();
  const db = getDbAt(config.dbPath);
  const seen: RunInput[] = [];
  const scripts: Record<string, Script> = {
    scout: async function* (input) {
      hqMessage(db, { dbPath: config.dbPath, runId: input.runId, agentId: "scout", room: "demo" }, { to: "writer", text: "Go." });
      yield done;
    },
    writer: async function* () {
      yield failed;
    },
  };
  const run = startRun({ room: "demo", agent: "scout" }, { config, engine: engine(scripts, seen), send: async () => true });
  await waitForRun(db, run.id);
  await until(() => runsOf(db, "writer").length === 1);
  await waitForRun(db, runsOf(db, "writer")[0]!.id);
  await sleep(100);
  assert.equal(runsOf(db, "writer").length, 1);
  const task = db.prepare("SELECT * FROM tasks WHERE agent_id = 'writer' AND source = 'message'").get() as TaskRow;
  assert.equal(task.status, "pending", "the message waits for the writer's next run");
});

test("a revise decision starts a run of the agent at once, with the reason revise", async () => {
  const config = wakeHome();
  const db = getDbAt(config.dbPath);
  const seen: RunInput[] = [];
  const id = addApproval(db, "scout", "A reply");
  decideApproval(db, id, { decision: "revise", note: "Shorter." }, config, { engine: engine({}, seen), send: async () => true });
  const [run] = runsOf(db, "scout");
  assert.ok(run, "a run started at once");
  assert.equal(run.reason, "revise");
  assert.equal(run.task, WAKE_TASK);
  await waitForRun(db, run.id);
  assert.ok(seen[0]!.prompt.includes(`, revise] Revise your submission #${id} "A reply" (mail_reply). User's note: Shorter.`));
  const task = db.prepare("SELECT status FROM tasks WHERE source = 'revise'").get() as TaskRow;
  assert.equal(task.status, "done");
});

test("a revision of an approved item wakes the agent too", async () => {
  const config = wakeHome();
  const db = getDbAt(config.dbPath);
  const seen: RunInput[] = [];
  const deps = { engine: engine({}, seen), send: async () => true };
  const id = addApproval(db, "scout", "A reply");
  decideApproval(db, id, { decision: "approved" }, config, deps);
  assert.equal(runsOf(db, "scout").length, 0, "approving gives the scout no task");
  decideApproval(db, id, { decision: "revise", note: "Not that tone." }, config, deps);
  const [run] = runsOf(db, "scout");
  assert.equal(run?.reason, "revise");
  await waitForRun(db, run!.id);
});

test("an agent with onRevise: queue only gets the task, for its next run", async () => {
  const config = wakeHome();
  const db = getDbAt(config.dbPath);
  const seen: RunInput[] = [];
  const id = addApproval(db, "mailer", "A mail");
  decideApproval(db, id, { decision: "revise", note: "Redo." }, config, { engine: engine({}, seen), send: async () => true });
  await sleep(50);
  assert.equal(runsOf(db, "mailer").length, 0);
  const task = db.prepare("SELECT * FROM tasks WHERE source = 'revise'").get() as TaskRow;
  assert.equal(task.agent_id, "mailer");
  assert.equal(task.status, "pending");
});

test("a revision while the agent is busy waits, then wakes it once its run ends", async () => {
  const config = wakeHome();
  const db = getDbAt(config.dbPath);
  const seen: RunInput[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  const scripts: Record<string, Script> = {
    scout: async function* () {
      if (calls++ === 0) await gate;
      yield done;
    },
  };
  const deps = { config, engine: engine(scripts, seen), send: async () => true };
  const busy = startRun({ room: "demo", agent: "scout" }, deps);
  await sleep(5);
  decideApproval(db, addApproval(db, "scout", "Busy"), { decision: "revise", note: "Redo." }, config, deps);
  assert.equal(runsOf(db, "scout").length, 1, "no second run while the lock is held");
  release();
  await waitForRun(db, busy.id);
  await until(() => runsOf(db, "scout").length === 2);
  assert.equal(runsOf(db, "scout")[1]!.reason, "revise");
  await sleep(50);
  assert.equal(runsOf(db, "scout").length, 2, "woken once");
});

test("a revision whose woken run fails is not woken again in a loop", async () => {
  const config = wakeHome();
  const db = getDbAt(config.dbPath);
  const seen: RunInput[] = [];
  const deps = { engine: engine({ scout: async function* () { yield failed; } }, seen), send: async () => true };
  decideApproval(db, addApproval(db, "scout", "Fails"), { decision: "revise", note: "Redo." }, config, deps);
  await until(() => runsOf(db, "scout").length === 1);
  await waitForRun(db, runsOf(db, "scout")[0]!.id);
  await sleep(100);
  assert.equal(runsOf(db, "scout").length, 1);
  const task = db.prepare("SELECT status FROM tasks WHERE source = 'revise'").get() as TaskRow;
  assert.equal(task.status, "pending", "the revision waits for the agent's next run");
});

test("onApproval: queue creates the task of an approved item but does not wake the agent", async () => {
  const base = { role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"] };
  const config = makeHome({}, {
    name: "demo",
    targetRepo: "../demo-project",
    agents: [{ id: "scout", name: "Scout", ...base, onApproval: "queue" }],
  });
  const db = getDbAt(config.dbPath);
  const seen: RunInput[] = [];
  decideApproval(db, addApproval(db, "scout", "Batch"), { decision: "approved" }, config, { engine: engine({}, seen) });
  await sleep(50);
  assert.equal(approvalTasks(db).length, 1);
  assert.equal(approvalTasks(db)[0]!.status, "pending");
  assert.equal(runsOf(db, "scout").length, 0);
});

test("an hq_message wakes an agent that did not set onMessage (the default)", async () => {
  const config = wakeHome();
  const db = getDbAt(config.dbPath);
  const seen: RunInput[] = [];
  const deps = { config, engine: engine({}, seen), send: async () => true };
  const sender = startRun({ room: "demo", agent: "writer" }, deps);
  await waitForRun(db, sender.id);
  hqMessage(db, { dbPath: config.dbPath, runId: sender.id, agentId: "writer", room: "demo" }, { to: "scout", text: "Hi." });
  const { wakeAgents } = await import("../src/server/runner");
  wakeAgents(config, db, deps);
  const [run] = runsOf(db, "scout");
  assert.equal(run?.reason, "message", "scout has no onMessage: it wakes by default");
  await waitForRun(db, run!.id);
});
