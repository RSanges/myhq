import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { writeRoomFile } from "./agent-proposal";
import { isInside, liveConfig, type HqConfig } from "./config";
import { now, type Db } from "./db";
import { HqError } from "./errors";
import { writeHomeKeys } from "./home-file";
import { readArchivedRooms } from "./home-settings";
import { loadHome, roomFileSchema, syncHome, toPosix, type Home, type Room } from "./rooms";
import { isArmed, setArmed } from "./routines";
import { dayKey } from "./time";

// The gestures on a room of the settings page (/reglages, tab « Salles »):
// pause and resume, archive and restore, remove an agent, delete the room.
// None of them erases anything:
// - the armed state stays where it lives (the database, over room.json); a
//   pause remembers which agents were armed (`room_pauses`, migration 24);
// - an archived room is named in `archivedRooms` of myhq.json: loadHome leaves
//   it out of `rooms`, so the floor, the desk lists, the scheduler and every
//   wake-up stop seeing it, while its folder and its history stay as they are;
// - removing an agent removes its block from room.json only (its role file,
//   its working directory and its history stay);
// - deleting a room moves `rooms/<name>/` to `archives/rooms/<name>-<day>/`
//   and leaves its working directories, worktrees and history where they are.

/** The body of the gestures POST /api/rooms/<room>/(pause|resume|archive|restore): an empty JSON object. */
export const gestureBodySchema = z.strictObject({});

/** The body of DELETE /api/rooms/<room>: the room's name typed by the owner. */
export const deleteRoomSchema = z.strictObject({ confirm: z.string().max(200) });

/** The folder, relative to the home, where deleted rooms' configuration goes. */
export const ARCHIVES_DIR = path.join("archives", "rooms");

// --- Pauses --------------------------------------------------------------------

export type RoomPause = { armed: string[]; pausedAt: string };

/** The paused rooms, by name. */
export function roomPauses(db: Db): Map<string, RoomPause> {
  const rows = db.prepare("SELECT room, armed, paused_at FROM room_pauses").all() as {
    room: string;
    armed: string;
    paused_at: string;
  }[];
  return new Map(
    rows.map((row) => {
      let armed: string[] = [];
      try {
        const parsed: unknown = JSON.parse(row.armed);
        if (Array.isArray(parsed)) armed = parsed.filter((id): id is string => typeof id === "string");
      } catch {
        // An unreadable list re-arms nobody.
      }
      return [row.room, { armed, pausedAt: row.paused_at }];
    }),
  );
}

/** A room of the floor (never an archived one), or ROOM_NOT_FOUND / ROOM_INVALID. */
function floorRoom(home: Home, name: string): Room {
  const room = home.rooms.find((each) => each.name === name);
  if (room) return room;
  const invalid = home.invalid.find((each) => path.basename(each.dir) === name);
  if (invalid) throw new HqError("ROOM_INVALID", 422, `Room "${name}" is invalid: ${invalid.error}`);
  if (home.archived?.some((each) => each.room.name === name)) {
    throw new HqError("ROOM_ARCHIVED", 409, `Room "${name}" is archived: restore it first.`);
  }
  throw new HqError("ROOM_NOT_FOUND", 404, `No room "${name}" in the home.`);
}

/**
 * Pauses a room: disarms every armed routine of its agents at once and
 * remembers which agents were armed. A room already paused stays as it is.
 */
export function pauseRoom(config: HqConfig, db: Db, name: string): RoomPause {
  const room = floorRoom(loadHome(config.home), name);
  const known = roomPauses(db).get(name);
  if (known) return known;
  const armed = room.agents.filter((agent) => agent.routines.length > 0 && isArmed(db, name, agent)).map((agent) => agent.id);
  for (const id of armed) setArmed(config, db, name, id, false);
  const pausedAt = now();
  db.prepare("INSERT INTO room_pauses (room, armed, paused_at) VALUES (?, ?, ?)").run(name, JSON.stringify(armed), pausedAt);
  return { armed, pausedAt };
}

/**
 * Resumes a paused room: re-arms exactly the agents that were armed when it
 * was paused (those still in the room), and forgets the pause. Returns the
 * agents re-armed; a room that is not paused stays as it is.
 */
export function resumeRoom(config: HqConfig, db: Db, name: string): string[] {
  const room = floorRoom(loadHome(config.home), name);
  const pause = roomPauses(db).get(name);
  if (!pause) return [];
  const rearmed = pause.armed.filter((id) => room.agents.some((agent) => agent.id === id && agent.routines.length > 0));
  for (const id of rearmed) setArmed(config, db, name, id, true);
  db.prepare("DELETE FROM room_pauses WHERE room = ?").run(name);
  return rearmed;
}

// --- Archives --------------------------------------------------------------------

/** The run of the room in progress, if any (the newest). */
function runningRun(db: Db, room: string, agent?: string): { agent: string; since: string } | null {
  const row = db
    .prepare(
      `SELECT agent_id, started_at FROM runs WHERE room = ? AND status = 'running'${agent ? " AND agent_id = ?" : ""}
       ORDER BY id DESC LIMIT 1`,
    )
    .get(...(agent ? [room, agent] : [room])) as { agent_id: string; started_at: string } | undefined;
  return row ? { agent: row.agent_id, since: row.started_at } : null;
}

/** The day of today in the home's time zone (YYYY-MM-DD). */
const today = (config: HqConfig): string => dayKey(new Date(), liveConfig(config).timeZone);

/**
 * Archives a room: pauses it, then names it in `archivedRooms` of myhq.json.
 * Nothing moves on disk and nothing is deleted from the database. Refused
 * while a run of the room is in progress (ROOM_BUSY).
 */
export function archiveRoom(config: HqConfig, db: Db, name: string): void {
  floorRoom(loadHome(config.home), name);
  const run = runningRun(db, name);
  if (run) throw new HqError("ROOM_BUSY", 409, `A run of "${name}" is in progress (${run.agent}): wait for its end.`);
  pauseRoom(config, db, name);
  const list = readArchivedRooms(config.home).rooms.filter((entry) => entry.name !== name);
  writeHomeKeys(config.home, { archivedRooms: [...list, { name, at: today(config) }] });
  syncHome(db, loadHome(config.home));
}

/**
 * Restores an archived room: it leaves `archivedRooms` and comes back on the
 * floor paused (its pause kept, or a new one when it has none).
 */
export function restoreRoom(config: HqConfig, db: Db, name: string): void {
  const list = readArchivedRooms(config.home).rooms;
  if (!list.some((entry) => entry.name === name)) throw new HqError("ROOM_NOT_ARCHIVED", 404, `Room "${name}" is not archived.`);
  const rest = list.filter((entry) => entry.name !== name);
  writeHomeKeys(config.home, { archivedRooms: rest.length > 0 ? rest : undefined });
  const home = loadHome(config.home);
  syncHome(db, home);
  // A room whose folder is gone or invalid has nothing to pause.
  if (home.rooms.some((room) => room.name === name)) pauseRoom(config, db, name);
}

// --- Removing an agent ---------------------------------------------------------------

/** Items waiting for a decision: of an agent, or of a room (its own or addressed to it). */
function pendingItems(db: Db, room: string, agent?: string): number {
  const row = agent
    ? db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending' AND room = ? AND agent_id = ?").get(room, agent)
    : db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending' AND (room = ? OR for_room = ?)").get(room, room);
  return (row as { n: number }).n;
}

/**
 * Removes an agent from its room: its block leaves room.json (written by the
 * proposals' writer, the room loaded again after it), nothing else. Refused
 * while it runs (AGENT_BUSY), while one of its items waits for a decision
 * (AGENT_HAS_PENDING), or when it is the last agent of the room
 * (ROOM_LAST_AGENT: archive or delete the room instead).
 */
export function removeAgent(config: HqConfig, db: Db, roomName: string, agentId: string): Room {
  const room = floorRoom(loadHome(config.home), roomName);
  if (!room.agents.some((agent) => agent.id === agentId)) {
    throw new HqError("AGENT_NOT_FOUND", 404, `No agent "${agentId}" in room "${roomName}".`);
  }
  if (room.agents.length === 1) {
    throw new HqError("ROOM_LAST_AGENT", 409, `"${agentId}" is the last agent of "${roomName}": archive or delete the room instead.`);
  }
  const run = runningRun(db, roomName, agentId);
  if (run) throw new HqError("AGENT_BUSY", 409, `"${agentId}" is running since ${run.since}: wait for the end of its run.`);
  const pending = pendingItems(db, roomName, agentId);
  if (pending > 0) {
    throw new HqError("AGENT_HAS_PENDING", 409, `${pending} item(s) of "${agentId}" wait for a decision on the desk.`);
  }
  const file = path.join(room.dir, "room.json");
  const original = fs.readFileSync(file, "utf8");
  const raw = JSON.parse(original) as Record<string, unknown>;
  const agents = Array.isArray(raw.agents) ? (raw.agents as { id?: unknown }[]) : [];
  const next = { ...raw, agents: agents.filter((agent) => agent.id !== agentId) };
  const checked = roomFileSchema.safeParse(next);
  if (!checked.success) {
    const details = checked.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
    throw new HqError("ROOM_INVALID", 422, `${file}: ${details}`);
  }
  // The keys MyHQ does not know stay: the raw object is written, not the parsed one.
  const loaded = writeRoomFile(config, room.dir, original, next, "ROOM_INVALID");
  syncHome(db, loadHome(config.home));
  const pause = roomPauses(db).get(roomName);
  if (pause?.armed.includes(agentId)) {
    db.prepare("UPDATE room_pauses SET armed = ? WHERE room = ?").run(
      JSON.stringify(pause.armed.filter((id) => id !== agentId)),
      roomName,
    );
  }
  return loaded;
}

// --- Deleting a room -------------------------------------------------------------------

/** Runs Git in `cwd` and returns its trimmed output; throws on a failure (exit code, missing binary, timeout). */
export type GitRunner = (args: string[], cwd: string) => string;

/** How long one Git command of the check may take. */
export const GIT_TIMEOUT_MS = 5_000;

const runGit: GitRunner = (args, cwd) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
  }).trim();

/**
 * Every Git command of the check runs with these: no fsmonitor hook and no
 * optional lock, so that a status never runs a program named in a
 * configuration, nor writes the index.
 */
const SAFE_GIT = ["-c", "core.fsmonitor=false", "--no-optional-locks"];

const gitMessage = (error: unknown): string => {
  if ((error as { signal?: string }).signal === "SIGTERM" || (error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    return `git took more than ${GIT_TIMEOUT_MS / 1000} s`;
  }
  const stderr = (error as { stderr?: string | Buffer }).stderr?.toString().trim();
  return stderr || (error instanceof Error ? error.message : String(error));
};

const realOrResolved = (p: string): string => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};

/**
 * The Git directory Git would use for `dir`, found without running Git: the
 * nearest `.git` going up from `dir` (a folder is the Git directory; a file
 * names it on its `gitdir:` line, relative to the file), with links followed.
 * Null when there is none: the folder is not under Git. A `.git` file that
 * cannot be read stands for itself.
 */
export function resolveGitDir(dir: string): string | null {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    const entry = path.join(current, ".git");
    let stat: fs.Stats | null;
    try {
      stat = fs.statSync(entry);
    } catch {
      stat = null;
    }
    if (stat?.isDirectory()) return realOrResolved(entry);
    if (stat?.isFile()) {
      try {
        const line = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(entry, "utf8"))?.[1];
        return line ? realOrResolved(path.resolve(current, line)) : realOrResolved(entry);
      } catch {
        return realOrResolved(entry);
      }
    }
    if (path.dirname(current) === current) return null;
  }
}

const samePath = (a: string, b: string): boolean => {
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

/** Why a working directory blocks a deletion: uncommitted changes, commits off the default branch, or a check that could not be done. */
export type WorkDirProblem =
  | { kind: "dirty"; files: number }
  | { kind: "unmerged"; commits: number; branch: string }
  | { kind: "unchecked"; detail: string };

/**
 * A working directory that holds its own Git repository (its Git directory
 * inside it, where the agent may have written the configuration): MyHQ never
 * runs Git there, and says so without blocking (a deletion does not move it).
 */
export type WorkDirNotice = { kind: "ownRepo"; gitdir: string };

/**
 * Checks an agent's working directory before its room is deleted. A folder
 * that does not exist or is not under Git passes. Git only ever runs on a
 * repository the agent cannot configure: when the Git directory (found
 * without Git, `resolveGitDir`) is inside the working directory, the answer is
 * a notice and no Git command runs, since a configuration written by the agent
 * could make a mere `git status` run a program in this process. Otherwise,
 * with fsmonitor off, no optional lock and a timeout: the files of the folder
 * must have no uncommitted change (untracked files count, ignored ones do
 * not); and when the folder is a worktree of its own, its HEAD must hold no
 * commit that is not on the default branch of its repository (`origin/HEAD`,
 * else a local `main` or `master`). Conservative: a Git folder that cannot be
 * checked is a problem, never a pass.
 */
export function workDirProblem(dir: string, git: GitRunner = runGit): WorkDirProblem | WorkDirNotice | null {
  if (!fs.existsSync(dir)) return null;
  const gitdir = resolveGitDir(dir);
  if (gitdir === null) return null;
  const real = realOrResolved(dir);
  if (isInside(real, gitdir)) return { kind: "ownRepo", gitdir };
  const run = (args: string[]) => git([...SAFE_GIT, ...args], dir);
  let top: string;
  try {
    top = run(["rev-parse", "--show-toplevel"]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "unchecked", detail: "git is not available" };
    return { kind: "unchecked", detail: gitMessage(error) };
  }
  try {
    const status = run(["status", "--porcelain", "--untracked-files=all", "--", "."]);
    if (status !== "") return { kind: "dirty", files: status.split("\n").length };
    // A folder inside another repository (the home, say) holds no commit of its own.
    if (!samePath(realOrResolved(top), real)) return null;
    let head = true;
    try {
      run(["rev-parse", "--verify", "-q", "HEAD"]);
    } catch {
      head = false;
    }
    // A repository without any commit has nothing to lose but its files, checked above.
    if (!head) return null;
    const refs: string[] = [];
    try {
      refs.push(run(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]));
    } catch {
      // No remote default: the local branches below.
    }
    for (const branch of ["main", "master"]) {
      try {
        run(["rev-parse", "--verify", "-q", `refs/heads/${branch}`]);
        refs.push(branch);
      } catch {
        // Not there.
      }
    }
    const targets = refs.filter((ref) => ref !== "");
    if (targets.length === 0) return { kind: "unchecked", detail: "no default branch found (origin/HEAD, main or master)" };
    const count = Number(run(["rev-list", "--count", "HEAD", "--not", ...targets]));
    if (!Number.isInteger(count)) return { kind: "unchecked", detail: "git rev-list gave no count" };
    return count > 0 ? { kind: "unmerged", commits: count, branch: targets[0]! } : null;
  } catch (error) {
    return { kind: "unchecked", detail: gitMessage(error) };
  }
}

export type DeletionCheck = {
  room: string;
  label: string | null;
  archived: boolean;
  running: { agent: string; since: string } | null;
  /** Items of the room, or addressed to it, that wait for a decision. */
  pending: number;
  /** The working directories (relative to the home) and what blocks each, null when it may go. */
  /** And, apart, a working directory with its own repository: never inspected, never blocking. */
  workDirs: { agent: string; dir: string; problem: WorkDirProblem | null; notice: WorkDirNotice | null }[];
  /** What blocks the deletion, empty when it may go. */
  blocked: ("running" | "pending" | "workDirs")[];
  /** The configuration folder, relative to the home, and where it would go. */
  configDir: string;
  destination: string;
  history: { runs: number; costUsd: number; items: number };
  agents: number;
};

/** The room as a deletion accepts it: loaded from the home, on the floor or archived. */
function loadedRoom(home: Home, name: string): { room: Room; archived: boolean } {
  const room = home.rooms.find((each) => each.name === name);
  if (room) return { room, archived: false };
  const archived = home.archived?.find((each) => each.room.name === name);
  if (archived) return { room: archived.room, archived: true };
  throw new HqError("ROOM_NOT_FOUND", 404, `No room "${name}" loaded from the home.`);
}

/** `archives/rooms/<name>-<day>`, with `-2`, `-3`... when it is taken. Relative to the home. */
function destinationOf(config: HqConfig, name: string): string {
  const base = path.join(ARCHIVES_DIR, `${name}-${today(config)}`);
  let candidate = base;
  for (let n = 2; fs.existsSync(path.join(config.home, candidate)); n++) candidate = `${base}-${n}`;
  return candidate;
}

/** What deleting a room would do, and what blocks it now. Read only. */
export function deletionCheck(config: HqConfig, db: Db, name: string, git: GitRunner = runGit): DeletionCheck {
  const { room, archived } = loadedRoom(loadHome(config.home), name);
  const running = runningRun(db, name);
  const pending = pendingItems(db, name);
  const seen = new Set<string>();
  const workDirs = room.agents.flatMap((agent) => {
    if (seen.has(agent.workDir)) return [];
    seen.add(agent.workDir);
    const state = workDirProblem(agent.workDir, git);
    const notice = state?.kind === "ownRepo" ? { kind: "ownRepo" as const, gitdir: toPosix(path.relative(config.home, state.gitdir)) } : null;
    const problem = state && state.kind !== "ownRepo" ? state : null;
    return [{ agent: agent.id, dir: toPosix(path.relative(config.home, agent.workDir)), problem, notice }];
  });
  const blocked: DeletionCheck["blocked"] = [];
  if (running) blocked.push("running");
  if (pending > 0) blocked.push("pending");
  if (workDirs.some((entry) => entry.problem !== null)) blocked.push("workDirs");
  const history = db
    .prepare("SELECT COUNT(*) AS runs, COALESCE(SUM(cost_usd), 0) AS costUsd FROM runs WHERE room = ?")
    .get(name) as { runs: number; costUsd: number };
  const items = (db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE room = ? OR for_room = ?").get(name, name) as { n: number }).n;
  return {
    room: name,
    label: room.label ?? null,
    archived,
    running,
    pending,
    workDirs,
    blocked,
    configDir: toPosix(path.relative(config.home, room.dir)),
    destination: toPosix(destinationOf(config, name)),
    history: { ...history, items },
    agents: room.agents.length,
  };
}

/**
 * Deletes a room, which erases nothing: its configuration folder
 * `rooms/<name>/` moves to `archives/rooms/<name>-<day>/`, the room leaves the
 * floor (and `archivedRooms`), and its working directories, worktrees and
 * history stay exactly where they are. `confirm` must be the room's name.
 * Refused (ROOM_DELETE_REFUSED) while a run is in progress, an item waits for
 * a decision, or a working directory holds work not on its default branch.
 * Every path is checked inside the home once its links are followed.
 */
export function deleteRoom(config: HqConfig, db: Db, name: string, confirm: string, git: GitRunner = runGit): { destination: string } {
  if (confirm.trim() !== name) throw new HqError("DELETE_CONFIRM_MISMATCH", 400, `Type the room's name, "${name}", to delete it.`);
  const check = deletionCheck(config, db, name, git);
  if (check.blocked.length > 0) {
    const reasons = [
      check.running ? `a run is in progress (${check.running.agent})` : null,
      check.pending > 0 ? `${check.pending} item(s) wait for a decision` : null,
      ...check.workDirs.filter((entry) => entry.problem).map((entry) => `${entry.dir}: ${describeProblem(entry.problem!)}`),
    ].filter(Boolean);
    throw new HqError("ROOM_DELETE_REFUSED", 409, `Room "${name}" was not deleted: ${reasons.join("; ")}.`);
  }
  const homeReal = fs.realpathSync.native(config.home);
  const roomsReal = fs.realpathSync.native(path.join(config.home, "rooms"));
  const source = path.join(config.home, "rooms", name);
  if (fs.lstatSync(source).isSymbolicLink()) throw new HqError("ROOM_PATH_REFUSED", 409, `rooms/${name} is a link: move it by hand.`);
  const sourceReal = fs.realpathSync.native(source);
  if (!isInside(homeReal, roomsReal) || !samePath(path.dirname(sourceReal), roomsReal)) {
    throw new HqError("ROOM_PATH_REFUSED", 409, `rooms/${name} leads out of the home: nothing was moved.`);
  }
  const archives = path.join(config.home, ARCHIVES_DIR);
  fs.mkdirSync(archives, { recursive: true });
  if (!isInside(homeReal, fs.realpathSync.native(archives))) {
    throw new HqError("ROOM_PATH_REFUSED", 409, `${toPosix(ARCHIVES_DIR)} leads out of the home: nothing was moved.`);
  }
  const target = path.join(config.home, check.destination);
  fs.renameSync(sourceReal, target);
  const list = readArchivedRooms(config.home).rooms;
  if (list.some((entry) => entry.name === name)) {
    const rest = list.filter((entry) => entry.name !== name);
    writeHomeKeys(config.home, { archivedRooms: rest.length > 0 ? rest : undefined });
  }
  // The pause is no history: a new room of the same name starts unpaused.
  db.prepare("DELETE FROM room_pauses WHERE room = ?").run(name);
  syncHome(db, loadHome(config.home));
  return { destination: check.destination };
}

function describeProblem(problem: WorkDirProblem): string {
  switch (problem.kind) {
    case "dirty":
      return `${problem.files} uncommitted change(s)`;
    case "unmerged":
      return `${problem.commits} commit(s) not on ${problem.branch}`;
    case "unchecked":
      return `could not be checked (${problem.detail})`;
  }
}
