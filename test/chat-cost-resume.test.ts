import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseChatOutput, type ChatOutcome, type ChatRunner } from "../src/assistant/chat";
import { chatTurnCost, readCostLedger, writeCostLedger } from "../src/assistant/chat-cost";
import { shouldResumeCli } from "../src/assistant/chat-resume";
import { ChatService } from "../src/assistant/chat-service";
import { getDbAt } from "../src/server/db";
import { ZERO_USAGE, type Usage } from "../src/server/engine";
import { recordChatMessage } from "../src/server/chat-history";
import { lastChatTurnEnd, recordChatTurn } from "../src/server/usage";
import { chatConfig, makeHome } from "./helpers";

// The chat meter (the cost of the turn alone) and the choice between resuming
// the CLI's conversation and starting a new one after a pause.

const usage = (inputTokens: number, outputTokens: number, cacheCreationInputTokens: number, cacheReadInputTokens: number): Usage => ({
  inputTokens,
  outputTokens,
  cacheCreationInputTokens,
  cacheReadInputTokens,
});

// --- The cost of a turn ------------------------------------------------------------

// Figures measured on `claude -p --continue` (CLI 2.1.318, three turns of one session):
// the result's total_cost_usd and modelUsage add up the session, usage is the turn's own.
const TURN1 = { reported: 0.00081689, usage: usage(2, 136, 3711, 649), session: usage(2, 136, 3711, 649) };
const TURN2 = { reported: 0.31570139, usage: usage(2, 3, 314876, 0), session: usage(4, 139, 318587, 649) };
const TURN3 = { reported: 0.33428379, usage: usage(2, 3, 2894, 313598), session: usage(6, 142, 321481, 314247) };

test("the first turn of a session costs what the CLI reports", () => {
  const cost = chatTurnCost({
    reportedUsd: TURN1.reported,
    usage: TURN1.usage,
    sessionUsage: TURN1.session,
    continued: false,
    previousReportedUsd: null,
  });
  assert.deepEqual(cost, { costUsd: TURN1.reported, method: "reported" });
});

test("a resumed turn costs the difference with the total the previous turn reported", () => {
  const second = chatTurnCost({
    reportedUsd: TURN2.reported,
    usage: TURN2.usage,
    sessionUsage: TURN2.session,
    continued: true,
    previousReportedUsd: TURN1.reported,
  });
  assert.equal(second.method, "delta");
  assert.ok(Math.abs(second.costUsd - 0.3148845) < 1e-9);
  const third = chatTurnCost({
    reportedUsd: TURN3.reported,
    usage: TURN3.usage,
    sessionUsage: TURN3.session,
    continued: true,
    previousReportedUsd: TURN2.reported,
  });
  assert.equal(third.method, "delta");
  assert.ok(Math.abs(third.costUsd - 0.0185824) < 1e-9);
});

test("the audited case: a turn after a 13 hour pause reported 0.70 USD, its own tokens are worth 0.30", () => {
  // chat_turns rows 18 and 19 of the audited week (Sonnet 5.5): 74,977 tokens written, nothing read.
  const cost = chatTurnCost({
    reportedUsd: 0.7015699,
    usage: usage(2, 82, 74977, 0),
    sessionUsage: usage(30, 6000, 190000, 600000),
    continued: true,
    previousReportedUsd: 0.4008379,
  });
  assert.equal(cost.method, "delta");
  assert.ok(Math.abs(cost.costUsd - 0.300732) < 1e-9);
  // Sonnet 5.5 prices: 2 USD per million input tokens, 10 output, 4 for a write, 0.10 for a read.
  assert.ok(Math.abs(cost.costUsd - (2 * 2 + 82 * 10 + 74977 * 4) / 1e6) < 1e-9);
});

test("a CLI that reports the turn alone (session tokens equal to the turn's) is left as is", () => {
  const cost = chatTurnCost({
    reportedUsd: 0.157,
    usage: usage(7, 1639, 20126, 37889),
    sessionUsage: usage(7, 1639, 20126, 37889),
    continued: true,
    previousReportedUsd: 0.0066,
  });
  assert.deepEqual(cost, { costUsd: 0.157, method: "reported" });
});

test("a new conversation is never corrected, whatever the ledger says", () => {
  const cost = chatTurnCost({
    reportedUsd: 0.08,
    usage: usage(2, 40, 19000, 0),
    sessionUsage: usage(2, 40, 19000, 0),
    continued: false,
    previousReportedUsd: 0.5,
  });
  assert.deepEqual(cost, { costUsd: 0.08, method: "reported" });
});

test("without the previous total, the turn's cost is estimated from its share of the session's tokens", () => {
  const cost = chatTurnCost({
    reportedUsd: TURN3.reported,
    usage: TURN3.usage,
    sessionUsage: TURN3.session,
    continued: true,
    previousReportedUsd: null,
  });
  assert.equal(cost.method, "estimated");
  assert.ok(Math.abs(cost.costUsd - 0.0185824) / 0.0185824 < 0.05, `estimate ${cost.costUsd} is within 5 % of the exact figure`);
  // A previous total above the new one means the session was reset: same estimate, never negative.
  const reset = chatTurnCost({
    reportedUsd: TURN3.reported,
    usage: TURN3.usage,
    sessionUsage: TURN3.session,
    continued: true,
    previousReportedUsd: 5,
  });
  assert.equal(reset.method, "estimated");
  assert.ok(reset.costUsd > 0 && reset.costUsd <= TURN3.reported);
});

test("the ledger keeps the last reported total, and a missing or damaged file gives none", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-ledger-"));
  const file = path.join(dir, "sub", "cost-ledger.json");
  assert.equal(readCostLedger(file), null);
  writeCostLedger(file, 0.42);
  assert.equal(readCostLedger(file), 0.42);
  fs.writeFileSync(file, "{not json");
  assert.equal(readCostLedger(file), null);
  fs.writeFileSync(file, JSON.stringify({ reportedUsd: "a lot" }));
  assert.equal(readCostLedger(file), null);
});

test("the result's modelUsage is read as the tokens of the whole session", () => {
  const result = {
    type: "result",
    subtype: "success",
    result: "ok",
    total_cost_usd: 0.33,
    usage: { input_tokens: 2, output_tokens: 3, cache_creation_input_tokens: 2894, cache_read_input_tokens: 313598 },
    modelUsage: {
      "claude-sonnet-5-5": { inputTokens: 4, outputTokens: 100, cacheReadInputTokens: 300000, cacheCreationInputTokens: 300000, costUSD: 0.3 },
      "claude-haiku-5-5": { inputTokens: 2, outputTokens: 42, cacheReadInputTokens: 14247, cacheCreationInputTokens: 21481 },
    },
  };
  const outcome = parseChatOutput(0, JSON.stringify(result), "");
  assert.ok(outcome.ok);
  assert.deepEqual(outcome.usage, usage(2, 3, 2894, 313598));
  assert.deepEqual(outcome.sessionUsage, usage(6, 142, 321481, 314247));
  assert.equal(outcome.costUsd, 0.33);
  // An older CLI gives no modelUsage.
  const old = parseChatOutput(0, JSON.stringify({ ...result, modelUsage: undefined }), "");
  assert.ok(old.ok);
  assert.equal(old.sessionUsage, undefined);
});

// --- Resume or start over ----------------------------------------------------------

const NOW = Date.parse("2026-11-06T15:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const decide = (over: Partial<Parameters<typeof shouldResumeCli>[0]> = {}) =>
  shouldResumeCli({ mode: "cli", conversationAlive: true, lastTurnEndedAt: ago(5), nowMs: NOW, freshAfterMinutes: 60, ...over });

test("the CLI's conversation is resumed inside the hour and started over after it", () => {
  assert.equal(decide(), true);
  assert.equal(decide({ lastTurnEndedAt: ago(60) }), true, "exactly at the limit still resumes");
  assert.equal(decide({ lastTurnEndedAt: ago(61) }), false);
  assert.equal(decide({ lastTurnEndedAt: ago(13 * 60) }), false);
  assert.equal(decide({ lastTurnEndedAt: ago(61), freshAfterMinutes: 180 }), true, "the limit is a setting");
  assert.equal(decide({ lastTurnEndedAt: ago(200), freshAfterMinutes: 180 }), false);
});

test("nothing to compare with, or nothing to resume: the usual rules", () => {
  assert.equal(decide({ lastTurnEndedAt: null }), true, "the first turn ever tries --continue, the CLI answers if there is none");
  assert.equal(decide({ lastTurnEndedAt: "not a date" }), true);
  assert.equal(decide({ mode: "history" }), false);
  assert.equal(decide({ conversationAlive: false }), false);
});

// --- Through the service ----------------------------------------------------------------

function service(runChat: ChatRunner) {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const logs: string[] = [];
  const chatService = new ChatService({
    config,
    db,
    chat: chatConfig({ cwd: config.home }),
    env: { PATH: process.env.PATH },
    chatMaxBudgetUsd: 0.5,
    runChat,
    log: (m) => logs.push(m),
  });
  return { config, db, logs, chatService };
}

const turnRows = (db: ReturnType<typeof getDbAt>) =>
  (db.prepare("SELECT cost_usd FROM chat_turns ORDER BY id").all() as { cost_usd: number }[]).map((r) => r.cost_usd);

test("a resumed conversation is metered turn by turn, not by the running total the CLI reports", async () => {
  // What a resumed session reports: the cost and the tokens of everything so far.
  const reports: ChatOutcome[] = [
    { ok: true, text: "un", costUsd: 0.2, usage: usage(2, 100, 19000, 0), sessionUsage: usage(2, 100, 19000, 0), tools: [] },
    { ok: true, text: "deux", costUsd: 0.22, usage: usage(2, 100, 500, 19000), sessionUsage: usage(4, 200, 19500, 19000), tools: [] },
    { ok: true, text: "trois", costUsd: 0.25, usage: usage(2, 100, 800, 19500), sessionUsage: usage(6, 300, 20300, 38500), tools: [] },
  ];
  const seen: string[][] = [];
  const { db, logs, chatService } = service(async (params) => {
    seen.push(params.args);
    return reports[seen.length - 1]!;
  });
  for (const text of ["a", "b", "c"]) await chatService.ask(text, "desk");
  assert.ok(seen[1]!.includes("--continue") && seen[2]!.includes("--continue"));
  const costs = turnRows(db);
  assert.equal(costs.length, 3);
  assert.ok(Math.abs(costs[0]! - 0.2) < 1e-9);
  assert.ok(Math.abs(costs[1]! - 0.02) < 1e-9);
  assert.ok(Math.abs(costs[2]! - 0.03) < 1e-9);
  assert.ok(logs.some((l) => l.includes("delta")));
});

test("the baseline survives a restart of the service", async () => {
  const reports: ChatOutcome[] = [
    { ok: true, text: "un", costUsd: 0.2, usage: usage(2, 100, 19000, 0), sessionUsage: usage(2, 100, 19000, 0), tools: [] },
    { ok: true, text: "deux", costUsd: 0.23, usage: usage(2, 100, 500, 19000), sessionUsage: usage(4, 200, 19500, 19000), tools: [] },
  ];
  let n = 0;
  const first = service(async () => reports[n++]!);
  await first.chatService.ask("a", "desk");
  const second = new ChatService({
    config: first.config,
    db: first.db,
    chat: chatConfig({ cwd: first.config.home }),
    env: { PATH: process.env.PATH },
    chatMaxBudgetUsd: 0.5,
    runChat: async () => reports[n++]!,
    log: () => undefined,
  });
  await second.ask("b", "desk");
  const costs = turnRows(first.db);
  assert.ok(Math.abs(costs[1]! - 0.03) < 1e-9, `got ${costs[1]}`);
});

test("after a pause of more than an hour the chat starts a new conversation with the last exchanges", async () => {
  const seen: { args: string[]; input: string }[] = [];
  const { db, logs, chatService } = service(async (params) => {
    seen.push({ args: params.args, input: params.input });
    return { ok: true, text: `R${seen.length}`, costUsd: 0.02, usage: ZERO_USAGE, tools: [] };
  });
  recordChatMessage(db, "user", "Quand est mon rendez-vous ?", null, { channel: "telegram" });
  recordChatMessage(db, "assistant", "Jeudi à 9 h.", null, { channel: "telegram" });
  const turn = (endedAt: string) =>
    recordChatTurn(db, {
      engine: "claude",
      model: "sonnet",
      status: "done",
      reason: null,
      usage: ZERO_USAGE,
      costUsd: 0.02,
      tools: [],
      startedAt: endedAt,
      endedAt,
    });

  turn(new Date(Date.now() - 2 * 3_600_000).toISOString());
  await chatService.ask("Et le suivant ?", "desk");
  assert.ok(!seen[0]!.args.includes("--continue"), "no --continue after two hours");
  assert.match(seen[0]!.input, /Utilisateur : Quand est mon rendez-vous \?\nToi : Jeudi à 9 h\./);
  assert.ok(logs.some((l) => l.includes("new conversation")));

  // That turn just ended: the next one resumes the conversation just started.
  assert.ok(lastChatTurnEnd(db)! > new Date(Date.now() - 60_000).toISOString());
  await chatService.ask("Merci", "desk");
  assert.ok(seen[1]!.args.includes("--continue"));
  assert.ok(!seen[1]!.input.includes("Quand est mon rendez-vous"), "a resumed turn does not repeat the transcript");
});

test("a pause shorter than the configured limit still resumes", async () => {
  const seen: string[][] = [];
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const chatService = new ChatService({
    config,
    db,
    chat: chatConfig({ cwd: config.home, freshAfterMinutes: 180 }),
    env: { PATH: process.env.PATH },
    chatMaxBudgetUsd: 0.5,
    runChat: async (params) => {
      seen.push(params.args);
      return { ok: true, text: "ok", costUsd: 0, usage: ZERO_USAGE, tools: [] };
    },
    log: () => undefined,
  });
  const endedAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
  recordChatTurn(db, { engine: "claude", model: "sonnet", status: "done", reason: null, usage: ZERO_USAGE, costUsd: 0, tools: [], startedAt: endedAt, endedAt });
  await chatService.ask("Salut", "desk");
  assert.ok(seen[0]!.includes("--continue"));
});
