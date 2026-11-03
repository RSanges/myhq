import assert from "node:assert/strict";
import { test } from "node:test";
import { Assistant } from "../src/assistant/assistant";
import type { ChatOutcome, ChatRunner } from "../src/assistant/chat";
import { EMPTY_ASSISTANT_CONFIG, type ChatConfig } from "../src/assistant/home-config";
import { PendingQuestions } from "../src/assistant/pending";
import { Telegram } from "../src/assistant/telegram";
import type { HqConfig } from "../src/server/config";
import { getDbAt, type Db, type RunRow } from "../src/server/db";
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
  await fake.close();
});
