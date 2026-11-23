import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Approval } from "../src/ui/schemas";
import { UnwatchedNotice, WatchCount } from "../src/ui/watch-count";

// The count of items to look at, on the floor and on the desk, leads to them in one click.

const unseen = (id: number, title: string): Approval => ({
  id,
  room: "demo",
  agentId: "scout",
  runId: null,
  type: "mail_alert",
  title,
  body: "B",
  payload: {},
  status: "unseen",
  decisionNote: null,
  annotations: [],
  decisionHistory: [],
  actionDone: false,
  informational: true,
  decidedAt: null,
  createdAt: "2026-11-02T10:00:00.000Z",
});

test("WatchCount: the count as the tab title says it, a link to the oldest item on the desk; nothing without items", () => {
  assert.equal(renderToStaticMarkup(createElement(WatchCount, { unseen: [] })), "");
  const html = renderToStaticMarkup(createElement(WatchCount, { unseen: [unseen(4, "A"), unseen(8, "B")] }));
  assert.match(html, /^<a [^>]*href="\/bureau#approval-4"[^>]*>2 à regarder<\/a>$/);
});

test("UnwatchedNotice: each item no tray watches links to its card in the list of the desk; nothing without one", () => {
  assert.equal(renderToStaticMarkup(createElement(UnwatchedNotice, { items: [] })), "");
  const html = renderToStaticMarkup(createElement(UnwatchedNotice, { items: [unseen(4, "Server alert")] }));
  assert.match(html, /sans tuile sur le bureau \(1\)/);
  assert.match(html, /<a [^>]*href="#approval-4"[^>]*>Server alert<\/a>/);
});
