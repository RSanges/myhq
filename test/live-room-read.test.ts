import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getDbAt, type Db } from "../src/server/db";
import { listPieces, liveFile, readExcerpt, readLiveRoom, readLiveRun, LIVE_DONE_MS, PIECES_MAX } from "../src/server/live-room";
import { loadHome, syncHome, type Home } from "../src/server/rooms";
import { hqShow, hqStatus, PINS_MAX } from "../src/mcp/tools";
import { makeHome } from "./helpers";

const MINUTE = 60_000;
const NOW = Date.parse("2026-11-13T20:05:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** Writes a file and sets its modification time. */
function write(file: string, content: string | Buffer, mtimeMs: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
}

// --- listPieces ----------------------------------------------------------------------

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "myhq-pieces-"));
}

test("listPieces: the matching files written in the window, newest first, real POSIX paths", () => {
  const work = scratch();
  const start = NOW - 30 * MINUTE;
  write(path.join(work, "renders", "take-1.mp4"), "1", start + MINUTE);
  write(path.join(work, "renders", "take-2.mp4"), "2", start + 3 * MINUTE);
  write(path.join(work, "renders", "old.mp4"), "0", start - MINUTE);
  write(path.join(work, "renders", "frames", "f-001.png"), "f", start + 2 * MINUTE);
  write(path.join(work, "renders", "notes.zip"), "z", start + 2 * MINUTE);
  write(path.join(work, "draft.md"), "d", start + 4 * MINUTE);
  const found = listPieces(work, ["renders/*.mp4", "./draft.md"], start, NOW);
  assert.deepEqual(
    found.map((piece) => [piece.relative, piece.kind]),
    [
      ["draft.md", "text"],
      ["renders/take-2.mp4", "video"],
      ["renders/take-1.mp4", "video"],
    ],
  );
  assert.equal(found[1]!.real, fs.realpathSync(path.join(work, "renders", "take-2.mp4")));
  assert.equal(found[1]!.size, 1);
  assert.deepEqual(listPieces(path.join(work, "missing"), ["**"], 0, NOW), []);
  assert.deepEqual(listPieces(work, ["nothing/**"], 0, NOW), []);
});

test("listPieces: at most 12, skips .git, node_modules and .claude, never follows a directory link", (t) => {
  const work = scratch();
  for (let i = 0; i < 15; i++) write(path.join(work, "out", `v${String(i).padStart(2, "0")}.png`), "x", NOW - (20 - i) * MINUTE);
  for (const skipped of [".git", "node_modules", ".claude"]) write(path.join(work, skipped, "x.png"), "x", NOW - MINUTE);
  const found = listPieces(work, ["**/*.png"], NOW - 60 * MINUTE, NOW);
  assert.equal(found.length, 12);
  assert.equal(found[0]!.relative, "out/v14.png");
  assert.ok(found.every((piece) => piece.relative.startsWith("out/")));

  const outside = scratch();
  write(path.join(outside, "secret.png"), "s", NOW - MINUTE);
  try {
    fs.symlinkSync(outside, path.join(work, "link"), "junction");
  } catch {
    t.skip("cannot create a directory link here");
    return;
  }
  assert.ok(listPieces(work, ["**/*.png", "link/*.png"], NOW - 60 * MINUTE, NOW).every((piece) => !piece.relative.includes("secret")));
});

test("readExcerpt: the first 40 lines or 4 KB, null for a binary file", () => {
  const work = scratch();
  const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
  write(path.join(work, "a.md"), lines, NOW);
  const excerpt = readExcerpt(path.join(work, "a.md"))!;
  assert.equal(excerpt.split("\n").length, 40);
  assert.ok(excerpt.startsWith("line 1\nline 2"));
  write(path.join(work, "big.txt"), "x".repeat(10_000), NOW);
  assert.equal(readExcerpt(path.join(work, "big.txt"))!.length, 4096);
  write(path.join(work, "bin.json"), Buffer.from([0x7b, 0x00, 0x7d]), NOW);
  assert.equal(readExcerpt(path.join(work, "bin.json")), null);
});

// --- readLiveRoom and readLiveRun ----------------------------------------------------------

/** A home with three agents: a painter that follows renders, a writer with no pattern, and a critic. */
function office(): { db: Db; home: Home; runsDir: string; work: (agent: string) => string } {
  const agent = (id: string, extra: object = {}) => ({ id, name: id[0]!.toUpperCase() + id.slice(1), role: "roles/scout.md", model: "sonnet", allowedTools: ["Write"], ...extra });
  const config = makeHome(
    {},
    {
      name: "demo",
      targetRepo: "x",
      color: "#3366cc",
      agents: [agent("painter", { pieces: ["renders/*.png", "renders/*.mp4"] }), agent("writer"), agent("critic", { pieces: ["sheets/*.png"] })],
    },
  );
  const db = getDbAt(config.dbPath);
  const home = loadHome(config.home);
  syncHome(db, home);
  return { db, home, runsDir: config.runsDir, work: (id) => path.join(config.home, "data", "work", "demo", id) };
}

function addRun(db: Db, agent: string, startedMs: number, ended: { ms: number; status: string; cost?: number } | null): number {
  return Number(
    db
      .prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at, ended_at, cost_usd) VALUES ('demo', ?, 'claude', ?, ?, ?, ?, ?)")
      .run(agent, `Task of ${agent}`, ended?.status ?? "running", iso(startedMs), ended ? iso(ended.ms) : null, ended?.cost ?? 0).lastInsertRowid,
  );
}

function addStatus(db: Db, runId: number, agent: string, text: string, ms: number, waiting = false): void {
  const id = db
    .prepare("INSERT INTO run_statuses (run_id, room, agent_id, text, created_at) VALUES (?, 'demo', ?, ?, ?)")
    .run(runId, agent, text, iso(ms)).lastInsertRowid;
  if (waiting) db.prepare("INSERT INTO run_waits (status_id) VALUES (?)").run(id);
}

test("readLiveRoom: running runs and runs ended under 5 minutes ago, one tile per agent, in their state", () => {
  const { db, home, runsDir, work } = office();
  const painterRun = addRun(db, "painter", NOW - 30 * MINUTE, null);
  addStatus(db, painterRun, "painter", "lit le brief", NOW - 29 * MINUTE);
  addStatus(db, painterRun, "painter", "rend le plan 1", NOW - 20 * MINUTE);
  addStatus(db, painterRun, "painter", "rend le plan 2", NOW - 10 * MINUTE);
  addStatus(db, painterRun, "painter", "compare les plans", NOW - 5 * MINUTE);
  addStatus(db, painterRun, "painter", "rend le plan 3", NOW - MINUTE);
  write(path.join(work("painter"), "renders", "plan-1.png"), "1", NOW - 20 * MINUTE);
  write(path.join(work("painter"), "renders", "plan-2.png"), "2", NOW - 10 * MINUTE);
  write(path.join(work("painter"), "renders", "before.png"), "0", NOW - 40 * MINUTE);

  const writerRun = addRun(db, "writer", NOW - 8 * MINUTE, null);
  addStatus(db, writerRun, "writer", "écrit", NOW - 7 * MINUTE);
  addStatus(db, writerRun, "writer", "attend la carte graphique", NOW - 2 * MINUTE, true);

  // The critic: an older finished run, then one that ended two minutes ago.
  addRun(db, "critic", NOW - 60 * MINUTE, { ms: NOW - 50 * MINUTE, status: "done" });
  const criticRun = addRun(db, "critic", NOW - 20 * MINUTE, { ms: NOW - 2 * MINUTE, status: "done", cost: 1.25 });
  // Ended too long ago: left out.
  addRun(db, "painter", NOW - 90 * MINUTE, { ms: NOW - LIVE_DONE_MS - MINUTE, status: "done" });

  const tiles = readLiveRoom(db, home, runsDir, NOW);
  assert.deepEqual(
    tiles.map((tile) => [tile.agentId, tile.runId, tile.state]),
    [
      ["painter", painterRun, "working"],
      ["writer", writerRun, "waiting"],
      ["critic", criticRun, "done"],
    ],
  );
  const [painter, writer, critic] = tiles as [(typeof tiles)[0], (typeof tiles)[0], (typeof tiles)[0]];
  assert.equal(painter.agentName, "Painter");
  assert.equal(painter.roomColor, "#3366cc");
  assert.equal(painter.task, "Task of painter");
  assert.deepEqual(painter.status, { text: "rend le plan 3", at: iso(NOW - MINUTE) });
  assert.deepEqual(painter.previous.map((status) => status.text), ["compare les plans", "rend le plan 2", "rend le plan 1"]);
  assert.equal(painter.piece?.source, "auto");
  assert.deepEqual(painter.piece?.versions.map((version) => version.path), ["renders/plan-1.png", "renders/plan-2.png"]);
  const latest = painter.piece!.versions[1]!;
  assert.equal(latest.kind, "image");
  assert.equal(latest.url, `/api/live/runs/${painterRun}/file?path=renders%2Fplan-2.png&v=${NOW - 10 * MINUTE}`);
  assert.equal(latest.at, iso(NOW - 10 * MINUTE));

  assert.equal(writer.piece, null, "no pattern and no pin: text only");
  assert.deepEqual(writer.status, { text: "attend la carte graphique", at: iso(NOW - 2 * MINUTE) });
  assert.equal(writer.waitingSince, iso(NOW - 2 * MINUTE));
  assert.equal(painter.waitingSince, null);

  assert.equal(critic.endedAt, iso(NOW - 2 * MINUTE));
  assert.equal(critic.costUsd, 1.25);
  assert.equal(critic.runStatus, "done");
  assert.equal(critic.piece, null, "nothing written in its window");
});

test("readLiveRoom: a later status ends the wait; a pin wins over the patterns and carries its caption", () => {
  const { db, home, runsDir, work } = office();
  const runId = addRun(db, "painter", NOW - 10 * MINUTE, null);
  addStatus(db, runId, "painter", "attend", NOW - 9 * MINUTE, true);
  addStatus(db, runId, "painter", "reprend", NOW - 8 * MINUTE);
  write(path.join(work("painter"), "renders", "a.png"), "a", NOW - 7 * MINUTE);
  write(path.join(work("painter"), "sheet.png"), "s", NOW - 6 * MINUTE);
  write(path.join(work("painter"), "notes.md"), "# Notes\nfirst line", NOW - 6 * MINUTE);
  const ctx = { dbPath: "", runId, agentId: "painter", room: "demo", workDir: work("painter") };
  hqShow(db, ctx, { path: "sheet.png", caption: "Regarde l'arrêt" });
  hqShow(db, ctx, { path: "notes.md", caption: "Le plan" });

  const [tile] = readLiveRoom(db, home, runsDir, NOW);
  assert.equal(tile!.state, "working");
  assert.equal(tile!.piece?.source, "pin");
  assert.deepEqual(
    tile!.piece?.versions.map((version) => [version.path, version.kind, version.caption, version.url === null, version.excerpt]),
    [
      ["sheet.png", "image", "Regarde l'arrêt", false, null],
      ["notes.md", "text", "Le plan", true, "# Notes\nfirst line"],
    ],
  );
});

test("readLiveRun: one tile and the statuses of the run, oldest first, waits marked; an unknown run is a 404", () => {
  const { db, home, runsDir } = office();
  const runId = addRun(db, "writer", NOW - 30 * MINUTE, { ms: NOW - 2 * MINUTE, status: "failed" });
  addStatus(db, runId, "writer", "écrit", NOW - 29 * MINUTE);
  addStatus(db, runId, "writer", "attend", NOW - 25 * MINUTE, true);
  const live = readLiveRun(db, home, runsDir, runId, NOW);
  assert.equal(live.tile.runId, runId);
  assert.equal(live.tile.state, "done");
  assert.deepEqual(live.timeline, [
    { text: "écrit", at: iso(NOW - 29 * MINUTE), waiting: false },
    { text: "attend", at: iso(NOW - 25 * MINUTE), waiting: true },
  ]);
  assert.throws(() => readLiveRun(db, home, runsDir, 999, NOW), /No run #999/);
});

test("readLiveRun: a run ended longer ago than the tile of a finished run is a 404, like an unknown one", () => {
  const { db, home, runsDir } = office();
  const old = addRun(db, "writer", NOW - 60 * MINUTE, { ms: NOW - LIVE_DONE_MS - MINUTE, status: "done" });
  assert.throws(() => readLiveRun(db, home, runsDir, old, NOW), (error: unknown) => (error as { status?: number }).status === 404);
});

test("hq_status still feeds the room through the HQ tool: waiting shows as the tile's state", () => {
  const { db, home, runsDir } = office();
  const runId = addRun(db, "writer", Date.now() - MINUTE, null);
  const ctx = { dbPath: "", runId, agentId: "writer", room: "demo" };
  hqStatus(db, ctx, { text: "attend le rendu", waiting: true });
  assert.equal(readLiveRoom(db, home, runsDir, Date.now())[0]!.state, "waiting");
  hqStatus(db, ctx, { text: "reprend" });
  assert.equal(readLiveRoom(db, home, runsDir, Date.now())[0]!.state, "working");
});

// --- Pins ------------------------------------------------------------------------------

test("pins: the latest pin per file only, the newest PIECES_MAX at most, and a cap on what a run stores", () => {
  const { db, home, runsDir, work } = office();
  const runId = addRun(db, "painter", Date.now() - 10 * MINUTE, null);
  const dir = work("painter");
  for (let i = 0; i < 20; i++) write(path.join(dir, "sheets", `s${String(i).padStart(2, "0")}.png`), "x", Date.now() - MINUTE);
  const ctx = { dbPath: "", runId, agentId: "painter", room: "demo", workDir: dir };
  hqShow(db, ctx, { path: "sheets/s00.png", caption: "first" });
  hqShow(db, ctx, { path: "sheets\\s00.png", caption: "again" });
  let versions = readLiveRoom(db, home, runsDir)[0]!.piece!.versions;
  assert.deepEqual(versions.map((each) => [each.path, each.caption]), [["sheets/s00.png", "again"]], "twice the same file: one version, the latest caption");
  assert.match(versions[0]!.url!, /path=sheets%2Fs00\.png&/);

  for (let i = 1; i < 20; i++) hqShow(db, ctx, { path: `sheets/s${String(i).padStart(2, "0")}.png`, caption: `n${i}` });
  versions = readLiveRoom(db, home, runsDir)[0]!.piece!.versions;
  assert.equal(versions.length, PIECES_MAX);
  assert.equal(versions.at(-1)!.path, "sheets/s19.png");
  assert.equal(new Set(versions.map((each) => each.path)).size, versions.length, "no duplicate path");

  const stored = (db.prepare("SELECT COUNT(*) AS n FROM run_pins WHERE run_id = ?").get(runId) as { n: number }).n;
  for (let i = stored; i < PINS_MAX; i++) hqShow(db, ctx, { path: "sheets/s01.png", caption: "more" });
  assert.throws(() => hqShow(db, ctx, { path: "sheets/s02.png", caption: "one too many" }), new RegExp(`already showed ${PINS_MAX} files`));
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM run_pins WHERE run_id = ?").get(runId) as { n: number }).n, PINS_MAX);
});

// --- The short cache of a read -----------------------------------------------------------

test("a read of the room within a few seconds of the previous one reuses its listing of the working directory", () => {
  const { db, home, runsDir, work } = office();
  const runId = addRun(db, "painter", Date.now() - 10 * MINUTE, null);
  write(path.join(work("painter"), "renders", "a.png"), "a", Date.now() - MINUTE);
  assert.equal(readLiveRoom(db, home, runsDir)[0]!.piece!.versions.length, 1);
  write(path.join(work("painter"), "renders", "b.png"), "b", Date.now() - MINUTE);
  assert.equal(readLiveRoom(db, home, runsDir)[0]!.piece!.versions.length, 1, "cached for a few seconds");
  assert.equal(readLiveRun(db, home, runsDir, runId).tile.runId, runId);
});

// --- liveFile: what the file route may serve ------------------------------------------

const is404 = (error: unknown) => (error as { status?: number }).status === 404;

/** liveFile, its descriptor closed at once: the tests only look at what it decided. */
function served(...args: Parameters<typeof liveFile>) {
  const file = liveFile(...args);
  fs.closeSync(file.fd);
  return file;
}

test("liveFile: a media file pinned by the run, or matching the patterns in the run window; anything else is a 404", () => {
  const { db, home, work } = office();
  const runId = addRun(db, "painter", NOW - 10 * MINUTE, null);
  const otherRun = addRun(db, "critic", NOW - 10 * MINUTE, null);
  const dir = work("painter");
  write(path.join(dir, "renders", "a.png"), "a", NOW - 5 * MINUTE);
  write(path.join(dir, "renders", "old.png"), "o", NOW - 20 * MINUTE);
  write(path.join(dir, "renders", "clip.mp4"), "m", NOW - 4 * MINUTE);
  write(path.join(dir, "loose.png"), "l", NOW - 4 * MINUTE);
  write(path.join(dir, "pinned.wav"), "w", NOW - 30 * MINUTE);
  write(path.join(dir, "renders", "notes.md"), "n", NOW - 4 * MINUTE);
  db.prepare("INSERT INTO run_pins (run_id, room, agent_id, path, caption, created_at) VALUES (?, 'demo', 'painter', 'pinned.wav', 'c', ?)").run(runId, iso(NOW));
  const cap = 1024;

  const ok = served(db, home, runId, "renders/a.png", cap, NOW);
  assert.equal(ok.mime, "image/png");
  assert.equal(ok.name, "a.png");
  assert.equal(ok.size, 1);
  assert.equal(served(db, home, runId, "renders\\clip.mp4", cap, NOW).mime, "video/mp4");
  assert.equal(served(db, home, runId, "pinned.wav", cap, NOW).mime, "audio/wav", "pinned: served whatever its time");

  for (const [rel, why] of [
    ["renders/old.png", "written before the run"],
    ["loose.png", "matches no pattern"],
    ["renders/notes.md", "a text piece is never served raw"],
    ["../x.png", "climbs out"],
    ["C:/x.png", "absolute"],
    ["/etc/x.png", "absolute, POSIX"],
    ["\\\\server\\share\\x.png", "a UNC path"],
    ["\\x.png", "rooted"],
    ["renders/none.png", "missing"],
    ["renders", "a folder"],
  ] as const) {
    assert.throws(() => liveFile(db, home, runId, rel, cap, NOW), is404, `${rel}: ${why}`);
  }
  assert.throws(() => liveFile(db, home, runId, "renders/a.png", 0, NOW), /not found/i, "above the cap");
  assert.throws(() => liveFile(db, home, otherRun, "renders/a.png", cap, NOW), /not found/i, "another agent's run");
  assert.throws(() => liveFile(db, home, 999, "renders/a.png", cap, NOW), /not found/i, "no such run");
});

test("liveFile: an .svg or an .html matching a pattern, or a followed file under node_modules, .git or .claude, is never served", () => {
  const agent = { id: "painter", name: "Painter", role: "roles/scout.md", model: "sonnet", allowedTools: ["Write"], pieces: ["out/*", "**/*.png"] };
  const config = makeHome({}, { name: "demo", targetRepo: "x", agents: [agent] });
  const db = getDbAt(config.dbPath);
  const home = loadHome(config.home);
  syncHome(db, home);
  const runId = addRun(db, "painter", NOW - 10 * MINUTE, null);
  const dir = path.join(config.home, "data", "work", "demo", "painter");
  write(path.join(dir, "out", "logo.svg"), "<svg onload='x'/>", NOW - MINUTE);
  write(path.join(dir, "out", "page.html"), "<script></script>", NOW - MINUTE);
  write(path.join(dir, "out", "ok.png"), "p", NOW - MINUTE);
  for (const skipped of ["node_modules", ".git", ".claude"]) write(path.join(dir, skipped, "x.png"), "x", NOW - MINUTE);
  assert.equal(served(db, home, runId, "out/ok.png", 1024, NOW).mime, "image/png");
  for (const rel of ["out/logo.svg", "out/page.html", "node_modules/x.png", ".git/x.png", ".claude/x.png"]) {
    assert.throws(() => liveFile(db, home, runId, rel, 1024, NOW), is404, rel);
  }
});

test("liveFile: a link or a junction leading out is a 404, even for a pinned file replaced later by one", (t) => {
  const { db, home, work } = office();
  const runId = addRun(db, "painter", NOW - 10 * MINUTE, null);
  const dir = work("painter");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-outside-"));
  write(path.join(outside, "secret.png"), "s", NOW - MINUTE);
  write(path.join(dir, "sheets", "secret.png"), "mine", NOW - MINUTE);
  db.prepare("INSERT INTO run_pins (run_id, room, agent_id, path, caption, created_at) VALUES (?, 'demo', 'painter', 'sheets/secret.png', 'c', ?)").run(runId, iso(NOW));
  assert.equal(served(db, home, runId, "sheets/secret.png", 1024, NOW).size, 4);
  // The pinned folder becomes a junction to a folder outside.
  fs.rmSync(path.join(dir, "sheets"), { recursive: true });
  try {
    fs.symlinkSync(outside, path.join(dir, "sheets"), "junction");
    fs.symlinkSync(outside, path.join(dir, "renders"), "junction");
  } catch {
    t.skip("cannot create a directory link here");
    return;
  }
  assert.throws(() => liveFile(db, home, runId, "sheets/secret.png", 1024, NOW), is404, "pinned, then a junction out");
  assert.throws(() => liveFile(db, home, runId, "renders/secret.png", 1024, NOW), is404, "followed, through a junction out");
  try {
    fs.symlinkSync(path.join(outside, "secret.png"), path.join(dir, "link.png"), "file");
  } catch {
    return; // A file link needs a privilege on Windows: the junctions above already cover the escape.
  }
  db.prepare("INSERT INTO run_pins (run_id, room, agent_id, path, caption, created_at) VALUES (?, 'demo', 'painter', 'link.png', 'c', ?)").run(runId, iso(NOW));
  assert.throws(() => liveFile(db, home, runId, "link.png", 1024, NOW), is404, "a file link out");
});

test("liveFile: a file that vanishes between the checks and the opening is the same 404, never an error with its path", (t) => {
  const { db, home, work } = office();
  const runId = addRun(db, "painter", NOW - 10 * MINUTE, null);
  write(path.join(work("painter"), "renders", "a.png"), "a", NOW - MINUTE);
  const gone = Object.assign(new Error("ENOENT: no such file or directory, open 'C:\\secret\\a.png'"), { code: "ENOENT" });
  t.mock.method(fs, "openSync", () => {
    throw gone;
  });
  assert.throws(() => liveFile(db, home, runId, "renders/a.png", 1024, NOW), (error: unknown) => is404(error) && !String(error).includes("secret"));
  t.mock.restoreAll();
  t.mock.method(fs, "statSync", () => {
    throw gone;
  });
  assert.throws(() => liveFile(db, home, runId, "renders/a.png", 1024, NOW), (error: unknown) => is404(error) && !String(error).includes("secret"));
});

test("liveFile: the file is opened once and checked on its descriptor, the same file as the one checked", () => {
  const { db, home, work } = office();
  const runId = addRun(db, "painter", NOW - 10 * MINUTE, null);
  const file = path.join(work("painter"), "renders", "a.png");
  write(file, "abc", NOW - MINUTE);
  const opened = liveFile(db, home, runId, "renders/a.png", 1024, NOW);
  try {
    const stat = fs.fstatSync(opened.fd);
    const checked = fs.statSync(fs.realpathSync(file));
    assert.equal(stat.ino, checked.ino);
    assert.equal(stat.size, 3);
  } finally {
    fs.closeSync(opened.fd);
  }
});

test("liveFile: a run ended longer ago than the tile of a finished run serves nothing", () => {
  const { db, home, work } = office();
  const old = addRun(db, "painter", NOW - 60 * MINUTE, { ms: NOW - LIVE_DONE_MS - MINUTE, status: "done" });
  write(path.join(work("painter"), "renders", "a.png"), "a", NOW - 30 * MINUTE);
  assert.throws(() => liveFile(db, home, old, "renders/a.png", 1024, NOW), is404);
});
