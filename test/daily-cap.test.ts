import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ChatService } from "../src/assistant/chat-service";
import type { ChatRunner } from "../src/assistant/chat";
import { corePreamble } from "../src/assistant/preamble";
import { decideApproval } from "../src/server/approvals";
import { alertCapReached } from "../src/server/cap-alert";
import { listChatHistory } from "../src/server/chat-history";
import type { HqConfig } from "../src/server/config";
import { getDbAt, type Db, type RunRow } from "../src/server/db";
import type { Engine, RunEvent, RunInput } from "../src/server/engine";
import { HqError } from "../src/server/errors";
import { loadHome, syncHome } from "../src/server/rooms";
import { resumeWaitingTasks, runsToday, startRun } from "../src/server/runner";
import { chatConfig, makeHome, waitForRun } from "./helpers";

const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const done: RunEvent = { type: "end", status: "done", reason: "success", summary: "ok", usage, costUsd: 0 };
const PUBLIC = { HQ_PUBLIC_URL: "https://hq.example.test" };

function capHome(overrides: Partial<HqConfig> = {}): HqConfig {
  const base = { role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"] };
  return makeHome(overrides, {
    name: "demo",
    targetRepo: "../demo-project",
    agents: [
      { id: "scout", name: "Agenda", ...base },
      { id: "writer", name: "Writer", ...base },
    ],
  });
}

function engine(seen: RunInput[] = [], gate?: Promise<void>): Engine {
  return {
    name: "claude",
    async *run(input) {
      seen.push(input);
      if (gate) await gate;
      yield done;
    },
  };
}

const runsOf = (db: Db, agent: string) =>
  db.prepare("SELECT * FROM runs WHERE agent_id = ? ORDER BY id").all(agent) as RunRow[];

/** Moves every run of the database to two days ago: the daily counter is back to zero. */
function newDay(db: Db): void {
  db.prepare("UPDATE runs SET started_at = ?").run(new Date(Date.now() - 48 * 3_600_000).toISOString());
}

function addApproval(db: Db, agent: string): number {
  return Number(
    db
      .prepare(
        "INSERT INTO approvals (room, agent_id, type, title, body, status, created_at) VALUES ('demo', ?, 'mail_reply', 'Reply', 'Hello.', 'pending', ?)",
      )
      .run(agent, new Date().toISOString()).lastInsertRowid,
  );
}

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A chat service whose turn writes one request for Agenda and answers as if it was in hand. */
function chatService(config: HqConfig, sent: string[], gate?: Promise<void>) {
  const db = getDbAt(config.dbPath);
  syncHome(db, loadHome(config.home));
  const requestsDir = path.join(config.home, "chat", "requests");
  const runChat: ChatRunner = async () => {
    fs.mkdirSync(requestsDir, { recursive: true });
    fs.writeFileSync(
      path.join(requestsDir, "a.json"),
      JSON.stringify({ room: "demo", agent: "scout", task: "Note a reminder for Friday." }),
    );
    return { ok: true, text: "Agenda prépare le rappel pour vendredi.", costUsd: 0 };
  };
  const service = new ChatService({
    config,
    db,
    chat: chatConfig({ cwd: config.home, requestsDir }),
    env: { PATH: process.env.PATH },
    chatMaxBudgetUsd: 0.5,
    runChat,
    startRun: (request) =>
      startRun(request, {
        config,
        engine: engine([], gate),
        send: async (text) => {
          sent.push(text);
          return true;
        },
        env: PUBLIC,
      }),
    log: () => undefined,
  });
  return { db, service };
}

// --- 1. The chat says so when a request cannot start -------------------------------

test("a request refused for the daily cap is said in the reply, with the task still pending", async () => {
  const config = capHome({ maxRunsPerDay: 1 });
  const sent: string[] = [];
  const { db, service } = chatService(config, sent);
  const first = startRun({ room: "demo", agent: "writer" }, { config, engine: engine(), send: async () => true });
  await waitForRun(db, first.id);

  const result = await service.ask("Note un rappel pour vendredi", "desk");
  assert.ok(result.ok);
  const task = db.prepare("SELECT * FROM tasks WHERE source = 'chat'").get() as { id: number; status: string };
  assert.equal(task.status, "pending");
  assert.match(result.reply, /^Agenda prépare le rappel pour vendredi\./, "the chat's own words stay");
  assert.ok(
    result.reply.endsWith(
      `Noté (tâche #${task.id}), mais Agenda ne peut pas tourner avant minuit : plafond de 1 tours atteint. La tâche partira toute seule à la remise à zéro du compteur.`,
    ),
    result.reply,
  );
  // What the user read is what the history keeps, and nothing started.
  assert.equal(listChatHistory(db, 5).at(-1)!.text, result.reply);
  assert.equal(runsOf(db, "scout").length, 0);
});

test("a request for a busy agent says it waits for the end of its run, and the end of that run wakes it", async () => {
  const config = capHome();
  const sent: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { db, service } = chatService(config, sent);
  const seen: RunInput[] = [];
  const busy = startRun({ room: "demo", agent: "scout" }, { config, engine: engine(seen, gate), send: async () => true });

  const result = await service.ask("Note un rappel pour vendredi", "desk");
  assert.match(result.reply, /Noté \(tâche #\d+\), mais Agenda est occupé : elle sera prise dès la fin de son tour en cours\.$/);
  assert.equal(runsOf(db, "scout").length, 1);

  release();
  await waitForRun(db, busy.id);
  // The run that ends wakes the agent again with the chat's task (reason chat).
  await until(() => runsOf(db, "scout").length === 2);
  const woken = runsOf(db, "scout")[1]!;
  assert.equal(woken.reason, "chat");
  await waitForRun(db, woken.id);
});

test("a request that starts its run adds no line to the reply", async () => {
  const config = capHome();
  const { db, service } = chatService(config, []);
  const result = await service.ask("Note un rappel pour vendredi", "desk");
  assert.equal(result.reply, "Agenda prépare le rappel pour vendredi.");
  await waitForRun(db, runsOf(db, "scout")[0]!.id);
});

test("the preamble tells the chat the cap is reached before it answers", () => {
  const config = capHome({ maxRunsPerDay: 1 });
  const db = getDbAt(config.dbPath);
  syncHome(db, loadHome(config.home));
  assert.deepEqual(corePreamble(db, config, ["runs"], new Date()), ["Tours d'agents aujourd'hui : 0 sur 1."]);
  db.prepare(
    "INSERT INTO runs (room, agent_id, engine, task, status, started_at) VALUES ('demo', 'scout', 'claude', 't', 'done', ?)",
  ).run(new Date().toISOString());
  const [line] = corePreamble(db, config, ["runs"], new Date());
  assert.match(line!, /^Tours d'agents aujourd'hui : 1 sur 1\. Plafond atteint : aucun agent ne peut démarrer avant minuit/);
  assert.match(line!, /ne promets pas que le travail est en cours/);
});

// --- 2. The tasks that waited for the cap resume ------------------------------------

test("tasks that waited for the cap are woken after the reset, in order, under the same cap", async () => {
  const config = capHome({ maxRunsPerDay: 1 });
  const db = getDbAt(config.dbPath);
  syncHome(db, loadHome(config.home));
  const seen: RunInput[] = [];
  const deps = { config, engine: engine(seen), send: async () => true };
  const first = startRun({ room: "demo", agent: "writer" }, deps);
  await waitForRun(db, first.id);
  // Two requests of the chat during the capped day: the writer's first, then Agenda's.
  const task = db.prepare(
    "INSERT INTO tasks (room, agent_id, source, text, status, created_at, updated_at) VALUES ('demo', ?, 'chat', ?, 'pending', ?, ?)",
  );
  const at = new Date().toISOString();
  task.run("writer", "Write the post.", at, at);
  task.run("scout", "Note the reminder.", at, at);

  assert.deepEqual(resumeWaitingTasks(config, db, deps), [], "nothing starts while the cap is reached");
  assert.equal(runsOf(db, "scout").length, 0);

  newDay(db);
  assert.equal(runsToday(db), 0);
  const started = resumeWaitingTasks(config, db, deps);
  // Same order as wakeAgents (task id) and the same cap: one run today, the other task waits.
  assert.deepEqual(
    started.map((run) => [run.agent_id, run.reason]),
    [["writer", "chat"]],
  );
  await waitForRun(db, started[0]!.id);
  assert.equal(runsOf(db, "scout").length, 0);
  assert.equal((db.prepare("SELECT status FROM tasks WHERE agent_id = 'scout'").get() as { status: string }).status, "pending");

  // The next day, the other one goes, and a task is never woken twice.
  newDay(db);
  const next = resumeWaitingTasks(config, db, deps);
  assert.deepEqual(
    next.map((run) => run.agent_id),
    ["scout"],
  );
  await waitForRun(db, next[0]!.id);
  assert.match(seen.at(-1)!.prompt, /Note the reminder\./);
  newDay(db);
  assert.deepEqual(resumeWaitingTasks(config, db, deps), []);
});

test("a revision that waited for the cap is woken too, with its reason", async () => {
  const config = capHome({ maxRunsPerDay: 1 });
  const db = getDbAt(config.dbPath);
  const deps = { config, engine: engine(), send: async () => true };
  const first = startRun({ room: "demo", agent: "writer" }, deps);
  await waitForRun(db, first.id);
  const id = addApproval(db, "scout");
  decideApproval(db, id, { decision: "revise", note: "Shorter." }, config, deps);
  assert.equal(runsOf(db, "scout").length, 0);
  newDay(db);
  const [run] = resumeWaitingTasks(config, db, deps);
  assert.equal(run!.reason, "revise");
  await waitForRun(db, run!.id);
});

// --- 3. The alert of the day ---------------------------------------------------------

test("the cap alert goes out once a day, with the waiting tasks and the settings link", async () => {
  const config = capHome({ maxRunsPerDay: 1 });
  const db = getDbAt(config.dbPath);
  syncHome(db, loadHome(config.home));
  const sent: string[] = [];
  const send = async (text: string) => {
    sent.push(text);
    return true;
  };
  const deps = { config, engine: engine(), env: PUBLIC, send };
  const first = startRun({ room: "demo", agent: "writer" }, deps);
  await waitForRun(db, first.id);
  assert.deepEqual(sent, [], "reaching the cap alone is not a refusal");

  const at = new Date().toISOString();
  for (const agent of ["scout", "writer"]) {
    db.prepare(
      "INSERT INTO tasks (room, agent_id, source, text, status, created_at, updated_at) VALUES ('demo', ?, 'chat', 'x', 'pending', ?, ?)",
    ).run(agent, at, at);
  }
  for (let i = 0; i < 3; i++) {
    assert.throws(
      () => startRun({ room: "demo", agent: "scout" }, deps),
      (e) => e instanceof HqError && e.code === "DAILY_CAP_REACHED",
    );
  }
  await until(() => sent.length >= 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sent.length, 1, "a single alert for the day");
  assert.equal(
    sent[0],
    [
      "MyHQ : plafond de 1 tours atteint pour aujourd'hui",
      "2 tâches attendent un tour : elles partiront toutes seules à la remise à zéro du compteur (minuit). Tu peux relever le plafond dans les réglages.",
      "",
      "Réglages : https://hq.example.test/reglages",
    ].join("\n"),
  );
  assert.ok(listChatHistory(db, 5).some((m) => m.kind === "alert" && m.text === sent[0]), "kept in the conversation");

  // The next day it can alert again; a send that fails does not use the day up.
  const tomorrow = new Date(Date.now() + 36 * 3_600_000);
  assert.equal(await alertCapReached({ config, db, send: async () => false, env: PUBLIC, at: tomorrow }), false);
  assert.equal(await alertCapReached({ config, db, send, env: PUBLIC, at: tomorrow }), true);
  assert.equal(await alertCapReached({ config, db, send, env: PUBLIC, at: tomorrow }), false);
});

test("without HQ_PUBLIC_URL the cap alert has no link, and says so when nothing waits", async () => {
  const config = capHome({ maxRunsPerDay: 3 });
  const db = getDbAt(config.dbPath);
  syncHome(db, loadHome(config.home));
  const sent: string[] = [];
  const send = async (text: string) => {
    sent.push(text);
    return true;
  };
  assert.equal(await alertCapReached({ config, db, send, env: {} }), true);
  assert.equal(
    sent[0],
    "MyHQ : plafond de 3 tours atteint pour aujourd'hui\nAucun agent ne peut démarrer avant la remise à zéro du compteur (minuit).",
  );
});
