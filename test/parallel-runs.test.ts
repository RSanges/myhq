import assert from "node:assert/strict";
import { test } from "node:test";
import { activeRunsOf, buildQuestionPrompt } from "../src/server/agent-questions";
import { listBlocked, taskWait } from "../src/server/blocked";
import { getDbAt, type Db, type RunRow, type TaskRow } from "../src/server/db";
import type { Engine, RunEvent, RunInput } from "../src/server/engine";
import { HqError } from "../src/server/errors";
import type { MachineReading } from "../src/server/machine";
import { listQueue } from "../src/server/queue";
import { loadHome, syncHome } from "../src/server/rooms";
import { recoverInterruptedRuns, startRun, wakeAgents } from "../src/server/runner";
import { relaunchGuard } from "../src/server/supervisor";
import { createSubject } from "../src/server/subjects";
import { makeHome, waitForRun } from "./helpers";

// Several runs of one agent at once, one per subject (docs/architecture.md,
// "Several benches"): the lock, the wake-ups, the MCP retry, the Standard's
// reasons and the run state of a question. An agent without `parallel` keeps
// one run at a time, whatever its subjects.

const usage = { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const done: RunEvent = { type: "end", status: "done", reason: "success", summary: "ok", usage, costUsd: 0 };
const quiet = async () => false;

/** An engine whose runs wait until `release(runId)` (or `releaseAll`); `seen` records them. */
function heldEngine() {
  const gates = new Map<number, { promise: Promise<void>; open: () => void }>();
  const gateOf = (runId: number) => {
    let gate = gates.get(runId);
    if (!gate) {
      let open = () => {};
      const promise = new Promise<void>((resolve) => (open = resolve));
      gate = { promise, open };
      gates.set(runId, gate);
    }
    return gate;
  };
  const seen: RunInput[] = [];
  const engine: Engine = {
    name: "claude",
    async *run(input: RunInput): AsyncIterable<RunEvent> {
      seen.push(input);
      await gateOf(input.runId).promise;
      yield done;
    },
  };
  return {
    engine,
    seen,
    release: (runId: number) => gateOf(runId).open(),
    releaseAll: () => {
      for (const gate of gates.values()) gate.open();
    },
  };
}

function office(extra: Record<string, unknown> = {}, others: Record<string, unknown>[] = []) {
  const config = makeHome({}, {
    name: "demo",
    targetRepo: "../demo-project",
    agents: [{ id: "scout", name: "Scout", role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"], ...extra }, ...others],
  });
  const db = getDbAt(config.dbPath);
  syncHome(db, loadHome(config.home));
  return { config, db };
}

function task(db: Db, subject: number | null, text: string, source = "revise", agent = "scout"): number {
  const at = new Date().toISOString();
  return Number(
    db
      .prepare(
        `INSERT INTO tasks (room, agent_id, source, text, status, subject_id, created_at, updated_at) VALUES ('demo', ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(agent, source, text, subject, at, at).lastInsertRowid,
  );
}

const taskRow = (db: Db, id: number) => db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow;
const running = (db: Db) => db.prepare("SELECT * FROM runs WHERE status = 'running' ORDER BY id").all() as RunRow[];
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

function expectCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof HqError, String(error));
    assert.equal(error.code, code);
    return true;
  };
}

test("without parallel nothing changes: one run of the agent at a time, whatever its subject", async () => {
  const { config, db } = office();
  const held = heldEngine();
  const deps = { config, engine: held.engine, send: quiet };
  const one = createSubject(db, "demo", "scout", "One");
  const two = createSubject(db, "demo", "scout", "Two");
  const first = startRun({ room: "demo", agent: "scout", task: "One." }, { ...deps, subject: one.id });
  assert.throws(() => startRun({ room: "demo", agent: "scout", task: "Two." }, { ...deps, subject: two.id }), expectCode("AGENT_BUSY"));
  assert.throws(() => startRun({ room: "demo", agent: "scout", task: "General." }, deps), expectCode("AGENT_BUSY"));
  // A wake-up of the other subject waits for the end of the run, as before.
  const waiting = task(db, two.id, "Revise two.");
  assert.deepEqual(wakeAgents(config, db, deps), []);
  assert.equal(relaunchGuard(db, config, loadHome(config.home), "demo", "scout", two.id)?.code, "AGENT_BUSY");
  assert.equal(activeRunsOf(db, "demo", "scout").length, 1);
  held.release(first.id);
  await waitForRun(db, first.id);
  await tick();
  // Its end wakes the agent for the other subject.
  const [next] = running(db);
  assert.equal(next?.subject_id, two.id);
  assert.equal(taskRow(db, waiting).run_id, next!.id);
  held.releaseAll();
  await waitForRun(db, next!.id);
});

test("a parallel agent runs two subjects at once, never the same subject twice; the general subject is one of them", async () => {
  const { config, db } = office({ parallel: true });
  const held = heldEngine();
  const deps = { config, engine: held.engine, send: quiet };
  const one = createSubject(db, "demo", "scout", "One");
  const two = createSubject(db, "demo", "scout", "Two");
  const a = startRun({ room: "demo", agent: "scout", task: "One." }, { ...deps, subject: one.id });
  const b = startRun({ room: "demo", agent: "scout", task: "Two." }, { ...deps, subject: two.id });
  assert.throws(() => startRun({ room: "demo", agent: "scout", task: "One again." }, { ...deps, subject: one.id }), expectCode("AGENT_BUSY"));
  const general = startRun({ room: "demo", agent: "scout", task: "Routine." }, deps);
  assert.throws(() => startRun({ room: "demo", agent: "scout", task: "Routine again." }, deps), expectCode("AGENT_BUSY"));
  assert.deepEqual(
    running(db).map((run) => run.subject_id),
    [one.id, two.id, null],
  );
  const home = loadHome(config.home);
  assert.equal(relaunchGuard(db, config, home, "demo", "scout", one.id)?.code, "AGENT_BUSY");
  const three = createSubject(db, "demo", "scout", "Three");
  assert.equal(relaunchGuard(db, config, home, "demo", "scout", three.id), null, "a free subject can be relaunched");
  held.releaseAll();
  for (const run of [a, b, general]) assert.equal((await waitForRun(db, run.id)).status, "done");
});

test("wake-ups of a parallel agent: one run per subject in one pass, no second one while it runs, the queue order kept", async () => {
  const { config, db } = office({ parallel: true });
  const held = heldEngine();
  const deps = { config, engine: held.engine, send: quiet };
  const one = createSubject(db, "demo", "scout", "One");
  const two = createSubject(db, "demo", "scout", "Two");
  const t1 = task(db, one.id, "Revise one.");
  const t1b = task(db, one.id, "Revise one more.");
  const t2 = task(db, two.id, "Revise two.");
  const started = wakeAgents(config, db, deps);
  assert.deepEqual(
    started.map((run) => run.subject_id),
    [one.id, two.id],
    "in the queue's order, one run per subject",
  );
  assert.equal(taskRow(db, t1).run_id, started[0]!.id);
  assert.equal(taskRow(db, t1b).run_id, started[0]!.id, "the run takes its whole subject");
  assert.equal(taskRow(db, t2).run_id, started[1]!.id);
  // A new task of a busy subject waits for that subject's run; nothing starts twice.
  const later = task(db, one.id, "And this.");
  assert.deepEqual(wakeAgents(config, db, deps), []);
  assert.equal(taskRow(db, later).status, "pending");
  const wait = taskWait(db, config, loadHome(config.home), taskRow(db, later), loadHome(config.home).rooms[0]!.agents[0]!);
  assert.equal(wait.cause, "afterRun");
  assert.equal(wait.stuck, false);
  held.release(started[0]!.id);
  await waitForRun(db, started[0]!.id);
  await tick();
  const again = running(db).filter((run) => run.subject_id === one.id);
  assert.equal(again.length, 1, "its end wakes that subject once");
  assert.equal(taskRow(db, later).run_id, again[0]!.id);
  held.releaseAll();
  for (const run of running(db)) await waitForRun(db, run.id);
});

test("a shared resource and the machine still gate each run of a parallel agent, and no later task overtakes", async () => {
  const gpu = office({ parallel: true, resources: ["gpu"] }, [
    { id: "other", name: "Other", role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"], resources: ["gpu"] },
  ]);
  const held = heldEngine();
  const deps = { config: gpu.config, engine: held.engine, send: quiet };
  const one = createSubject(gpu.db, "demo", "scout", "One");
  const two = createSubject(gpu.db, "demo", "scout", "Two");
  task(gpu.db, one.id, "Render one.");
  const second = task(gpu.db, two.id, "Render two.");
  const theirs = task(gpu.db, null, "Render theirs.", "revise", "other");
  const started = wakeAgents(gpu.config, gpu.db, deps);
  assert.deepEqual(started.map((run) => run.subject_id), [one.id], "the second subject waits for the GPU its own first run holds");
  assert.equal(taskRow(gpu.db, theirs).status, "pending", "and the other agent's later task does not take the GPU before it");
  const queue = listQueue(gpu.db, gpu.config, loadHome(gpu.config.home));
  assert.equal(queue.find((entry) => entry.taskId === second)?.cause, "resource");
  held.release(started[0]!.id);
  await waitForRun(gpu.db, started[0]!.id);
  await tick();
  assert.deepEqual(running(gpu.db).map((run) => [run.agent_id, run.subject_id]), [["scout", two.id]], "the GPU goes to the first in the order");
  held.releaseAll();
  for (const run of running(gpu.db)) await waitForRun(gpu.db, run.id);

  // The machine: each run reserves its need, so a third run of the same agent waits for memory.
  const ram = office({ parallel: true, needs: { ramGb: 4 } });
  const reading = (): MachineReading => ({ at: new Date().toISOString(), ramFreeGb: 12, ramTotalGb: 32, vramUsedGb: null, vramTotalGb: null });
  const ramDeps = { config: ram.config, engine: held.engine, send: quiet, machine: reading };
  const subjects = ["A", "B", "C"].map((title) => createSubject(ram.db, "demo", "scout", title));
  for (const each of subjects) task(ram.db, each.id, `Work on ${each.title}.`);
  const ramStarted = wakeAgents(ram.config, ram.db, ramDeps);
  // 12 GB free, 2 GB kept free: two runs of 4 GB fit, the third does not.
  assert.deepEqual(ramStarted.map((run) => run.subject_id), [subjects[0]!.id, subjects[1]!.id]);
  held.releaseAll();
  for (const run of running(ram.db)) await waitForRun(ram.db, run.id);
});

test("a task that waits for the next run of a parallel agent is taken once a run of another subject ended done", async () => {
  const { config, db } = office({ parallel: true });
  const held = heldEngine();
  const deps = { config, engine: held.engine, send: quiet };
  const one = createSubject(db, "demo", "scout", "One");
  const two = createSubject(db, "demo", "scout", "Two");
  const note = task(db, one.id, "Note for the next run of one.", "manual");
  await tick();
  assert.deepEqual(wakeAgents(config, db, deps), [], "a manual task wakes nobody by itself");
  const other = startRun({ room: "demo", agent: "scout", task: "Two." }, { ...deps, subject: two.id });
  const wait = taskWait(db, config, loadHome(config.home), taskRow(db, note), loadHome(config.home).rooms[0]!.agents[0]!);
  assert.equal(wait.cause, "afterRun", "the end of the other subject's run will take it");
  held.release(other!.id);
  await waitForRun(db, other!.id);
  await tick();
  const [taken] = running(db);
  assert.equal(taken?.subject_id, one.id);
  assert.equal(taskRow(db, note).run_id, taken!.id);
  held.releaseAll();
  await waitForRun(db, taken!.id);
  assert.deepEqual(wakeAgents(config, db, deps), [], "and nothing more starts");
});

test("the Standard's reasons of a parallel agent read the run of the task's own subject", async () => {
  const { config, db } = office({ parallel: true });
  const held = heldEngine();
  const deps = { config, engine: held.engine, send: quiet };
  const one = createSubject(db, "demo", "scout", "One");
  const two = createSubject(db, "demo", "scout", "Two");
  const first = startRun({ room: "demo", agent: "scout", task: "One." }, { ...deps, subject: one.id });
  // A task given back to subject one while its run goes: that run's end does not take it (older than nothing, newer than the run).
  const given = task(db, one.id, "Given back.", "manual");
  const agent = loadHome(config.home).rooms[0]!.agents[0]!;
  assert.equal(taskWait(db, config, loadHome(config.home), taskRow(db, given), agent).cause, "busy");
  // A task of subject two, while only subject one runs, is not "busy": nothing holds its lock.
  const free = task(db, two.id, "Free.", "manual");
  assert.equal(taskWait(db, config, loadHome(config.home), taskRow(db, free), agent).cause, "noWake");
  const old = new Date(Date.now() + 20 * 60_000);
  const entries = listBlocked(db, loadHome(config.home), config, old);
  assert.equal(entries.find((entry) => entry.id === given)?.cause, "busy");
  held.releaseAll();
  await waitForRun(db, first.id);
});

test("the automatic MCP retry of a subject is not locked out by another subject's run, nor doubled", async () => {
  const { config, db } = office({ parallel: true });
  const one = createSubject(db, "demo", "scout", "One");
  const two = createSubject(db, "demo", "scout", "Two");
  let openTwo = () => {};
  const gateTwo = new Promise<void>((resolve) => (openTwo = resolve));
  let attempts = 0;
  const engine: Engine = {
    name: "claude",
    async *run(input: RunInput): AsyncIterable<RunEvent> {
      if (input.prompt.includes("Task:\nTwo.")) {
        await gateTwo;
        yield done;
        return;
      }
      attempts++;
      if (attempts === 1) {
        yield { type: "start", sessionId: "s", model: "haiku", tools: [], mcpServers: [{ name: "hq", status: "pending" }] };
        return;
      }
      yield done;
    },
  };
  const sent: string[] = [];
  const deps = { config, engine, send: async (text: string) => (sent.push(text), true), mcpRetryDelayMs: 20 };
  const busy = startRun({ room: "demo", agent: "scout", task: "Two." }, { ...deps, subject: two.id });
  const first = startRun({ room: "demo", agent: "scout", task: "One." }, { ...deps, subject: one.id });
  assert.equal((await waitForRun(db, first.id)).status, "failed");
  for (let i = 0; i < 100 && attempts < 2; i++) await tick();
  const retries = db.prepare("SELECT * FROM runs WHERE subject_id = ? AND id > ? ORDER BY id").all(one.id, first.id) as RunRow[];
  assert.equal(retries.length, 1, "one retry, in its own subject, while subject two still runs");
  assert.equal((await waitForRun(db, retries[0]!.id)).status, "done");
  assert.equal(sent.length, 0, "no alert: the retry started");
  openTwo();
  await waitForRun(db, busy.id);
});

test("the run state of a question to a parallel agent lists its runs, and says which one hears this subject", async () => {
  const { config, db } = office({ parallel: true });
  const held = heldEngine();
  const deps = { config, engine: held.engine, send: quiet };
  const one = createSubject(db, "demo", "scout", "One");
  const two = createSubject(db, "demo", "scout", "Two");
  const three = createSubject(db, "demo", "scout", "Three");
  const a = startRun({ room: "demo", agent: "scout", task: "Work on one." }, { ...deps, subject: one.id });
  const b = startRun({ room: "demo", agent: "scout", task: "Work on two." }, { ...deps, subject: two.id });
  const home = loadHome(config.home);
  const room = home.rooms[0]!;
  const runs = activeRunsOf(db, "demo", "scout");
  assert.deepEqual(runs.map((run) => run.id), [b.id, a.id], "the latest started first");
  const prompt = (subject: { id: number; title: string | null } | null) =>
    buildQuestionPrompt({ room, agent: room.agents[0]!, question: "Where are you?", previous: [], parallelRuns: runs, subject, memory: "m", today: "d" });
  const inOne = prompt({ id: one.id, title: "One" });
  assert.match(inOne, /You have 2 run\(s\) in progress/);
  assert.match(inOne, new RegExp(`Run #${a.id} on this very subject`));
  assert.match(inOne, new RegExp(`Run #${b.id} on your subject "Two"`));
  assert.match(inOne, new RegExp(`Run #${a.id} works on this very subject: what the owner says here now`));
  assert.match(inOne, new RegExp(`does not reach run #${b.id}: it works on another subject`));
  const inThree = prompt({ id: three.id, title: "Three" });
  assert.match(inThree, /No run works on this very subject: a run or a revision proposed here can start at once/);
  assert.doesNotMatch(inThree, /waits for its turn/);
  assert.match(inThree, new RegExp(`does not reach run #${b.id} nor run #${a.id}: they work on another subject`));
  const idle = buildQuestionPrompt({ room, agent: room.agents[0]!, question: "?", previous: [], parallelRuns: [], memory: "m", today: "d" });
  assert.match(idle, /You have no run in progress\./);
  held.releaseAll();
  await waitForRun(db, a.id);
  await waitForRun(db, b.id);
});

test("a crash with several runs of one agent in progress: all of them are closed and their tasks given back", () => {
  const { db } = office({ parallel: true });
  const one = createSubject(db, "demo", "scout", "One");
  const at = new Date().toISOString();
  const insert = db.prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at, subject_id) VALUES ('demo', 'scout', 'claude', ?, 'running', ?, ?)");
  const r1 = Number(insert.run("One.", at, one.id).lastInsertRowid);
  const r2 = Number(insert.run("General.", at, null).lastInsertRowid);
  const t1 = task(db, one.id, "Mailbox of one.");
  const t2 = task(db, null, "Mailbox of general.");
  db.prepare("UPDATE tasks SET status = 'in_progress', run_id = ? WHERE id = ?").run(r1, t1);
  db.prepare("UPDATE tasks SET status = 'in_progress', run_id = ? WHERE id = ?").run(r2, t2);
  const recovered = recoverInterruptedRuns(db);
  assert.equal(recovered.runs, 2);
  assert.equal(recovered.requeued, 2);
  assert.deepEqual([taskRow(db, t1).status, taskRow(db, t2).status], ["pending", "pending"]);
});
