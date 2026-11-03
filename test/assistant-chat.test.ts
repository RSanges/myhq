import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Assistant } from "../src/assistant/assistant";
import type { ChatOutcome, ChatRunner } from "../src/assistant/chat";
import { EMPTY_ASSISTANT_CONFIG, type ChatConfig } from "../src/assistant/home-config";
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
    assistant: { ...EMPTY_ASSISTANT_CONFIG, chat: chatConfig({ cwd: config.home, ...options.chat }) },
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
  assert.deepEqual(Object.keys(last[0]!).sort(), ["createdAt", "id", "kind", "role", "text"]);
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
