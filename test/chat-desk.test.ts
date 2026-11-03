import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, test } from "node:test";
import { handleChatPost, handleHistoryDelete, handleHistoryGet } from "../src/assistant/chat-api";
import { getChatService } from "../src/assistant/chat-service";
import type { ChatOutcome, ChatRunner } from "../src/assistant/chat";
import { Assistant } from "../src/assistant/assistant";
import { PendingSelections } from "../src/assistant/pending";
import { EMPTY_ASSISTANT_CONFIG } from "../src/assistant/home-config";
import { Telegram } from "../src/assistant/telegram";
import { subscribeChat, type ChatEvent } from "../src/server/chat-hub";
import { listChatHistory, recordBotMessage, recordChatMessage } from "../src/server/chat-history";
import type { HqConfig } from "../src/server/config";
import { getDbAt, type Db, type RunRow } from "../src/server/db";
import type { Engine } from "../src/server/engine";
import { eventStreamResponse } from "../src/server/event-stream";
import { startRun as realStartRun, type StartRunRequest } from "../src/server/runner";
import { startFakeTelegram } from "./fake-telegram";
import { chatConfig, makeHome, waitForRun } from "./helpers";

// The desk's conversation: the shared pipeline over HTTP (POST /api/chat), the
// queue of turns across channels, tasks for agents, and the `chat` event.

const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

const saved = process.env.MYHQ_HOME;
afterEach(() => {
  if (saved === undefined) delete process.env.MYHQ_HOME;
  else process.env.MYHQ_HOME = saved;
});
const fakes: { close(): Promise<void> }[] = [];
after(() => Promise.all(fakes.map((fake) => fake.close())));

/** An engine whose run ends when `release` is called. */
function hangingEngine() {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const engine: Engine = {
    name: "claude",
    async *run() {
      yield { type: "start", sessionId: "s", model: "haiku", tools: [], mcpServers: [] };
      await gate;
      yield { type: "end", status: "done", reason: "success", summary: "ok", usage, costUsd: 0 };
    },
  };
  return { engine, release };
}

type Seen = { input: string };

function setup(
  options: {
    config?: HqConfig;
    chat?: Partial<ReturnType<typeof chatConfig>> | null;
    answer?: (seen: Seen, n: number) => ChatOutcome | Promise<ChatOutcome>;
    startRun?: (request: StartRunRequest) => RunRow;
  } = {},
) {
  const config = options.config ?? makeHome();
  process.env.MYHQ_HOME = config.home;
  const db = getDbAt(config.dbPath);
  const seen: Seen[] = [];
  const runChat: ChatRunner = async (params) => {
    const turn = { input: params.input };
    seen.push(turn);
    return options.answer ? options.answer(turn, seen.length) : { ok: true, text: `Réponse ${seen.length}`, costUsd: 0 };
  };
  const logs: string[] = [];
  const service = getChatService(config, {
    chat: options.chat === null ? null : chatConfig({ cwd: config.home, ...options.chat }),
    env: { PATH: process.env.PATH },
    chatMaxBudgetUsd: 0.5,
    runChat,
    startRun: options.startRun,
    log: (m) => logs.push(m),
  });
  const events: ChatEvent[] = [];
  const unsubscribe = subscribeChat((event) => events.push(event));
  after(unsubscribe);
  const post = (body: unknown) =>
    handleChatPost(
      new Request("http://127.0.0.1/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  return { config, db, service, seen, logs, events, post };
}

function addApproval(db: Db, title = "Réponse à la mairie"): number {
  return Number(
    db
      .prepare(
        "INSERT INTO approvals (room, agent_id, type, title, body, status, created_at) VALUES ('demo', 'scout', 'mail_reply', ?, 'body', 'pending', ?)",
      )
      .run(title, new Date().toISOString()).lastInsertRowid,
  );
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const json = async (response: Response): Promise<Json> => (await response.json()) as Json;
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

// --- The shared pipeline over HTTP --------------------------------------------------

test("POST /api/chat runs the chat turn: the reply, the desk channel in the history, a chat event", async () => {
  const { db, post, seen, events } = setup();
  const response = await post({ text: "  Quoi de neuf ?  " });
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.ok, true);
  assert.equal(body.reply, "Réponse 1");
  assert.equal("pendingConfirmation" in body, false);
  assert.equal(seen[0]!.input, "Quoi de neuf ?", "the text is trimmed, nothing precedes the first message");
  assert.deepEqual(
    body.messages.map((m: Json) => [m.role, m.channel, m.to, m.text]),
    [
      ["user", "desk", null, "Quoi de neuf ?"],
      ["assistant", "desk", null, "Réponse 1"],
    ],
  );
  assert.deepEqual(
    listChatHistory(db, 10).map((m) => [m.role, m.channel]),
    [
      ["user", "desk"],
      ["assistant", "desk"],
    ],
  );
  const recorded = events.filter((e) => e.type === "message").map((e) => (e as Extract<ChatEvent, { type: "message" }>).message.text);
  assert.deepEqual(recorded, ["Quoi de neuf ?", "Réponse 1"]);

  // The turn resumes the CLI's conversation: nothing to give back when the bot said nothing on its own.
  await post({ text: "Et encore ?" });
  assert.equal(seen[1]!.input, "Et encore ?");
});

test("POST /api/chat: invalid bodies are refused, and so is a chat that is not configured", async () => {
  const { post } = setup({ chat: null });
  assert.equal((await post({ text: "   " })).status, 400);
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ text: "a", extra: 1 })).status, 400);
  const response = await post({ text: "Bonjour" });
  assert.equal(response.status, 404);
  assert.equal((await json(response)).error.code, "CHAT_NOT_CONFIGURED");
});

test("a failed turn answers with the reason, records nothing and is not an HTTP error", async () => {
  const { post, db } = setup({ answer: () => ({ ok: false, reason: "timeout", detail: "timed out" }) });
  const response = await post({ text: "Long" });
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.ok, false);
  assert.match(body.reply, /J'ai dépassé/);
  assert.deepEqual(body.messages, []);
  assert.deepEqual(listChatHistory(db, 10), []);
});

test("held actions: the turn asks for a confirmation, « oui » over HTTP executes them through the same path", async () => {
  const config = makeHome();
  const requestsDir = path.join(config.home, "chat", "requests");
  const db = getDbAt(config.dbPath);
  const id = addApproval(db);
  const { post, seen, service } = setup({
    config,
    chat: { requestsDir, actions: ["approve"], mcpServers: { mail: { command: "node" } } },
    answer: (_seen, n) => {
      if (n === 1) {
        fs.mkdirSync(requestsDir, { recursive: true });
        fs.writeFileSync(path.join(requestsDir, "a.json"), JSON.stringify({ action: "approve", id }));
      }
      return { ok: true, text: `Réponse ${n}`, costUsd: 0, tools: n === 1 ? ["mcp__mail__mail_search"] : [] };
    },
  });
  const first = await json(await post({ text: "Approuve le brouillon" }));
  assert.match(first.reply, /^Réponse 1\n\nCette réponse s'appuie sur du courrier ou du web/);
  assert.deepEqual(first.pendingConfirmation, { summary: `approuver l'item #${id}` });
  assert.equal((db.prepare("SELECT status FROM approvals WHERE id = ?").get(id) as { status: string }).status, "pending");
  assert.deepEqual(service.state().pendingConfirmation, { summary: `approuver l'item #${id}` });
  const history = await json(handleHistoryGet(new Request("http://127.0.0.1/api/chat/history")));
  assert.deepEqual(history.turn, { running: false, queued: 0, pendingConfirmation: { summary: `approuver l'item #${id}` } });

  const yes = await json(await post({ text: "Oui !" }));
  assert.equal(yes.reply, `Item #${id} : Approuvé.`);
  assert.equal("pendingConfirmation" in yes, false);
  assert.equal((db.prepare("SELECT status FROM approvals WHERE id = ?").get(id) as { status: string }).status, "approved");
  assert.equal(seen.length, 1, "the yes is not a chat turn");
  assert.equal(service.state().pendingConfirmation, null);
  assert.deepEqual(
    listChatHistory(db, 10).slice(-2).map((m) => [m.role, m.channel, m.text]),
    [
      ["user", "desk", "Oui !"],
      ["assistant", "desk", `Item #${id} : Approuvé.`],
    ],
  );
});

test("« non » drops held actions, and any other message drops them with a note and goes on", async () => {
  const config = makeHome();
  const requestsDir = path.join(config.home, "chat", "requests");
  const db = getDbAt(config.dbPath);
  const id = addApproval(db);
  const { post, seen } = setup({
    config,
    chat: { requestsDir, actions: ["approve"], mcpServers: { mail: { command: "node" } } },
    answer: (_seen, n) => {
      if (n === 1 || n === 2) {
        fs.mkdirSync(requestsDir, { recursive: true });
        fs.writeFileSync(path.join(requestsDir, `a${n}.json`), JSON.stringify({ action: "approve", id }));
      }
      return { ok: true, text: `Réponse ${n}`, costUsd: 0, tools: n <= 2 ? ["mcp__mail__mail_search"] : [] };
    },
  });
  await post({ text: "Approuve" });
  const no = await json(await post({ text: "non" }));
  assert.equal(no.reply, "D'accord, je n'en fais rien.");
  assert.equal(seen.length, 1);

  await post({ text: "Approuve encore" });
  const other = await json(await post({ text: "Plutôt, résume mes mails" }));
  assert.match(other.reply, /^Je laisse tomber les actions qui attendaient ton accord\.\n\nRéponse 3/);
  assert.equal(seen.length, 3);
  assert.equal((db.prepare("SELECT status FROM approvals WHERE id = ?").get(id) as { status: string }).status, "pending");
  // The note is part of what the user reads, so the history keeps it with the answer.
  assert.match(listChatHistory(db, 1)[0]!.text, /^Je laisse tomber les actions/);
});

// --- One turn at a time, across channels ------------------------------------------

test("a second message waits for the turn in progress, whatever its channel, and the state says so", async () => {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const order: string[] = [];
  const { post, service, events, db } = setup({
    answer: async ({ input }, n) => {
      order.push(`start ${n}`);
      if (n === 1) await gate;
      order.push(`end ${n}`);
      return { ok: true, text: `Réponse à ${input.split("\n").at(-1)}`, costUsd: 0 };
    },
  });
  const first = post({ text: "Premier" });
  await tick();
  assert.deepEqual(service.state(), { running: true, queued: 0, pendingConfirmation: null });

  // The Telegram side asks while the desk's turn runs.
  const second = service.converse("Deuxième", "telegram");
  const third = post({ text: "Troisième" });
  await tick();
  assert.deepEqual(order, ["start 1"], "nothing else starts while the first runs");
  assert.deepEqual(service.state(), { running: true, queued: 2, pendingConfirmation: null });

  open();
  const [a, b, c] = await Promise.all([first, second, third]);
  assert.equal((await json(a)).reply, "Réponse à Premier");
  assert.equal(b.reply, "Réponse à Deuxième");
  assert.equal((await json(c)).reply, "Réponse à Troisième");
  assert.deepEqual(order, ["start 1", "end 1", "start 2", "end 2", "start 3", "end 3"]);
  assert.deepEqual(
    listChatHistory(db, 10).map((m) => [m.role, m.channel, m.text]),
    [
      ["user", "desk", "Premier"],
      ["assistant", "desk", "Réponse à Premier"],
      ["user", "telegram", "Deuxième"],
      ["assistant", "telegram", "Réponse à Deuxième"],
      ["user", "desk", "Troisième"],
      ["assistant", "desk", "Réponse à Troisième"],
    ],
  );
  await service.idle();
  assert.deepEqual(service.state(), { running: false, queued: 0, pendingConfirmation: null });
  const turns = events.filter((e) => e.type === "turn").map((e) => (e as Extract<ChatEvent, { type: "turn" }>).turn);
  assert.ok(turns.some((turn) => turn.running && turn.queued === 2));
  assert.deepEqual(turns.at(-1), { running: false, queued: 0, pendingConfirmation: null });
});

test("a Telegram message and a desk message share one queue (the bridge's Assistant uses the same service)", async () => {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const order: string[] = [];
  const config = makeHome();
  const { post, service, db } = setup({
    config,
    answer: async ({ input }, n) => {
      order.push(`start ${n}`);
      if (n === 1) await gate;
      order.push(`end ${n}`);
      return { ok: true, text: `Réponse à ${input.split("\n").at(-1)}`, costUsd: 0 };
    },
  });
  const fake = await startFakeTelegram("tok");
  fakes.push(fake);
  const assistant = new Assistant({
    telegram: new Telegram("tok", fake.url),
    chatId: "42",
    config,
    db,
    assistant: { ...EMPTY_ASSISTANT_CONFIG, chat: chatConfig({ cwd: config.home }) },
    extensions: [],
    env: { PATH: process.env.PATH },
    chatMaxBudgetUsd: 0.5,
    chatService: service,
    log: () => undefined,
    typingIntervalMs: 20,
  });
  const desk = post({ text: "Depuis le bureau" });
  await tick();
  await assistant.handleUpdate({
    update_id: 1,
    message: { message_id: 1, chat: { id: 42, type: "private" }, from: { id: 42 }, date: 1, text: "Depuis Telegram" },
  } as never);
  await tick();
  assert.deepEqual(order, ["start 1"]);
  assert.equal(service.state().queued, 1);
  open();
  await desk;
  await assistant.idle();
  assert.deepEqual(order, ["start 1", "end 1", "start 2", "end 2"]);
  assert.deepEqual(fake.sent(), ["Réponse à Depuis Telegram"]);
  assert.deepEqual(
    listChatHistory(db, 10).map((m) => [m.role, m.channel]),
    [
      ["user", "desk"],
      ["assistant", "desk"],
      ["user", "telegram"],
      ["assistant", "telegram"],
    ],
  );
});

test("/new over HTTP empties the conversation, after the turn in progress, and tells the streams", async () => {
  const { post, db, events, service } = setup();
  await post({ text: "Bonjour" });
  assert.equal(listChatHistory(db, 10).length, 2);
  const response = await handleHistoryDelete();
  assert.deepEqual(await json(response), { cleared: true });
  assert.deepEqual(listChatHistory(db, 10), []);
  assert.ok(events.some((e) => e.type === "cleared"));
  await service.idle();
});

// --- Tasks for agents ---------------------------------------------------------------

test("with `to`, the text becomes the task of that agent and a run starts at once, with the usual lock and cap", async () => {
  const config = makeHome({ maxRunsPerDay: 1 });
  const { engine, release } = hangingEngine();
  const { post, db, seen } = setup({
    config,
    chat: null,
    startRun: (request) => realStartRun(request, { config, engine, send: async () => true }),
  });
  const first = await post({ text: "Prépare la réponse à la mairie", to: { room: "demo", agent: "scout" } });
  assert.equal(first.status, 202);
  const body = await json(first);
  assert.equal(body.reply, `Tâche transmise à Scout, tour n° ${body.dispatch.run.id} lancé`);
  assert.equal(body.dispatch.run.reason, "desk");
  assert.equal(body.dispatch.run.task, "Prépare la réponse à la mairie");
  assert.equal(body.dispatch.run.status, "running");
  assert.equal(seen.length, 0, "the chat model is not called");
  assert.deepEqual(
    body.messages.map((m: Json) => [m.role, m.kind, m.channel, m.to, m.text]),
    [
      ["user", null, "desk", { room: "demo", agent: "scout" }, "Prépare la réponse à la mairie"],
      ["bot", "dispatch", "desk", { room: "demo", agent: "scout" }, body.reply],
    ],
  );
  const task = db.prepare("SELECT text, status FROM tasks WHERE run_id = ?").get(body.dispatch.run.id) as { text: string };
  assert.equal(task.text, "Prépare la réponse à la mairie");

  // The agent is busy: same refusal as POST /api/runs, and nothing is recorded for it.
  const busy = await post({ text: "Autre chose", to: { room: "demo", agent: "scout" } });
  assert.equal(busy.status, 409);
  assert.equal((await json(busy)).error.code, "AGENT_BUSY");
  assert.equal(listChatHistory(db, 10).length, 2);

  release();
  await waitForRun(db, body.dispatch.run.id);
  const capped = await post({ text: "Encore", to: { room: "demo", agent: "scout" } });
  assert.equal(capped.status, 429);
  assert.equal((await json(capped)).error.code, "DAILY_CAP_REACHED");

  assert.equal((await post({ text: "x", to: { room: "demo", agent: "nobody" } })).status, 404);
  assert.equal((await post({ text: "x", to: { room: "nowhere", agent: "scout" } })).status, 404);
});

test("the next chat turn knows what the user sent to an agent", async () => {
  const config = makeHome();
  const { engine, release } = hangingEngine();
  after(release);
  const { post, seen } = setup({
    config,
    chat: { resume: "history" },
    startRun: (request) => realStartRun(request, { config, engine, send: async () => true }),
  });
  await post({ text: "Fais le point", to: { room: "demo", agent: "scout" } });
  await post({ text: "Alors ?" });
  assert.match(seen[0]!.input, /Utilisateur \(à demo \/ scout\) : Fais le point\nToi, message automatique \(tâche transmise\) : Tâche transmise à Scout/);
});

// --- The stream and the history -----------------------------------------------------

test("the live stream carries a `chat` event for every message recorded, from any channel", async () => {
  const { db } = setup();
  const controller = new AbortController();
  const response = eventStreamResponse(new Request("http://127.0.0.1/api/events", { signal: controller.signal }));
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const read = async (until: RegExp) => {
    const deadline = Date.now() + 3_000;
    while (!until.test(text)) {
      if (Date.now() > deadline) throw new Error(`no ${until} in ${text}`);
      const chunk = await Promise.race([reader.read(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 200))]);
      if (chunk && !chunk.done) text += decoder.decode(chunk.value);
    }
  };
  await read(/event: ready/);
  recordChatMessage(db, "user", "Depuis Telegram", null, { channel: "telegram" });
  recordBotMessage(db, "Un item attend", "alert");
  await read(/Un item attend/);
  const frames = text
    .split("\n\n")
    .filter((frame) => frame.startsWith("event: chat"))
    .map((frame) => JSON.parse(frame.split("\ndata: ")[1]!) as ChatEvent);
  assert.deepEqual(
    frames.map((frame) => (frame.type === "message" ? [frame.message.role, frame.message.kind, frame.message.channel, frame.message.text] : frame.type)),
    [
      ["user", null, "telegram", "Depuis Telegram"],
      ["bot", "alert", "telegram", "Un item attend"],
    ],
  );
  assert.ok(!/id: [^\n]*\nevent: chat/.test(text), "a chat event carries no stream id");
  controller.abort();
});

test("GET /api/chat/history: the last 50 by default, oldest first, with channel, target, kind and the state of the turns", async () => {
  const { db } = setup();
  for (let i = 0; i < 60; i++) recordChatMessage(db, i % 2 ? "assistant" : "user", `m${i}`, null, { channel: i < 55 ? "telegram" : "desk" });
  recordBotMessage(db, "Alerte", "alert");
  recordChatMessage(db, "user", "pour Scout", null, { channel: "desk", to: { room: "demo", agent: "scout" } });
  const get = (query = "") => handleHistoryGet(new Request(`http://127.0.0.1/api/chat/history${query}`));
  const body = await json(get());
  assert.equal(body.messages.length, 50);
  assert.equal(body.messages.at(-1).text, "pour Scout");
  assert.deepEqual(Object.keys(body.messages[0]).sort(), ["channel", "choices", "createdAt", "id", "kind", "role", "text", "to"]);
  assert.deepEqual(
    body.messages.slice(-3).map((m: Json) => [m.role, m.kind, m.channel, m.to]),
    [
      ["assistant", null, "desk", null],
      ["bot", "alert", "telegram", null],
      ["user", null, "desk", { room: "demo", agent: "scout" }],
    ],
  );
  const ids = body.messages.map((m: Json) => m.id as number);
  assert.deepEqual(ids, [...ids].sort((x, y) => x - y));
  assert.deepEqual(body.turn, { running: false, queued: 0, pendingConfirmation: null });
  assert.equal((await json(get("?limit=3"))).messages.length, 3);
  assert.equal(get("?limit=0").status, 400);
  assert.equal(get("?limit=201").status, 400);
});

// --- Selection lists ----------------------------------------------------------------

const LIST = [
  "Voici ce qui attend :",
  "- [ ] 1. Mairie de Paris : recours FPS",
  "- [ ] 2. Relance du notaire pour la promesse de vente du garage",
  "- [ ] 3. Dossier assurance",
].join("\n");

test("desk round trip: a reply with a task list carries its choices, the selection goes back as a message and is recorded", async () => {
  const { post, seen, db } = setup({
    answer: (_turn, n) => ({ ok: true, text: n === 1 ? LIST : "Je m'en occupe.", costUsd: 0 }),
  });
  const first = await json(await post({ text: "Qu'est-ce qui attend ?" }));
  assert.deepEqual(first.choices, [
    { id: "1", label: "1. Mairie de Paris : recours FPS" },
    { id: "2", label: "2. Relance du notaire pour la promesse de vente du garage" },
    { id: "3", label: "3. Dossier assurance" },
  ]);
  assert.deepEqual(first.messages[1].choices, first.choices, "the reply carries them in the history message too");
  assert.equal(first.messages[0].choices, null);

  const history = await json(handleHistoryGet(new Request("http://127.0.0.1/api/chat/history")));
  assert.equal(history.messages[1].choices.length, 3);

  const second = await json(await post({ text: "Sélection : 1, 3" }));
  assert.equal(second.reply, "Je m'en occupe.");
  assert.equal("choices" in second, false, "a plain reply has no choices");
  assert.equal(seen[1]!.input, "Sélection : 1, 3");
  assert.deepEqual(
    listChatHistory(db, 10).map((m) => [m.role, m.channel, m.text, m.choices?.length ?? null]),
    [
      ["user", "desk", "Qu'est-ce qui attend ?", null],
      ["assistant", "desk", LIST, 3],
      ["user", "desk", "Sélection : 1, 3", null],
      ["assistant", "desk", "Je m'en occupe.", null],
    ],
  );
});

test("a task list of more than 12 items is a plain reply", async () => {
  const many = Array.from({ length: 13 }, (_, i) => `- [ ] ${i + 1}. Item ${i + 1}`).join("\n");
  const { post } = setup({ answer: () => ({ ok: true, text: many, costUsd: 0 }) });
  const body = await json(await post({ text: "Liste" }));
  assert.equal("choices" in body, false);
  assert.equal(body.messages[1].choices, null);
});

/** An Assistant on a fake Bot API, over the service of `setup`. */
async function telegramSetup(options: Parameters<typeof setup>[0] = {}, selections?: PendingSelections) {
  const base = setup(options);
  const fake = await startFakeTelegram("tok");
  fakes.push(fake);
  const assistant = new Assistant({
    telegram: new Telegram("tok", fake.url),
    chatId: "42",
    config: base.config,
    db: base.db,
    assistant: { ...EMPTY_ASSISTANT_CONFIG, chat: chatConfig({ cwd: base.config.home }) },
    extensions: [],
    env: { PATH: process.env.PATH },
    chatMaxBudgetUsd: 0.5,
    chatService: base.service,
    selections,
    log: () => undefined,
    typingIntervalMs: 20,
  });
  let updateId = 1;
  const say = async (text: string) => {
    await assistant.handleUpdate({
      update_id: updateId++,
      message: { message_id: updateId, chat: { id: 42, type: "private" }, from: { id: 42 }, date: 1, text },
    } as never);
    await assistant.idle();
  };
  const press = async (messageId: number, data: string, text = "ignored", wait = true) => {
    await assistant.handleUpdate({
      update_id: updateId++,
      callback_query: { id: `cb${updateId}`, from: { id: 42 }, message: { message_id: messageId, chat: { id: 42 }, text }, data },
    } as never);
    if (wait) await assistant.idle();
  };
  const edits = () => fake.calls.filter((c) => c.method === "editMessageText").map((c) => c.params);
  const answers = () => fake.calls.filter((c) => c.method === "answerCallbackQuery").map((c) => c.params.text ?? null);
  const labels = (params: Record<string, unknown>) =>
    ((params.reply_markup as { inline_keyboard: { text: string }[][] } | undefined)?.inline_keyboard ?? []).map((row) =>
      row.map((button) => button.text).join(" | "),
    );
  return { ...base, fake, assistant, say, press, edits, answers, labels };
}

test("Telegram: the reply comes with a keyboard, items toggle in place, Valider sends the selection through the chat", async () => {
  const { say, press, fake, edits, labels, seen, db } = await telegramSetup({
    answer: (_turn, n) => ({ ok: true, text: n === 1 ? LIST : "Je m'en occupe.", costUsd: 0 }),
  });
  await say("Qu'est-ce qui attend ?");
  const sent = fake.calls.filter((c) => c.method === "sendMessage");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.params.text, LIST, "the reply text goes out whole");
  assert.deepEqual(labels(sent[0]!.params), [
    "☐ 1. Mairie de Paris : recours FPS",
    "☐ 2. Relance du notaire pour la promess...",
    "☐ 3. Dossier assurance",
    "Valider la sélection | Annuler",
  ]);
  const id = 100;

  await press(id, "hq:s:0");
  await press(id, "hq:s:2");
  await press(id, "hq:s:2");
  await press(id, "hq:s:1");
  assert.equal(edits().length, 4);
  assert.deepEqual(edits().at(-1)!.message_id, id);
  assert.equal(edits().at(-1)!.text, LIST);
  assert.deepEqual(labels(edits().at(-1)!).slice(0, 3), [
    "☑ 1. Mairie de Paris : recours FPS",
    "☑ 2. Relance du notaire pour la promess...",
    "☐ 3. Dossier assurance",
  ]);
  assert.equal(seen.length, 1, "toggling does not reach the chat");

  await press(id, "hq:s:ok");
  const done = edits().at(-1)!;
  assert.equal(done.text, `${LIST}\n\nSélection : 1, 2 (envoyée)`);
  assert.equal("reply_markup" in done, false, "the keyboard is gone");
  assert.equal(seen.length, 2);
  assert.equal(seen[1]!.input, "Sélection : 1, 2", "as if the user had typed it");
  assert.equal(fake.sent().at(-1), "Je m'en occupe.");
  assert.deepEqual(
    listChatHistory(db, 10).map((m) => [m.role, m.channel, m.text]),
    [
      ["user", "telegram", "Qu'est-ce qui attend ?"],
      ["assistant", "telegram", LIST],
      ["user", "telegram", "Sélection : 1, 2"],
      ["assistant", "telegram", "Je m'en occupe."],
    ],
  );

  // The keyboard is used up: a late press says so and takes the buttons off.
  const before = edits().length;
  await press(id, "hq:s:ok", done.text as string);
  assert.equal(seen.length, 2);
  assert.equal(edits().length, before + 1);
});

test("Telegram: Valider with nothing ticked asks for a tick, Annuler drops the list without a turn", async () => {
  const { say, press, edits, answers, seen, fake } = await telegramSetup({ answer: () => ({ ok: true, text: LIST, costUsd: 0 }) });
  await say("Liste");
  await press(100, "hq:s:ok");
  assert.equal(answers().at(-1), "Rien n'est coché.");
  assert.equal(edits().length, 0);
  await press(100, "hq:s:1");
  await press(100, "hq:s:no");
  const last = edits().at(-1)!;
  assert.equal(last.text, `${LIST}\n\n(sélection annulée)`);
  assert.equal("reply_markup" in last, false);
  assert.equal(seen.length, 1, "nothing was sent to the chat");
  await press(100, "hq:s:ok");
  assert.equal(answers().at(-1), "Cette liste a expiré, demande-la moi de nouveau.");
  assert.equal(fake.sent().length, 1);
});

test("Telegram: the keyboard expires after the hour, and the list stays as text", async () => {
  const { say, press, edits, answers, seen } = await telegramSetup(
    { answer: () => ({ ok: true, text: LIST, costUsd: 0 }) },
    new PendingSelections(0),
  );
  await say("Liste");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await press(100, "hq:s:0", LIST);
  assert.equal(answers().at(-1), "Cette liste a expiré, demande-la moi de nouveau.");
  assert.equal(edits().length, 1);
  assert.equal(edits()[0]!.text, LIST);
  assert.equal("reply_markup" in edits()[0]!, false);
  await press(100, "hq:s:ok", LIST);
  assert.equal(seen.length, 1);
});

test("Telegram: a task list of more than 12 items gets no keyboard, a plain reply neither", async () => {
  const many = Array.from({ length: 13 }, (_, i) => `- [ ] ${i + 1}. Item ${i + 1}`).join("\n");
  const { say, fake } = await telegramSetup({ answer: (_turn, n) => ({ ok: true, text: n === 1 ? many : "Ok.", costUsd: 0 }) });
  await say("Liste");
  await say("Merci");
  const sent = fake.calls.filter((c) => c.method === "sendMessage");
  assert.equal(sent.length, 2);
  assert.ok(sent.every((c) => !("reply_markup" in c.params)));
});

test("Telegram: a selection sent while another message is being answered waits its turn", async () => {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const { say, press, seen, assistant, service } = await telegramSetup({
    answer: async (_turn, n) => {
      if (n === 2) await gate;
      return { ok: true, text: n === 1 ? LIST : `Réponse ${n}`, costUsd: 0 };
    },
  });
  await say("Liste");
  void say("Autre chose");
  await tick();
  await press(100, "hq:s:0", "ignored", false);
  await press(100, "hq:s:ok", "ignored", false);
  assert.equal(seen.length, 2, "the selection is queued behind the turn in progress");
  open();
  await assistant.idle();
  await service.idle();
  assert.equal(seen.length, 3);
  assert.equal(seen[2]!.input, "Sélection : 1");
});
