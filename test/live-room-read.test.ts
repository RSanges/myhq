import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getDbAt, type Db } from "../src/server/db";
import { listPieces, liveFile, readExcerpt, readLiveRoom, readLiveRun, LIVE_DONE_MS } from "../src/server/live-room";
import { loadHome, syncHome, type Home } from "../src/server/rooms";
import { hqShow, hqStatus } from "../src/mcp/tools";
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
  const runId = addRun(db, "writer", NOW - 30 * MINUTE, { ms: NOW - 20 * MINUTE, status: "failed" });
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

test("hq_status still feeds the room through the HQ tool: waiting shows as the tile's state", () => {
  const { db, home, runsDir } = office();
  const runId = addRun(db, "writer", Date.now() - MINUTE, null);
  const ctx = { dbPath: "", runId, agentId: "writer", room: "demo" };
  hqStatus(db, ctx, { text: "attend le rendu", waiting: true });
  assert.equal(readLiveRoom(db, home, runsDir, Date.now())[0]!.state, "waiting");
  hqStatus(db, ctx, { text: "reprend" });
  assert.equal(readLiveRoom(db, home, runsDir, Date.now())[0]!.state, "working");
});

// --- liveFile: what the file route may serve ------------------------------------------

test("liveFile: a media file pinned by the run, or matching the patterns in the run window; anything else is a 404", (t) => {
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

  const ok = liveFile(db, home, runId, "renders/a.png", cap, NOW);
  assert.equal(ok.mime, "image/png");
  assert.equal(ok.name, "a.png");
  assert.equal(ok.path, fs.realpathSync(path.join(dir, "renders", "a.png")));
  assert.equal(ok.size, 1);
  assert.equal(liveFile(db, home, runId, "renders\\clip.mp4", cap, NOW).mime, "video/mp4");
  assert.equal(liveFile(db, home, runId, "pinned.wav", cap, NOW).mime, "audio/wav", "pinned: served whatever its time");

  for (const [rel, why] of [
    ["renders/old.png", "written before the run"],
    ["loose.png", "matches no pattern"],
    ["renders/notes.md", "a text piece is never served raw"],
    ["../x.png", "climbs out"],
    ["C:/x.png", "absolute"],
    ["renders/none.png", "missing"],
    ["renders", "a folder"],
  ] as const) {
    assert.throws(() => liveFile(db, home, runId, rel, cap, NOW), (error: unknown) => (error as { status?: number }).status === 404, `${rel}: ${why}`);
  }
  assert.throws(() => liveFile(db, home, runId, "renders/a.png", 0, NOW), /not found/i, "above the cap");
  assert.throws(() => liveFile(db, home, otherRun, "renders/a.png", cap, NOW), /not found/i, "another agent's run");
  assert.throws(() => liveFile(db, home, 999, "renders/a.png", cap, NOW), /not found/i, "no such run");
  void t;
});
