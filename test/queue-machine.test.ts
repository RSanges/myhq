import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CHAT_ACTIONS, describeAction, takeChatActions } from "../src/assistant/actions";
import type { ChatOutcome, ChatRunner } from "../src/assistant/chat";
import { getChatService } from "../src/assistant/chat-service";
import { listBlocked } from "../src/server/blocked";
import type { HqConfig } from "../src/server/config";
import { getDbAt, queueOrder, type Db, type RunRow } from "../src/server/db";
import type { Engine, RunEvent } from "../src/server/engine";
import { HqError } from "../src/server/errors";
import {
  closeRunMachine,
  effectiveNeeds,
  machineCheck,
  machineView,
  parseNvidiaSmi,
  reservations,
  takeReading,
  vetoesIdle,
  type MachineReading,
} from "../src/server/machine";
import { listQueue, moveInQueue, queueMoveSchema } from "../src/server/queue";
import { loadHome, syncHome, type Agent } from "../src/server/rooms";
import { fireRoutine } from "../src/server/routines";
import { buildPrompt, MACHINE_CHECKED, resumeWaitingTasks, startRun, wakeAgents } from "../src/server/runner";
import { strings } from "../src/ui/strings";
import { chatConfig, makeHome, waitForRun } from "./helpers";

// The queue (one order, the owner's places, no overtaking on what is scarce) and the machine (the reading, the gate with
// reservations and margins, the veto command, the peaks and the effective need). See docs/architecture.md, "The queue and the machine".

const r = strings.deskModules.standard.reasons;
const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const done: RunEvent = { type: "end", status: "done", reason: "success", summary: "ok", usage, costUsd: 0 };

const agent = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
  role: "roles/scout.md",
  model: "haiku",
  allowedTools: ["mcp__hq__*"],
  ...extra,
});

/** A home with one room "demo" holding these agents, and the myhq.json given. */
function home(agents: Record<string, unknown>[], myhq?: unknown): { config: HqConfig; db: Db } {
  const config = makeHome({}, { name: "demo", targetRepo: "../demo", agents });
  if (myhq !== undefined) fs.writeFileSync(path.join(config.home, "myhq.json"), JSON.stringify(myhq));
  const db = getDbAt(config.dbPath);
  syncHome(db, loadHome(config.home));
  return { config, db };
}

/** An engine whose runs of the agents in `hold` wait until released (all of them, or one agent's); the others end at once. */
function holdingEngine(hold: string[]): { engine: Engine; release: (agentId?: string) => void } {
  const gates = new Map(
    hold.map((id) => {
      let open = () => {};
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      return [id, { gate, open }] as const;
    }),
  );
  return {
    release: (agentId) => {
      for (const [id, each] of gates) if (agentId === undefined || id === agentId) each.open();
    },
    engine: {
      name: "claude",
      async *run(input) {
        await gates.get(input.agentId)?.gate;
        yield done;
      },
    },
  };
}

const reading = (over: Partial<MachineReading> = {}): MachineReading => ({
  at: "2026-11-16T10:00:00.000Z",
  ramFreeGb: 10,
  ramTotalGb: 32,
  vramUsedGb: 2,
  vramTotalGb: 24,
  ...over,
});

/** A pending task of an agent, `minutesAgo` old. */
function addTask(db: Db, agentId: string, text = `work of ${agentId}`, minutesAgo = 1): number {
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return Number(
    db
      .prepare("INSERT INTO tasks (room, agent_id, source, text, status, created_at, updated_at) VALUES ('demo', ?, 'chat', ?, 'pending', ?, ?)")
      .run(agentId, text, at, at).lastInsertRowid,
  );
}

const runsOf = (db: Db, agentId: string) => db.prepare("SELECT * FROM runs WHERE agent_id = ? ORDER BY id").all(agentId) as RunRow[];

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const queueOf = (db: Db, config: HqConfig, read: () => MachineReading = () => reading()) => listQueue(db, config, loadHome(config.home), read);

// --- The reading ---------------------------------------------------------------------------

test("the reading: RAM from the probe, the first GPU of nvidia-smi read strictly, anything else unknown, never a throw", () => {
  const gib = 1024 ** 3;
  const memory = () => ({ freeBytes: 6 * gib, totalBytes: 16 * gib });
  const known = takeReading({ memory, gpu: () => "4096, 24576\n1024, 8192\n" }, new Date("2026-11-16T10:00:00Z"));
  assert.deepEqual(known, { at: "2026-11-16T10:00:00.000Z", ramFreeGb: 6, ramTotalGb: 16, vramUsedGb: 4, vramTotalGb: 24 });
  // No nvidia-smi on this machine (or it failed): the GPU is unknown, the RAM is still read.
  const absent = takeReading({ memory, gpu: () => null });
  assert.equal(absent.vramUsedGb, null);
  assert.equal(absent.vramTotalGb, null);
  assert.equal(absent.ramFreeGb, 6);
  // A probe that throws is unknown too, and a RAM probe that throws reads as nothing free.
  const broken = takeReading({
    memory: () => {
      throw new Error("no");
    },
    gpu: () => {
      throw new Error("no");
    },
  });
  assert.equal(broken.vramUsedGb, null);
  assert.equal(broken.ramFreeGb, 0);
  for (const garbage of ["", "N/A, N/A", "[Not Supported]", "12 MiB, 24 MiB", "9000, 8000", "1, 0", "NVIDIA-SMI has failed"]) {
    assert.equal(parseNvidiaSmi(garbage), null, garbage);
  }
  assert.deepEqual(parseNvidiaSmi("  512 , 8192  \r\n"), { usedGb: 0.5, totalGb: 8 });
});

// --- An agent without needs, a home as before ------------------------------------------------

test("a home with no needs, no rank and no veto command behaves as before: no reading, no record, the same prompt and order", async () => {
  const { config, db } = home([agent("scout"), agent("writer"), agent("painter", { resources: ["gpu"] })]);
  const read = () => {
    throw new Error("the machine must not be read for agents without needs");
  };
  const scout = loadHome(config.home).rooms[0]!.agents[0]!;
  assert.deepEqual(machineCheck({ config, db, room: "demo", agent: scout, read }), { kind: "free", need: null, reading: null });
  const prompt = buildPrompt({ room: loadHome(config.home).rooms[0]!, agent: scout, runId: 1, task: "Task.", mailbox: [] });
  assert.ok(!prompt.includes(MACHINE_CHECKED), "no sentence about the machine");
  // Without any rank, the order of the queue is the order of the ids, as the wake-ups had it.
  const ids = [addTask(db, "writer", "w1", 3), addTask(db, "scout", "s1", 2), addTask(db, "writer", "w2", 1)];
  assert.deepEqual(
    (db.prepare(`SELECT id FROM tasks WHERE status = 'pending' ORDER BY ${queueOrder()}`).all() as { id: number }[]).map((row) => row.id),
    ids,
  );
  const started = wakeAgents(config, db, { config, engine: holdingEngine([]).engine, send: async () => true, machine: read });
  assert.deepEqual(started.map((run) => run.agent_id), ["writer", "scout"]);
  for (const run of started) await waitForRun(db, run.id);
  // An agent with resources and no veto command: the machine is not read, and its prompt has no new line either.
  let painterPrompt = "";
  const engine: Engine = {
    name: "claude",
    async *run(input) {
      painterPrompt = input.prompt;
      yield done;
    },
  };
  await waitForRun(db, startRun({ room: "demo", agent: "painter" }, { config, engine, send: async () => true, machine: read }).id);
  assert.ok(painterPrompt.length > 0 && !painterPrompt.includes(MACHINE_CHECKED));
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM run_machine").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM machine_vetoes").get() as { n: number }).n, 0);
});

test("the run instruction about the machine: one sentence, only when the machine was checked for the run", async () => {
  const room = { name: "demo", shared: false } as never;
  const base = { id: "a", name: "A", resources: ["gpu"] } as unknown as Agent;
  const of = (machineChecked?: boolean) => buildPrompt({ room, agent: base, runId: 1, task: "T.", mailbox: [], machineChecked });
  assert.ok(!of().includes(MACHINE_CHECKED));
  assert.equal(of(true).split(MACHINE_CHECKED).length, 2);
  // In a real start: needs declared, or a veto command asked for an agent with resources; resources alone check nothing.
  const prompts = new Map<string, string>();
  const engine: Engine = {
    name: "claude",
    async *run(input) {
      prompts.set(input.agentId, input.prompt);
      yield done;
    },
  };
  const plain = home([agent("painter", { resources: ["gpu"] }), agent("big", { needs: { ramGb: 1 } })]);
  for (const id of ["painter", "big"]) await waitForRun(plain.db, startRun({ room: "demo", agent: id }, { config: plain.config, engine, send: async () => true, machine: () => reading() }).id);
  assert.ok(!prompts.get("painter")!.includes(MACHINE_CHECKED), "resources and no veto command: the machine was not looked at");
  assert.equal(prompts.get("big")!.split(MACHINE_CHECKED).length, 2);
  const vetoed = vetoHome("ok", { resources: ["gpu"] });
  assert.throws(() => startRun({ room: "demo", agent: "painter" }, { ...vetoed.deps, engine }));
  await vetoesIdle();
  await until(() => prompts.has("painter") && prompts.get("painter")!.includes(MACHINE_CHECKED));
  await waitForRun(vetoed.db, runsOf(vetoed.db, "painter")[0]!.id);
});

test("room.json needs and myhq.json machine are checked by zod", () => {
  const { config } = home([agent("scout", { needs: { ramGb: 4 } })]);
  assert.deepEqual(loadHome(config.home).rooms[0]!.agents[0]!.needs, { ramGb: 4, vramGb: null });
  for (const needs of [{}, { ramGb: -1 }, { ramGb: "4" }, { ramGb: 4, cpu: 2 }]) {
    const bad = makeHome({}, { name: "demo", targetRepo: "../demo", agents: [agent("scout", { needs })] });
    assert.equal(loadHome(bad.home).rooms.length, 0, JSON.stringify(needs));
  }
  const invalid = home([agent("scout", { needs: { ramGb: 4 } })], { machine: { keepFreeRamGb: -2 } });
  const view = machineView(invalid.db, invalid.config, [], () => reading());
  assert.match(view.error ?? "", /machine\.keepFreeRamGb/);
  assert.equal(view.keepFreeRamGb, 2, "an invalid block keeps the defaults");
});

// --- The order ------------------------------------------------------------------------------

test("the order: the owner's places first, then the oldest first; up, down and back to automatic order", () => {
  const { config, db } = home([agent("a"), agent("b"), agent("c"), agent("d")]);
  const [a, b, c, d] = [addTask(db, "a", "a", 4), addTask(db, "b", "b", 3), addTask(db, "c", "c", 2), addTask(db, "d", "d", 1)];
  const order = () => queueOf(db, config).map((entry) => entry.taskId);
  assert.deepEqual(order(), [a, b, c, d]);
  moveInQueue(db, { taskId: c, move: "first" });
  assert.deepEqual(order(), [c, a, b, d]);
  // The tasks from the head down to where c was keep their places; d keeps the automatic order.
  assert.deepEqual(
    queueOf(db, config).map((entry) => entry.placed),
    [true, true, true, false],
  );
  moveInQueue(db, { taskId: d, move: "up" });
  assert.deepEqual(order(), [c, a, d, b]);
  moveInQueue(db, { taskId: c, move: "down" });
  assert.deepEqual(order(), [a, c, d, b]);
  // Back to automatic order: the task goes after the placed ones, by age.
  moveInQueue(db, { taskId: a, move: "auto" });
  assert.deepEqual(order(), [c, d, b, a]);
  for (const id of [b, c, d]) moveInQueue(db, { taskId: id, move: "auto" });
  assert.deepEqual(order(), [a, b, c, d], "with no place left, the order of before");
  // The edges change nothing.
  moveInQueue(db, { taskId: a, move: "up" });
  moveInQueue(db, { taskId: d, move: "down" });
  assert.deepEqual(order(), [a, b, c, d]);
});

test("the reorder input is checked by zod, and only a pending task moves", () => {
  for (const bad of [{}, { taskId: 1 }, { taskId: 0, move: "first" }, { taskId: 1.5, move: "up" }, { taskId: 1, move: "last" }, { taskId: "1", move: "up" }, { taskId: 1, move: "up", rank: 2 }]) {
    assert.equal(queueMoveSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
  assert.equal(queueMoveSchema.safeParse({ taskId: 3, move: "auto" }).success, true);
  const { db } = home([agent("a")]);
  assert.throws(() => moveInQueue(db, { taskId: 999, move: "first" }), (error: unknown) => error instanceof HqError && error.code === "TASK_NOT_FOUND" && error.status === 404);
  const taken = addTask(db, "a");
  db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(taken);
  assert.throws(() => moveInQueue(db, { taskId: taken, move: "first" }), (error: unknown) => error instanceof HqError && error.code === "NOT_IN_QUEUE" && error.status === 409);
});

test("the order serves the resource: when it frees, the task the owner put first takes it", async () => {
  const gpu = { resources: ["gpu"] };
  const { config, db } = home([agent("holder", gpu), agent("a", gpu), agent("b", gpu), agent("c", gpu)]);
  const { engine, release } = holdingEngine(["holder", "c"]);
  const deps = { config, engine, send: async () => true };
  const holding = startRun({ room: "demo", agent: "holder" }, deps);
  const [, , c] = [addTask(db, "a", "a", 3), addTask(db, "b", "b", 2), addTask(db, "c", "c", 1)];
  moveInQueue(db, { taskId: c, move: "first" });
  assert.deepEqual(wakeAgents(config, db, deps), []);
  assert.deepEqual(
    queueOf(db, config).map((entry) => [entry.agentId, entry.cause]),
    [
      ["c", "resource"],
      ["a", "resource"],
      ["b", "resource"],
    ],
  );
  release("holder");
  await waitForRun(db, holding.id);
  await until(() => runsOf(db, "c").length === 1);
  assert.equal(runsOf(db, "a").length, 0, "a, older, waits: c was put first");
  assert.equal(runsOf(db, "b").length, 0);
  release();
  await waitForRun(db, runsOf(db, "c")[0]!.id);
});

// --- No overtaking -----------------------------------------------------------------------------

test("no overtaking on a resource: a later task that needs what an earlier one waits for waits behind it; one that needs nothing scarce starts", async () => {
  const { config, db } = home([agent("holder", { resources: ["disk"] }), agent("a", { resources: ["disk", "gpu"] }), agent("b", { resources: ["gpu"] }), agent("c")]);
  const { engine, release } = holdingEngine(["holder", "a"]);
  const deps = { config, engine, send: async () => true };
  const holding = startRun({ room: "demo", agent: "holder" }, deps);
  const [a] = [addTask(db, "a", "a", 3), addTask(db, "b", "b", 2), addTask(db, "c", "c", 1)];
  // a waits for the disk; the GPU is free, but b would take what a needs: it waits behind a. c needs nothing scarce.
  const started = wakeAgents(config, db, deps);
  assert.deepEqual(started.map((run) => run.agent_id), ["c"]);
  const queue = queueOf(db, config);
  assert.deepEqual(queue.map((entry) => [entry.agentId, entry.cause]), [
    ["a", "resource"],
    ["b", "behind"],
  ]);
  assert.equal(queue[1]!.reason, r.behind(a));
  release("holder");
  await waitForRun(db, holding.id);
  // When the disk frees, a starts first; b still waits for the GPU that a now holds.
  await until(() => runsOf(db, "a").length === 1);
  assert.equal(runsOf(db, "b").length, 0);
  release();
  await waitForRun(db, runsOf(db, "a")[0]!.id);
});

test("no overtaking on the machine: a later task that needs RAM waits behind an earlier one that waits for RAM; a GPU need or no need still starts", async () => {
  const { config, db } = home([agent("big", { needs: { ramGb: 12 } }), agent("small", { needs: { ramGb: 4 } }), agent("gpu", { needs: { vramGb: 4 } }), agent("plain")]);
  const { engine, release } = holdingEngine(["gpu", "plain", "small"]);
  const deps = { config, engine, send: async () => true, machine: () => reading() };
  const [big] = [addTask(db, "big", "big", 4), addTask(db, "small", "small", 3), addTask(db, "gpu", "gpu", 2), addTask(db, "plain", "plain", 1)];
  const started = wakeAgents(config, db, deps);
  assert.deepEqual(started.map((run) => run.agent_id), ["gpu", "plain"]);
  const queue = queueOf(db, config);
  assert.deepEqual(queue.map((entry) => [entry.agentId, entry.cause]), [
    ["big", "machine"],
    ["small", "behind"],
  ]);
  assert.equal(queue[1]!.reason, r.behind(big));
  // With the owner's order, the small one goes first and starts: the big one no longer holds a place before it.
  moveInQueue(db, { taskId: queue[1]!.taskId, move: "first" });
  assert.deepEqual(wakeAgents(config, db, deps).map((run) => run.agent_id), ["small"]);
  release();
  for (const id of ["gpu", "plain", "small"]) await waitForRun(db, runsOf(db, id)[0]!.id);
});

// --- The gate --------------------------------------------------------------------------------

test("the gate with reservations: two tasks released in the same pass against memory for one start one run", async () => {
  const { config, db } = home([agent("a", { needs: { ramGb: 6 } }), agent("b", { needs: { ramGb: 6 } })]);
  let now = reading({ ramFreeGb: 10 });
  const { engine, release } = holdingEngine(["a"]);
  const deps = { config, engine, send: async () => true, machine: () => now };
  addTask(db, "a", "a", 2);
  addTask(db, "b", "b", 1);
  const started = wakeAgents(config, db, deps);
  assert.deepEqual(started.map((run) => run.agent_id), ["a"], "a reserves its 6 GB at once: 10 - 6 = 4 < 6 + 2 for b");
  const [waiting] = queueOf(db, config, () => now);
  assert.equal(waiting!.cause, "machine");
  assert.equal(waiting!.reason, r.machine({ kind: "ram", needGb: 6, keepGb: 2, freeGb: 10, reservedGb: 6, leftGb: 4 }));
  // a took 5 of its 6 GB: it reserves only 1 more, and b still does not fit (5 - 1 = 4).
  now = reading({ ramFreeGb: 5 });
  assert.deepEqual(reservations(db, now), { ramGb: 1, vramGb: 0 });
  assert.deepEqual(wakeAgents(config, db, deps), []);
  // a ends, its memory comes back: the end of its run starts b.
  now = reading({ ramFreeGb: 10 });
  release();
  await waitForRun(db, started[0]!.id);
  await until(() => runsOf(db, "b").length === 1);
});

test("margins: the home's margin counts in the gate; a GPU need without a GPU reading waits (fail closed)", () => {
  const needs = { needs: { ramGb: 6 } };
  const tight = home([agent("a", needs)]);
  const deps = (config: HqConfig, machine: () => MachineReading) => ({ config, engine: holdingEngine([]).engine, send: async () => true, machine });
  assert.throws(
    () => startRun({ room: "demo", agent: "a" }, deps(tight.config, () => reading({ ramFreeGb: 7 }))),
    (error: unknown) => error instanceof HqError && error.code === "MACHINE_BUSY" && error.status === 409 && /6 GB of RAM free plus 2 GB kept/.test(error.message),
  );
  const loose = home([agent("a", needs)], { machine: { keepFreeRamGb: 0.5 } });
  assert.equal(startRun({ room: "demo", agent: "a" }, deps(loose.config, () => reading({ ramFreeGb: 7 }))).agent_id, "a");

  const gpu = home([agent("g", { needs: { vramGb: 4 } })]);
  const unknown = () => reading({ vramUsedGb: null, vramTotalGb: null });
  assert.throws(
    () => startRun({ room: "demo", agent: "g" }, deps(gpu.config, unknown)),
    (error: unknown) => error instanceof HqError && error.code === "MACHINE_BUSY" && /GPU cannot be read/.test(error.message),
  );
  addTask(gpu.db, "g");
  assert.equal(queueOf(gpu.db, gpu.config, unknown)[0]!.reason, r.vramUnknown(4));
  // The GPU margin: 24 - 2 used = 22 free, a need of 21 with 1 kept fits, with 2 kept it does not.
  const big = home([agent("g", { needs: { vramGb: 21 } })], { machine: { keepFreeVramGb: 2 } });
  assert.throws(() => startRun({ room: "demo", agent: "g" }, deps(big.config, () => reading())), (error: unknown) => error instanceof HqError && error.code === "MACHINE_BUSY");
});

test("a routine of an agent the machine cannot take is skipped, as for a busy agent", () => {
  const { config, db } = home([agent("a", { needs: { ramGb: 64 } })]);
  const room = loadHome(config.home).rooms[0]!;
  db.prepare("UPDATE agents SET armed = 1 WHERE room = 'demo' AND id = 'a'").run();
  const firing = fireRoutine(config, db, room, room.agents[0]!, { cron: "* * * * *", task: null }, new Date(), {
    config,
    engine: holdingEngine([]).engine,
    send: async () => true,
    machine: () => reading(),
  });
  assert.equal(firing.outcome, "skipped_busy");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'pending'").get() as { n: number }).n, 0, "a routine is not queued");
});

// --- The reasons of the queue ------------------------------------------------------------------

test("GET /api/queue reasons: agent busy on run #n, a resource held, the daily cap, waits by design, in the words of the Standard", async () => {
  const { config, db } = home([agent("busy"), agent("holder", { resources: ["gpu"] }), agent("painter", { resources: ["gpu"] }), agent("calm", { onMessage: "queue" })]);
  const { engine, release } = holdingEngine(["busy", "holder"]);
  const deps = { config, engine, send: async () => true };
  const busyRun = startRun({ room: "demo", agent: "busy" }, deps);
  const holderRun = startRun({ room: "demo", agent: "holder" }, deps);
  // Newer than the run: its end takes it.
  await new Promise((resolve) => setTimeout(resolve, 5));
  addTask(db, "busy", "next for busy", 0);
  addTask(db, "painter", "paint");
  const at = new Date().toISOString();
  db.prepare("INSERT INTO tasks (room, agent_id, source, text, status, created_at, updated_at) VALUES ('demo', 'calm', 'message', 'later', 'pending', ?, ?)").run(at, at);
  const reasons = Object.fromEntries(queueOf(db, config).map((entry) => [entry.agentId, entry.reason]));
  assert.equal(reasons.busy, r.afterRun(busyRun.id));
  assert.equal(reasons.painter, r.resource("gpu", holderRun.id, "demo / holder"));
  assert.equal(reasons.calm, r.byDesign);
  // The daily cap, for what would start.
  release();
  await waitForRun(db, busyRun.id);
  await waitForRun(db, holderRun.id);
  await until(() => db.prepare("SELECT 1 FROM runs WHERE status = 'running'").get() === undefined);
  const capped = home([agent("a")], { maxRunsPerDay: 0 });
  addTask(capped.db, "a");
  assert.equal(queueOf(capped.db, capped.config)[0]!.cause, "cap");
  // The Standard keeps listing only what is stuck: a task waiting by design is not on it.
  assert.ok(!listBlocked(db, loadHome(config.home), config).some((entry) => entry.agentId === "calm"));
});

// --- The veto command ----------------------------------------------------------------------------

/** A veto command of the home: a Node script that answers what `behaviour` says, and keeps what it read. */
function vetoHome(behaviour: "wait" | "ok" | "crash" | "timeout", painter: Record<string, unknown> = { needs: { ramGb: 1 } }) {
  const script = {
    wait: `process.stdout.write(JSON.stringify({ wait: true, reason: "Un jeu tourne" }));`,
    ok: `process.stdout.write(JSON.stringify({ wait: false }));`,
    crash: `process.exit(3);`,
    timeout: `setTimeout(() => {}, 60000);`,
  }[behaviour];
  const s = home([agent("painter", painter)], { machine: { veto: { command: [process.execPath, "veto.cjs"], timeoutSeconds: 0.5 } } });
  fs.writeFileSync(
    path.join(s.config.home, "veto.cjs"),
    `let input = ""; process.stdin.on("data", (c) => (input += c)); process.stdin.on("end", () => { require("fs").writeFileSync("veto-input.json", input); ${script} });`,
  );
  const deps = { config: s.config, engine: holdingEngine([]).engine, send: async () => true, machine: () => reading() };
  return { ...s, deps };
}

test("the veto command: wait keeps the task with its reason, and it receives the reading and the run", async () => {
  const { config, db, deps } = vetoHome("wait");
  addTask(db, "painter");
  assert.deepEqual(wakeAgents(config, db, deps), []);
  assert.equal(queueOf(db, config)[0]!.reason, r.vetoAsking);
  await vetoesIdle();
  assert.equal(runsOf(db, "painter").length, 0);
  assert.equal(queueOf(db, config)[0]!.reason, r.veto("Un jeu tourne"));
  const input = JSON.parse(fs.readFileSync(path.join(config.home, "veto-input.json"), "utf8"));
  assert.deepEqual(input.run, { room: "demo", agent: "painter", needs: { ramGb: 1, vramGb: null }, declaredNeeds: { ramGb: 1, vramGb: null }, resources: [] });
  assert.equal(input.reading.ramFreeGb, 10);
  // A fresh wait is not asked again at the next wake-up.
  assert.deepEqual(wakeAgents(config, db, deps), []);
  assert.equal((db.prepare("SELECT verdict FROM machine_vetoes").get() as { verdict: string }).verdict, "wait");
});

for (const behaviour of ["ok", "crash", "timeout"] as const) {
  test(`the veto command: ${behaviour} lets the run start (fail open for a failure), the answer wakes the agent`, async () => {
    const { config, db, deps } = vetoHome(behaviour);
    addTask(db, "painter");
    assert.deepEqual(wakeAgents(config, db, deps), []);
    await vetoesIdle();
    await until(() => runsOf(db, "painter").length === 1);
    // The answer stays, for the settings page; it was used by the start, so the next one asks again.
    const row = db.prepare("SELECT verdict, error FROM machine_vetoes").get() as { verdict: string; error: string | null };
    assert.equal(row.verdict, "ok");
    assert.equal(row.error === null, behaviour === "ok");
    const painter = loadHome(config.home).rooms[0]!.agents[0]!;
    assert.deepEqual(machineCheck({ config, db, room: "demo", agent: painter, read: () => reading() }), { kind: "free", need: { ramGb: 1, vramGb: null }, reading: reading() });
    // A command that fails is told to the owner on the Standard, as MyHQ's note, not only in the log.
    const notes = listBlocked(db, loadHome(config.home), config).filter((entry) => entry.cause === "myhqNote");
    assert.equal(notes.length, behaviour === "ok" ? 0 : 1);
    await waitForRun(db, runsOf(db, "painter")[0]!.id);
  });
}

test("the veto command: a command that cannot start is told on the Standard until it answers again; the settings page keeps its error", async () => {
  const s = home([agent("painter", { resources: ["gpu"] })], { machine: { veto: { command: ["./missing-veto.cmd"], timeoutSeconds: 1 } } });
  const deps = { config: s.config, engine: holdingEngine([]).engine, send: async () => true, machine: () => reading() };
  addTask(s.db, "painter");
  assert.deepEqual(wakeAgents(s.config, s.db, deps), []);
  await vetoesIdle();
  await until(() => runsOf(s.db, "painter").length === 1);
  await waitForRun(s.db, runsOf(s.db, "painter")[0]!.id);
  const [note] = listBlocked(s.db, loadHome(s.config.home), s.config).filter((entry) => entry.cause === "myhqNote");
  assert.match(note!.reason, /commande de veto du home échoue/);
  assert.match(note!.reason, /could not start/);
  const view = machineView(s.db, s.config, [], () => reading());
  assert.match(view.vetoes[0]!.error ?? "", /could not start/);
  // Once the command answers again, the note is done.
  fs.writeFileSync(path.join(s.config.home, "veto.cjs"), `process.stdout.write(JSON.stringify({ wait: false }));`);
  fs.writeFileSync(path.join(s.config.home, "myhq.json"), JSON.stringify({ machine: { veto: { command: [process.execPath, "veto.cjs"] } } }));
  assert.throws(() => startRun({ room: "demo", agent: "painter" }, deps));
  await vetoesIdle();
  await until(() => runsOf(s.db, "painter").length === 2);
  await waitForRun(s.db, runsOf(s.db, "painter")[1]!.id);
  assert.equal(listBlocked(s.db, loadHome(s.config.home), s.config).filter((entry) => entry.cause === "myhqNote").length, 0);
  // An invalid machine block is shown with the other invalid settings, not taken silently for "no veto".
  fs.writeFileSync(path.join(s.config.home, "myhq.json"), JSON.stringify({ machine: { veto: { command: [] } } }));
  assert.match(machineView(s.db, s.config, [], () => reading()).error ?? "", /machine\.veto\.command/);
});

test("the veto command is asked only for an agent with needs or resources", () => {
  const { config, db } = home([agent("plain")], { machine: { veto: { command: [process.execPath, "missing.cjs"] } } });
  const plain = loadHome(config.home).rooms[0]!.agents[0]!;
  const read = () => {
    throw new Error("not read");
  };
  assert.equal(machineCheck({ config, db, room: "demo", agent: plain, read, ask: { env: {}, rewake: () => undefined } }).kind, "free");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM machine_vetoes").get() as { n: number }).n, 0);
});

// --- Measured, then estimated ------------------------------------------------------------------

test("peaks: sampled on the tick and at the end, stored with whether the run was alone; the effective need is raised, never lowered", async () => {
  const { config, db } = home([agent("a", { needs: { ramGb: 2, vramGb: 8 } }), agent("b", { needs: { ramGb: 1 } })]);
  let now = reading({ ramFreeGb: 10, vramUsedGb: 2 });
  const { engine, release } = holdingEngine(["a"]);
  const deps = { config, engine, send: async () => true, machine: () => now };
  const run = startRun({ room: "demo", agent: "a" }, deps);
  // The tick: the machine gave up 3 GB of RAM and 5 of GPU memory since the run started.
  now = reading({ ramFreeGb: 7, vramUsedGb: 7 });
  resumeWaitingTasks(config, db, deps);
  now = reading({ ramFreeGb: 9, vramUsedGb: 3 });
  release();
  await waitForRun(db, run.id);
  await until(() => (db.prepare("SELECT ended_at FROM run_machine WHERE run_id = ?").get(run.id) as { ended_at: string | null }).ended_at !== null);
  const row = db.prepare("SELECT ram_peak_gb, vram_peak_gb, alone FROM run_machine WHERE run_id = ?").get(run.id);
  assert.deepEqual(row, { ram_peak_gb: 3, vram_peak_gb: 5, alone: 1 });
  const agentA = loadHome(config.home).rooms[0]!.agents[0]!;
  // One run teaches nothing: a need is raised only when two runs measured it.
  assert.deepEqual(effectiveNeeds(db, "demo", agentA), { ramGb: 2, vramGb: 8 });
  const at = new Date().toISOString();
  const past = Number(db.prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at, ended_at) VALUES ('demo', 'a', 'claude', 't', 'done', ?, ?)").run(at, at).lastInsertRowid);
  db.prepare(
    "INSERT INTO run_machine (run_id, room, agent_id, ram_need_gb, ram_declared_gb, ram_free_start_gb, ram_peak_gb, started_at, ended_at, alone) VALUES (?, 'demo', 'a', 2, 2, 20, 4, ?, ?, 1)",
  ).run(past, at, at);
  // RAM: declared 2, measured 3 and 4: raised to the second highest, 3. GPU: declared 8, measured 5: kept at 8 (never lowered).
  assert.deepEqual(effectiveNeeds(db, "demo", agentA), { ramGb: 3, vramGb: 8 });

  // Two runs that overlap are not alone: their peaks do not count.
  const insert = db.prepare(
    "INSERT INTO runs (room, agent_id, engine, task, status, started_at, ended_at) VALUES ('demo', ?, 'claude', 't', 'running', ?, NULL)",
  );
  const start = new Date().toISOString();
  const one = Number(insert.run("a", start).lastInsertRowid);
  const two = Number(insert.run("b", start).lastInsertRowid);
  const record = db.prepare(
    "INSERT INTO run_machine (run_id, room, agent_id, ram_need_gb, vram_need_gb, ram_free_start_gb, vram_used_start_gb, ram_peak_gb, started_at) VALUES (?, 'demo', ?, 2, NULL, 20, NULL, 15, ?)",
  );
  record.run(one, "a", start);
  record.run(two, "b", start);
  db.prepare("UPDATE runs SET status = 'done' WHERE id IN (?, ?)").run(one, two);
  closeRunMachine(db, one, () => reading({ ramFreeGb: 20 }));
  closeRunMachine(db, two, () => reading({ ramFreeGb: 20 }));
  assert.deepEqual(db.prepare("SELECT alone FROM run_machine WHERE run_id IN (?, ?) ORDER BY run_id").all(one, two), [{ alone: 0 }, { alone: 0 }]);
  assert.deepEqual(effectiveNeeds(db, "demo", agentA), { ramGb: 3, vramGb: 8 }, "the 15 GB of a run that was not alone do not count");

  // The settings page: declared, measured median and max of the runs alone, and what is reserved.
  const view = machineView(db, config, loadHome(config.home).rooms[0]!.agents.map((each) => ({ room: "demo", agent: each })), () => reading());
  assert.deepEqual(
    view.agents.map((each) => [each.agent, each.kind, each.declaredGb, each.runs, each.medianGb, each.maxGb, each.effectiveGb]),
    [
      ["a", "ram", 2, 2, 3.5, 4, 3],
      ["a", "vram", 8, 1, 5, 5, 8],
      ["b", "ram", 1, 0, null, null, 1],
    ],
  );
  assert.equal(view.reading?.ramFreeGb, 10);
});

// --- The chat actions -----------------------------------------------------------------------------

test("chat actions: queue lists the queue, queue_first puts a task first; queue_first needs a taskId", async () => {
  assert.ok(CHAT_ACTIONS.includes("queue") && CHAT_ACTIONS.includes("queue_first"));
  const dir = fs.mkdtempSync(path.join(makeHome().home, "requests-"));
  fs.writeFileSync(path.join(dir, "a.json"), JSON.stringify({ action: "queue_first" }));
  fs.writeFileSync(path.join(dir, "b.json"), JSON.stringify({ action: "queue_first", taskId: 4 }));
  fs.writeFileSync(path.join(dir, "c.json"), JSON.stringify({ action: "queue" }));
  const taken = takeChatActions(dir, CHAT_ACTIONS, () => undefined);
  assert.deepEqual(taken.actions, [{ action: "queue_first", taskId: 4 }, { action: "queue" }]);
  assert.deepEqual(taken.refused, [strings.assistant.actions.invalid]);
  assert.equal(describeAction({ action: "queue_first", taskId: 4 }), "mettre la tâche #4 en tête de la file d'attente");

  const { config, db } = home([agent("holder", { resources: ["gpu"] }), agent("a", { resources: ["gpu"] }), agent("b", { resources: ["gpu"] })]);
  const { engine, release } = holdingEngine(["holder", "b"]);
  const holding = startRun({ room: "demo", agent: "holder" }, { config, engine, send: async () => true });
  const first = addTask(db, "a", "le rendu A", 2);
  const second = addTask(db, "b", "le rendu B", 1);
  const requestsDir = path.join(config.home, "chat", "requests");
  let actions: unknown[] = [];
  const runChat: ChatRunner = async (): Promise<ChatOutcome> => {
    fs.mkdirSync(requestsDir, { recursive: true });
    actions.forEach((action, i) => fs.writeFileSync(path.join(requestsDir, `act-${i}.json`), JSON.stringify(action)));
    return { ok: true, text: "Réponse", costUsd: 0, tools: [] };
  };
  const service = getChatService(config, {
    chat: chatConfig({ cwd: config.home, requestsDir, actions: ["queue", "queue_first"] }),
    env: { PATH: process.env.PATH },
    chatMaxBudgetUsd: 0.5,
    runChat,
    queue: { engine, send: async () => true },
    log: () => undefined,
  });
  const q = strings.assistant.actions.queue;
  actions = [{ action: "queue_first", taskId: second }, { action: "queue" }];
  const reply = (await service.ask("Mets le rendu B en premier", "desk")).reply;
  const lines = reply.split("\n\n").slice(1).join("\n\n").split("\n");
  assert.equal(lines[0], q.first(second));
  assert.equal(lines[1], q.title(2));
  assert.match(lines[2]!, new RegExp(`^1\\. Tâche #${second}, demo / B : le rendu B \\(Ressource « gpu »`));
  assert.match(lines[3]!, new RegExp(`^2\\. Tâche #${first}, demo / A`));
  release("holder");
  await waitForRun(db, holding.id);
  await until(() => runsOf(db, "b").length === 1);
  assert.equal(runsOf(db, "a").length, 0, "b was put first: it takes the GPU");
  release();
  await waitForRun(db, runsOf(db, "b")[0]!.id);
});
