import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { Env } from "../src/server/config";
import { getDbAt, type Db } from "../src/server/db";
import type { Engine, RunEvent } from "../src/server/engine";
import { readNotifyTypes } from "../src/server/export";
import { notify, notifyPendingApprovals, type Send } from "../src/server/notify";
import { loadHome } from "../src/server/rooms";
import { startRun } from "../src/server/runner";
import { startFakeTelegram, type FakeTelegram } from "./fake-telegram";
import { makeHome, waitForRun } from "./helpers";

const TOKEN = "notify-token";
const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

/** The app's sender, pointed at the fake Bot API, polling on (so alerts carry buttons). */
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

function addApproval(db: Db, type: string, title: string, body: string): number {
  return Number(
    db
      .prepare(
        "INSERT INTO approvals (room, agent_id, type, title, body, status, created_at) VALUES ('demo', 'scout', ?, ?, ?, 'pending', ?)",
      )
      .run(type, title, body, new Date().toISOString()).lastInsertRowid,
  );
}

function writeMyhq(home: string, settings: unknown): void {
  fs.writeFileSync(path.join(home, "myhq.json"), JSON.stringify(settings));
}

test("myhq.json: notifyTypes defaults to none, and an invalid file keeps the short alerts", () => {
  const config = makeHome();
  assert.deepEqual(readNotifyTypes(config.home), []);
  writeMyhq(config.home, { language: "fr" });
  assert.deepEqual(readNotifyTypes(config.home), []);
  writeMyhq(config.home, { notifyTypes: ["mail_alert", "mail_reply"] });
  assert.deepEqual(readNotifyTypes(config.home), ["mail_alert", "mail_reply"]);
  writeMyhq(config.home, { notifyTypes: ["Not A Type"] });
  assert.deepEqual(readNotifyTypes(config.home), []);
});

test("a listed type goes out in full, cut at 4000, the buttons under the last part; others stay short", async () => {
  const fake = await startFakeTelegram(TOKEN);
  try {
    const db = getDbAt(makeHome().dbPath);
    const body = `Draft reply:\n${"line of the draft, kept as **is**\n".repeat(300)}End.`;
    const long = addApproval(db, "mail_reply", "Reply to Alice", body);
    const short = addApproval(db, "community_reply", "A thread", "Body of the reply.");
    await notifyPendingApprovals(db, sender(fake), ["mail_reply"]);

    const calls = sendCalls(fake);
    const parts = calls.filter((c) => String(c.text).includes("line of the draft") || String(c.text).includes(`#${long}`));
    assert.ok(parts.length >= 3, `the body is cut in several messages (${parts.length})`);
    assert.ok(parts.every((p) => String(p.text).length <= 4000));
    assert.match(String(parts[0]!.text), new RegExp(`MyHQ : un item attend ta validation \\(#${long}\\)`));
    assert.match(String(parts[0]!.text), /Reply to Alice\n\nDraft reply:/);
    assert.match(String(parts.at(-1)!.text), /End\.$/);
    // The body is sent as is (no Markdown stripping), and only the last part carries the buttons.
    assert.ok(String(parts[1]!.text).includes("kept as **is**"));
    assert.deepEqual(
      parts.map((p) => "reply_markup" in p),
      parts.map((_, i) => i === parts.length - 1),
    );
    const keyboard = parts.at(-1)!.reply_markup as { inline_keyboard: { callback_data: string }[][] };
    assert.equal(keyboard.inline_keyboard[0]![0]!.callback_data, `hq:a:${long}`);

    const alert = calls.find((c) => String(c.text).includes(`#${short}`))!;
    assert.equal(String(alert.text).includes("Body of the reply."), false, "an unlisted type gets the short alert");
    assert.ok("reply_markup" in alert);

    // Notified once.
    const before = sendCalls(fake).length;
    await notifyPendingApprovals(db, sender(fake), ["mail_reply"]);
    assert.equal(sendCalls(fake).length, before);
  } finally {
    await fake.close();
  }
});

test("a run reads notifyTypes from myhq.json for the items it submits", async () => {
  const fake = await startFakeTelegram(TOKEN);
  try {
    const config = makeHome();
    writeMyhq(config.home, { notifyTypes: ["mail_alert"] });
    const db = getDbAt(config.dbPath);
    const engine: Engine = {
      name: "claude",
      async *run(input) {
        db.prepare(
          "INSERT INTO approvals (room, agent_id, run_id, type, title, body, status, created_at) VALUES ('demo', 'scout', ?, 'mail_alert', 'Invoice due', 'The full alert text.', 'pending', ?)",
        ).run(input.runId, new Date().toISOString());
        yield { type: "tool_result", toolUseId: "t1", isError: false, content: "{}" };
        yield { type: "end", status: "done", reason: "success", summary: "ok", usage, costUsd: 0 };
      },
    };
    const run = startRun({ room: "demo", agent: "scout" }, { config, engine, send: sender(fake) });
    await waitForRun(db, run.id);
    await fake.waitFor(() => fake.sent().some((t) => t.includes("The full alert text.")));
    assert.equal(fake.sent().length, 1);
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
