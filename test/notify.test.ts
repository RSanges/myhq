import assert from "node:assert/strict";
import { test } from "node:test";
import { notify } from "../src/server/notify";

test("does nothing without the Telegram variables", async () => {
  let called = false;
  const sent = await notify("hello", {}, (async () => {
    called = true;
    return new Response("{}");
  }) as typeof fetch);
  assert.equal(sent, false);
  assert.equal(called, false);
});

test("posts plain text to the Bot API", async () => {
  let url = "";
  let body: Record<string, unknown> = {};
  const sent = await notify(
    "hello",
    { HQ_TELEGRAM_BOT_TOKEN: "t0k3n", HQ_TELEGRAM_CHAT_ID: "42" },
    (async (input: string | URL | Request, init?: RequestInit) => {
      url = String(input);
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response("{}");
    }) as typeof fetch,
  );
  assert.equal(sent, true);
  assert.equal(url, "https://api.telegram.org/bott0k3n/sendMessage");
  assert.equal(body.chat_id, "42");
  assert.equal(body.text, "hello");
  assert.equal("reply_markup" in body, false);
});

test("never throws when the network fails", async () => {
  const sent = await notify("hello", { HQ_TELEGRAM_BOT_TOKEN: "t", HQ_TELEGRAM_CHAT_ID: "1" }, (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch);
  assert.equal(sent, false);
});
