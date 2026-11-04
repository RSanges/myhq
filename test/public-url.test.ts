import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { hqSubmit, type HqContext } from "../src/mcp/tools";
import type { Env } from "../src/server/config";
import { getDbAt } from "../src/server/db";
import type { Engine, RunEvent } from "../src/server/engine";
import { notify, notifyPendingApprovals, type Send } from "../src/server/notify";
import { appendLine, approvalLinkLine, deskLinkLine, publicUrl, runLinkLine } from "../src/server/public-url";
import { startRun } from "../src/server/runner";
import { startFakeTelegram, type FakeTelegram } from "./fake-telegram";
import { makeHome, waitForRun } from "./helpers";

const TOKEN = "public-url-token";
const BASE = "https://pc.tail1234.ts.net";
const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

const botEnv = (fake: FakeTelegram): Env => ({
  HQ_TELEGRAM_BOT_TOKEN: TOKEN,
  HQ_TELEGRAM_CHAT_ID: "42",
  HQ_TELEGRAM_API_BASE: fake.url,
});
const sender =
  (fake: FakeTelegram): Send =>
  (text, options) =>
    notify(text, botEnv(fake), fetch, options);

const ending = (status: "done" | "failed", summary: string): Engine => ({
  name: "claude",
  async *run() {
    const end: RunEvent = { type: "end", status, reason: status === "done" ? "success" : "error", summary, usage, costUsd: 0 };
    yield end;
  },
});

test("publicUrl: optional, http(s) only, reduced to origin and path without a trailing slash", () => {
  assert.equal(publicUrl({}), null);
  assert.equal(publicUrl({ HQ_PUBLIC_URL: "  " }), null);
  assert.equal(publicUrl({ HQ_PUBLIC_URL: "pc.tail1234.ts.net" }), null);
  assert.equal(publicUrl({ HQ_PUBLIC_URL: "ftp://pc.example" }), null);
  assert.equal(publicUrl({ HQ_PUBLIC_URL: BASE }), BASE);
  assert.equal(publicUrl({ HQ_PUBLIC_URL: ` ${BASE}/ ` }), BASE);
  assert.equal(publicUrl({ HQ_PUBLIC_URL: `${BASE}/hq//?x=1#frag` }), `${BASE}/hq`);
  assert.equal(publicUrl({ HQ_PUBLIC_URL: "http://127.0.0.1:4242" }), "http://127.0.0.1:4242");
});

test("the link lines carry the deep link of the item or the run, or are null without the address", () => {
  const env = { HQ_PUBLIC_URL: BASE };
  assert.equal(approvalLinkLine(7, env), `Ouvrir : ${BASE}/bureau#approval-7`);
  assert.equal(runLinkLine(12, env), `Ouvrir : ${BASE}/bureau#run-12`);
  assert.equal(deskLinkLine(env), `Bureau : ${BASE}/bureau`);
  assert.equal(approvalLinkLine(7, {}), null);
  assert.equal(runLinkLine(12, {}), null);
  assert.equal(deskLinkLine({}), null);
});

test("appendLine: at the end of the last message, or as one more when it would be cut", () => {
  assert.deepEqual(appendLine(["a", "b"], null), ["a", "b"]);
  assert.deepEqual(appendLine(["a", "b"], "L"), ["a", "b\n\nL"]);
  const full = "x".repeat(3990);
  const line = "Ouvrir : https://example.test/#run-1";
  assert.deepEqual(appendLine([full], line), [full, line]);
});

function submitHome() {
  const config = makeHome(
    {},
    {
      name: "demo",
      targetRepo: "../demo-project",
      agents: [{ id: "mailer", name: "Mailer", role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"] }],
    },
  );
  writeFileSync(path.join(config.home, "myhq.json"), JSON.stringify({ notifyTypes: ["mail_alert"] }));
  const db = getDbAt(config.dbPath);
  const ctx: HqContext = { dbPath: config.dbPath, runId: 1, agentId: "mailer", room: "demo", home: config.home };
  db.prepare(
    "INSERT INTO runs (id, room, agent_id, engine, task, status, started_at) VALUES (1, 'demo', 'mailer', 'claude', 't', 'done', ?)",
  ).run(new Date().toISOString());
  const pending = hqSubmit(db, ctx, { type: "mail_reply", title: "Reply to Alice", body: "Hello Alice." }).approvalId;
  const info = hqSubmit(db, ctx, { type: "mail_alert", title: "Invoice due", body: "Pay before Friday." }).approvalId;
  return { db, pending, info };
}

test("approval alerts end with the link when HQ_PUBLIC_URL is set, and are unchanged without it", async () => {
  const fake = await startFakeTelegram(TOKEN);
  try {
    const without = submitHome();
    await notifyPendingApprovals(without.db, sender(fake), {});
    const plain = fake.sent();
    assert.equal(plain.length, 2);
    assert.ok(plain.every((text) => !text.includes("Ouvrir")), "no link without HQ_PUBLIC_URL");

    const withUrl = submitHome();
    await notifyPendingApprovals(withUrl.db, sender(fake), { HQ_PUBLIC_URL: `${BASE}/` });
    const sent = fake.sent().slice(2);
    assert.equal(sent.length, 2);
    const alert = sent.find((text) => text.includes("Reply to Alice"))!;
    const info = sent.find((text) => text.includes("Invoice due"))!;
    assert.ok(alert.endsWith(`\n\nOuvrir : ${BASE}/bureau#approval-${withUrl.pending}`), alert);
    assert.ok(info.endsWith(`Pay before Friday.\n\nOuvrir : ${BASE}/bureau#approval-${withUrl.info}`), info);
    // Apart from the last line, the text is the same as without the address.
    assert.equal(alert.split("\n\nOuvrir")[0], plain.find((text) => text.includes("Reply to Alice"))!);
  } finally {
    await fake.close();
  }
});

test("a failed run links to #run-<id>, and a summary ends with the desk address", async () => {
  const fake = await startFakeTelegram(TOKEN);
  try {
    const config = makeHome(
      {},
      {
        name: "demo",
        targetRepo: "../demo-project",
        agents: [
          { id: "scout", name: "Scout", role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"], notifyRuns: "summary" },
        ],
      },
    );
    const db = getDbAt(config.dbPath);
    const deps = { config, send: sender(fake), env: { HQ_PUBLIC_URL: BASE } };

    const failed = startRun({ room: "demo", agent: "scout" }, { ...deps, engine: ending("failed", "boom") });
    await waitForRun(db, failed.id);
    await fake.waitFor(() => fake.sent().length === 1);
    assert.ok(fake.sent()[0]!.endsWith(`a échoué\nboom\n\nOuvrir : ${BASE}/bureau#run-${failed.id}`), fake.sent()[0]);

    const done = startRun({ room: "demo", agent: "scout" }, { ...deps, engine: ending("done", "Brief du matin") });
    await waitForRun(db, done.id);
    await fake.waitFor(() => fake.sent().length === 2);
    assert.equal(fake.sent()[1], `Brief du matin\n\nBureau : ${BASE}/bureau`);

    // Without the address, nothing changes.
    const plain = startRun({ room: "demo", agent: "scout" }, { config, send: sender(fake), env: {}, engine: ending("done", "Brief") });
    await waitForRun(db, plain.id);
    await fake.waitFor(() => fake.sent().length === 3);
    assert.equal(fake.sent()[2], "Brief");
  } finally {
    await fake.close();
  }
});
