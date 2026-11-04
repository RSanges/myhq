import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { Assistant } from "../src/assistant/assistant";
import type { ChatOutcome, ChatRunner } from "../src/assistant/chat";
import { EMPTY_ASSISTANT_CONFIG, loadAssistantConfig, type ChatConfig } from "../src/assistant/home-config";
import { confirmationAnswer, isUntrustedTool } from "../src/assistant/actions";
import { corePreamble, fitPreamble, type PreambleConfig } from "../src/assistant/preamble";
import { HqError } from "../src/server/errors";
import { strings } from "../src/ui/strings";
import { PendingQuestions } from "../src/assistant/pending";
import { Telegram } from "../src/assistant/telegram";
import { chatTranscript, KEPT_MESSAGES, listChatHistory, recordBotMessage, recordChatMessage } from "../src/server/chat-history";
import type { HqConfig } from "../src/server/config";
import { getDbAt, type Db, type RunRow } from "../src/server/db";
import { notifyPendingApprovals } from "../src/server/notify";
import { loadHome, syncHome } from "../src/server/rooms";
import type { StartRunRequest } from "../src/server/runner";
import { startFakeTelegram } from "./fake-telegram";
import { chatConfig, makeHome } from "./helpers";

// The chat mechanisms of the core: meter, history, preamble and actions, with
// a fake engine (a ChatRunner) and a fake Bot API.

const TOKEN = "test-token";
const CHAT = "42";
const USAGE = { inputTokens: 3, outputTokens: 40, cacheCreationInputTokens: 1000, cacheReadInputTokens: 2000 };

let updateId = 1;
const message = (text: string) => ({
  update_id: updateId++,
  message: { message_id: updateId, chat: { id: Number(CHAT), type: "private" }, from: { id: Number(CHAT) }, date: 1, text },
});

type Seen = { args: string[]; input: string };

const fakes: { close(): Promise<void> }[] = [];
after(() => Promise.all(fakes.map((fake) => fake.close())));

async function setup(options: {
  chat?: Partial<ChatConfig>;
  answer?: (seen: Seen, n: number) => ChatOutcome | Promise<ChatOutcome>;
  config?: HqConfig;
  startRun?: (request: StartRunRequest) => RunRow;
  questions?: PendingQuestions;
  dropDir?: string;
}) {
  const config = options.config ?? makeHome();
  const db = getDbAt(config.dbPath);
  syncHome(db, loadHome(config.home));
  const fake = await startFakeTelegram(TOKEN);
  fakes.push(fake);
  const seen: Seen[] = [];
  const runChat: ChatRunner = async (params) => {
    const turn = { args: params.args, input: params.input };
    seen.push(turn);
    return options.answer
      ? options.answer(turn, seen.length)
      : { ok: true, text: `Réponse ${seen.length}`, costUsd: 0.01, usage: USAGE, tools: [], model: "claude-haiku-4-5" };
  };
  const logs: string[] = [];
  const assistant = new Assistant({
    telegram: new Telegram(TOKEN, fake.url),
    chatId: CHAT,
    config,
    db,
    assistant: {
      ...EMPTY_ASSISTANT_CONFIG,
      ...(options.dropDir ? { dropDir: options.dropDir } : {}),
      chat: chatConfig({ cwd: config.home, ...options.chat }),
    },
    extensions: [],
    env: { PATH: process.env.PATH },
    chatMaxBudgetUsd: 0.5,
    runChat,
    startRun: options.startRun,
    questions: options.questions,
    log: (m) => logs.push(m),
    typingIntervalMs: 20,
  });
  const say = async (text: string) => {
    await assistant.handleUpdate(message(text) as never);
    await assistant.idle();
  };
  return { config, db, fake, assistant, seen, logs, say };
}

function addApproval(db: Db, title = "Réponse à la mairie", type = "mail_reply", agent = "scout"): number {
  return Number(
    db
      .prepare(
        "INSERT INTO approvals (room, agent_id, type, title, body, status, created_at) VALUES ('demo', ?, ?, ?, 'body', 'pending', ?)",
      )
      .run(agent, type, title, new Date().toISOString()).lastInsertRowid,
  );
}

// --- C5: the meter ---------------------------------------------------------------

test("every chat turn is metered in chat_turns, answered or not, and /status gives the week", async () => {
  const { db, fake, say } = await setup({
    answer: (_seen, n) =>
      n === 1
        ? { ok: true, text: "Voilà.", costUsd: 0.03, usage: USAGE, tools: ["Read", "mcp__mail__mail_search"], model: "claude-haiku-4-5" }
        : { ok: false, reason: "budget", detail: "error_max_budget_usd", costUsd: 0.5 },
  });
  await say("Quoi de neuf ?");
  await say("Et encore ?");
  const rows = db.prepare("SELECT * FROM chat_turns ORDER BY id").all() as {
    engine: string;
    model: string;
    status: string;
    reason: string | null;
    cache_read_input_tokens: number;
    cost_usd: number;
    tool_calls: number;
  }[];
  assert.deepEqual(
    rows.map((r) => [r.engine, r.model, r.status, r.reason, r.cache_read_input_tokens, r.cost_usd, r.tool_calls]),
    [
      ["claude", "claude-haiku-4-5", "done", null, 2000, 0.03, 2],
      ["claude", "haiku", "failed", "budget", 0, 0.5, 0],
    ],
  );
  await say("/status");
  assert.ok(fake.sent().at(-1)!.includes("Conversation cette semaine : 2 message(s), 0,53"));
});

// --- C4: the conversation MyHQ keeps ----------------------------------------------

test("a fresh turn gets the transcript, a resumed one only what the bot sent since; /new clears it", async () => {
  const { db, seen, say } = await setup({});
  await say("Bonjour");
  assert.equal(seen[0]!.input, "Bonjour", "nothing to give on the first turn");
  assert.ok(seen[0]!.args.includes("--continue"));

  // The bot sends an alert on its own (notify.ts records it), then the user answers it.
  recordBotMessage(db, "MyHQ : un item attend ta validation (#3)", "alert");
  await say("oui vas-y");
  assert.ok(seen[1]!.args.includes("--continue"));
  assert.equal(
    seen[1]!.input,
    [
      "[Messages envoyés de ta part depuis notre dernier échange]",
      "Toi, message automatique (alerte) : MyHQ : un item attend ta validation (#3)",
      "[Fin de la conversation récente]",
      "",
      "oui vas-y",
    ].join("\n"),
  );

  assert.deepEqual(
    listChatHistory(db, 10).map((m) => [m.role, m.kind, m.text]),
    [
      ["user", null, "Bonjour"],
      ["assistant", null, "Réponse 1"],
      ["bot", "alert", "MyHQ : un item attend ta validation (#3)"],
      ["user", null, "oui vas-y"],
      ["assistant", null, "Réponse 2"],
    ],
  );

  await say("/new");
  assert.deepEqual(listChatHistory(db, 10), []);
  await say("On repart");
  assert.equal(seen[2]!.input, "On repart");
  assert.ok(!seen[2]!.args.includes("--continue"));
});

test("without --continue (resume: history), or when the CLI lost the conversation, the transcript is injected, capped", async () => {
  const { seen, say } = await setup({ chat: { resume: "history", historyTurns: 2 } });
  await say("Un");
  await say("Deux");
  await say("Trois");
  assert.ok(seen.every((turn) => !turn.args.includes("--continue")));
  assert.equal(
    seen[2]!.input,
    [
      "[Conversation récente, du plus ancien au plus récent]",
      "Utilisateur : Un",
      "Toi : Réponse 1",
      "Utilisateur : Deux",
      "Toi : Réponse 2",
      "[Fin de la conversation récente]",
      "",
      "Trois",
    ].join("\n"),
  );
  await say("Quatre");
  assert.match(seen[3]!.input, /^\[Conversation[^\n]*\]\nUtilisateur : Deux\n/, "two exchanges at most");

  // The CLI says there is nothing to continue: the retry carries the transcript.
  const lost = await setup({
    answer: (turn, n) =>
      turn.args.includes("--continue") && n > 1
        ? { ok: false, reason: "no_conversation", detail: "No conversation found to continue" }
        : { ok: true, text: `R${n}`, costUsd: 0 },
  });
  await lost.say("Premier");
  await lost.say("Second");
  assert.equal(lost.seen.length, 3);
  assert.equal(lost.seen[1]!.input, "Second");
  assert.match(lost.seen[2]!.input, /^\[Conversation récente[^\n]*\]\nUtilisateur : Premier\nToi : R1\n\[Fin/);
});

test("the transcript keeps the newest messages within its character cap", () => {
  const db = getDbAt(makeHome().dbPath);
  recordChatMessage(db, "user", "a".repeat(300));
  recordChatMessage(db, "assistant", "b".repeat(300));
  recordChatMessage(db, "user", "c".repeat(100));
  const text = chatTranscript(db, { turns: 12, maxChars: 300, since: "all" })!;
  assert.ok(text.length <= 300, `${text.length}`);
  assert.ok(text.includes("c".repeat(100)));
  assert.ok(!text.includes("aaaaaaaaaa"));
  const one = chatTranscript(db, { turns: 12, maxChars: 200, since: "all" })!;
  assert.ok(one.length <= 200);
  assert.equal(chatTranscript(db, { turns: 0, maxChars: 8000, since: "all" }), null);
  assert.equal(chatTranscript(db, { turns: 12, maxChars: 8000, since: "lastExchange" }), null);
});

test("GET /api/chat/history shape: the last messages, oldest first, never more than kept", () => {
  const db = getDbAt(makeHome().dbPath);
  for (let i = 0; i < KEPT_MESSAGES + 5; i++) recordChatMessage(db, i % 2 ? "assistant" : "user", `m${i}`);
  const count = (db.prepare("SELECT COUNT(*) AS n FROM chat_messages").get() as { n: number }).n;
  assert.equal(count, KEPT_MESSAGES);
  const last = listChatHistory(db, 2);
  assert.deepEqual(
    last.map((m) => [m.role, m.text]),
    [
      ["assistant", `m${KEPT_MESSAGES + 3}`],
      ["user", `m${KEPT_MESSAGES + 4}`],
    ],
  );
  assert.deepEqual(Object.keys(last[0]!).sort(), ["channel", "choices", "createdAt", "id", "kind", "role", "text", "to"]);
});

test("alerts the bot really sent go into the conversation, unsent ones do not", async () => {
  const db = getDbAt(makeHome().dbPath);
  addApproval(db, "Réponse au garage");
  await notifyPendingApprovals(db, async () => false);
  assert.deepEqual(listChatHistory(db, 10), []);
  addApproval(db, "Réponse à la mairie");
  await notifyPendingApprovals(db, async () => true);
  const [alert] = listChatHistory(db, 10);
  assert.equal(alert!.role, "bot");
  assert.equal(alert!.kind, "alert");
  assert.match(alert!.text, /Réponse à la mairie/);
});

// --- C1: the preamble --------------------------------------------------------------

const PREAMBLE: PreambleConfig = { fields: ["datetime", "pending", "runs"], command: null, file: null, maxChars: 600, timeoutMs: 3000 };

test("the preamble gives the date in HQ_TIMEZONE, the pending items (five, then a count) and today's runs", () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  syncHome(db, loadHome(config.home));
  const lines = () => corePreamble(db, config, PREAMBLE.fields, new Date("2026-11-03T13:05:00Z"));
  assert.deepEqual(lines(), [
    "Nous sommes le mardi 3 novembre 2026 à 14:05 (Europe/Paris).",
    "Rien n'attend de validation.",
    "Tours d'agents aujourd'hui : 0 sur 12.",
  ]);
  const first = addApproval(db, "Réponse à la mairie au sujet du justificatif de domicile demandé vendredi");
  for (let i = 0; i < 6; i++) addApproval(db, `Item ${i}`, "social_post");
  const [, title, item, ...rest] = lines();
  assert.equal(title, "À valider (7) :");
  assert.equal(item, `- n° ${first}, Scout, mail_reply : Réponse à la mairie au sujet du justificatif de...`);
  assert.equal(rest.length, 6, "four more items, the count of the rest, the runs");
  assert.equal(rest[4], "- et 2 autres");
});

test("the preamble stays under maxChars: the home's output is cut first, the core only when it alone does not fit", () => {
  const core = ["Nous sommes le mardi 3 novembre 2026 à 14:05 (Europe/Paris).", "Rien n'attend de validation."];
  const short = fitPreamble(core, "Agenda : dentiste à 14 h.", 600);
  assert.equal(
    short,
    [
      "[Contexte à cet instant, le plus récent fait foi]",
      ...core,
      "Agenda : dentiste à 14 h.",
      "[Fin du contexte]",
    ].join("\n"),
  );
  const long = fitPreamble(core, "x".repeat(2000), 600);
  assert.equal(long.length, 600);
  assert.ok(long.includes(core[1]!), "the core's facts are whole");
  assert.ok(long.endsWith("...\n[Fin du contexte]"));
  const tiny = fitPreamble(["y".repeat(500)], "z".repeat(100), 150);
  assert.ok(tiny.length <= 150);
  assert.ok(!tiny.includes("z"), "no room for the home's output");
});

test("each chat message is preceded by the preamble with the home's command output, cached for a minute", async () => {
  const config = makeHome();
  const counter = path.join(config.home, "count.txt");
  const script = path.join(config.home, "preamble.mjs");
  fs.writeFileSync(
    script,
    `import fs from "node:fs"; const f = ${JSON.stringify(counter)}; const n = fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8")) + 1 : 1; fs.writeFileSync(f, String(n)); console.log("Agenda : dentiste à 14 h (appel " + n + ").");`,
  );
  const { db, seen, say } = await setup({
    config,
    chat: { preamble: { ...PREAMBLE, command: `node preamble.mjs` } },
  });
  const id = addApproval(db, "Réponse à la mairie");
  await say("Qu'est-ce que j'ai aujourd'hui ?");
  const input = seen[0]!.input;
  assert.match(input, /^\[Contexte à cet instant, le plus récent fait foi\]\nNous sommes le /);
  assert.ok(input.includes(`- n° ${id}, Scout, mail_reply : Réponse à la mairie`));
  assert.ok(input.includes("Agenda : dentiste à 14 h (appel 1)."));
  assert.ok(input.endsWith("[Fin du contexte]\n\nQu'est-ce que j'ai aujourd'hui ?"));
  await say("Et demain ?");
  assert.ok(seen[1]!.input.includes("(appel 1)"), "the command ran once in the minute");
  assert.equal(fs.readFileSync(counter, "utf8"), "1");
  // The history keeps the user's own words, never the preamble.
  assert.equal(listChatHistory(db, 10)[0]!.text, "Qu'est-ce que j'ai aujourd'hui ?");
});

test("a preamble command that fails or runs too long leaves the core's facts, and the chat does not wait", async () => {
  const config = makeHome();
  fs.writeFileSync(path.join(config.home, "slow.mjs"), "setTimeout(() => console.log('late'), 2000);");
  const { seen, say, logs } = await setup({
    config,
    chat: { preamble: { ...PREAMBLE, command: "node slow.mjs", timeoutMs: 300 } },
  });
  const started = Date.now();
  await say("Salut");
  assert.ok(Date.now() - started < 3000);
  assert.ok(!seen[0]!.input.includes("late"));
  assert.match(seen[0]!.input, /Tours d'agents aujourd'hui/);
  assert.ok(logs.some((l) => /preamble command timed out/.test(l)));

  const failing = await setup({ chat: { preamble: { ...PREAMBLE, fields: ["runs"], command: "node -e process.exit(3)" } } });
  await failing.say("Salut");
  assert.equal(
    failing.seen[0]!.input,
    "[Contexte à cet instant, le plus récent fait foi]\nTours d'agents aujourd'hui : 0 sur 12.\n[Fin du contexte]\n\nSalut",
  );
});

test("assistant.json: chat.preamble is validated, command or file", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-assistant-"));
  const write = (preamble: unknown) =>
    fs.writeFileSync(path.join(home, "assistant.json"), JSON.stringify({ chat: { cwd: "chat", preamble } }));
  write({ command: "npx tsx assistant/chat/preamble.ts" });
  assert.deepEqual(loadAssistantConfig(home).chat!.preamble, {
    fields: ["datetime", "lastExchange", "pending", "runs"],
    command: "npx tsx assistant/chat/preamble.ts",
    file: null,
    maxChars: 600,
    timeoutMs: 3000,
  });
  write({ fields: ["datetime"], file: "data/assistant/preamble.txt", maxChars: 400, timeoutSeconds: 1 });
  assert.equal(loadAssistantConfig(home).chat!.preamble!.file, path.join(home, "data", "assistant", "preamble.txt"));
  write({ command: "x", file: "y" });
  assert.throws(() => loadAssistantConfig(home), /command or file/);
  write({ fields: ["weather"] });
  assert.throws(() => loadAssistantConfig(home), /chat\.preamble\.fields/);
  fs.writeFileSync(path.join(home, "assistant.json"), JSON.stringify({ chat: { cwd: "chat" } }));
  assert.equal(loadAssistantConfig(home).chat!.preamble, null, "no preamble unless asked");
});

// --- C2: actions on the HQ from the chat, and the confirmation guard -----------------

const ALL_ACTIONS = ["approve", "reject", "revise", "run", "arm", "disarm"] as const;

/** A chat whose turn writes the given action files, then answers having called `tools`. */
async function actionChat(options: {
  files: (n: number) => Record<string, unknown>[];
  tools: (n: number) => string[] | undefined;
  chat?: Partial<ChatConfig>;
  config?: HqConfig;
  startRun?: (request: StartRunRequest) => RunRow;
  questions?: PendingQuestions;
  dropDir?: string;
}) {
  const config = options.config ?? makeHome();
  const requestsDir = path.join(config.home, "chat", "requests");
  const ctx = await setup({
    config,
    startRun: options.startRun,
    questions: options.questions,
    dropDir: options.dropDir,
    chat: {
      requestsDir,
      actions: [...ALL_ACTIONS],
      mcpServers: { mail: { command: "node" }, rom2: { command: "node" } },
      trustedServers: ["rom2"],
      ...options.chat,
    },
    answer: (_seen, n) => {
      fs.mkdirSync(requestsDir, { recursive: true });
      options.files(n).forEach((file, i) =>
        fs.writeFileSync(path.join(requestsDir, `act-${n}-${i}.json`), JSON.stringify(file)),
      );
      const tools = options.tools(n);
      return { ok: true, text: `Réponse ${n}`, costUsd: 0, ...(tools ? { tools } : {}) };
    },
  });
  return { ...ctx, requestsDir };
}

const status = (db: Db, id: number) =>
  (db.prepare("SELECT status FROM approvals WHERE id = ?").get(id) as { status: string }).status;

test("an action asked by a turn that read nothing untrusted is executed at once, its line closing the reply", async () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const id = Number(
    db
      .prepare(
        "INSERT INTO approvals (room, agent_id, type, title, body, payload, status, created_at) VALUES ('demo', 'scout', 'community_reply', 'Reply', 'The reply.', ?, 'pending', ?)",
      )
      .run(JSON.stringify({ url: "https://example.com/t/1" }), new Date().toISOString()).lastInsertRowid,
  );
  const rejectMe = addApproval(db, "Garage");
  const { fake, requestsDir, say } = await actionChat({
    config,
    files: () => [
      { action: "approve", id },
      { action: "reject", approvalId: rejectMe, note: "Pas maintenant." },
    ],
    tools: () => ["Read", "mcp__rom2__rom2_act"],
  });
  await say("Approuve la réponse et refuse le garage");
  assert.equal(status(db, id), "approved");
  assert.equal(status(db, rejectMe), "rejected");
  // The reply, then the core's lines, then the hand-over of the approved item, as a button does.
  assert.deepEqual(fake.sent(), [
    `Réponse 1\n\nItem #${id} : Approuvé.\nItem #${rejectMe} : Refusé.`,
    "The reply.",
    "https://example.com/t/1",
  ]);
  assert.deepEqual(fs.readdirSync(requestsDir), []);
  // The history keeps what the user read.
  assert.match(listChatHistory(db, 5).at(-1)!.text, /Item #\d+ : Refusé\.$/);
});

test("a turn that read a mail holds its actions until the user says oui", async () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const id = addApproval(db);
  const { fake, seen, say, logs } = await actionChat({
    config,
    files: (n) => (n === 1 ? [{ action: "approve", id }] : []),
    tools: (n) => (n === 1 ? ["mcp__mail__mail_search", "mcp__rom2__rom2_act"] : []),
  });
  await say("Approuve le brouillon pour la mairie");
  assert.equal(status(db, id), "pending", "nothing happens before the yes");
  assert.match(fake.sent()[0]!, /^Réponse 1\n\nCette réponse s'appuie sur du courrier ou du web/);
  assert.ok(fake.sent()[0]!.includes(`approuver l'item #${id}`));
  assert.ok(logs.some((l) => /held for confirmation \(untrusted: mcp__mail__mail_search\)/.test(l)));

  await say("Oui !");
  assert.equal(status(db, id), "approved");
  assert.equal(fake.sent().at(-1), `Item #${id} : Approuvé.`);
  assert.equal(seen.length, 1, "the yes is not a chat turn");

  // A second yes has nothing left to confirm: it goes to the chat.
  await say("oui");
  assert.equal(seen.length, 2);
});

test("non drops the held actions, another message drops them too and goes on, and they expire after an hour", async () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const id = addApproval(db);
  const web = await actionChat({
    config,
    files: (n) => (n <= 2 ? [{ action: "approve", id }] : []),
    tools: () => ["WebFetch"],
  });
  await web.say("Approuve");
  await web.say("non");
  assert.equal(status(db, id), "pending");
  assert.equal(web.fake.sent().at(-1), "D'accord, je n'en fais rien.");
  await web.say("Approuve encore");
  await web.say("Attends, qui l'a écrit ?");
  assert.equal(status(db, id), "pending");
  assert.ok(web.fake.sent().includes("Je laisse tomber les actions qui attendaient ton accord."));
  assert.equal(web.seen.length, 3, "the other message went to the chat");

  const late = await actionChat({
    config,
    questions: new PendingQuestions(0),
    files: (n) => (n === 1 ? [{ action: "approve", id }] : []),
    tools: () => undefined, // A runner that does not say which tools it called is not trusted.
  });
  await late.say("Approuve");
  await new Promise((r) => setTimeout(r, 5));
  await late.say("oui");
  assert.equal(status(db, id), "pending");
  assert.ok(late.fake.sent().includes("Les actions qui attendaient ton accord datent de plus d'une heure, je les ai abandonnées."));
});

test("run, arm and disarm go through the same lock, cap and errors; the room may be left out for a unique agent", async () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const requests: StartRunRequest[] = [];
  let busy = false;
  const decided = addApproval(db);
  db.prepare("UPDATE approvals SET status = 'approved' WHERE id = ?").run(decided);
  const { fake, say } = await actionChat({
    config,
    files: () => [
      { action: "run", agent: "scout", task: "Lance la veille." },
      { action: "run", room: "demo", agent: "scout" },
      { action: "disarm", agent: "scout" },
      { action: "arm", room: "demo", agent: "scout" },
      { action: "run", agent: "ghost" },
      { action: "approve", id: decided },
      { action: "approve", id: 999 },
    ],
    tools: () => [],
    startRun: (request) => {
      requests.push(request);
      if (busy) throw new HqError("AGENT_BUSY", 409, "busy");
      busy = true;
      return { id: 7, room: request.room, agent_id: request.agent } as RunRow;
    },
  });
  await say("Lance la veille");
  assert.deepEqual(requests, [
    { room: "demo", agent: "scout", task: "Lance la veille.", reason: "chat" },
    { room: "demo", agent: "scout", reason: "chat" },
  ]);
  const armed = (db.prepare("SELECT armed FROM agents WHERE room = 'demo' AND id = 'scout'").get() as { armed: number }).armed;
  assert.equal(armed, 1);
  const lines = fake.sent()[0]!.split("\n\n")[1]!.split("\n");
  assert.deepEqual(lines, [
    "Tour #7 lancé pour demo / scout.",
    `Je n'ai pas pu lancer un tour de demo / scout : ${strings.errors.byCode.AGENT_BUSY}`,
    "Routines de demo / scout désarmées.",
    "Routines de demo / scout armées.",
    "Je n'ai pas pu lancer un tour de ghost : je ne connais aucun agent « ghost ».",
    `Je n'ai pas pu approuver l'item #${decided} : ${strings.errors.byCode.APPROVAL_ALREADY_DECIDED}`,
    `Je n'ai pas pu approuver l'item #999 : ${strings.errors.byCode.APPROVAL_NOT_FOUND}`,
  ]);
});

test("actions outside the whitelist or malformed are refused with a line, requests to agents are left alone, a failed turn drops its actions", async () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const id = addApproval(db);
  const { fake, requestsDir, say, logs } = await actionChat({
    config,
    chat: { actions: ["run"] },
    files: () => [{ action: "approve", id }, { action: "reject", id }, { action: "explode" }],
    tools: () => [],
  });
  await say("Approuve");
  assert.equal(status(db, id), "pending");
  const [, lines] = fake.sent()[0]!.split("\n\n");
  assert.deepEqual(lines!.split("\n"), [
    "L'action « approve » ne m'est pas permise ici, je l'ai écartée.",
    "Une action demandée était mal formée, je l'ai écartée (détail dans le journal).",
    "Une action demandée était mal formée, je l'ai écartée (détail dans le journal).",
  ]);
  assert.equal(fs.readdirSync(path.join(requestsDir, "rejected")).length, 3);
  assert.ok(logs.some((l) => /reject needs a note/.test(l)));

  const failing = await setup({
    config,
    chat: { requestsDir, actions: [...ALL_ACTIONS] },
    answer: () => {
      fs.writeFileSync(path.join(requestsDir, "a.json"), JSON.stringify({ action: "approve", id }));
      fs.writeFileSync(path.join(requestsDir, "b.json"), JSON.stringify({ room: "demo", agent: "scout", task: "Later." }));
      return { ok: false, reason: "budget", detail: "error_max_budget_usd" };
    },
  });
  await failing.say("Approuve");
  assert.equal(status(db, id), "pending");
  assert.deepEqual(
    fs.readdirSync(requestsDir).filter((name) => name.endsWith(".json")),
    ["b.json"],
    "the request to an agent waits as before",
  );
});

test("which tools are untrusted: web tools, chat.untrustedTools, and every server not marked untrusted: false", () => {
  const chat = { mcpServers: { mail: { command: "n" }, rom2: { command: "n" } }, trustedServers: ["rom2"], untrustedTools: ["mcp__rom2__rom2_fetch*", "Read"] };
  assert.equal(isUntrustedTool("WebFetch", chat), true);
  assert.equal(isUntrustedTool("WebSearch", chat), true);
  assert.equal(isUntrustedTool("mcp__mail__mail_search", chat), true);
  assert.equal(isUntrustedTool("mcp__other__x", chat), true, "an unknown server is untrusted");
  assert.equal(isUntrustedTool("mcp__rom2__rom2_act", chat), false);
  assert.equal(isUntrustedTool("mcp__rom2__rom2_fetch_page", chat), true);
  assert.equal(isUntrustedTool("Read", chat), true);
  assert.equal(isUntrustedTool("Grep", chat), false);
  assert.equal(confirmationAnswer("  Vas-y. "), "yes");
  assert.equal(confirmationAnswer("OK"), "yes");
  assert.equal(confirmationAnswer("Non!"), "no");
  assert.equal(confirmationAnswer("oui mais attends"), null);
});

test("assistant.json: actions whitelist, untrusted flags kept out of the MCP config, untrustedTools", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-assistant-"));
  const write = (chat: unknown) =>
    fs.writeFileSync(path.join(home, "assistant.json"), JSON.stringify({ chat: { cwd: "chat", ...(chat as object) } }));
  write({
    mcpServers: { courrier: { command: "node" }, rom2: { command: "node", untrusted: false }, agenda: { command: "node", untrusted: true } },
    requests: { dir: "chat/requests", actions: ["approve", "run"] },
    untrustedTools: ["mcp__agenda__*"],
  });
  const chat = loadAssistantConfig(home).chat!;
  assert.deepEqual(chat.actions, ["approve", "run"]);
  assert.deepEqual(chat.trustedServers, ["rom2"]);
  assert.deepEqual(chat.untrustedTools, ["mcp__agenda__*"]);
  assert.deepEqual(chat.mcpServers.rom2, { command: "node" }, "the flag is MyHQ's, not the CLI's");
  write({ requests: { dir: "chat/requests" } });
  assert.deepEqual(loadAssistantConfig(home).chat!.actions, [], "no action unless whitelisted");
  write({ requests: { dir: "r", actions: ["delete"] } });
  assert.throws(() => loadAssistantConfig(home), /chat\.requests\.actions/);
  write({ mcpServers: { rom2: { command: "node", untrusted: "no" } } });
  assert.throws(() => loadAssistantConfig(home), /chat\.mcpServers\.rom2\.untrusted/);
});

// --- A captioned photo or document is a request of the owner ----------------------------

const fileMessage = (extra: Record<string, unknown>) => ({
  update_id: updateId++,
  message: { message_id: updateId, chat: { id: Number(CHAT), type: "private" }, from: { id: Number(CHAT) }, date: 1, ...extra },
});
const photoMessage = (caption?: string) =>
  fileMessage({ photo: [{ file_id: "big", width: 1280, height: 853 }], ...(caption ? { caption } : {}) });
const documentMessage = (caption?: string) =>
  fileMessage({ document: { file_id: "doc", file_name: "Invitation.pdf" }, ...(caption ? { caption } : {}) });

const addDirsOf = (args: string[]) => args.flatMap((arg, i) => (args[i - 1] === "--add-dir" ? [arg] : []));

test("a photo with a caption starts a chat turn with the stored file's path, and the exchange is kept", async () => {
  const config = makeHome();
  const dropDir = path.join(config.home, "inbox");
  const { db, fake, seen, assistant } = await setup({ config, dropDir });
  fake.addFile("big", "JPEGDATA");
  await assistant.handleUpdate(photoMessage("Ajoute au calendrier") as never);
  await assistant.idle();
  const [photo] = fs.readdirSync(dropDir).filter((f) => f.endsWith(".jpg"));
  assert.equal(seen.length, 1);
  const input = seen[0]!.input;
  assert.ok(input.startsWith("Ajoute au calendrier\n\n[Pièce jointe (photo) reçue sur Telegram : "), input);
  assert.ok(input.includes(path.join(dropDir, photo!)), "the stored file's path");
  assert.ok(input.includes("outil Read"));
  assert.match(fake.sent()[0]!, /^Reçu : Photo .*\.jpg\. Déposé dans inbox\.$/);
  assert.equal(fake.sent()[1], "Réponse 1");
  const history = listChatHistory(db, 5);
  assert.deepEqual(history.map((m) => m.role), ["user", "assistant"]);
  assert.ok(history[0]!.text.includes(path.join(dropDir, photo!)));
  assert.equal(history[1]!.text, "Réponse 1");
});

test("the drop folder is made readable for that turn unless the chat already covers it", async () => {
  const outsideDir = path.join(os.tmpdir(), "myhq-drop-outside");
  const outside = await setup({ dropDir: outsideDir });
  outside.fake.addFile("big", "JPEGDATA");
  await outside.assistant.handleUpdate(photoMessage("Ajoute au calendrier") as never);
  await outside.assistant.idle();
  assert.deepEqual(addDirsOf(outside.seen[0]!.args), [outsideDir]);
  // A plain message does not widen the chat's reach.
  await outside.say("Bonjour");
  assert.deepEqual(addDirsOf(outside.seen[1]!.args), []);
  fs.rmSync(outsideDir, { recursive: true, force: true });

  const config = makeHome();
  const vault = path.join(config.home, "vault");
  const covered = await setup({ config, dropDir: path.join(vault, "inbox"), chat: { addDirs: [vault] } });
  covered.fake.addFile("big", "JPEGDATA");
  await covered.assistant.handleUpdate(photoMessage("Ajoute au calendrier") as never);
  await covered.assistant.idle();
  assert.deepEqual(addDirsOf(covered.seen[0]!.args), [vault], "inside an addDir: nothing added");

  const home = makeHome();
  const inCwd = await setup({ config: home, dropDir: path.join(home.home, "inbox") });
  inCwd.fake.addFile("big", "JPEGDATA");
  await inCwd.assistant.handleUpdate(photoMessage("Ajoute au calendrier") as never);
  await inCwd.assistant.idle();
  assert.deepEqual(addDirsOf(inCwd.seen[0]!.args), [], "inside the working folder: nothing added");
});

test("a photo without a caption is filed and acknowledged, no turn starts", async () => {
  const config = makeHome();
  const dropDir = path.join(config.home, "inbox");
  const { db, fake, seen, assistant } = await setup({ config, dropDir });
  fake.addFile("big", "JPEGDATA");
  await assistant.handleUpdate(photoMessage() as never);
  await assistant.idle();
  assert.equal(seen.length, 0);
  assert.equal(fake.sent().length, 1);
  assert.match(fake.sent()[0]!, /^Reçu : Photo /);
  assert.deepEqual(fs.readdirSync(dropDir).map((f) => path.extname(f)), [".jpg"], "no note without a caption");
  assert.deepEqual(listChatHistory(db, 5), []);
});

test("a document with a caption starts a turn too", async () => {
  const config = makeHome();
  const dropDir = path.join(config.home, "inbox");
  const { fake, seen, assistant } = await setup({ config, dropDir });
  fake.addFile("doc", "%PDF");
  await assistant.handleUpdate(documentMessage("Résume ce PDF") as never);
  await assistant.idle();
  assert.equal(seen.length, 1);
  assert.ok(seen[0]!.input.startsWith("Résume ce PDF\n\n[Pièce jointe (document) reçue sur Telegram : "));
  assert.ok(seen[0]!.input.includes(path.join(dropDir, "Invitation.pdf")));
  assert.equal(fs.readFileSync(path.join(dropDir, "Invitation.pdf"), "utf8"), "%PDF");
  assert.deepEqual(fake.sent(), ["Reçu : Invitation.pdf. Déposé dans inbox.", "Réponse 1"]);
});

test("a file that cannot be stored never reaches the chat", async () => {
  const config = makeHome();
  const { fake, seen, assistant } = await setup({ config, dropDir: path.join(config.home, "inbox") });
  // No file "big" on the fake Bot API: the download fails.
  await assistant.handleUpdate(photoMessage("Ajoute au calendrier") as never);
  await assistant.idle();
  assert.equal(seen.length, 0);
  assert.deepEqual(fake.sent(), [strings.assistant.files.failed]);
});

test("actions that follow a read in a file turn are held for a yes, a turn that read nothing runs them at once", async () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const first = addApproval(db);
  const second = addApproval(db, "Garage");
  // Turn 1 reads the photo then asks for an approval; turn 2 asks for one without reading anything.
  const { fake, seen, assistant, logs } = await actionChat({
    config,
    dropDir: path.join(config.home, "inbox"),
    files: (n) => [{ action: "approve", id: n === 1 ? first : second }],
    tools: (n) => (n === 1 ? ["Read", "mcp__rom2__rom2_act"] : ["mcp__rom2__rom2_act"]),
  });
  fake.addFile("big", "JPEGDATA");
  await assistant.handleUpdate(photoMessage("Approuve ce qui est demandé") as never);
  await assistant.idle();
  assert.equal(status(db, first), "pending", "nothing happens before the yes");
  assert.match(fake.sent()[1]!, /^Réponse 1\n\nCette réponse s'appuie sur du courrier ou du web/);
  assert.ok(logs.some((l) => /held for confirmation \(untrusted: Read\)/.test(l)));

  await assistant.handleUpdate(message("Oui") as never);
  await assistant.idle();
  assert.equal(status(db, first), "approved");
  assert.equal(seen.length, 1, "the yes is not a chat turn");

  await assistant.handleUpdate(photoMessage("Approuve le garage") as never);
  await assistant.idle();
  assert.equal(status(db, second), "approved", "no Read, no hold");
});

test("a Read outside of a file message does not hold actions; a captioned file is not a yes and drops held ones", async () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const id = addApproval(db);
  const second = addApproval(db, "Garage");
  const { fake, seen, assistant, say } = await actionChat({
    config,
    dropDir: path.join(config.home, "inbox"),
    files: (n) => (n === 1 ? [{ action: "approve", id }] : n === 3 ? [{ action: "approve", id: second }] : []),
    tools: (n) => (n === 1 ? ["mcp__mail__mail_search", "mcp__rom2__rom2_act"] : n === 3 ? ["Read", "mcp__rom2__rom2_act"] : []),
  });
  await say("Approuve le brouillon");
  assert.equal(status(db, id), "pending");
  fake.addFile("big", "JPEGDATA");
  await assistant.handleUpdate(photoMessage("Oui") as never);
  await assistant.idle();
  assert.equal(status(db, id), "pending", "a caption saying oui is not the yes");
  assert.equal(seen.length, 2, "the caption went to the chat");
  assert.ok(fake.sent().includes(strings.assistant.actions.dropped));

  // A plain text turn that reads a file of the vault is not held by this rule (Read alone is trusted).
  await say("Approuve le garage");
  assert.equal(status(db, second), "approved");
});
