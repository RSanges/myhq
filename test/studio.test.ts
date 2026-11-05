import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { hqMessage, hqRooms, hqSubmit, ToolError, type HqContext } from "../src/mcp/tools";
import { decideApproval } from "../src/server/approvals";
import type { HqConfig } from "../src/server/config";
import { getDbAt, openDb, type ApprovalRow, type Db, type RunRow, type TaskRow } from "../src/server/db";
import { DeskCommands } from "../src/server/desk-command";
import { resolveDesk } from "../src/server/desk";
import type { Engine, RunEvent, RunInput } from "../src/server/engine";
import { HqError } from "../src/server/errors";
import { getState, toApproval, APPROVAL_SELECT, type ApprovalRowWithAction } from "../src/server/feed";
import { notifyPendingApprovals } from "../src/server/notify";
import { loadHome, syncHome } from "../src/server/rooms";
import { fireRoutine, schedulerInfo } from "../src/server/routines";
import { buildPrompt, startRun, wakeAgents, WAKE_TASK } from "../src/server/runner";
import { makeHome, waitForRun } from "./helpers";

const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const done: RunEvent = { type: "end", status: "done", reason: "success", summary: "ok", usage, costUsd: 0 };

const agent = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
  role: "roles/scout.md",
  model: "haiku",
  allowedTools: ["mcp__hq__*"],
  ...extra,
});

function writeRoom(home: string, room: Record<string, unknown> & { name: string }): void {
  const dir = path.join(home, "rooms", room.name);
  fs.mkdirSync(path.join(dir, "roles"), { recursive: true });
  fs.writeFileSync(path.join(dir, "roles", "scout.md"), "You are a test agent.\n");
  fs.writeFileSync(path.join(dir, "room.json"), JSON.stringify(room));
}

/**
 * A home with a project room "demo" (scout, writer), a shared studio (video
 * and sound hold the GPU, script does not) and a second project room "other".
 */
function studioHome(): HqConfig {
  const config = makeHome(
    {},
    { name: "demo", targetRepo: "../demo", color: "#ff3d7f", agents: [agent("scout"), agent("writer")] },
  );
  writeRoom(config.home, {
    name: "studio",
    targetRepo: "../studio",
    color: "#f5a524",
    shared: true,
    agents: [agent("video", { resources: ["gpu"] }), agent("sound", { resources: ["gpu"] }), agent("script")],
  });
  writeRoom(config.home, { name: "other", targetRepo: "../other", agents: [agent("social")] });
  return config;
}

function setup(): { config: HqConfig; db: Db } {
  const config = studioHome();
  const db = getDbAt(config.dbPath);
  syncHome(db, loadHome(config.home));
  return { config, db };
}

/** The context of the HQ MCP server for a run of `room/agent` (a run row is needed for the foreign keys). */
function ctxOf(db: Db, config: HqConfig, room: string, agentId: string): HqContext {
  const runId = Number(
    db
      .prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at) VALUES (?, ?, 'claude', 't', 'done', ?)")
      .run(room, agentId, new Date(Date.now() - 60_000).toISOString()).lastInsertRowid,
  );
  return { dbPath: config.dbPath, runId, agentId, room, home: config.home };
}

const tasksOf = (db: Db, room: string, agentId: string) =>
  db.prepare("SELECT * FROM tasks WHERE room = ? AND agent_id = ? ORDER BY id").all(room, agentId) as TaskRow[];

test("room.json: shared and resources are optional, checked, and shared is mirrored into the database", () => {
  const { config, db } = setup();
  const home = loadHome(config.home);
  assert.deepEqual(home.invalid, []);
  const byName = new Map(home.rooms.map((room) => [room.name, room]));
  assert.equal(byName.get("studio")!.shared, true);
  assert.equal(byName.get("demo")!.shared, false);
  assert.deepEqual(byName.get("studio")!.agents.map((a) => [a.id, a.resources]), [
    ["video", ["gpu"]],
    ["sound", ["gpu"]],
    ["script", []],
  ]);
  assert.deepEqual(
    db.prepare("SELECT name, shared FROM rooms ORDER BY name").all(),
    [
      { name: "demo", shared: 0 },
      { name: "other", shared: 0 },
      { name: "studio", shared: 1 },
    ],
  );
  writeRoom(config.home, { name: "bad", targetRepo: "x", agents: [agent("a", { resources: ["GPU!"] })] });
  writeRoom(config.home, { name: "twice", targetRepo: "x", agents: [agent("a", { resources: ["gpu", "gpu"] })] });
  writeRoom(config.home, { name: "notbool", targetRepo: "x", shared: "yes", agents: [agent("a")] });
  const invalid = loadHome(config.home).invalid.map((each) => each.error);
  assert.equal(invalid.length, 3);
  assert.match(invalid.find((e) => e.includes("bad"))!, /resources/);
  assert.match(invalid.find((e) => e.includes("twice"))!, /listed twice/);
  assert.match(invalid.find((e) => e.includes("notbool"))!, /shared/);
});

test("migration 12: a database of version 11 keeps its rows and gets the new columns with their defaults", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-migration-"));
  const file = path.join(dir, "hq.db");
  const db = openDb(file);
  const at = "2026-11-01T08:00:00.000Z";
  db.prepare("INSERT INTO rooms (name, target_repo, synced_at) VALUES ('demo', 'x', ?)").run(at);
  db.prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at) VALUES ('demo', 'scout', 'claude', 't', 'done', ?)").run(at);
  db.prepare("INSERT INTO messages (room, from_agent, to_agent, text, created_at) VALUES ('demo', 'scout', 'writer', 'hi', ?)").run(at);
  db.prepare("INSERT INTO tasks (room, agent_id, source, text, status, created_at, updated_at) VALUES ('demo', 'writer', 'message', 'hi', 'pending', ?, ?)").run(at, at);
  db.prepare("INSERT INTO approvals (room, agent_id, type, title, body, status, created_at) VALUES ('demo', 'scout', 'post', 'T', 'B', 'pending', ?)").run(at);
  // Back to version 11: the columns of migration 12 removed, the migration forgotten.
  db.exec(`
    ALTER TABLE rooms DROP COLUMN shared;
    ALTER TABLE messages DROP COLUMN to_room;
    ALTER TABLE tasks DROP COLUMN from_room;
    ALTER TABLE tasks DROP COLUMN from_agent;
    ALTER TABLE approvals DROP COLUMN for_room;
    ALTER TABLE runs DROP COLUMN resources;
    DELETE FROM schema_migrations WHERE version = 12;
    -- The later migrations, forgotten too.
    DROP TABLE approval_files;
    DELETE FROM schema_migrations WHERE version > 12;
  `);
  db.close();

  const raw = new Database(file);
  assert.equal((raw.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v, 11);
  raw.close();

  const migrated = openDb(file);
  assert.equal((migrated.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 12").get() as { n: number }).n, 1);
  assert.deepEqual(migrated.prepare("SELECT name, shared FROM rooms").all(), [{ name: "demo", shared: 0 }]);
  assert.deepEqual(migrated.prepare("SELECT to_agent, to_room FROM messages").all(), [{ to_agent: "writer", to_room: null }]);
  assert.deepEqual(migrated.prepare("SELECT text, from_room, from_agent FROM tasks").all(), [{ text: "hi", from_room: null, from_agent: null }]);
  const approval = migrated.prepare(`${APPROVAL_SELECT} WHERE a.id = 1`).get() as ApprovalRowWithAction;
  assert.equal(approval.for_room, null);
  assert.equal(toApproval(approval).forRoom, null);
  assert.equal((migrated.prepare("SELECT resources FROM runs").get() as RunRow).resources, "[]");
  migrated.close();
});

test("hq_message: an agent may order from a shared room; the task keeps the sender and wakes per onMessage", () => {
  const { config, db } = setup();
  const scout = ctxOf(db, config, "demo", "scout");
  const { messageId } = hqMessage(db, scout, { to: "video", room: "studio", text: "A 20 s clip of the app." });
  const [task] = tasksOf(db, "studio", "video");
  assert.ok(task);
  assert.equal(task.source, "message");
  assert.equal(task.ref_id, messageId);
  assert.equal(task.from_room, "demo");
  assert.equal(task.from_agent, "scout");
  assert.equal(task.status, "pending");
  assert.match(task.text, /^Message from scout of room "demo" \(answer with hq_message to "scout", room "demo"\): A 20 s clip/);
  const message = db.prepare("SELECT room, from_agent, to_agent, to_room FROM messages WHERE id = ?").get(messageId);
  assert.deepEqual(message, { room: "demo", from_agent: "scout", to_agent: "video", to_room: "studio" });

  // Within the room nothing changed, the sender is recorded too, and writing to oneself is still refused.
  hqMessage(db, scout, { to: "writer", text: "Hello." });
  const [own] = tasksOf(db, "demo", "writer");
  assert.equal(own!.text, "Message from scout: Hello.");
  assert.equal(db.prepare("SELECT to_room FROM messages WHERE to_agent = 'writer'").pluck().get(), null);
  assert.throws(() => hqMessage(db, scout, { to: "scout", text: "Me." }), /cannot write to itself/);
});

test("hq_message: a room that is not shared is refused, unless the recipient ordered from the sender's room", () => {
  const { config, db } = setup();
  const scout = ctxOf(db, config, "demo", "scout");
  assert.throws(() => hqMessage(db, scout, { to: "social", room: "other", text: "Hi." }), (error: unknown) => {
    assert.ok(error instanceof ToolError);
    assert.match(error.message, /Room "other" is not shared/);
    return true;
  });
  assert.throws(() => hqMessage(db, scout, { to: "nobody", room: "studio", text: "Hi." }), /Unknown agent "nobody" in room "studio"/);
  assert.throws(() => hqMessage(db, scout, { to: "video", room: "nowhere", text: "Hi." }), /Unknown room "nowhere"/);
  assert.equal(tasksOf(db, "other", "social").length, 0);

  // The studio cannot write to a room that never ordered from it...
  const video = ctxOf(db, config, "studio", "video");
  assert.throws(() => hqMessage(db, video, { to: "scout", room: "demo", text: "Which format?" }), /not shared/);
  // ...but once scout ordered, any agent of the studio may answer scout (and only scout).
  hqMessage(db, scout, { to: "script", room: "studio", text: "A script for a reel." });
  hqMessage(db, video, { to: "scout", room: "demo", text: "Which format?" });
  const [answer] = tasksOf(db, "demo", "scout");
  assert.equal(answer!.from_room, "studio");
  assert.equal(answer!.from_agent, "video");
  assert.match(answer!.text, /^Message from video of room "studio"/);
  assert.throws(() => hqMessage(db, video, { to: "writer", room: "demo", text: "And you?" }), /not shared/);
  assert.throws(() => hqMessage(db, video, { to: "social", room: "other", text: "Hi." }), /not shared/);
});

test("hq_message: a room removed from the home is no longer reachable", () => {
  const { config, db } = setup();
  fs.rmSync(path.join(config.home, "rooms", "studio"), { recursive: true });
  syncHome(db, loadHome(config.home));
  const scout = ctxOf(db, config, "demo", "scout");
  assert.throws(() => hqMessage(db, scout, { to: "video", room: "studio", text: "Hi." }), /Unknown room "studio"/);
  assert.deepEqual(hqRooms(db, scout).rooms, []);
});

test("hq_rooms lists the shared rooms and their agents", () => {
  const { config, db } = setup();
  assert.deepEqual(hqRooms(db, ctxOf(db, config, "demo", "scout")), {
    rooms: [
      {
        room: "studio",
        yours: false,
        agents: [
          { id: "script", name: "Script" },
          { id: "sound", name: "Sound" },
          { id: "video", name: "Video" },
        ],
      },
    ],
  });
  assert.equal(hqRooms(db, ctxOf(db, config, "studio", "video")).rooms[0]!.yours, true);
});

test("the run prompt tells a room about the shared rooms, and a shared room how to deliver", () => {
  const { config } = setup();
  const home = loadHome(config.home);
  const demo = home.rooms.find((room) => room.name === "demo")!;
  const studio = home.rooms.find((room) => room.name === "studio")!;
  const toDemo = buildPrompt({ room: demo, agent: demo.agents[0]!, runId: 1, task: "T", mailbox: [], sharedRooms: ["studio"] });
  assert.match(toDemo, /Shared rooms you may order from with hq_message and "room" \(hq_rooms lists their agents\): studio\./);
  assert.doesNotMatch(toDemo, /Your room is shared/);
  const toStudio = buildPrompt({ room: studio, agent: studio.agents[0]!, runId: 2, task: "T", mailbox: [] });
  assert.match(toStudio, /Your room is shared: .*hq_submit and forRoom/);
  assert.doesNotMatch(buildPrompt({ room: demo, agent: demo.agents[0]!, runId: 3, task: "T", mailbox: [] }), /Shared rooms/);
  // Every prompt tells the agent to check an item with hq_items before denying it.
  assert.match(toDemo, /Before you say that an item is not approved, or does not exist, check it with hq_items/);
  assert.match(toStudio, /check it with hq_items/);
  assert.match(toDemo, /Read the content of an item .* with hq_items and its id/);
});

test("hq_submit forRoom: a shared room delivers to the room that ordered; refused for a room that is not shared or unknown", () => {
  const { config, db } = setup();
  const video = ctxOf(db, config, "studio", "video");
  const { approvalId } = hqSubmit(db, video, { type: "clip_video", title: "[demo] Clip", body: "A clip.", forRoom: "demo" });
  const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(approvalId) as ApprovalRow;
  assert.equal(row.room, "studio");
  assert.equal(row.agent_id, "video");
  assert.equal(row.for_room, "demo");
  // Its own room is no delivery.
  const own = hqSubmit(db, video, { type: "clip_video", title: "Own", body: "B", forRoom: "studio" });
  assert.equal((db.prepare("SELECT for_room FROM approvals WHERE id = ?").get(own.approvalId) as ApprovalRow).for_room, null);

  const scout = ctxOf(db, config, "demo", "scout");
  assert.throws(
    () => hqSubmit(db, scout, { type: "post", title: "T", body: "B", forRoom: "studio" }),
    /forRoom is only for the agents of a shared room, and room "demo" is not shared/,
  );
  assert.throws(() => hqSubmit(db, video, { type: "post", title: "T", body: "B", forRoom: "nowhere" }), /forRoom: unknown room "nowhere"/);
});

test("a delivery shows in the pile of the room that ordered, its decisions go back to the producing agent", async () => {
  const { config, db } = setup();
  const video = ctxOf(db, config, "studio", "video");
  const { approvalId } = hqSubmit(db, video, { type: "clip_video", title: "[demo] Clip", body: "A clip.", forRoom: "demo" });

  // The API shapes: forRoom on the item, the colour of the room that ordered on the desk.
  const state = getState(db, loadHome(config.home), schedulerInfo(config));
  const item = state.approvals.pending.find((a) => a.id === approvalId)!;
  assert.equal(item.room, "studio");
  assert.equal(item.agentId, "video");
  assert.equal(item.forRoom, "demo");
  const desk = await resolveDesk({ config, db, commands: new DeskCommands({ env: {} }) });
  const pile = desk.objects.find((object) => object.object === "pile")!;
  assert.deepEqual(pile.spines, [{ approvalId, room: "demo", color: "#ff3d7f" }]);
  const deskItem = pile.items.find((each) => each.id === `approval-${approvalId}`)!;
  assert.equal(deskItem.color, "#ff3d7f");
  assert.deepEqual(deskItem.ref, {
    kind: "approval",
    id: approvalId,
    room: "studio",
    agentId: "video",
    type: "clip_video",
    status: "pending",
    forRoom: "demo",
  });

  // Telegram says where it comes from and where it goes.
  const sent: string[] = [];
  await notifyPendingApprovals(db, async (text) => {
    sent.push(text);
    return true;
  }, {});
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /studio pour demo \/ Video : clip_video/);

  // A revise goes back to the studio's agent, not to the room that ordered.
  const seen: RunInput[] = [];
  const engine: Engine = {
    name: "claude",
    async *run(input) {
      seen.push(input);
      yield done;
    },
  };
  decideApproval(db, approvalId, { decision: "revise", note: "Shorter." }, config, { engine, send: async () => true });
  const [revise] = tasksOf(db, "studio", "video").filter((task) => task.source === "revise");
  assert.ok(revise);
  assert.equal(revise.ref_id, approvalId);
  assert.equal(tasksOf(db, "demo", "scout").length, 0);
  const run = db.prepare("SELECT * FROM runs WHERE room = 'studio' AND agent_id = 'video' AND reason = 'revise'").get() as RunRow;
  assert.ok(run, "the producing agent was woken");
  await waitForRun(db, run.id);
});

test("an order to a shared room wakes its agent", async () => {
  const { config, db } = setup();
  hqMessage(db, ctxOf(db, config, "demo", "scout"), { to: "script", room: "studio", text: "A script." });
  const seen: RunInput[] = [];
  const engine: Engine = {
    name: "claude",
    async *run(input) {
      seen.push(input);
      yield done;
    },
  };
  const [run] = wakeAgents(config, db, { engine, send: async () => true });
  assert.ok(run);
  assert.equal(run.room, "studio");
  assert.equal(run.agent_id, "script");
  assert.equal(run.reason, "message");
  assert.equal(run.task, WAKE_TASK);
  await waitForRun(db, run.id);
  assert.match(seen[0]!.prompt, /Your room is shared/);
  assert.match(seen[0]!.prompt, /\[task \d+, message\] Message from scout of room "demo"/);
});

/** An engine whose runs of the agents listed in `hold` wait until `release` is called. */
function holdingEngine(hold: string[]): { engine: Engine; release: () => void; seen: RunInput[] } {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: RunInput[] = [];
  return {
    seen,
    release: () => release(),
    engine: {
      name: "claude",
      async *run(input) {
        seen.push(input);
        if (hold.includes(input.agentId)) await gate;
        yield done;
      },
    },
  };
}

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("resources: two runs holding the GPU never run at once; a manual start gets RESOURCE_BUSY, a wake-up waits", async () => {
  const { config, db } = setup();
  const { engine, release } = holdingEngine(["video"]);
  const deps = { config, engine, send: async () => true };
  const first = startRun({ room: "studio", agent: "video" }, deps);
  assert.deepEqual(JSON.parse((db.prepare("SELECT resources FROM runs WHERE id = ?").get(first.id) as RunRow).resources), ["gpu"]);

  // A manual start of another GPU agent is refused with a clear error.
  assert.throws(
    () => startRun({ room: "studio", agent: "sound" }, deps),
    (error: unknown) => {
      assert.ok(error instanceof HqError);
      assert.equal(error.code, "RESOURCE_BUSY");
      assert.equal(error.status, 409);
      assert.match(error.message, new RegExp(`Resource "gpu" is held by run #${first.id} of studio/video`));
      return true;
    },
  );
  // An agent without the resource runs alongside.
  const script = startRun({ room: "studio", agent: "script" }, deps);
  await waitForRun(db, script.id);

  // A message to the sound engineer does not start it: the task waits, and the agent shows it.
  hqMessage(db, ctxOf(db, config, "demo", "scout"), { to: "sound", room: "studio", text: "A jingle." });
  assert.deepEqual(wakeAgents(config, db, deps), []);
  const [waiting] = tasksOf(db, "studio", "sound");
  assert.equal(waiting!.status, "pending");
  const sound = getState(db, loadHome(config.home), schedulerInfo(config))
    .rooms.find((room) => room.name === "studio")!
    .agents.find((each) => each.id === "sound")!;
  assert.deepEqual(sound.resources, ["gpu"]);
  assert.deepEqual(sound.waitingFor, ["gpu"]);

  // A routine of a GPU agent that comes due is journaled as skipped_busy.
  const home = loadHome(config.home);
  const studio = home.rooms.find((room) => room.name === "studio")!;
  const soundAgent = studio.agents.find((each) => each.id === "sound")!;
  db.prepare("UPDATE agents SET armed = 1 WHERE room = 'studio' AND id = 'sound'").run();
  const firing = fireRoutine(config, db, studio, soundAgent, { cron: "* * * * *", task: null }, new Date(), deps);
  assert.equal(firing.outcome, "skipped_busy");
  assert.match(firing.detail ?? "", /Resource "gpu"/);

  // When the GPU is released, the end of the holding run wakes the waiting agent.
  release();
  await waitForRun(db, first.id);
  await until(() => db.prepare("SELECT 1 FROM runs WHERE room = 'studio' AND agent_id = 'sound'").get() !== undefined);
  const woken = db.prepare("SELECT * FROM runs WHERE room = 'studio' AND agent_id = 'sound'").get() as RunRow;
  assert.equal(woken.reason, "message");
  await waitForRun(db, woken.id);
  assert.equal(tasksOf(db, "studio", "sound").find((task) => task.source === "message")!.status, "done");
  const after = getState(db, loadHome(config.home), schedulerInfo(config))
    .rooms.find((room) => room.name === "studio")!
    .agents.find((each) => each.id === "sound")!;
  assert.deepEqual(after.waitingFor, []);
});

test("the owner's start of any agent still works across rooms", async () => {
  const { config, db } = setup();
  const engine: Engine = {
    name: "claude",
    async *run() {
      yield done;
    },
  };
  for (const [room, agentId] of [
    ["demo", "scout"],
    ["studio", "video"],
    ["other", "social"],
  ] as const) {
    const run = startRun({ room, agent: agentId, task: "From the desk.", reason: "desk" }, { config, engine });
    assert.equal((await waitForRun(db, run.id)).status, "done");
  }
});
