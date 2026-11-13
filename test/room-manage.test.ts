import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { POST as pausePost } from "../src/app/api/rooms/[room]/pause/route";
import type { HqConfig } from "../src/server/config";
import { getDbAt, type Db, type RunRow } from "../src/server/db";
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

/**
 * What a fresh scheduler fires around 07:00 (Europe/Paris) on a day of
 * November: a first tick plans each routine it sees, a second one at 07:00
 * fires the routines due. A run is recorded instead of started.
 */
function firedAtSeven(config: HqConfig, db: Db): string[] {
  const start = (request: { room: string; agent: string }) =>
    db
      .prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at) VALUES (?, ?, 'claude', 'routine', 'done', ?) RETURNING *")
      .get(request.room, request.agent, new Date().toISOString()) as RunRow;
  const scheduler = new Scheduler(config, db, { start }, () => {});
  scheduler.tick(new Date("2026-11-16T05:59:00Z"), config);
  return scheduler.tick(new Date("2026-11-16T06:00:10Z"), config).map((firing) => `${firing.room}/${firing.agentId} ${firing.outcome}`);
}

test("an archived room leaves the floor, the scheduler and the runs, keeps its folder and its base, and comes back paused", () => {
  const { config, db } = office();
  db.prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at, cost_usd) VALUES ('demo', 'scout', 'claude', 't', 'done', ?, 0.5)").run(
    new Date().toISOString(),
  );
  // Before: the scout's routine of 07:00 fires (the analyst's, at 08:00, is not due).
  assert.deepEqual(firedAtSeven(config, db), ["demo/scout started"]);
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
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM runs WHERE room = 'demo'").get() as { n: number }).n, 2);
  // Nothing of it fires: the scheduler sees no routine, and a gesture on it is refused.
  // The same two ticks see no routine of it at all (not even a disarmed one to skip).
  assert.deepEqual(firedAtSeven(config, db), []);
  assert.equal(code(() => pauseRoom(config, db, "demo")), "ROOM_ARCHIVED");
  assert.equal(code(() => setArmed(config, db, "demo", "scout", true)), "ROOM_NOT_FOUND");
  // The settings list it apart.
  const view = buildSettingsView(config, db, {});
  assert.deepEqual(view.rooms.map((room) => room.name), []);
  assert.equal(view.archivedRooms[0]?.name, "demo");
  assert.equal(view.archivedRooms[0]?.totalRuns, 2);

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
  // The home is a repository (its .git outside the working directory): Git runs, and a failure refuses.
  fs.mkdirSync(path.join(config.home, ".git"));
  const seen: string[][] = [];
  const missing = (args: string[]) => {
    seen.push(args);
    throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
  };
  assert.equal(workDirProblem(plain, missing)?.kind, "unchecked");
  // Every Git command of the check turns fsmonitor off and takes no optional lock.
  assert.deepEqual(seen[0]?.slice(0, 3), ["-c", "core.fsmonitor=false", "--no-optional-locks"]);
  const failing = () => {
    throw Object.assign(new Error("fatal"), { stderr: "fatal: unsafe repository" });
  };
  assert.equal(workDirProblem(plain, failing)?.kind, "unchecked");
  const timedOut = () => {
    throw Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT", signal: "SIGTERM" });
  };
  assert.deepEqual(workDirProblem(plain, timedOut), { kind: "unchecked", detail: "git took more than 5 s" });
  assert.deepEqual(deletionCheck(config, db, "demo", failing).blocked, ["workDirs"]);
  assert.equal(code(() => deleteRoom(config, db, "demo", "demo", failing)), "ROOM_DELETE_REFUSED");
});

test("a working directory with its own repository is never inspected with Git, and only noted", () => {
  const { config, db } = office();
  const work = path.join(config.home, "data", "work", "demo", "scout");
  fs.mkdirSync(work, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: work, stdio: "ignore" });
  // A configuration the agent could write: a plain git status would run this command.
  const witness = path.join(config.home, "witness.txt");
  execFileSync("git", ["config", "core.fsmonitor", `echo pwned > "${witness.replace(/\\/g, "/")}"`], { cwd: work, stdio: "ignore" });
  fs.writeFileSync(path.join(work, "draft.md"), "draft\n");
  let calls = 0;
  const counting = (args: string[], cwd: string) => {
    calls += 1;
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  };
  const state = workDirProblem(work, counting);
  assert.equal(state?.kind, "ownRepo");
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(witness), false);
  const check = deletionCheck(config, db, "demo");
  assert.deepEqual(check.blocked, []);
  assert.equal(check.workDirs.find((entry) => entry.agent === "scout")?.notice?.kind, "ownRepo");
  assert.equal(check.workDirs.find((entry) => entry.agent === "scout")?.problem, null);
  assert.equal(fs.existsSync(witness), false);

  // A .git file that points to a Git directory inside the working directory is the same.
  const other = path.join(config.home, "data", "work", "demo", "analyst");
  fs.mkdirSync(path.join(other, "hidden", "objects"), { recursive: true });
  fs.writeFileSync(path.join(other, ".git"), "gitdir: hidden\n");
  calls = 0;
  assert.equal(workDirProblem(other, counting)?.kind, "ownRepo");
  assert.equal(calls, 0);
  // The deletion goes through and leaves both folders where they are.
  deleteRoom(config, db, "demo", "demo");
  assert.ok(fs.existsSync(path.join(work, "draft.md")));
  assert.equal(fs.existsSync(witness), false);
  // The trap was real: a plain status in that folder runs the command.
  execFileSync("git", ["status", "--porcelain"], { cwd: work, stdio: "ignore" });
  assert.equal(fs.existsSync(witness), true);
});

/** A link to a folder: a junction on Windows (no privilege needed), a symbolic link elsewhere. */
const linkDir = (target: string, link: string) => fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");

test("a room folder that is a link out of the home is never moved", () => {
  const { config, db } = office();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-outside-"));
  const roomDir = path.join(config.home, "rooms", "demo");
  fs.cpSync(roomDir, path.join(outside, "demo"), { recursive: true });
  fs.rmSync(roomDir, { recursive: true });
  linkDir(path.join(outside, "demo"), roomDir);
  // A linked folder is no room of the home: it is not loaded, so it cannot be named for a deletion.
  assert.deepEqual(loadHome(config.home).rooms, []);
  assert.ok(["ROOM_NOT_FOUND", "ROOM_PATH_REFUSED"].includes(code(() => deleteRoom(config, db, "demo", "demo")) ?? ""));
  assert.ok(fs.existsSync(path.join(outside, "demo", "room.json")));
});

test("an archives folder that is a link out of the home receives nothing", () => {
  const { config, db } = office();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-outside-"));
  fs.mkdirSync(path.join(config.home, "archives"), { recursive: true });
  linkDir(outside, path.join(config.home, "archives", "rooms"));
  assert.equal(code(() => deleteRoom(config, db, "demo", "demo")), "ROOM_PATH_REFUSED");
  assert.ok(fs.existsSync(path.join(config.home, "rooms", "demo", "room.json")));
  assert.deepEqual(fs.readdirSync(outside), []);
});


const savedHome = process.env.MYHQ_HOME;
afterEach(() => {
  if (savedHome === undefined) delete process.env.MYHQ_HOME;
  else process.env.MYHQ_HOME = savedHome;
});

test("HTTP: a gesture needs a JSON body, so that a plain form of another page cannot send it", async () => {
  const { config, db } = office();
  process.env.MYHQ_HOME = config.home;
  const post = (body: string, type: string | null) =>
    pausePost(
      new Request("http://localhost/api/rooms/demo/pause", {
        method: "POST",
        body,
        headers: type ? { "content-type": type } : {},
      }),
      { params: Promise.resolve({ room: "demo" }) },
    );
  const errorCode = async (response: Response) => ((await response.json()) as { error: { code: string } }).error.code;

  const form = await post("a=1", "application/x-www-form-urlencoded");
  assert.equal(form.status, 415);
  assert.equal(await errorCode(form), "UNSUPPORTED_MEDIA_TYPE");
  const plain = await post("{}", "text/plain");
  assert.equal(plain.status, 415);
  const none = await post("{}", null);
  assert.equal(none.status, 415);
  const extra = await post(JSON.stringify({ room: "other" }), "application/json");
  assert.equal(extra.status, 400);
  assert.equal(await errorCode(extra), "INVALID_INPUT");
  assert.equal(roomPauses(db).has("demo"), false);

  const ok = await post("{}", "application/json; charset=utf-8");
  assert.equal(ok.status, 200);
  assert.equal(roomPauses(db).has("demo"), true);
});

test("an archive entry whose room is gone is ignored, and dropped at the next write", () => {
  const { config, db } = office();
  fs.writeFileSync(path.join(config.home, "myhq.json"), JSON.stringify({ archivedRooms: [{ name: "vanished", at: "2026-10-01" }] }));
  const home = loadHome(config.home);
  assert.deepEqual([home.rooms.map((room) => room.name), home.archived?.length], [["demo"], 0]);
  assert.deepEqual(buildSettingsView(config, db, {}).archivedRooms, []);
  archiveRoom(config, db, "demo");
  const list = (JSON.parse(fs.readFileSync(path.join(config.home, "myhq.json"), "utf8")) as { archivedRooms: { name: string }[] }).archivedRooms;
  assert.deepEqual(list.map((entry) => entry.name), ["demo"]);
});

test("a deletion is refused while an agent's working directory lies under the room's folder", () => {
  const { config, db } = office({}, [agent("scout", { workingDirectory: "rooms/demo/work" }), agent("writer")]);
  fs.mkdirSync(path.join(config.home, "rooms", "demo", "work"), { recursive: true });
  const check = deletionCheck(config, db, "demo");
  assert.deepEqual(check.blocked, ["workDirs"]);
  assert.deepEqual(check.workDirs.find((entry) => entry.agent === "scout")?.problem, { kind: "insideRoom" });
  assert.equal(code(() => deleteRoom(config, db, "demo", "demo")), "ROOM_DELETE_REFUSED");
  assert.ok(fs.existsSync(path.join(config.home, "rooms", "demo", "work")));
});

test("a room created again under a deleted room's name starts from its own room.json", () => {
  const { config, db } = office();
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-room-copy-"));
  fs.cpSync(path.join(config.home, "rooms", "demo"), copy, { recursive: true });
  // MyHQ keeps the analyst armed and the scout disarmed, against room.json.
  setArmed(config, db, "demo", "analyst", true);
  setArmed(config, db, "demo", "scout", false);
  pauseRoom(config, db, "demo");
  deleteRoom(config, db, "demo", "demo");
  fs.cpSync(copy, path.join(config.home, "rooms", "demo"), { recursive: true });
  // room.json says scout armed, analyst not: that is what holds again.
  assert.equal(armedOf(config, db, "scout"), true);
  assert.equal(armedOf(config, db, "analyst"), false);
  assert.equal(roomPauses(db).has("demo"), false);
});

test("removing an agent writes room.json atomically and leaves no temporary file", () => {
  const { config, db } = office();
  const dir = path.join(config.home, "rooms", "demo");
  removeAgent(config, db, "demo", "writer");
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
  assert.match(fs.readFileSync(path.join(dir, "room.json"), "utf8"), /\n$/);
});
