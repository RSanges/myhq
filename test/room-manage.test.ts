import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { HqConfig } from "../src/server/config";
import { getDbAt, type Db } from "../src/server/db";
import { HqError } from "../src/server/errors";
import {
  archiveRoom,
  deleteRoom,
  deletionCheck,
  pauseRoom,
  removeAgent,
  restoreRoom,
  resumeRoom,
  roomPauses,
  workDirProblem,
} from "../src/server/room-manage";
import { loadHome } from "../src/server/rooms";
import { isArmed, Scheduler, setArmed } from "../src/server/routines";
import { buildSettingsView, saveSettings } from "../src/server/settings";
import { ensureWorktree } from "../src/server/worktree";
import { makeHome, makeRepo } from "./helpers";

// The gestures on a room of the settings page: pause and resume, archive and
// restore, remove an agent, delete. Each against a temporary home and base.

const agent = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id.toUpperCase(),
  role: `roles/${id}.md`,
  model: "haiku",
  allowedTools: ["mcp__hq__*"],
  ...extra,
});

/** A home with room "demo" of three agents: two with a routine (one armed), one without. */
function office(roomExtra: Record<string, unknown> = {}, agents?: unknown[]): { config: HqConfig; db: Db } {
  const config = makeHome(
    {},
    {
      name: "demo",
      targetRepo: "../demo-project",
      ...roomExtra,
      agents: agents ?? [
        agent("scout", { cron: "0 7 * * *", armed: true }),
        agent("analyst", { cron: "0 8 * * *" }),
        agent("writer"),
      ],
    },
  );
  const roles = path.join(config.home, "rooms", "demo", "roles");
  for (const id of ["scout", "analyst", "writer", "dev"]) fs.writeFileSync(path.join(roles, `${id}.md`), `You are ${id}.\n`);
  return { config, db: getDbAt(config.dbPath) };
}

const roomOf = (config: HqConfig, name = "demo") => loadHome(config.home).rooms.find((room) => room.name === name);
const armedOf = (config: HqConfig, db: Db, id: string) => isArmed(db, "demo", roomOf(config)!.agents.find((a) => a.id === id)!);
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof HqError) return error.code;
    throw error;
  }
  return null;
};
const startRunRow = (db: Db, room: string, agentId: string) =>
  db
    .prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at) VALUES (?, ?, 'claude', 't', 'running', ?)")
    .run(room, agentId, new Date().toISOString());
const pendingItem = (db: Db, room: string, agentId: string, forRoom: string | null = null) =>
  db
    .prepare(
      "INSERT INTO approvals (room, agent_id, type, title, body, status, for_room, created_at) VALUES (?, ?, 'post', 'T', 'B', 'pending', ?, ?)",
    )
    .run(room, agentId, forRoom, new Date().toISOString());

test("pausing disarms every armed routine of the room and resuming re-arms exactly those", () => {
  const { config, db } = office();
  setArmed(config, db, "demo", "analyst", true);
  setArmed(config, db, "demo", "analyst", false);
  assert.equal(armedOf(config, db, "scout"), true);
  assert.equal(armedOf(config, db, "analyst"), false);

  const pause = pauseRoom(config, db, "demo");
  assert.deepEqual(pause.armed, ["scout"]);
  assert.equal(armedOf(config, db, "scout"), false);
  assert.deepEqual(roomPauses(db).get("demo")?.armed, ["scout"]);
  // Pausing again keeps the first memory.
  assert.deepEqual(pauseRoom(config, db, "demo").armed, ["scout"]);

  assert.deepEqual(resumeRoom(config, db, "demo"), ["scout"]);
  assert.equal(armedOf(config, db, "scout"), true);
  assert.equal(armedOf(config, db, "analyst"), false);
  assert.equal(roomPauses(db).has("demo"), false);
  // A room that is not paused resumes nothing.
  assert.deepEqual(resumeRoom(config, db, "demo"), []);
  assert.equal(code(() => pauseRoom(config, db, "nope")), "ROOM_NOT_FOUND");
});

test("an archived room leaves the floor, the scheduler and the runs, keeps its folder and its base, and comes back paused", () => {
  const { config, db } = office();
  db.prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at, cost_usd) VALUES ('demo', 'scout', 'claude', 't', 'done', ?, 0.5)").run(
    new Date().toISOString(),
  );
  archiveRoom(config, db, "demo");

  const home = loadHome(config.home);
  assert.deepEqual(home.rooms.map((room) => room.name), []);
  assert.deepEqual(home.archived?.map((entry) => entry.room.name), ["demo"]);
  assert.ok(fs.existsSync(path.join(config.home, "rooms", "demo", "room.json")));
  const file = JSON.parse(fs.readFileSync(path.join(config.home, "myhq.json"), "utf8")) as { archivedRooms: { name: string; at: string }[] };
  assert.equal(file.archivedRooms[0]?.name, "demo");
  assert.match(file.archivedRooms[0]!.at, /^\d{4}-\d{2}-\d{2}$/);
  // The base keeps its rows: the room, its agents, its runs.
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM agents WHERE room = 'demo'").get() as { n: number }).n, 3);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM runs WHERE room = 'demo'").get() as { n: number }).n, 1);
  // Nothing of it fires: the scheduler sees no routine, and a gesture on it is refused.
  const scheduler = new Scheduler(config, db, {}, () => {});
  assert.deepEqual(scheduler.tick(new Date()), []);
  assert.equal(code(() => pauseRoom(config, db, "demo")), "ROOM_ARCHIVED");
  assert.equal(code(() => setArmed(config, db, "demo", "scout", true)), "ROOM_NOT_FOUND");
  // The settings list it apart.
  const view = buildSettingsView(config, db, {});
  assert.deepEqual(view.rooms.map((room) => room.name), []);
  assert.equal(view.archivedRooms[0]?.name, "demo");
  assert.equal(view.archivedRooms[0]?.totalRuns, 1);

  restoreRoom(config, db, "demo");
  assert.deepEqual(loadHome(config.home).rooms.map((room) => room.name), ["demo"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(config.home, "myhq.json"), "utf8")).archivedRooms, undefined);
  // Back paused, the armed agent remembered: resuming re-arms it.
  assert.equal(armedOf(config, db, "scout"), false);
  assert.deepEqual(roomPauses(db).get("demo")?.armed, ["scout"]);
  assert.equal(buildSettingsView(config, db, {}).rooms[0]?.state, "paused");
  assert.deepEqual(resumeRoom(config, db, "demo"), ["scout"]);
  assert.equal(code(() => restoreRoom(config, db, "demo")), "ROOM_NOT_ARCHIVED");
});

test("archiving is refused while a run of the room is in progress", () => {
  const { config, db } = office();
  startRunRow(db, "demo", "writer");
  assert.equal(code(() => archiveRoom(config, db, "demo")), "ROOM_BUSY");
  assert.equal(fs.existsSync(path.join(config.home, "myhq.json")), false);
  assert.equal(armedOf(config, db, "scout"), true);
});

test("removing an agent removes its block from room.json and nothing else", () => {
  const { config, db } = office({ color: "#ff3d7f", custom: undefined });
  const file = path.join(config.home, "rooms", "demo", "room.json");
  const work = path.join(config.home, "data", "work", "demo", "analyst");
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, "notes.md"), "kept\n");
  db.prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at) VALUES ('demo', 'analyst', 'claude', 't', 'done', ?)").run(
    new Date().toISOString(),
  );
  pauseRoom(config, db, "demo");

  const room = removeAgent(config, db, "demo", "analyst");
  assert.deepEqual(room.agents.map((a) => a.id), ["scout", "writer"]);
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { color: string; agents: { id: string }[] };
  assert.equal(raw.color, "#ff3d7f");
  assert.deepEqual(raw.agents.map((a) => a.id), ["scout", "writer"]);
  // Its role, its folder and its history stay.
  assert.ok(fs.existsSync(path.join(config.home, "rooms", "demo", "roles", "analyst.md")));
  assert.equal(fs.readFileSync(path.join(work, "notes.md"), "utf8"), "kept\n");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM runs WHERE agent_id = 'analyst'").get() as { n: number }).n, 1);
  assert.equal(code(() => removeAgent(config, db, "demo", "analyst")), "AGENT_NOT_FOUND");
});

test("removing an agent is refused while it runs, while an item of it waits, and for the last agent", () => {
  const { config, db } = office();
  const file = path.join(config.home, "rooms", "demo", "room.json");
  const before = fs.readFileSync(file, "utf8");
  startRunRow(db, "demo", "scout");
  assert.equal(code(() => removeAgent(config, db, "demo", "scout")), "AGENT_BUSY");
  pendingItem(db, "demo", "analyst");
  assert.equal(code(() => removeAgent(config, db, "demo", "analyst")), "AGENT_HAS_PENDING");
  assert.equal(fs.readFileSync(file, "utf8"), before);

  const single = office({}, [agent("writer")]);
  assert.equal(code(() => removeAgent(single.config, single.db, "demo", "writer")), "ROOM_LAST_AGENT");
});

test("a room's label is saved with the room settings and shown in the view, the name staying the identifier", () => {
  const { config, db } = office();
  saveSettings(config, db, "rooms", { rooms: [{ name: "demo", label: "Démo client", color: null, agents: [] }] });
  const raw = JSON.parse(fs.readFileSync(path.join(config.home, "rooms", "demo", "room.json"), "utf8")) as { name: string; label: string };
  assert.deepEqual([raw.name, raw.label], ["demo", "Démo client"]);
  assert.equal(roomOf(config)?.label, "Démo client");
  assert.equal(buildSettingsView(config, db, {}).rooms[0]?.label, "Démo client");
  // null takes it away: the name is shown again.
  saveSettings(config, db, "rooms", { rooms: [{ name: "demo", label: null, color: null, agents: [] }] });
  assert.equal(roomOf(config)?.label, null);
  // A label is one line of 60 characters at most.
  assert.throws(() => saveSettings(config, db, "rooms", { rooms: [{ name: "demo", label: "x".repeat(61), color: null, agents: [] }] }));
});

test("deleting a room needs its name typed and moves only its configuration to archives/rooms", () => {
  const { config, db } = office();
  const work = path.join(config.home, "data", "work", "demo", "scout");
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, "draft.md"), "draft\n");
  db.prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at, cost_usd) VALUES ('demo', 'scout', 'claude', 't', 'done', ?, 0.25)").run(
    new Date().toISOString(),
  );
  archiveRoom(config, db, "demo");

  assert.equal(code(() => deleteRoom(config, db, "demo", "dem")), "DELETE_CONFIRM_MISMATCH");
  assert.equal(code(() => deleteRoom(config, db, "other", "other")), "ROOM_NOT_FOUND");
  assert.equal(code(() => deleteRoom(config, db, "../demo", "../demo")), "ROOM_NOT_FOUND");

  const check = deletionCheck(config, db, "demo");
  assert.deepEqual(check.blocked, []);
  assert.equal(check.archived, true);
  assert.deepEqual(check.history, { runs: 1, costUsd: 0.25, items: 0 });
  assert.match(check.destination, /^archives\/rooms\/demo-\d{4}-\d{2}-\d{2}$/);

  const { destination } = deleteRoom(config, db, "demo", "demo");
  assert.equal(destination, check.destination);
  assert.equal(fs.existsSync(path.join(config.home, "rooms", "demo")), false);
  assert.ok(fs.existsSync(path.join(config.home, destination, "room.json")));
  assert.ok(fs.existsSync(path.join(config.home, destination, "roles", "scout.md")));
  // The working directories and the history stay where they are.
  assert.equal(fs.readFileSync(path.join(work, "draft.md"), "utf8"), "draft\n");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM runs WHERE room = 'demo'").get() as { n: number }).n, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(config.home, "myhq.json"), "utf8")).archivedRooms, undefined);
  assert.equal(roomPauses(db).has("demo"), false);
  const home = loadHome(config.home);
  assert.deepEqual([home.rooms.length, home.archived?.length], [0, 0]);
});

test("a second deletion of the same name on the same day gets a suffix", () => {
  const { config, db } = office();
  const first = deleteRoom(config, db, "demo", "demo").destination;
  const again = office();
  // The same home: a new room "demo" written by hand.
  fs.cpSync(path.join(again.config.home, "rooms", "demo"), path.join(config.home, "rooms", "demo"), { recursive: true });
  const second = deleteRoom(config, db, "demo", "demo").destination;
  assert.equal(second, `${first}-2`);
});

test("deleting a room is refused while a run is in progress and while an item of it or for it waits", () => {
  const { config, db } = office();
  startRunRow(db, "demo", "scout");
  assert.equal(code(() => deleteRoom(config, db, "demo", "demo")), "ROOM_DELETE_REFUSED");
  assert.deepEqual(deletionCheck(config, db, "demo").blocked, ["running"]);
  db.prepare("UPDATE runs SET status = 'done'").run();
  pendingItem(db, "studio", "editor", "demo");
  assert.deepEqual(deletionCheck(config, db, "demo").blocked, ["pending"]);
  assert.equal(code(() => deleteRoom(config, db, "demo", "demo")), "ROOM_DELETE_REFUSED");
  assert.ok(fs.existsSync(path.join(config.home, "rooms", "demo", "room.json")));
});

test("deleting a room is refused while a worktree holds uncommitted changes or commits off the default branch", () => {
  const repo = makeRepo();
  const branch = execFileSync("git", ["branch", "--show-current"], { cwd: repo, encoding: "utf8" }).trim();
  const { config, db } = office({}, [
    agent("dev", { worktree: "data/worktrees/demo/dev" }),
    agent("writer"),
  ]);
  // The target repository, relative to the home.
  const roomFile = path.join(config.home, "rooms", "demo", "room.json");
  const raw = JSON.parse(fs.readFileSync(roomFile, "utf8")) as Record<string, unknown>;
  raw.targetRepo = path.relative(config.home, repo);
  fs.writeFileSync(roomFile, JSON.stringify(raw));
  const tree = path.join(config.home, "data", "worktrees", "demo", "dev");
  ensureWorktree({ repo, dir: tree, branch: "hq/dev" });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: tree, stdio: "ignore" });
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");

  // Clean and on the default branch's commit: it passes.
  assert.equal(branch === "main" || branch === "master", true);
  assert.equal(workDirProblem(tree), null);
  assert.deepEqual(deletionCheck(config, db, "demo").blocked, []);

  fs.writeFileSync(path.join(tree, "new.txt"), "new\n");
  assert.deepEqual(workDirProblem(tree), { kind: "dirty", files: 1 });
  assert.equal(code(() => deleteRoom(config, db, "demo", "demo")), "ROOM_DELETE_REFUSED");

  git("add", ".");
  git("commit", "-q", "-m", "work");
  assert.deepEqual(workDirProblem(tree), { kind: "unmerged", commits: 1, branch });
  assert.deepEqual(deletionCheck(config, db, "demo").blocked, ["workDirs"]);

  // Merged into the default branch: it passes again.
  execFileSync("git", ["merge", "-q", "hq/dev"], { cwd: repo, stdio: "ignore" });
  assert.equal(workDirProblem(tree), null);
  const { destination } = deleteRoom(config, db, "demo", "demo");
  // The worktree did not move.
  assert.ok(fs.existsSync(path.join(tree, "new.txt")));
  assert.ok(fs.existsSync(path.join(config.home, destination, "room.json")));
});

test("a Git folder that cannot be checked refuses the deletion; a folder outside Git passes", () => {
  const { config, db } = office();
  const plain = path.join(config.home, "data", "work", "demo", "scout");
  fs.mkdirSync(plain, { recursive: true });
  assert.equal(workDirProblem(plain), null);
  // Git missing while the folder is a repository: refused, never a pass.
  fs.mkdirSync(path.join(plain, ".git"));
  const missing = () => {
    throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
  };
  assert.equal(workDirProblem(plain, missing)?.kind, "unchecked");
  const failing = () => {
    throw Object.assign(new Error("fatal"), { stderr: "fatal: unsafe repository" });
  };
  assert.equal(workDirProblem(plain, failing)?.kind, "unchecked");
  assert.deepEqual(deletionCheck(config, db, "demo", failing).blocked, ["workDirs"]);
  assert.equal(code(() => deleteRoom(config, db, "demo", "demo", failing)), "ROOM_DELETE_REFUSED");
});

test("a room folder that is a link out of the home is never moved", { skip: process.platform === "win32" }, () => {
  const { config, db } = office();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-outside-"));
  const roomDir = path.join(config.home, "rooms", "demo");
  fs.cpSync(roomDir, path.join(outside, "demo"), { recursive: true });
  fs.rmSync(roomDir, { recursive: true });
  fs.symlinkSync(path.join(outside, "demo"), roomDir, "dir");
  assert.equal(code(() => deleteRoom(config, db, "demo", "demo")), "ROOM_PATH_REFUSED");
  assert.ok(fs.existsSync(path.join(outside, "demo", "room.json")));
});

