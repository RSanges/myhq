import fs from "node:fs";
import path from "node:path";
import { ATTACHMENT_TYPES, AttachmentError, resolveInside } from "./attachments";
import type { Db, RunRow, RunStatus } from "./db";
import { HqError } from "./errors";
import { estimateCostUsd, journalUsage } from "./long-runs";
import { runSummary } from "./run-summary";
import type { Agent, Home, Room } from "./rooms";
import { patternRegExp, relativeInside } from "./write-guard-lib.mjs";

/**
 * The surveillance room (docs/architecture.md, "The surveillance room"): the
 * agents at work right now, each with the piece it works on. The piece is a
 * file of its working directory, either shown by the agent itself (hq_show,
 * `run_pins`) or followed by MyHQ through the patterns of its role
 * (room.json `pieces`): the matching files written during the run.
 */

export type PieceKind = "video" | "image" | "audio" | "text";

/** The text files a piece may be: shown as their path and a short excerpt, never served raw. */
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".csv", ".srt", ".vtt", ".html", ".css", ".js", ".ts", ".tsx", ".py", ".yaml", ".yml"]);

/** The kind of a piece from its name: the media kinds of the attachments, text from a short list, null otherwise. */
export function pieceKind(name: string): PieceKind | null {
  const ext = path.extname(name).toLowerCase();
  const kind = ATTACHMENT_TYPES[ext]?.kind;
  if (kind === "video" || kind === "image" || kind === "audio") return kind;
  return TEXT_EXTENSIONS.has(ext) ? "text" : null;
}

/** How long a finished run keeps its tile, greyed. */
export const LIVE_DONE_MS = 5 * 60_000;
/** The most versions of a piece a tile carries (the newest). */
export const PIECES_MAX = 12;
/** The most entries one walk of a working directory visits. */
const WALK_MAX = 5_000;
/** Folders a walk never enters. */
const SKIPPED_DIRS = new Set([".git", "node_modules", ".claude"]);
/** The longest status history a tile carries besides its latest status. */
const PREVIOUS_STATUSES = 3;
const EXCERPT_LINES = 40;
const EXCERPT_BYTES = 4096;

/** A file of the working directory that matches the piece patterns. */
export type FoundPiece = { relative: string; real: string; kind: PieceKind; mtimeMs: number; size: number };

/** The folders and files before the first wildcard of a pattern, normalized as patternRegExp reads it. */
function staticPrefix(pattern: string): string {
  const segments = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").split("/");
  const fixed: string[] = [];
  for (const segment of segments) {
    if (/[*?]/.test(segment)) break;
    fixed.push(segment);
  }
  return fixed.join("/");
}

/**
 * The files of `workDir` that match one of `patterns` (relative to it, as
 * room.json `pieces` gives them), of a piece kind, modified between `sinceMs`
 * and `untilMs`: newest first, PIECES_MAX at most. Each pattern is walked from
 * its static prefix; a walk never enters a directory link, `.git`,
 * `node_modules` or `.claude`, and visits WALK_MAX entries at most in all. A
 * file is matched by its real path relative to the real directory, so a link
 * that leads out is never listed.
 */
export function listPieces(workDir: string, patterns: readonly string[], sinceMs: number, untilMs: number): FoundPiece[] {
  let root: string;
  try {
    root = fs.realpathSync(workDir);
  } catch {
    return [];
  }
  const tests = patterns.map((pattern) => patternRegExp(pattern)).filter((test): test is RegExp => test !== null);
  const found = new Map<string, FoundPiece>();
  let budget = WALK_MAX;

  const consider = (file: string) => {
    let real: string;
    let stat: fs.Stats;
    try {
      real = fs.realpathSync(file);
      stat = fs.statSync(real);
    } catch {
      return;
    }
    const relative = relativeInside(root, real);
    if (!relative || !stat.isFile() || stat.mtimeMs < sinceMs || stat.mtimeMs > untilMs) return;
    const kind = pieceKind(relative);
    if (!kind || !tests.some((test) => test.test(relative))) return;
    found.set(relative, { relative, real, kind, mtimeMs: stat.mtimeMs, size: stat.size });
  };

  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (budget <= 0) return;
      budget -= 1;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        // A link is considered as a file only: consider() refuses a directory and anything outside.
        consider(full);
      }
    }
  };

  for (const pattern of patterns) {
    const start = path.join(root, staticPrefix(pattern));
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(start);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walk(start);
    else consider(start);
  }
  return [...found.values()].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, PIECES_MAX);
}

/** The start of a text piece: its first 40 lines or 4 KB. Null for a file that holds a NUL byte (binary) or cannot be read. */
export function readExcerpt(file: string): string | null {
  let bytes: Buffer;
  try {
    const handle = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(EXCERPT_BYTES);
      bytes = buffer.subarray(0, fs.readSync(handle, buffer, 0, EXCERPT_BYTES, 0));
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return null;
  }
  if (bytes.includes(0)) return null;
  return bytes.toString("utf8").split("\n").slice(0, EXCERPT_LINES).join("\n");
}

// Shapes returned by the API (documented in docs/api.md).

/** One version of a piece: a file as it was found or shown. */
export type PieceVersionDto = {
  /** Relative to the agent's working directory, in POSIX form. */
  path: string;
  kind: PieceKind;
  /** When the file was last written (followed), or when the agent showed it (pinned). */
  at: string;
  size: number;
  /** Where a media file is served (GET /api/live/runs/<id>/file); null for a text piece. */
  url: string | null;
  /** The start of a text piece; null otherwise, or for a text piece that cannot be read as text. */
  excerpt: string | null;
  /** Why the agent showed it (hq_show); null when followed. */
  caption: string | null;
};

export type LiveStatusDto = { text: string; at: string };

export type LiveTileDto = {
  runId: number;
  room: string;
  /** The name shown for the room (room.json `label`), null to show `room`. */
  roomLabel: string | null;
  roomColor: string | null;
  agentId: string;
  agentName: string;
  task: string;
  /** What the agent is asked to do, in one line (run-summary.ts); null: none (yet), the task says it. */
  taskSummary: string | null;
  /** working: its run is in progress; waiting: in progress, its latest status says it waits; done: ended under 5 minutes ago. */
  state: "working" | "waiting" | "done";
  runStatus: RunStatus;
  startedAt: string;
  endedAt: string | null;
  /** The cost of the run: estimated from its tokens while it runs, null when it cannot be. */
  costUsd: number | null;
  /** Its latest status (hq_status): while waiting, the reason. */
  status: LiveStatusDto | null;
  /** The statuses before the latest one, newest first, three at most. */
  previous: LiveStatusDto[];
  /** While waiting: since when. */
  waitingSince: string | null;
  /** The piece, its versions oldest first; null: a text-only tile (no pattern, no pin, nothing found). */
  piece: { source: "pin" | "auto"; versions: PieceVersionDto[] } | null;
};

const iso = (ms: number) => new Date(ms).toISOString();

const fileUrl = (runId: number, relative: string, mtimeMs: number) =>
  `/api/live/runs/${runId}/file?path=${encodeURIComponent(relative)}&v=${Math.floor(mtimeMs)}`;

function findAgent(home: Home, roomName: string, agentId: string): { room: Room; agent: Agent } | null {
  const room = home.rooms.find((each) => each.name === roomName);
  const agent = room?.agents.find((each) => each.id === agentId);
  return room && agent ? { room, agent } : null;
}

/** The end of a run's window: when it ended, or now. */
const windowEnd = (run: RunRow, now: number) => (run.ended_at ? Date.parse(run.ended_at) : now);

/** A run the room still shows: in progress, or ended under LIVE_DONE_MS ago. Older ones answer nothing. */
const inRoom = (run: RunRow, now: number) => run.status === "running" || (run.ended_at !== null && Date.parse(run.ended_at) >= now - LIVE_DONE_MS);

/** How long a listing of a working directory and the cost of a run are reused: a read every few seconds walks no folder twice. */
const CACHE_MS = 3_000;
const cache = new Map<string, { at: number; value: unknown }>();

function cached<T>(key: string, compute: () => T): T {
  const at = Date.now();
  const hit = cache.get(key);
  if (hit && at - hit.at < CACHE_MS) return hit.value as T;
  const value = compute();
  cache.set(key, { at, value });
  if (cache.size > 200) {
    for (const [stale, entry] of cache) if (at - entry.at >= CACHE_MS) cache.delete(stale);
  }
  return value;
}

function version(runId: number, found: { relative: string; real: string; kind: PieceKind; mtimeMs: number; size: number }, at: string, caption: string | null): PieceVersionDto {
  const text = found.kind === "text";
  return {
    path: found.relative,
    kind: found.kind,
    at,
    size: found.size,
    url: text ? null : fileUrl(runId, found.relative, found.mtimeMs),
    excerpt: text ? readExcerpt(found.real) : null,
    caption,
  };
}

/**
 * The pieces the agent showed during the run (hq_show), oldest first: the
 * latest pin of each file, the PIECES_MAX newest, those whose file is gone or
 * now leads out left out.
 */
function pinnedVersions(db: Db, run: RunRow, agent: Agent): PieceVersionDto[] {
  const pins = db
    .prepare(
      `SELECT p.path, p.caption, p.created_at FROM run_pins p
       WHERE p.run_id = ? AND p.id = (SELECT MAX(q.id) FROM run_pins q WHERE q.run_id = p.run_id AND q.path = p.path)
       ORDER BY p.id DESC LIMIT ?`,
    )
    .all(run.id, PIECES_MAX) as { path: string; caption: string; created_at: string }[];
  const versions: PieceVersionDto[] = [];
  const seen = new Set<string>();
  for (const pin of pins.reverse()) {
    let real: string;
    let relative: string;
    let stat: fs.Stats;
    try {
      ({ real, relative } = resolveInside(agent.workDir, pin.path, "pin"));
      stat = fs.statSync(real);
    } catch {
      continue;
    }
    const kind = pieceKind(relative);
    if (!kind || !stat.isFile() || seen.has(relative)) continue;
    seen.add(relative);
    versions.push(version(run.id, { relative, real, kind, mtimeMs: stat.mtimeMs, size: stat.size }, pin.created_at, pin.caption));
  }
  return versions;
}

function piece(db: Db, run: RunRow, agent: Agent | null, now: number): LiveTileDto["piece"] {
  if (!agent) return null;
  const pinned = pinnedVersions(db, run, agent);
  if (pinned.length > 0) return { source: "pin", versions: pinned };
  if (agent.pieces.length === 0) return null;
  const since = Date.parse(run.started_at);
  const key = ["pieces", agent.workDir, ...agent.pieces, since, run.ended_at ?? "running"].join("\n");
  const found = cached(key, () => listPieces(agent.workDir, agent.pieces, since, windowEnd(run, now)));
  if (found.length === 0) return null;
  return { source: "auto", versions: [...found].reverse().map((each) => version(run.id, each, iso(each.mtimeMs), null)) };
}

function costOf(db: Db, run: RunRow, agent: Agent | null, runsDir: string): number | null {
  if (run.status !== "running") return run.cost_usd;
  return cached(["cost", runsDir, run.id].join("\n"), () => runningCost(db, run, agent, runsDir));
}

/** The cost of a run in progress, estimated from the tokens of its journal and its model. */
function runningCost(db: Db, run: RunRow, agent: Agent | null, runsDir: string): number | null {
  const start = db.prepare("SELECT data FROM events WHERE run_id = ? AND type = 'start' ORDER BY id LIMIT 1").get(run.id) as
    | { data: string }
    | undefined;
  let model: string | null = agent?.model ?? null;
  try {
    const data = start ? (JSON.parse(start.data) as { model?: unknown }) : {};
    if (typeof data.model === "string" && data.model) model = data.model;
  } catch {
    // A malformed start event: the agent's model.
  }
  return estimateCostUsd(journalUsage(path.join(runsDir, `${run.id}.jsonl`)), model);
}

function tileOf(db: Db, home: Home, runsDir: string, run: RunRow, now: number): LiveTileDto {
  const found = findAgent(home, run.room, run.agent_id);
  const statuses = db
    .prepare(
      `SELECT s.text, s.created_at, EXISTS(SELECT 1 FROM run_waits w WHERE w.status_id = s.id) AS waiting
       FROM run_statuses s WHERE s.run_id = ? ORDER BY s.id DESC LIMIT ?`,
    )
    .all(run.id, PREVIOUS_STATUSES + 1) as { text: string; created_at: string; waiting: number }[];
  const latest = statuses[0];
  const running = run.status === "running";
  const waiting = running && latest?.waiting === 1;
  return {
    runId: run.id,
    room: run.room,
    roomLabel: found?.room.label ?? null,
    roomColor: found?.room.color ?? null,
    agentId: run.agent_id,
    agentName: found?.agent.name ?? run.agent_id,
    task: run.task,
    taskSummary: runSummary(db, run.id),
    state: !running ? "done" : waiting ? "waiting" : "working",
    runStatus: run.status,
    startedAt: run.started_at,
    endedAt: run.ended_at,
    costUsd: costOf(db, run, found?.agent ?? null, runsDir),
    status: latest ? { text: latest.text, at: latest.created_at } : null,
    previous: statuses.slice(1).map((status) => ({ text: status.text, at: status.created_at })),
    waitingSince: waiting && latest ? latest.created_at : null,
    piece: piece(db, run, found?.agent ?? null, now),
  };
}

/**
 * The tiles of the surveillance room (GET /api/live): every run in progress,
 * oldest first, then the runs ended under LIVE_DONE_MS ago, newest first; one
 * per agent (its run in progress, else its latest).
 */
export function readLiveRoom(db: Db, home: Home, runsDir: string, now: number = Date.now()): LiveTileDto[] {
  const running = db.prepare("SELECT * FROM runs WHERE status = 'running' ORDER BY started_at, id").all() as RunRow[];
  const ended = db
    .prepare("SELECT * FROM runs WHERE status <> 'running' AND ended_at >= ? ORDER BY ended_at DESC, id DESC")
    .all(iso(now - LIVE_DONE_MS)) as RunRow[];
  const seen = new Set<string>();
  const tiles: LiveTileDto[] = [];
  for (const run of [...running, ...ended]) {
    const key = `${run.room}\u0000${run.agent_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tiles.push(tileOf(db, home, runsDir, run, now));
  }
  return tiles;
}

/** One run as the detail panel shows it (GET /api/live/runs/<id>): its tile and all its statuses, oldest first. */
export function readLiveRun(
  db: Db,
  home: Home,
  runsDir: string,
  runId: number,
  now: number = Date.now(),
): { tile: LiveTileDto; timeline: { text: string; at: string; waiting: boolean }[] } {
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | undefined;
  if (!run || !inRoom(run, now)) throw new HqError("RUN_NOT_FOUND", 404, `No run #${runId} in the room.`);
  const timeline = (
    db
      .prepare(
        `SELECT s.text, s.created_at, EXISTS(SELECT 1 FROM run_waits w WHERE w.status_id = s.id) AS waiting
         FROM run_statuses s WHERE s.run_id = ? ORDER BY s.id`,
      )
      .all(runId) as { text: string; created_at: string; waiting: number }[]
  ).map((status) => ({ text: status.text, at: status.created_at, waiting: status.waiting === 1 }));
  return { tile: tileOf(db, home, runsDir, run, now), timeline };
}

/**
 * The media file of a run that GET /api/live/runs/<id>/file may serve, opened
 * once: inside the agent's working directory once links are followed, a
 * regular file of a media kind, at most `maxBytes`, and either shown by this
 * run (hq_show) or matching the agent's patterns, outside `.git`,
 * `node_modules` and `.claude`, with a modification time inside the run. The
 * run must still be in the room (in progress, or ended under LIVE_DONE_MS
 * ago). The checks that matter are made on the open descriptor (a regular
 * file, the same device and inode as the path checked, its size), which the
 * caller streams from and closes: the file is never reopened by its path.
 * Anything else, a missing run or agent or a file that vanishes included, is
 * the same 404, which does not tell whether the file exists.
 */
export function liveFile(
  db: Db,
  home: Home,
  runId: number,
  raw: string,
  maxBytes: number,
  now: number = Date.now(),
): { fd: number; path: string; name: string; mime: string; size: number; mtimeMs: number } {
  const notFound = () => new HqError("FILE_NOT_FOUND", 404, `Run #${runId} shows no such file: not found.`);
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | undefined;
  const found = run ? findAgent(home, run.room, run.agent_id) : null;
  if (!run || !found || !inRoom(run, now)) throw notFound();
  let inside: { real: string; relative: string };
  try {
    inside = resolveInside(found.agent.workDir, raw, "file");
  } catch (error) {
    if (error instanceof AttachmentError) throw notFound();
    throw error;
  }
  const kind = pieceKind(inside.relative);
  if (!kind || kind === "text") throw notFound();
  const pinned = db.prepare("SELECT 1 FROM run_pins WHERE run_id = ? AND path = ?").get(runId, inside.relative) !== undefined;
  const followable =
    !inside.relative.split("/").some((segment) => SKIPPED_DIRS.has(segment)) &&
    found.agent.pieces.some((pattern) => patternRegExp(pattern)?.test(inside.relative) ?? false);
  if (!pinned && !followable) throw notFound();
  let fd: number | undefined;
  try {
    const checked = fs.statSync(inside.real);
    fd = fs.openSync(inside.real, "r");
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.dev !== checked.dev || stat.ino !== checked.ino || stat.size > maxBytes) throw notFound();
    if (!pinned && (stat.mtimeMs < Date.parse(run.started_at) || stat.mtimeMs > windowEnd(run, now))) throw notFound();
    return {
      fd,
      path: inside.real,
      name: path.basename(inside.real),
      mime: ATTACHMENT_TYPES[path.extname(inside.real).toLowerCase()]!.mime,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    // A file that vanished or cannot be read is refused like any other, without its path.
    throw error instanceof HqError ? error : notFound();
  }
}
