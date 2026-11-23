import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { hqSubmit, ToolError, type HqContext } from "../src/mcp/tools";
import { decideApproval } from "../src/server/approvals";
import type { HqConfig } from "../src/server/config";
import { getDbAt, type Db } from "../src/server/db";
import { HqError } from "../src/server/errors";
import { ROOM_BRIEF } from "../src/server/room-brief";
import { loadHome, syncHome } from "../src/server/rooms";
import { makeHome } from "./helpers";

// The keeper of a room's brief proposes a new text (type `room_brief`); MyHQ
// writes the file only when the owner approves it.

const agent = (id: string) => ({ id, name: id, role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"] });
const OLD = "Colours: black and gold.\n";
const NEW = "Colours: black and warm gold.\nTone: plain.\n";

function setup(keeper: string | null = "writer"): { config: HqConfig; db: Db; file: string; dir: string } {
  const config = makeHome(
    {},
    { name: "demo", targetRepo: "x", brief: { file: "brief.md", ...(keeper ? { keeper } : {}) }, agents: [agent("scout"), agent("writer")] },
  );
  const dir = path.join(config.home, "rooms", "demo");
  const file = path.join(dir, "brief.md");
  fs.writeFileSync(file, OLD);
  const db = getDbAt(config.dbPath);
  syncHome(db, loadHome(config.home));
  return { config, db, file, dir };
}

function ctxOf(db: Db, config: HqConfig, agentId: string): HqContext {
  const runId = Number(
    db
      .prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at) VALUES ('demo', ?, 'claude', 't', 'done', ?)")
      .run(agentId, new Date().toISOString()).lastInsertRowid,
  );
  return { dbPath: config.dbPath, runId, agentId, room: "demo", home: config.home };
}

const submit = (db: Db, ctx: HqContext, payload: Record<string, unknown> = { text: NEW, summary: "Warmer gold, a tone line." }) =>
  hqSubmit(db, ctx, { type: ROOM_BRIEF, title: "Brief: warmer gold", body: "The client asked for a warmer gold.", payload });

const backups = (dir: string) => fs.readdirSync(dir).filter((name) => name.startsWith("brief.md.") && name.endsWith(".bak"));
const leftovers = (dir: string) => fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"));

test("room_brief: the keeper's proposal waits for approval, and approving it writes the brief, the old one kept beside it", () => {
  const { config, db, file, dir } = setup();
  const { approvalId, status } = submit(db, ctxOf(db, config, "writer"));
  assert.equal(status, "pending");
  assert.equal(fs.readFileSync(file, "utf8"), OLD, "nothing is written on submission");
  const body = (db.prepare("SELECT body FROM approvals WHERE id = ?").get(approvalId) as { body: string }).body;
  assert.ok(body.startsWith("The client asked for a warmer gold."));
  assert.ok(body.includes("Warmer gold, a tone line."), "the summary of the change");
  assert.ok(body.includes("Colours: black and warm gold.\nTone: plain."), "the full new text");

  assert.equal(decideApproval(db, approvalId, { decision: "approved" }, config).status, "approved");
  assert.equal(fs.readFileSync(file, "utf8"), NEW);
  const [backup] = backups(dir);
  assert.ok(backup, "the old brief is kept beside it");
  assert.match(backup, /^brief\.md\.\d{8}-\d{6}\.bak$/);
  assert.equal(fs.readFileSync(path.join(dir, backup), "utf8"), OLD);
  assert.deepEqual(leftovers(dir), []);
  assert.deepEqual(loadHome(config.home).invalid, []);
});

test("room_brief: a rejection, or a revision, writes nothing", () => {
  const { config, db, file, dir } = setup();
  const writer = ctxOf(db, config, "writer");
  assert.equal(decideApproval(db, submit(db, writer).approvalId, { decision: "rejected", note: "No." }, config).status, "rejected");
  const second = submit(db, writer, { text: "Another text.\n", summary: "Another." }).approvalId;
  assert.equal(decideApproval(db, second, { decision: "revise", note: "Shorter." }, config).status, "revise");
  assert.equal(fs.readFileSync(file, "utf8"), OLD);
  assert.deepEqual(backups(dir), []);
});

test("room_brief: only the keeper of the room's brief submits one, with a text and a summary", () => {
  const { config, db } = setup();
  const refused = (ctx: HqContext, pattern: RegExp, payload?: Record<string, unknown>) =>
    assert.throws(() => submit(db, ctx, payload), (error: unknown) => error instanceof ToolError && pattern.test(error.message));
  refused(ctxOf(db, config, "scout"), /Only the keeper of the brief of room "demo" \("writer"\) submits room_brief/);
  const writer = ctxOf(db, config, "writer");
  refused(writer, /invalid room_brief payload: text/, { summary: "No text." });
  refused(writer, /invalid room_brief payload: summary/, { text: NEW });
  refused(writer, /invalid room_brief payload/, { text: NEW, summary: "x", extra: 1 });
  assert.equal(db.prepare("SELECT COUNT(*) FROM approvals").pluck().get(), 0);

  const keeperless = setup(null);
  assert.throws(() => submit(keeperless.db, ctxOf(keeperless.db, keeperless.config, "writer")), /Room "demo" has no brief keeper/);
});

test("room_brief: a keeper changed before the approval leaves the item pending and the brief as it was", () => {
  const { config, db, file, dir } = setup();
  const { approvalId } = submit(db, ctxOf(db, config, "writer"));
  const roomJson = path.join(dir, "room.json");
  const room = JSON.parse(fs.readFileSync(roomJson, "utf8")) as { brief: { keeper: string } };
  fs.writeFileSync(roomJson, JSON.stringify({ ...room, brief: { ...room.brief, keeper: "scout" } }));
  assert.throws(
    () => decideApproval(db, approvalId, { decision: "approved" }, config),
    (error: unknown) => error instanceof HqError && error.code === "ROOM_BRIEF_INVALID" && /no longer keeps/.test(error.message),
  );
  assert.equal((db.prepare("SELECT status FROM approvals WHERE id = ?").get(approvalId) as { status: string }).status, "pending");
  assert.equal(fs.readFileSync(file, "utf8"), OLD);
  assert.deepEqual(backups(dir), []);
});
