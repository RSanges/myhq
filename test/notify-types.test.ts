import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { hqReadDecisions, hqSubmit, readContext, type HqContext } from "../src/mcp/tools";
import type { Env } from "../src/server/config";
import { getDbAt, type ApprovalRow, type Db } from "../src/server/db";
import type { Engine, RunEvent } from "../src/server/engine";
import { getState } from "../src/server/feed";
import { readNotifyTypes } from "../src/server/home-settings";
import { cutAlertBody, NOTIFICATION_TEXT_LIMIT, notify, notifyPendingApprovals, type Send } from "../src/server/notify";
import { loadHome } from "../src/server/rooms";
import { schedulerInfo } from "../src/server/routines";
import { startRun } from "../src/server/runner";
import { startFakeTelegram, type FakeTelegram } from "./fake-telegram";
import { makeHome, waitForRun } from "./helpers";

const TOKEN = "notify-token";
const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

/** The app's sender, pointed at the fake Bot API, polling on (so pending alerts carry buttons). */
function sender(fake: FakeTelegram): Send {
  const env: Env = {
    HQ_TELEGRAM_BOT_TOKEN: TOKEN,
    HQ_TELEGRAM_CHAT_ID: "42",
    HQ_TELEGRAM_API_BASE: fake.url,
    HQ_TELEGRAM_POLLING: "true",
  };
  return (text, options) => notify(text, env, fetch, options);
}

const sendCalls = (fake: FakeTelegram) => fake.calls.filter((c) => c.method === "sendMessage").map((c) => c.params);

function writeMyhq(home: string, settings: unknown): void {
  fs.writeFileSync(path.join(home, "myhq.json"), JSON.stringify(settings));
}

const approval = (db: Db, id: number) => db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow;

/** A home with a mailer (onApproval: task), myhq.json declaring mail_alert informational. */
function informationalHome() {
  const config = makeHome(
    {},
    {
      name: "demo",
      targetRepo: "../demo-project",
      agents: [
        { id: "mailer", name: "Mailer", role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"], onApproval: "task" },
      ],
    },
  );
  writeMyhq(config.home, { notifyTypes: ["mail_alert"] });
  return config;
}

test("myhq.json: notifyTypes defaults to none, and an invalid file keeps every item pending", () => {
  const config = makeHome();
  assert.deepEqual(readNotifyTypes(config.home), []);
  writeMyhq(config.home, { language: "fr" });
  assert.deepEqual(readNotifyTypes(config.home), []);
  writeMyhq(config.home, { notifyTypes: ["mail_alert", "brief"] });
  assert.deepEqual(readNotifyTypes(config.home), ["mail_alert", "brief"]);
  writeMyhq(config.home, { notifyTypes: ["Not A Type"] });
  assert.deepEqual(readNotifyTypes(config.home), []);
});

test("the HQ MCP server finds the home from HQ_DB_PATH", () => {
  const config = makeHome();
  const ctx = readContext({ HQ_DB_PATH: config.dbPath, HQ_RUN_ID: "1", HQ_AGENT_ID: "a", HQ_ROOM: "r" });
  assert.equal(ctx.home, config.home);
  const elsewhere = readContext({ HQ_DB_PATH: path.join(config.home, "hq.db"), HQ_RUN_ID: "1", HQ_AGENT_ID: "a", HQ_ROOM: "r" });
  assert.equal(elsewhere.home, undefined);
});

test("hq_submit: an informational type is born unseen, read by its agent, off the pending list and on the watch list", () => {
  const config = informationalHome();
  const db = getDbAt(config.dbPath);
  const ctx: HqContext = { dbPath: config.dbPath, runId: 1, agentId: "mailer", room: "demo", home: config.home };
  db.prepare(
    "INSERT INTO runs (id, room, agent_id, engine, task, status, started_at) VALUES (1, 'demo', 'mailer', 'claude', 't', 'done', ?)",
  ).run(new Date().toISOString());

  const info = hqSubmit(db, ctx, { type: "mail_alert", title: "Invoice due", body: "Pay before Friday." });
  assert.equal(info.status, "unseen");
  const row = approval(db, info.approvalId);
  assert.equal(row.status, "unseen");
  assert.equal(row.decision_note, null);
  assert.equal(row.decided_at, null, "nobody decided anything");
  assert.ok(row.seen_by_agent_at, "its agent does not read it back as a decision");

  const reply = hqSubmit(db, ctx, { type: "mail_reply", title: "Reply to Alice", body: "Hello Alice." });
  assert.equal(reply.status, "pending");
  assert.equal(approval(db, reply.approvalId).decision_note, null);

  // Desk: its own section, neither pending nor history. No task for the onApproval agent, nothing to read back.
  const state = getState(db, loadHome(config.home), schedulerInfo(config));
  assert.deepEqual(state.approvals.pending.map((a) => a.id), [reply.approvalId]);
  assert.deepEqual(state.approvals.unseen.map((a) => [a.id, a.status, a.informational]), [[info.approvalId, "unseen", true]]);
  assert.deepEqual(state.approvals.history, []);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE source = 'approval'").get() as { n: number }).n, 0);
  assert.deepEqual(hqReadDecisions(db, ctx).decisions, []);
});

/** A home with a mailer whose long alert is submitted: the id of the long informational item, and of a pending one. */
function longItem(body: string) {
  const config = informationalHome();
  const db = getDbAt(config.dbPath);
  const ctx: HqContext = { dbPath: config.dbPath, runId: 1, agentId: "mailer", room: "demo", home: config.home };
  db.prepare(
    "INSERT INTO runs (id, room, agent_id, engine, task, status, started_at) VALUES (1, 'demo', 'mailer', 'claude', 't', 'done', ?)",
  ).run(new Date().toISOString());
  const info = hqSubmit(db, ctx, { type: "mail_alert", title: "Mails du matin", body }).approvalId;
  const pending = hqSubmit(db, ctx, { type: "mail_reply", title: "Reply to Alice", body: "Hello Alice." }).approvalId;
  return { db, info, pending };
}

test("a long informational item is one message cut at a sentence, with « … », its link and a single Vu button; a pending one keeps the alert and buttons", async () => {
  const fake = await startFakeTelegram(TOKEN);
  try {
    const paragraph = `${"A sentence of the alert that goes on and on, kept as **is**. ".repeat(12)}`.trim();
    const body = `Three mails need you:\n\n${Array.from({ length: 8 }, () => paragraph).join("\n\n")}\n\nEnd.`;
    const { db, info, pending } = longItem(body);
    const env: Env = { HQ_PUBLIC_URL: "https://hq.example.net" };
    await notifyPendingApprovals(db, sender(fake), env);

    const calls = sendCalls(fake);
    assert.equal(calls.length, 2, "one message for the long item, one alert for the approval");
    const text = String(calls[0]!.text);
    const head = `MyHQ : Mails du matin (#${info})\ndemo / mailer : mail_alert`;
    assert.ok(text.startsWith(`${head}\n\nThree mails need you:`));
    // Cut at the end of a paragraph (the second half of the window holds one), then « … » and the link.
    assert.ok(text.includes("kept as **is**"), "the body is sent as is");
    assert.match(text, new RegExp(`…\\n\\nLire la suite : https://hq\\.example\\.net/bureau#approval-${info}$`));
    assert.equal(text.includes("End."), false, "the end of the body stays on the desk");
    const shown = text.slice(0, text.indexOf("…"));
    assert.ok(shown.length <= NOTIFICATION_TEXT_LIMIT, `${shown.length} characters`);
    assert.ok(text.length < NOTIFICATION_TEXT_LIMIT + 200);
    assert.deepEqual((calls[0]!.reply_markup as { inline_keyboard: unknown }).inline_keyboard, [[{ text: "Vu", callback_data: `hq:w:${info}` }]]);

    const alert = calls.find((c) => String(c.text).includes(`(#${pending})`))!;
    assert.match(String(alert.text), /un item attend ta validation/);
    assert.equal(String(alert.text).includes("Hello Alice."), false);
    assert.ok("reply_markup" in alert);

    const before = sendCalls(fake).length;
    await notifyPendingApprovals(db, sender(fake), env);
    assert.equal(sendCalls(fake).length, before, "sent once");
  } finally {
    await fake.close();
  }
});

test("a long informational item without HQ_PUBLIC_URL ends with the mention of the item in MyHQ", async () => {
  const fake = await startFakeTelegram(TOKEN);
  try {
    const { db, info } = longItem(`Intro.\n${"a line of the alert, kept as is\n".repeat(300)}End.`);
    await notifyPendingApprovals(db, sender(fake), {});
    const [first] = sendCalls(fake);
    const text = String(first!.text);
    assert.equal(sendCalls(fake).length, 2);
    assert.match(text, new RegExp(`…\\n\\n\\(suite dans MyHQ, item #${info}\\)$`));
    assert.ok(text.length < NOTIFICATION_TEXT_LIMIT + 100);
    assert.equal(text.includes("Lire la suite"), false);
  } finally {
    await fake.close();
  }
});

test("a short informational item is sent whole, with the usual link line, and a text just at the limit is not cut", async () => {
  const fake = await startFakeTelegram(TOKEN);
  try {
    const head = (id: number) => `MyHQ : Mails du matin (#${id})\ndemo / mailer : mail_alert`;
    const { db, info } = longItem("Pay before Friday.");
    const env: Env = { HQ_PUBLIC_URL: "https://hq.example.net" };
    await notifyPendingApprovals(db, sender(fake), env);
    assert.equal(
      String(sendCalls(fake)[0]!.text),
      `${head(info)}\n\nPay before Friday.\n\nOuvrir : https://hq.example.net/bureau#approval-${info}`,
    );

    // The alert line and the body together fill the limit to the character: whole.
    const filler = (id: number) => "x".repeat(NOTIFICATION_TEXT_LIMIT - head(id).length - 2);
    const next = longItem("placeholder");
    next.db.prepare("UPDATE approvals SET body = ? WHERE id = ?").run(filler(next.info), next.info);
    await notifyPendingApprovals(next.db, sender(fake), env);
    const exact = String(sendCalls(fake).find((c) => String(c.text).includes(`(#${next.info})\ndemo / mailer : mail_alert`))!.text);
    assert.equal(exact.includes("…"), false);
    assert.match(exact, /Ouvrir : /);
  } finally {
    await fake.close();
  }
});

test("cutAlertBody: end of paragraph, else end of sentence, else a word, never inside an emoji", () => {
  const paragraphs = "First paragraph here.\n\nSecond paragraph goes on for a while.\n\nThird one.";
  assert.equal(cutAlertBody(paragraphs, 100), paragraphs, "short enough: untouched");
  assert.equal(cutAlertBody(paragraphs, 50), "First paragraph here.\n\nSecond paragraph goes on", "the paragraph break is before the middle of the window and no sentence ends after it: a word");
  assert.equal(cutAlertBody("Aaaa bbbb cccc dddd eeee.\n\nFfff gggg hhhh iiii jjjj", 40), "Aaaa bbbb cccc dddd eeee.", "a paragraph in the second half");
  assert.equal(cutAlertBody("One. Two three four five six seven. Eight nine ten eleven", 45), "One. Two three four five six seven.", "a sentence in the second half");
  assert.equal(cutAlertBody("One two three four five six seven eight", 20), "One two three four", "a word");
  assert.equal(cutAlertBody("abcdefghijklmnopqrstuvwxyz", 10), "abcdefghij", "no space at all: where the window ends");
  assert.equal(cutAlertBody("ab😀cd", 3), "ab", "the pair of an emoji is kept whole");
});
test("an approved item whose note happens to be « notification » is not sent again as information", async () => {
  const fake = await startFakeTelegram(TOKEN);
  try {
    const db = getDbAt(makeHome().dbPath);
    db.prepare(
      "INSERT INTO approvals (room, agent_id, type, title, body, status, decision_note, decided_at, created_at) VALUES ('demo', 'scout', 'x', 'T', 'B', 'approved', 'notification', '2026-11-03T10:00:00.000Z', '2026-11-03T09:00:00.000Z')",
    ).run();
    await notifyPendingApprovals(db, sender(fake));
    assert.deepEqual(fake.sent(), []);
  } finally {
    await fake.close();
  }
});

function summaryHome(notifyRuns?: string) {
  return makeHome(
    {},
    {
      name: "demo",
      targetRepo: "../demo-project",
      agents: [
        {
          id: "scout",
          name: "Scout",
          role: "roles/scout.md",
          model: "haiku",
          allowedTools: ["mcp__hq__*"],
          ...(notifyRuns ? { notifyRuns } : {}),
        },
      ],
    },
  );
}

const ending = (status: "done" | "failed", summary: string): Engine => ({
  name: "claude",
  async *run() {
    const end: RunEvent = { type: "end", status, reason: status === "done" ? "success" : "error", summary, usage, costUsd: 0 };
    yield end;
  },
});

test("room.json: notifyRuns is optional, null by default, and checked", () => {
  assert.equal(loadHome(summaryHome().home).rooms[0]!.agents[0]!.notifyRuns, null);
  assert.equal(loadHome(summaryHome("summary").home).rooms[0]!.agents[0]!.notifyRuns, "summary");
  assert.match(loadHome(summaryHome("all").home).invalid[0]!.error, /notifyRuns/);
});

test("notifyRuns summary: the summary of a run that ends well is the Telegram message", async () => {
  const fake = await startFakeTelegram(TOKEN);
  try {
    const config = summaryHome("summary");
    const db = getDbAt(config.dbPath);
    const brief = "## Brief du matin\n\n**Agenda** : réunion à 10 h.\n- Deux mails importants.";
    const run = startRun({ room: "demo", agent: "scout" }, { config, engine: ending("done", brief), send: sender(fake) });
    await waitForRun(db, run.id);
    await fake.waitFor(() => fake.sent().length === 1);
    assert.equal(fake.sent()[0], "Brief du matin\n\nAgenda : réunion à 10 h.\n- Deux mails importants.");
    assert.equal("reply_markup" in sendCalls(fake)[0]!, false);

    // A failed run sends the failure alert only.
    const failed = startRun({ room: "demo", agent: "scout" }, { config, engine: ending("failed", "boom"), send: sender(fake) });
    await waitForRun(db, failed.id);
    await fake.waitFor(() => fake.sent().length === 2);
    assert.match(fake.sent()[1]!, /a échoué\nboom/);
  } finally {
    await fake.close();
  }
});

test("without notifyRuns, a run that ends well sends nothing", async () => {
  const fake = await startFakeTelegram(TOKEN);
  try {
    const config = summaryHome();
    const db = getDbAt(config.dbPath);
    const run = startRun({ room: "demo", agent: "scout" }, { config, engine: ending("done", "Quiet."), send: sender(fake) });
    await waitForRun(db, run.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(fake.sent(), []);
  } finally {
    await fake.close();
  }
});
