import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { hqPending } from "../src/mcp/tools";
import { decideApproval } from "../src/server/approvals";
import { getDbAt, type Db, type TaskRow } from "../src/server/db";
import type { Engine, RunEvent } from "../src/server/engine";
import { HqError } from "../src/server/errors";
import { getState } from "../src/server/feed";
import { readArchivedRooms } from "../src/server/home-settings";
import { archiveRoom, restoreRoom } from "../src/server/room-manage";
import { loadHome } from "../src/server/rooms";
import { makeHome, waitForRun } from "./helpers";

// An archived room really leaves the desk: its items waiting are set aside,
// a decision on one is refused, and they come back as they were (and are
// carried out) once the room is restored. The archive list is read entry by
// entry, and never loses an entry it could not read.

const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const done: RunEvent = { type: "end", status: "done", reason: "success", summary: "ok", usage, costUsd: 0 };
const engine: Engine = {
  name: "claude",
  async *run() {
    yield done;
  },
};

function office() {
  const config = makeHome(
    {},
    {
      name: "demo",
      targetRepo: "../demo-project",
      agents: [{ id: "scout", name: "Scout", role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"], onApproval: "task" }],
    },
  );
  return { config, db: getDbAt(config.dbPath) };
}

const addItem = (db: Db, status: "pending" | "unseen", title: string) =>
  Number(
    db
      .prepare("INSERT INTO approvals (room, agent_id, type, title, body, status, created_at) VALUES ('demo', 'scout', 'post', ?, 'B', ?, ?)")
      .run(title, status, new Date().toISOString()).lastInsertRowid,
  );

const scheduler = { enabled: false, running: false, timeZone: "Europe/Paris" };
const listed = (config: ReturnType<typeof office>["config"], db: Db) => {
  const state = getState(db, loadHome(config.home), scheduler);
  return {
    pending: state.approvals.pending.map((item) => item.id),
    unseen: state.approvals.unseen.map((item) => item.id),
    hq: hqPending(db).pending.map((item) => item.id),
  };
};

test("the items of an archived room leave the desk, refuse a decision, and come back to be carried out", async () => {
  const { config, db } = office();
  const post = addItem(db, "pending", "A post");
  const note = addItem(db, "unseen", "A note");
  assert.deepEqual(listed(config, db), { pending: [post], unseen: [note], hq: [post] });

  archiveRoom(config, db, "demo");
  assert.deepEqual(listed(config, db), { pending: [], unseen: [], hq: [] });
  assert.throws(
    () => decideApproval(db, post, { decision: "approved" }, config, { engine }),
    (error: unknown) => error instanceof HqError && error.code === "ROOM_ARCHIVED" && error.status === 409,
  );
  assert.equal((db.prepare("SELECT status FROM approvals WHERE id = ?").get(post) as { status: string }).status, "pending");

  restoreRoom(config, db, "demo");
  assert.deepEqual(listed(config, db), { pending: [post], unseen: [note], hq: [post] });
  // Approved now, it does what its agent's onApproval says: a task, and a run that takes it.
  decideApproval(db, post, { decision: "approved" }, config, { engine });
  const task = db.prepare("SELECT * FROM tasks WHERE source = 'approval' AND ref_id = ?").get(post) as TaskRow | undefined;
  assert.ok(task, "the approval gave its agent a task");
  const run = db.prepare("SELECT id FROM runs WHERE room = 'demo' AND agent_id = 'scout' ORDER BY id DESC").get() as { id: number };
  await waitForRun(db, run.id);
  assert.equal((db.prepare("SELECT status FROM tasks WHERE id = ?").get(task.id) as TaskRow).status, "done");
});

test("an archive list with an entry MyHQ cannot read keeps the others archived, and keeps that entry", () => {
  const { config, db } = office();
  const second = path.join(config.home, "rooms", "other");
  fs.cpSync(path.join(config.home, "rooms", "demo"), second, { recursive: true });
  const raw = JSON.parse(fs.readFileSync(path.join(second, "room.json"), "utf8")) as Record<string, unknown>;
  fs.writeFileSync(path.join(second, "room.json"), JSON.stringify({ ...raw, name: "other" }));
  const odd = { name: "Not A Room", at: "yesterday" };
  fs.writeFileSync(path.join(config.home, "myhq.json"), JSON.stringify({ archivedRooms: [{ name: "other", at: "2026-10-01" }, odd] }));

  const read = readArchivedRooms(config.home);
  assert.deepEqual(read.rooms, [{ name: "other", at: "2026-10-01" }]);
  assert.match(read.error ?? "", /archivedRooms\.1/);
  assert.deepEqual(loadHome(config.home).rooms.map((room) => room.name), ["demo"]);

  // Archiving another room rewrites the list: the valid entries and the unread one stay.
  archiveRoom(config, db, "demo");
  const list = (JSON.parse(fs.readFileSync(path.join(config.home, "myhq.json"), "utf8")) as { archivedRooms: unknown[] }).archivedRooms;
  assert.equal(list.length, 3);
  assert.deepEqual(list.at(-1), odd);
  assert.deepEqual(loadHome(config.home).rooms.map((room) => room.name), []);
  restoreRoom(config, db, "other");
  const after = (JSON.parse(fs.readFileSync(path.join(config.home, "myhq.json"), "utf8")) as { archivedRooms: unknown[] }).archivedRooms;
  assert.deepEqual(after.map((entry) => (entry as { name: string }).name), ["demo", "Not A Room"]);

  // A key that is not a list is never rewritten.
  fs.writeFileSync(path.join(config.home, "myhq.json"), JSON.stringify({ archivedRooms: "demo" }));
  assert.throws(() => archiveRoom(config, db, "other"), (error: unknown) => error instanceof HqError && error.code === "SETTINGS_FILE_INVALID");
});
