import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveInside } from "../src/server/attachments";
import { getDbAt, openDb } from "../src/server/db";
import { pieceKind } from "../src/server/live-room";
import { loadHome, syncHome } from "../src/server/rooms";
import { buildPrompt } from "../src/server/runner";
import { hqShow, hqStatus, type HqContext } from "../src/mcp/tools";
import { makeHome } from "./helpers";

/** A home with one running run of the scout, its database and the context of its HQ server. */
function runningRun() {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  syncHome(db, loadHome(config.home));
  const runId = Number(
    db
      .prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at) VALUES ('demo', 'scout', 'claude', 't', 'running', ?)")
      .run(new Date().toISOString()).lastInsertRowid,
  );
  const ctx = { dbPath: config.dbPath, runId, agentId: "scout", room: "demo" };
  return { config, db, runId, ctx };
}

const changeCount = (db: ReturnType<typeof getDbAt>) => (db.prepare("SELECT COUNT(*) AS n FROM changes").get() as { n: number }).n;

test("hq_status with waiting: the text is the reason, and the status is marked in run_waits in the same write", () => {
  const { db, ctx } = runningRun();
  const before = changeCount(db);
  const plain = hqStatus(db, ctx, { text: "rend le plan 2" });
  const wait = hqStatus(db, ctx, { text: "attend la carte graphique", waiting: true });
  assert.equal(wait.waiting, true);
  assert.equal(plain.waiting, false);
  const marked = db.prepare("SELECT status_id FROM run_waits").all() as { status_id: number }[];
  const ids = db.prepare("SELECT id, text FROM run_statuses ORDER BY id").all() as { id: number; text: string }[];
  assert.deepEqual(marked.map((row) => row.status_id), [ids[1]!.id]);
  assert.equal(ids[1]!.text, "attend la carte graphique");
  assert.equal(changeCount(db), before, "no run, event, message or item");
});

test("migration 22 is idempotent: applied again, it keeps the tables and their rows", () => {
  const { config, db, ctx } = runningRun();
  hqStatus(db, ctx, { text: "attend", waiting: true });
  db.exec("DELETE FROM schema_migrations WHERE version = 22;");
  const reopened = openDb(config.dbPath);
  try {
    assert.equal((reopened.prepare("SELECT COUNT(*) AS n FROM run_waits").get() as { n: number }).n, 1);
    assert.equal((reopened.prepare("SELECT COUNT(*) AS n FROM run_pins").get() as { n: number }).n, 0);
  } finally {
    reopened.close();
  }
});

// --- hq_show: the agent shows a file ------------------------------------------------

/** The running run of the scout, with files in its working directory and the context hq_show needs. */
function showSetup() {
  const setup = runningRun();
  const work = path.join(setup.config.home, "data", "work", "demo", "scout");
  fs.mkdirSync(path.join(work, "renders"), { recursive: true });
  fs.writeFileSync(path.join(work, "renders", "plan-01.mp4"), "fake mp4");
  fs.writeFileSync(path.join(work, "notes.md"), "# Notes\n");
  fs.writeFileSync(path.join(work, "model.stl"), "solid x");
  fs.writeFileSync(path.join(work, "plan.pdf"), "%PDF-1.7");
  fs.writeFileSync(path.join(work, "big.png"), Buffer.alloc(64));
  const ctx: HqContext = { ...setup.ctx, workDir: work, attachmentMaxBytes: 32 };
  return { ...setup, work, ctx };
}

test("pieceKind: video, image, audio and 3D model from the attachment types, text from a short list, nothing else", () => {
  assert.equal(pieceKind("a/clip.MP4"), "video");
  assert.equal(pieceKind("sheet.webp"), "image");
  assert.equal(pieceKind("take.wav"), "audio");
  assert.equal(pieceKind("parts/bracket.3mf"), "model");
  assert.equal(pieceKind("part.STL"), "model");
  assert.equal(pieceKind("part.glb"), "model");
  assert.equal(pieceKind("part.gltf"), null, "only the 3D formats the attachments accept");
  assert.equal(pieceKind("part.step"), null);
  assert.equal(pieceKind("notes.md"), "text");
  assert.equal(pieceKind("src/app.ts"), "text");
  assert.equal(pieceKind("doc.pdf"), null);
  assert.equal(pieceKind("archive.zip"), null);
  assert.equal(pieceKind("logo.svg"), null, "a client's piece is never followed");
  assert.equal(pieceKind("drawing.dxf"), null);
});

test("resolveInside: the real path and its POSIX path relative to the working directory, never outside", (t) => {
  const { work } = showSetup();
  const inside = resolveInside(work, "renders\\plan-01.mp4", "hq_show");
  assert.equal(inside.relative, "renders/plan-01.mp4");
  assert.equal(inside.real, fs.realpathSync(path.join(work, "renders", "plan-01.mp4")));
  for (const bad of ["/etc/x.png", "C:/x.png", "../x.png", "renders/../../x.png", "missing.mp4", "."]) {
    assert.throws(() => resolveInside(work, bad, "hq_show"), /Error: hq_show: /, bad);
  }
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-outside-"));
  fs.writeFileSync(path.join(outside, "secret.png"), "outside");
  try {
    fs.symlinkSync(outside, path.join(work, "escape"), "junction");
  } catch {
    t.skip("cannot create a directory link here");
    return;
  }
  assert.throws(() => resolveInside(work, "escape/secret.png", "hq_show"), /leads out of your working directory/);
});

test("hq_show pins a file of a known kind with its caption, in POSIX form, and writes no change", () => {
  const { db, ctx, runId } = showSetup();
  const before = changeCount(db);
  const shown = hqShow(db, ctx, { path: "renders\\plan-01.mp4", caption: "  Regarde la fin du plan  " });
  assert.equal(shown.path, "renders/plan-01.mp4");
  const rows = db.prepare("SELECT run_id, room, agent_id, path, caption FROM run_pins").all();
  assert.deepEqual(rows, [{ run_id: runId, room: "demo", agent_id: "scout", path: "renders/plan-01.mp4", caption: "Regarde la fin du plan" }]);
  hqShow(db, ctx, { path: "notes.md", caption: "Le plan du film" });
  assert.equal(hqShow(db, ctx, { path: "model.stl", caption: "La pièce assemblée" }).path, "model.stl");
  assert.equal(changeCount(db), before);
});

test("hq_show refuses a file out of reach, of an unknown kind, above the cap, a bad caption, or without a working directory", () => {
  const { db, ctx } = showSetup();
  assert.throws(() => hqShow(db, ctx, { path: "../x.mp4", caption: "c" }), /climbs out/);
  assert.throws(() => hqShow(db, ctx, { path: "missing.mp4", caption: "c" }), /does not exist/);
  assert.throws(() => hqShow(db, ctx, { path: "plan.pdf", caption: "c" }), /kind/);
  assert.throws(() => hqShow(db, ctx, { path: "renders", caption: "c" }), /not a file/);
  assert.throws(() => hqShow(db, ctx, { path: "big.png", caption: "c" }), /cap/);
  assert.throws(() => hqShow(db, ctx, { path: "notes.md", caption: "   " }));
  assert.throws(() => hqShow(db, ctx, { path: "notes.md", caption: "x".repeat(201) }));
  const { workDir: _workDir, ...noWorkDir } = ctx;
  void _workDir;
  assert.throws(() => hqShow(db, noWorkDir, { path: "notes.md", caption: "c" }), /working directory/);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM run_pins").get() as { n: number }).n, 0);
});

test("the prompt of a run tells about hq_show next to hq_status", () => {
  const { config } = runningRun();
  const home = loadHome(config.home);
  const room = home.rooms[0]!;
  const prompt = buildPrompt({ room, agent: room.agents[0]!, runId: 1, task: "t", mailbox: [] });
  assert.match(prompt, /hq_show \(if you have it\)/);
});
