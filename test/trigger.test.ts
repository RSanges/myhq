import assert from "node:assert/strict";
import { test } from "node:test";
import { POST } from "../src/app/api/runs/route";
import { getDbAt, type RunRow } from "../src/server/db";
import type { Engine } from "../src/server/engine";
import { HqError } from "../src/server/errors";
import { toRun } from "../src/server/feed";
import { startRun, startRunSchema } from "../src/server/runner";
import { authorizeTrigger } from "../src/server/trigger";
import { makeHome, waitForRun } from "./helpers";

const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const engine: Engine = {
  name: "claude",
  async *run() {
    yield { type: "start", sessionId: "s", model: "haiku", tools: [], mcpServers: [] };
    yield { type: "end", status: "done", reason: "success", summary: "ok", usage, costUsd: 0 };
  },
};

const unauthorized = (error: unknown) => error instanceof HqError && error.code === "UNAUTHORIZED" && error.status === 401;

test("reason: lowercase letters and underscores, 40 at most", () => {
  const ok = (reason: string) => startRunSchema.safeParse({ room: "r", agent: "a", reason }).success;
  assert.equal(ok("mail"), true);
  assert.equal(ok("rom_two"), true);
  assert.equal(ok("a".repeat(40)), true);
  assert.equal(ok("a".repeat(41)), false);
  assert.equal(ok("Mail"), false);
  assert.equal(ok("mail-1"), false);
  assert.equal(ok(""), false);
});

test("without HQ_TRIGGER_TOKEN, any request passes, reason or not", () => {
  const config = makeHome();
  authorizeTrigger(config, null, undefined);
  authorizeTrigger(config, null, "mail");
});

test("with HQ_TRIGGER_TOKEN, a request with a reason needs the bearer token; the desk (no reason) does not", () => {
  const config = makeHome({ triggerToken: "s3cret-token" });
  authorizeTrigger(config, null, undefined);
  authorizeTrigger(config, "Bearer s3cret-token", "mail");
  authorizeTrigger(config, "bearer s3cret-token", "mail");
  assert.throws(() => authorizeTrigger(config, null, "mail"), unauthorized);
  assert.throws(() => authorizeTrigger(config, "Bearer wrong", "mail"), unauthorized);
  assert.throws(() => authorizeTrigger(config, "Bearer s3cret-token-longer", "mail"), unauthorized);
  assert.throws(() => authorizeTrigger(config, "s3cret-token", "mail"), unauthorized);
});

test("the reason is stored on the run, in its DTO and in its start event", async () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const run = startRun({ room: "demo", agent: "scout", reason: "mail" }, { config, engine, send: async () => true });
  assert.equal(run.reason, "mail");
  await waitForRun(db, run.id);
  assert.equal(toRun(db.prepare("SELECT * FROM runs WHERE id = ?").get(run.id) as RunRow).reason, "mail");
  const start = db.prepare("SELECT data FROM events WHERE run_id = ? AND type = 'start'").get(run.id) as { data: string };
  assert.equal((JSON.parse(start.data) as { reason?: string }).reason, "mail");

  const plain = startRun({ room: "demo", agent: "scout" }, { config, engine, send: async () => true });
  await waitForRun(db, plain.id);
  assert.equal(plain.reason, null);
  const plainStart = db.prepare("SELECT data FROM events WHERE run_id = ? AND type = 'start'").get(plain.id) as { data: string };
  assert.equal("reason" in (JSON.parse(plainStart.data) as object), false);
});

test("POST /api/runs: 401 without the token when it is set, the reason stored with it", async () => {
  const config = makeHome();
  const saved = { home: process.env.MYHQ_HOME, token: process.env.HQ_TRIGGER_TOKEN, bin: process.env.HQ_CLAUDE_BIN };
  process.env.MYHQ_HOME = config.home;
  process.env.HQ_TRIGGER_TOKEN = "route-token";
  // Never a real claude: the run fails at spawn, which is all this test needs.
  process.env.HQ_CLAUDE_BIN = "myhq-no-such-binary";
  const post = (body: unknown, auth?: string) =>
    POST(
      new Request("http://127.0.0.1/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
        body: JSON.stringify(body),
      }),
    );
  try {
    const denied = await post({ room: "demo", agent: "scout", reason: "mail" });
    assert.equal(denied.status, 401);
    assert.equal(((await denied.json()) as { error: { code: string } }).error.code, "UNAUTHORIZED");
    const wrong = await post({ room: "demo", agent: "scout", reason: "mail" }, "Bearer nope");
    assert.equal(wrong.status, 401);
    const db = getDbAt(config.dbPath);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n, 0);

    const accepted = await post({ room: "demo", agent: "scout", reason: "mail" }, "Bearer route-token");
    assert.equal(accepted.status, 202);
    const { run } = (await accepted.json()) as { run: { id: number; reason: string } };
    assert.equal(run.reason, "mail");
    await waitForRun(db, run.id);

    const invalid = await post({ room: "demo", agent: "scout", reason: "Not valid" }, "Bearer route-token");
    assert.equal(invalid.status, 400);
  } finally {
    for (const [key, value] of [
      ["MYHQ_HOME", saved.home],
      ["HQ_TRIGGER_TOKEN", saved.token],
      ["HQ_CLAUDE_BIN", saved.bin],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
