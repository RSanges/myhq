import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { decideProposal } from "../src/server/agent-questions";
import { listBlocked, relaunchBlocked } from "../src/server/blocked";
import type { HqConfig } from "../src/server/config";
import { getDbAt, queueOrder, type Db, type RunRow } from "../src/server/db";
import type { Engine, RunEvent, RunInput } from "../src/server/engine";
import {
  closeRunMachine,
  effectiveNeeds,
  RESERVATION_WINDOW_MS,
  reservations,
  sampleMachine,
  vetoesIdle,
  type MachineReading,
} from "../src/server/machine";
import { listQueue, moveInQueue } from "../src/server/queue";
import { loadHome, syncHome } from "../src/server/rooms";
import { fireRoutine } from "../src/server/routines";
import { MachineBusy, recoverInterruptedRuns, resumeWaitingTasks, startRun, wakeAgents } from "../src/server/runner";
import { createSubject } from "../src/server/subjects";
import { entryRule } from "../src/server/supervisor";
import { hqStatus } from "../src/mcp/tools";
import { strings } from "../src/ui/strings";
import { makeHome, waitForRun } from "./helpers";

// The gate of the machine as the review of the queue found it wanting (docs/architecture.md, "The queue and the
// machine"): a start the veto command defers is never lost nor doubled, a need that can never fit holds nothing and
// reaches the Standard, the learned need cannot lock an agent out, a wait keeps only what fell short, the reservations
// count the memory given up once, the machine records of a crash are closed, the reading is taken before the start's
// transaction, a run hears each exchange once, and a queued proposal of a removed agent can be set aside.

const r = strings.deskModules.standard.reasons;
const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const done: RunEvent = { type: "end", status: "done", reason: "success", summary: "ok", usage, costUsd: 0 };

const agent = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"], ...extra });

function home(agents: Record<string, unknown>[], myhq?: unknown): { config: HqConfig; db: Db } {
  const config = makeHome({}, { name: "demo", targetRepo: "../demo", agents });
  if (myhq !== undefined) fs.writeFileSync(path.join(config.home, "myhq.json"), JSON.stringify(myhq));
  const db = getDbAt(config.dbPath);
  syncHome(db, loadHome(config.home));
  return { config, db };
}

/** An engine whose runs of the agents in `hold` wait until released; the others end at once. `seen` records every run. */
function holdingEngine(hold: string[] = []) {
  let open = () => {};
  const gate = new Promise<void>((resolve) => (open = resolve));
  const seen: RunInput[] = [];
  const engine: Engine = {
    name: "claude",
    async *run(input) {
      seen.push(input);
      if (hold.includes(input.agentId)) await gate;
      yield done;
    },
  };
  return { engine, seen, release: () => open() };
}

const reading = (over: Partial<MachineReading> = {}): MachineReading => ({
  at: "2026-11-16T10:00:00.000Z",
  ramFreeGb: 10,
  ramTotalGb: 32,
  vramUsedGb: 2,
  vramTotalGb: 24,
  ...over,
});

function addTask(db: Db, agentId: string, minutesAgo = 1, subjectId: number | null = null): number {
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return Number(
    db
      .prepare("INSERT INTO tasks (room, agent_id, source, text, status, subject_id, created_at, updated_at) VALUES ('demo', ?, 'chat', ?, 'pending', ?, ?, ?)")
      .run(agentId, `work of ${agentId}`, subjectId, at, at).lastInsertRowid,
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

/** Everything settles: the veto calls, then the runs. */
async function settle(db: Db): Promise<void> {
  await vetoesIdle();
  await until(() => db.prepare("SELECT 1 FROM runs WHERE status = 'running'").get() === undefined);
  await vetoesIdle();
}

/** A home with one agent "painter" (resources, no needs) and a veto command that answers `answer`. */
function vetoed(answer: "ok" | "wait" = "ok", painter: Record<string, unknown> = { resources: ["gpu"] }) {
  const s = home([agent("painter", painter)], { machine: { veto: { command: [process.execPath, "veto.cjs"], timeoutSeconds: 2 } } });
  const out = answer === "ok" ? { wait: false } : { wait: true, reason: "Un jeu tourne" };
  fs.writeFileSync(path.join(s.config.home, "veto.cjs"), `process.stdout.write(${JSON.stringify(JSON.stringify(out))});`);
  const { engine, seen } = holdingEngine();
  return { ...s, seen, deps: { config: s.config, engine, send: async () => true, machine: () => reading() } };
}

// --- 1. A start the veto command defers ---------------------------------------------------------------

test("a routine that meets the veto command being asked starts once it says ok: one firing, one run", async () => {
  const { config, db, deps } = vetoed();
  db.prepare("UPDATE agents SET armed = 1").run();
  const room = loadHome(config.home).rooms[0]!;
  const firing = fireRoutine(config, db, room, room.agents[0]!, { cron: "* * * * *", task: null }, new Date(), deps);
  assert.equal(firing.outcome, "skipped_busy");
  await settle(db);
  const runs = runsOf(db, "painter");
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.reason, null, "a routine's run, as any");
  assert.deepEqual(db.prepare("SELECT outcome, run_id FROM routine_firings WHERE id = ?").get(firing.id), { outcome: "started", run_id: runs[0]!.id });
  // Nothing is left to start it again: a tick and the end of the run start nothing more.
  resumeWaitingTasks(config, db, deps);
  await settle(db);
  assert.equal(runsOf(db, "painter").length, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'pending'").get() as { n: number }).n, 0, "a routine is not queued");
});

test("a routine the veto command answers wait for is not started, and its firing says why", async () => {
  const { config, db, deps } = vetoed("wait");
  db.prepare("UPDATE agents SET armed = 1").run();
  const room = loadHome(config.home).rooms[0]!;
  const firing = fireRoutine(config, db, room, room.agents[0]!, { cron: "* * * * *", task: null }, new Date(), deps);
  await settle(db);
  assert.equal(runsOf(db, "painter").length, 0);
  const row = db.prepare("SELECT outcome, detail FROM routine_firings WHERE id = ?").get(firing.id) as { outcome: string; detail: string };
  assert.equal(row.outcome, "skipped_busy");
  assert.match(row.detail, /says to wait.*Un jeu tourne/);
});

test("a run started by hand and a relaunch that meet the veto command being asked start once it says ok, once each", async () => {
  const { db, deps, seen } = vetoed();
  assert.throws(
    () => startRun({ room: "demo", agent: "painter", task: "Rends la scène" }, deps),
    (error: unknown) => error instanceof MachineBusy && error.deferred && /starts once it answers/.test(error.message),
  );
  await settle(db);
  assert.equal(runsOf(db, "painter").length, 1);
  assert.equal(seen[0]!.prompt.includes("Rends la scène"), true, "the same start: its own task");
  // A relaunch from the Standard: its tasks stay pending while the command is asked, then one run takes them.
  const at = new Date(Date.now() - 60_000).toISOString();
  const blocked = Number(
    db.prepare("INSERT INTO tasks (room, agent_id, source, text, status, note, created_at, updated_at) VALUES ('demo', 'painter', 'message', 'm', 'blocked', 'x', ?, ?)").run(at, at)
      .lastInsertRowid,
  );
  const result = relaunchBlocked(deps.config, db, { kind: "task", id: blocked }, deps);
  assert.equal(result.waiting?.code, "MACHINE_BUSY");
  await settle(db);
  const runs = runsOf(db, "painter");
  assert.equal(runs.length, 2);
  assert.equal((db.prepare("SELECT run_id FROM tasks WHERE id = ?").get(blocked) as { run_id: number }).run_id, runs[1]!.id);
});

test("a start with a pending task behind it (a wake-up, a confirmed proposal) starts once through the wake-ups, never twice", async () => {
  const { config, db, deps } = vetoed();
  addTask(db, "painter");
  assert.deepEqual(wakeAgents(config, db, deps), []);
  await settle(db);
  assert.equal(runsOf(db, "painter").length, 1);
  // A proposal confirmed while the command is asked is kept as a task, which the answer's wake-up starts: one run.
  const ask = db.prepare("INSERT INTO agent_questions (room, agent_id, question, answer, status, engine, started_at) VALUES ('demo', 'painter', 'q', 'a', 'done', 'claude', ?)");
  const question = Number(ask.run(new Date().toISOString()).lastInsertRowid);
  db.prepare("INSERT INTO question_proposals (question_id, task, state, created_at) VALUES (?, 'Rends B', 'pending', ?)").run(question, new Date().toISOString());
  const { run } = decideProposal({ room: "demo", agent: "painter", questionId: question, action: "launch" }, deps);
  assert.equal(run, null);
  await settle(db);
  resumeWaitingTasks(config, db, deps);
  await settle(db);
  assert.equal(runsOf(db, "painter").length, 2);
});

// --- 2. A need that can never fit, and the learned need ----------------------------------------------

test("a need above the machine's total never starts: it holds nothing, says so, and reaches the Standard for the owner", async () => {
  const { config, db } = home([agent("huge", { needs: { ramGb: 40 } }), agent("small", { needs: { ramGb: 1 } }), agent("gpu", { needs: { vramGb: 30 } })]);
  const { engine } = holdingEngine();
  const deps = { config, engine, send: async () => true, machine: () => reading({ ramFreeGb: 30 }) };
  const huge = addTask(db, "huge", 20);
  addTask(db, "gpu", 19);
  addTask(db, "small", 1);
  assert.deepEqual(wakeAgents(config, db, deps).map((run) => run.agent_id), ["small"], "nothing waits behind a need that can never fit");
  await settle(db);
  const [entry] = listQueue(db, config, loadHome(config.home), () => reading({ ramFreeGb: 30 }));
  assert.equal(entry!.taskId, huge);
  assert.equal(entry!.cause, "neverFits");
  assert.equal(entry!.reason, r.neverFits({ what: "ram", needGb: 40, keepGb: 2, totalGb: 32 }));
  // The Standard lists it for the owner (the supervisor's, not a wait that resolves itself).
  const stuck = listBlocked(db, loadHome(config.home), config, new Date(), () => reading({ ramFreeGb: 30 })).filter((each) => each.cause === "neverFits");
  assert.deepEqual(stuck.map((each) => each.agentId).sort(), ["gpu", "huge"]);
  assert.equal(entryRule(stuck[0]!).kind, "supervisor");
});

test("the learned need: one outlier never counts, a peak above what the machine can give is left out, a new declaration starts over", async () => {
  const { config, db } = home([agent("a", { needs: { ramGb: 4 } })]);
  const insert = db.prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at, ended_at) VALUES ('demo', 'a', 'claude', 't', 'done', ?, ?)");
  const peak = (gb: number, declared = 4) => {
    const at = new Date().toISOString();
    const id = Number(insert.run(at, at).lastInsertRowid);
    db.prepare(
      "INSERT INTO run_machine (run_id, room, agent_id, ram_need_gb, ram_declared_gb, ram_free_start_gb, ram_peak_gb, started_at, ended_at, alone) VALUES (?, 'demo', 'a', 4, ?, 31, ?, ?, ?, 1)",
    ).run(id, declared, gb, at, at);
  };
  const a = () => loadHome(config.home).rooms[0]!.agents[0]!;
  const ceiling = { ramGb: 30, vramGb: null };
  // A game opened during one run alone: 29 GB given up. One run is an outlier: the need stays 4, and the agent can start.
  peak(29);
  assert.deepEqual(effectiveNeeds(db, "demo", a(), ceiling), { ramGb: 4, vramGb: null });
  const { engine } = holdingEngine();
  const run = startRun({ room: "demo", agent: "a" }, { config, engine, send: async () => true, machine: () => reading({ ramFreeGb: 30 }) });
  assert.equal(run.agent_id, "a");
  await waitForRun(db, run.id);
  // Above what the machine can give at all (32 - 2): left out, whatever the number of runs.
  peak(31);
  assert.deepEqual(effectiveNeeds(db, "demo", a(), ceiling), { ramGb: 4, vramGb: null });
  // Two real runs agree: the need is raised to the second highest.
  peak(6);
  assert.deepEqual(effectiveNeeds(db, "demo", a(), ceiling), { ramGb: 6, vramGb: null });
  // The owner changes the declaration: the peaks measured under the old one no longer count.
  const file = path.join(config.home, "rooms", "demo", "room.json");
  const room = JSON.parse(fs.readFileSync(file, "utf8"));
  room.agents[0].needs = { ramGb: 1 };
  fs.writeFileSync(file, JSON.stringify(room));
  assert.deepEqual(effectiveNeeds(db, "demo", a(), ceiling), { ramGb: 1, vramGb: null });
  peak(3, 1);
  peak(2, 1);
  assert.deepEqual(effectiveNeeds(db, "demo", a(), ceiling), { ramGb: 2, vramGb: null });
});

test("down to the end: a task the owner sends last stays after the tasks that arrive later, and up or auto brings it back", async () => {
  const { config, db } = home([agent("a", { needs: { ramGb: 20 } }), agent("c", { needs: { ramGb: 1 } })]);
  const { engine } = holdingEngine();
  const deps = { config, engine, send: async () => true, machine: () => reading({ ramFreeGb: 10 }) };
  const order = () => (db.prepare(`SELECT id FROM tasks WHERE status = 'pending' ORDER BY ${queueOrder()}`).all() as { id: number }[]).map((row) => row.id);
  const stuck = addTask(db, "a", 5);
  addTask(db, "c", 4);
  assert.deepEqual(wakeAgents(config, db, deps), [], "c waits behind a, which waits for RAM");
  moveInQueue(db, { taskId: stuck, move: "down" });
  assert.deepEqual(wakeAgents(config, db, deps).map((run) => run.agent_id), ["c"]);
  await settle(db);
  // A task that arrives later goes before it: the stuck one no longer holds the new ones back.
  const later = addTask(db, "c", 0);
  assert.deepEqual(order(), [later, stuck]);
  assert.deepEqual(wakeAgents(config, db, deps).map((run) => run.agent_id), ["c"]);
  await settle(db);
  const other = addTask(db, "a", 0);
  assert.deepEqual(order(), [other, stuck], "after every task without a place");
  moveInQueue(db, { taskId: stuck, move: "up" });
  assert.deepEqual(order(), [stuck, other]);
  moveInQueue(db, { taskId: stuck, move: "down" });
  assert.deepEqual(order(), [other, stuck]);
  // Back to the automatic order: after the task the up move placed ahead.
  moveInQueue(db, { taskId: stuck, move: "auto" });
  assert.deepEqual(order(), [other, stuck]);
  moveInQueue(db, { taskId: other, move: "auto" });
  assert.deepEqual(order(), [stuck, other], "with no place left, the oldest first");
});

// --- 3. A wait keeps only what fell short ---------------------------------------------------------------

test("an unreadable GPU holds only the GPU: a RAM-only agent does not wait behind a RAM and GPU agent", async () => {
  const { config, db } = home([agent("g", { needs: { ramGb: 1, vramGb: 4 } }), agent("r", { needs: { ramGb: 1 } }), agent("v", { needs: { vramGb: 1 } })]);
  const { engine } = holdingEngine();
  const unknown = () => reading({ ramFreeGb: 30, vramUsedGb: null, vramTotalGb: null });
  addTask(db, "g", 3);
  addTask(db, "v", 2);
  addTask(db, "r", 1);
  assert.deepEqual(wakeAgents(config, db, { config, engine, send: async () => true, machine: unknown }).map((run) => run.agent_id), ["r"]);
  await settle(db);
  const queue = listQueue(db, config, loadHome(config.home), unknown);
  assert.deepEqual(queue.map((entry) => [entry.agentId, entry.cause]), [
    ["g", "machine"],
    ["v", "machine"],
  ]);
});

// --- 4. A run hears each exchange once ------------------------------------------------------------------

test("a run of the general subject with a revision and a queued proposal hears each exchange once: in its prompt or at hq_status", async () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  let open = () => {};
  const held = new Promise<void>((resolve) => (open = resolve));
  const seen: RunInput[] = [];
  const engine: Engine = {
    name: "claude",
    async *run(input) {
      seen.push(input);
      await held;
      yield done;
    },
  };
  const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();
  const ask = db.prepare("INSERT INTO agent_questions (room, agent_id, question, answer, status, engine, started_at) VALUES ('demo', 'scout', ?, ?, 'done', 'claude', ?)");
  const proposal = Number(ask.run("Can you redo it?", "I propose a run", ago(600)).lastInsertRowid);
  ask.run("MARKER-BETWEEN: keep the frame", "Noted", ago(400));
  const approval = Number(
    db.prepare("INSERT INTO approvals (room, agent_id, type, title, body, status, created_at) VALUES ('demo', 'scout', 'doc', 'Item', 'b', 'revise', ?)").run(ago(300))
      .lastInsertRowid,
  );
  ask.run("MARKER-AFTER: make it blue", "Noted, blue", ago(200));
  const task = db.prepare("INSERT INTO tasks (room, agent_id, source, ref_id, text, status, created_at, updated_at) VALUES ('demo', 'scout', ?, ?, ?, 'pending', ?, ?)");
  task.run("revise", approval, "revise the item", ago(100), ago(100));
  task.run("chat", proposal, "the proposed run", ago(100), ago(100));
  const run = startRun({ room: "demo", agent: "scout", task: "wake" }, { config, engine, send: async () => true });
  await until(() => seen.length === 1);
  const prompt = seen[0]!.prompt;
  assert.ok(prompt.includes("MARKER-AFTER") && prompt.includes("MARKER-BETWEEN"), "both are in the prompt: none is skipped");
  const ctx = { dbPath: config.dbPath, runId: run.id, agentId: "scout", room: "demo" };
  assert.equal((hqStatus(db, ctx, { text: "step" }) as { fromOwner?: string }).fromOwner, undefined, "nothing is delivered twice");
  ask.run("MARKER-LATER: and smaller", "Noted", new Date().toISOString());
  const later = (hqStatus(db, ctx, { text: "step 2" }) as { fromOwner?: string }).fromOwner ?? "";
  assert.ok(later.includes("MARKER-LATER") && !later.includes("MARKER-AFTER"));
  open();
  await waitForRun(db, run.id);
});

// --- 5. The machine records of a crash --------------------------------------------------------------------

test("a run with needs cut by a crash has its machine record closed at the restart: later runs are measured alone, ticks read nothing", () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const insert = db.prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at) VALUES ('demo', 'scout', 'claude', 't', 'running', ?)");
  const record = db.prepare("INSERT INTO run_machine (run_id, room, agent_id, ram_need_gb, ram_free_start_gb, started_at) VALUES (?, 'demo', 'scout', 2, 20, ?)");
  const before = new Date(Date.now() - 86_400_000).toISOString();
  const crashed = Number(insert.run(before).lastInsertRowid);
  record.run(crashed, before);
  recoverInterruptedRuns(db);
  // The next run starts after the restart.
  const t1 = new Date(Date.now() + 1_000).toISOString();
  const later = Number(insert.run(t1).lastInsertRowid);
  record.run(later, t1);
  db.prepare("UPDATE runs SET status = 'done', ended_at = ? WHERE id = ?").run(new Date().toISOString(), later);
  closeRunMachine(db, later, () => reading({ ramFreeGb: 20 }));
  assert.deepEqual(db.prepare("SELECT run_id, ended_at IS NULL AS open, alone FROM run_machine ORDER BY run_id").all(), [
    { run_id: crashed, open: 0, alone: 0 },
    { run_id: later, open: 0, alone: 1 },
  ]);
  let reads = 0;
  sampleMachine(db, () => (reads++, reading()));
  assert.equal(reads, 0);
  // A record left open by a run that ended without the normal path is closed by the next tick too.
  const gone = Number(insert.run(t1).lastInsertRowid);
  record.run(gone, t1);
  db.prepare("UPDATE runs SET status = 'failed', ended_at = ? WHERE id = ?").run(t1, gone);
  sampleMachine(db, () => (reads++, reading()));
  assert.equal(reads, 0);
  assert.deepEqual(db.prepare("SELECT ended_at IS NULL AS open, alone FROM run_machine WHERE run_id = ?").get(gone), { open: 0, alone: 0 });
});

// --- 6. The reading is taken before the start's transaction ---------------------------------------------

test("the machine is read before the transaction of the start, never inside it", async () => {
  const { config, db } = home([agent("a", { needs: { ramGb: 1 } })]);
  const inside: boolean[] = [];
  const read = () => (inside.push(db.inTransaction), reading());
  const { engine } = holdingEngine();
  await waitForRun(db, startRun({ room: "demo", agent: "a" }, { config, engine, send: async () => true, machine: read }).id);
  addTask(db, "a");
  wakeAgents(config, db, { config, engine, send: async () => true, machine: read });
  await settle(db);
  assert.ok(inside.length >= 2);
  assert.deepEqual([...new Set(inside)], [false]);
});

// --- 7. The reservations, and a parallel agent ---------------------------------------------------------------

test("the reservations credit the memory given up once: A and B need 8 GB from 20 free, A took 2, C (4 GB, margin 2) does not start", () => {
  const { config, db } = home([agent("a", { needs: { ramGb: 8 } }), agent("b", { needs: { ramGb: 8 } }), agent("c", { needs: { ramGb: 4 } })]);
  const start = new Date().toISOString();
  for (const id of ["a", "b"]) {
    const run = Number(db.prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at) VALUES ('demo', ?, 'claude', 't', 'running', ?)").run(id, start).lastInsertRowid);
    db.prepare("INSERT INTO run_machine (run_id, room, agent_id, ram_need_gb, ram_declared_gb, ram_free_start_gb, started_at) VALUES (?, 'demo', ?, 8, 8, 20, ?)").run(run, id, start);
  }
  const now = reading({ ramFreeGb: 18 });
  assert.deepEqual(reservations(db, now), { ramGb: 14, vramGb: 0 }, "16 to take, 2 given up: 14 still reserved");
  assert.throws(
    () => startRun({ room: "demo", agent: "c" }, { config, engine: holdingEngine().engine, send: async () => true, machine: () => now }),
    (error: unknown) => error instanceof MachineBusy && /4 GB are left/.test(error.message) && error.holds.join() === "ram",
  );
});

test("a run older than the reservation window reserves nothing: what it took shows in what is free, and C starts beside it", () => {
  const { config, db } = home([agent("a", { needs: { ramGb: 8 } }), agent("c", { needs: { ramGb: 4 } })]);
  const old = new Date(Date.now() - RESERVATION_WINDOW_MS - 60_000).toISOString();
  const run = Number(db.prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at) VALUES ('demo', 'a', 'claude', 't', 'running', ?)").run(old).lastInsertRowid);
  db.prepare("INSERT INTO run_machine (run_id, room, agent_id, ram_need_gb, ram_declared_gb, ram_free_start_gb, started_at) VALUES (?, 'demo', 'a', 8, 8, 12, ?)").run(run, old);
  const now = reading({ ramFreeGb: 11 });
  // Within the window, A would still reserve 8 - 1 = 7 GB and leave 4, under C's 4 + 2.
  assert.deepEqual(reservations(db, now, new Date(Date.parse(old) + 60_000)), { ramGb: 7, vramGb: 0 });
  assert.deepEqual(reservations(db, now), { ramGb: 0, vramGb: 0 });
  const started = startRun({ room: "demo", agent: "c" }, { config, engine: holdingEngine().engine, send: async () => true, machine: () => now });
  assert.equal(started.agent_id, "c");
});

test("a parallel agent: two subjects' runs reserve twice, a third waits for RAM and holds only RAM, a start deferred by the veto starts once per subject", async () => {
  const { config, db } = home([agent("p", { parallel: true, needs: { ramGb: 8 } }), agent("v", { needs: { vramGb: 1 } })]);
  const { engine, release } = holdingEngine(["p"]);
  const deps = { config, engine, send: async () => true, machine: () => reading({ ramFreeGb: 24 }) };
  const [one, two, three] = [createSubject(db, "demo", "p", "Un").id, createSubject(db, "demo", "p", "Deux").id, createSubject(db, "demo", "p", "Trois").id];
  addTask(db, "p", 4, one);
  addTask(db, "p", 3, two);
  addTask(db, "p", 2, three);
  addTask(db, "v", 1);
  // 24 free: one fits (8 + 2), two sees 8 reserved (16 left), three sees 16 reserved (8 left): it waits, holding RAM only.
  const started = wakeAgents(config, db, deps);
  assert.deepEqual(started.map((run) => [run.agent_id, run.subject_id]), [
    ["p", one],
    ["p", two],
    ["v", null],
  ]);
  assert.equal(reservations(db, reading({ ramFreeGb: 24 })).ramGb, 16, "two runs of one agent reserve twice");
  const [waiting] = listQueue(db, config, loadHome(config.home), () => reading({ ramFreeGb: 24 }));
  assert.equal(waiting!.cause, "machine");
  release();
  await settle(db);

  // The veto command, asked for the two subjects at once: each subject's task starts once, and only once.
  const vetoedHome = home([agent("p", { parallel: true, resources: ["gpu"] })], { machine: { veto: { command: [process.execPath, "veto.cjs"], timeoutSeconds: 2 } } });
  fs.writeFileSync(path.join(vetoedHome.config.home, "veto.cjs"), `process.stdout.write(JSON.stringify({ wait: false }));`);
  const a = createSubject(vetoedHome.db, "demo", "p", "A").id;
  const b = createSubject(vetoedHome.db, "demo", "p", "B").id;
  addTask(vetoedHome.db, "p", 2, a);
  addTask(vetoedHome.db, "p", 1, b);
  const vdeps = { config: vetoedHome.config, engine: holdingEngine().engine, send: async () => true, machine: () => reading() };
  assert.deepEqual(wakeAgents(vetoedHome.config, vetoedHome.db, vdeps), []);
  await settle(vetoedHome.db);
  await until(() => runsOf(vetoedHome.db, "p").length === 2);
  await settle(vetoedHome.db);
  resumeWaitingTasks(vetoedHome.config, vetoedHome.db, vdeps);
  await settle(vetoedHome.db);
  assert.deepEqual(runsOf(vetoedHome.db, "p").map((run) => run.subject_id).sort(), [a, b].sort());
});

// --- 10. A queued proposal of a removed agent ---------------------------------------------------------------------

test("a queued proposal of an agent removed from the home can still be set aside: its task is closed", () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const at = new Date().toISOString();
  const question = Number(
    db.prepare("INSERT INTO agent_questions (room, agent_id, question, answer, status, engine, started_at) VALUES ('demo', 'gone', 'q', 'a', 'done', 'claude', ?)").run(at)
      .lastInsertRowid,
  );
  const task = Number(
    db.prepare("INSERT INTO tasks (room, agent_id, source, ref_id, text, status, created_at, updated_at) VALUES ('demo', 'gone', 'chat', ?, 'Rends B', 'pending', ?, ?)").run(question, at, at)
      .lastInsertRowid,
  );
  db.prepare("INSERT INTO question_proposals (question_id, task, state, task_id, created_at, decided_at) VALUES (?, 'Rends B', 'launched', ?, ?, ?)").run(question, task, at, at);
  const { question: after, run } = decideProposal({ room: "demo", agent: "gone", questionId: question, action: "dismiss" }, { config });
  assert.equal(run, null);
  assert.equal(after.id, question);
  assert.equal((db.prepare("SELECT status FROM tasks WHERE id = ?").get(task) as { status: string }).status, "done");
  // Launching still needs the agent.
  assert.throws(() => decideProposal({ room: "demo", agent: "gone", questionId: question, action: "launch" }, { config }), /No agent "gone"/);
});
