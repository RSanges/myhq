import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  defaultDrawer,
  DroppedFileError,
  DRAWERS,
  listOrders,
  listRoomFolder,
  moveDroppedIntoReceived,
  moveExclusive,
  moveIntoOrder,
  openOrder,
  receivedEntries,
  receivedNames,
  resolveRoomFile,
  roomFolder,
  RoomFolderError,
  roomFoldersRoot,
  saveReceived,
  slug,
} from "../src/server/room-folders";
import { openDb, type Db } from "../src/server/db";

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "myhq-folders-"));

test("slug: lowercase ASCII, accents stripped, runs of other characters become one dash, 60 at most", () => {
  assert.equal(slug("Enseigne Été : ACME, n°2 !"), "enseigne-ete-acme-n-2");
  assert.equal(slug("  --Déjà vu--  "), "deja-vu");
  assert.equal(slug("!!!"), "sans-titre");
  assert.equal(slug(""), "sans-titre");
  const long = slug("a".repeat(59) + " bcd");
  assert.equal(long.length <= 60, true);
  assert.equal(long, "a".repeat(59), "cut at 60, then trimmed of its dash");
});

test("drawers: the closed list, recu first", () => {
  assert.deepEqual([...DRAWERS], ["recu", "videos", "visuels", "sons", "social", "modeles-3d", "rendus", "impression", "devis", "documents"]);
});

test("default drawer: by what the files are, a 3D model, else a video, else a sound, else a PDF, else images", () => {
  assert.equal(defaultDrawer(["clip.mp4"]), "videos");
  assert.equal(defaultDrawer(["cover.png"]), "visuels");
  assert.equal(defaultDrawer(["voice.wav"]), "sons");
  assert.equal(defaultDrawer(["part.3mf"]), "modeles-3d");
  assert.equal(defaultDrawer(["quote.pdf"]), "documents");
  assert.equal(defaultDrawer(["part_sheet.png", "part.3mf"]), "modeles-3d", "the preview first does not decide");
  assert.equal(defaultDrawer(["thumb.png", "clip.mp4"]), "videos");
  assert.equal(defaultDrawer(["thumb.png", "voice.wav"]), "sons");
  assert.equal(defaultDrawer(["thumb.png", "spec.pdf"]), "documents");
  assert.equal(defaultDrawer(["clip.mp4", "voice.wav", "part.stl"]), "modeles-3d");
  assert.equal(defaultDrawer([]), null);
});

test("folders root: folders.dir of myhq.json, relative to the home or absolute, <home>/folders by default", () => {
  const home = tempRoot();
  assert.equal(roomFoldersRoot(home), path.join(home, "folders"));
  fs.writeFileSync(path.join(home, "myhq.json"), JSON.stringify({ folders: { dir: "../shelves" } }));
  assert.equal(roomFoldersRoot(home), path.resolve(home, "../shelves"));
  const absolute = path.join(tempRoot(), "elsewhere");
  fs.writeFileSync(path.join(home, "myhq.json"), JSON.stringify({ folders: { dir: absolute } }));
  assert.equal(roomFoldersRoot(home), absolute);
  fs.writeFileSync(path.join(home, "myhq.json"), JSON.stringify({ folders: { dir: "" } }));
  assert.throws(() => roomFoldersRoot(home), /folders\.dir/);
});

test("openOrder: <YYYY>-<MM>-<client>-<subject> in the home's time zone, with its recu, idempotent", () => {
  const root = tempRoot();
  // 23:30 UTC on 31 October is already November in Paris.
  const at = new Date("2026-10-31T23:30:00.000Z");
  const first = openOrder(root, "shop", "ACME", "Enseigne lumineuse", at, "Europe/Paris");
  assert.deepEqual(first, { order: "2026-11-acme-enseigne-lumineuse", created: true });
  assert.ok(fs.statSync(path.join(root, "shop", first.order, "recu")).isDirectory());
  assert.deepEqual(openOrder(root, "shop", "acme", "enseigne  lumineuse", at, "Europe/Paris"), {
    order: "2026-11-acme-enseigne-lumineuse",
    created: false,
  });
  assert.equal(openOrder(root, "shop", "acme", "sign", at, "UTC").order, "2026-10-acme-sign");
  assert.throws(() => openOrder(root, "shop", "!!!", "sign", at, "UTC"), RoomFolderError);
  assert.throws(() => openOrder(root, "shop", "acme", "  ", at, "UTC"), RoomFolderError);
});

test("listOrders: the order folders of a room, newest first; drawers and other folders are not orders", () => {
  const root = tempRoot();
  assert.deepEqual(listOrders(root, "shop"), [], "no folder yet");
  for (const dir of ["2026-10-acme-sign", "2026-11-acme-mug", "2026-11-beta-cup", "visuels", "recu", "notes", "2026-1-bad"]) {
    fs.mkdirSync(path.join(root, "shop", dir), { recursive: true });
  }
  fs.writeFileSync(path.join(root, "shop", "2026-12-file-not-dir"), "x");
  assert.deepEqual(listOrders(root, "shop"), ["2026-11-beta-cup", "2026-11-acme-mug", "2026-10-acme-sign"]);
});

test("listRoomFolder: directories first then by name, with roles and kinds, hidden files skipped", () => {
  const root = tempRoot();
  const room = path.join(root, "shop");
  fs.mkdirSync(path.join(room, "recu"), { recursive: true });
  fs.mkdirSync(path.join(room, "visuels"));
  fs.mkdirSync(path.join(room, "2026-11-acme-sign", "devis"), { recursive: true });
  fs.mkdirSync(path.join(room, "misc"));
  fs.writeFileSync(path.join(room, "a.png"), "png");
  fs.writeFileSync(path.join(room, "notes.txt"), "text");
  fs.writeFileSync(path.join(room, ".hidden"), "x");
  const top = listRoomFolder(root, "shop", "");
  assert.deepEqual(
    top.map((e) => [e.name, e.path, e.type, e.role, e.kind]),
    [
      ["2026-11-acme-sign", "2026-11-acme-sign", "dir", "order", null],
      ["misc", "misc", "dir", null, null],
      ["recu", "recu", "dir", "drawer", null],
      ["visuels", "visuels", "dir", "drawer", null],
      ["a.png", "a.png", "file", null, "image"],
      ["notes.txt", "notes.txt", "file", null, null],
    ],
  );
  assert.equal(top.find((e) => e.name === "a.png")!.size, 3);
  assert.ok(!Number.isNaN(Date.parse(top[0]!.modifiedAt)));
  const order = listRoomFolder(root, "shop", "2026-11-acme-sign");
  assert.deepEqual(order.map((e) => [e.path, e.role]), [["2026-11-acme-sign/devis", "drawer"]]);
  assert.deepEqual(listRoomFolder(root, "shop", "misc"), []);
  assert.deepEqual(listRoomFolder(root, "studio", ""), [], "a room without a folder yet is empty");
});

test("listRoomFolder and resolveRoomFile: a path with .., an absolute path or a link out is refused", (t) => {
  const root = tempRoot();
  const room = path.join(root, "shop");
  fs.mkdirSync(path.join(room, "recu"), { recursive: true });
  fs.writeFileSync(path.join(room, "recu", "brief.pdf"), "pdf");
  fs.mkdirSync(path.join(root, "studio"));
  fs.writeFileSync(path.join(root, "studio", "secret.png"), "secret");
  for (const bad of ["../studio", "recu/../../studio", "/etc", "C:\\Windows", "C:/x", "\\\\server\\share"]) {
    assert.throws(() => listRoomFolder(root, "shop", bad), RoomFolderError, bad);
    assert.throws(() => resolveRoomFile(root, "shop", bad), RoomFolderError, bad);
  }
  assert.throws(() => listRoomFolder(root, "shop", "missing"), RoomFolderError);
  assert.throws(() => listRoomFolder(root, "shop", "recu/brief.pdf"), RoomFolderError, "a file is not a directory");
  assert.equal(resolveRoomFile(root, "shop", "recu/brief.pdf"), fs.realpathSync(path.join(room, "recu", "brief.pdf")));
  assert.throws(() => resolveRoomFile(root, "shop", "recu"), RoomFolderError, "a directory is not a file");
  assert.throws(() => resolveRoomFile(root, "shop", "recu/missing.pdf"), RoomFolderError);
  try {
    fs.symlinkSync(path.join(root, "studio"), path.join(room, "escape"), "junction");
  } catch {
    t.skip("cannot create a directory link here");
    return;
  }
  assert.throws(() => listRoomFolder(root, "shop", "escape"), RoomFolderError);
  assert.throws(() => resolveRoomFile(root, "shop", "escape/secret.png"), RoomFolderError);
});

test("saveReceived: a safe free name in the recu of the room or of the order, never overwritten", () => {
  const root = tempRoot();
  assert.equal(saveReceived(root, "shop", null, "brief.pdf", Buffer.from("one")), "recu/brief.pdf");
  assert.equal(saveReceived(root, "shop", null, "brief.pdf", Buffer.from("two")), "recu/brief-2.pdf");
  assert.equal(saveReceived(root, "shop", null, "brief.pdf", Buffer.from("three")), "recu/brief-3.pdf");
  assert.equal(fs.readFileSync(path.join(root, "shop", "recu", "brief.pdf"), "utf8"), "one");
  assert.equal(saveReceived(root, "shop", null, "../../evil\u0001.png", Buffer.from("x")), "recu/evil.png");
  assert.equal(saveReceived(root, "shop", null, "C:\\Users\\x\\photo.jpg", Buffer.from("x")), "recu/photo.jpg");
  assert.equal(saveReceived(root, "shop", null, "..", Buffer.from("x")), "recu/fichier");
  assert.equal(saveReceived(root, "shop", null, ".env", Buffer.from("x")), "recu/env", "never a hidden file");
  const { order } = openOrder(root, "shop", "acme", "sign", new Date("2026-11-15T10:00:00Z"), "UTC");
  assert.equal(saveReceived(root, "shop", order, "logo.svg", Buffer.from("<svg/>")), `${order}/recu/logo.svg`);
  assert.throws(() => saveReceived(root, "shop", "2026-11-acme-missing", "a.pdf", Buffer.from("x")), RoomFolderError);
  assert.throws(() => saveReceived(root, "shop", "../studio", "a.pdf", Buffer.from("x")), RoomFolderError);
});

test("migration 27: a fresh database has the columns, and one at version 26 gets them with its rows kept", () => {
  const columns = (db: Db, table: string) =>
    (db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as { name: string }[]).map((c) => c.name);
  const fresh = openDb(path.join(tempRoot(), "hq.db"));
  assert.ok(["drawer", "order_name", "filed_path"].every((c) => columns(fresh, "approvals").includes(c)));
  assert.ok(columns(fresh, "rooms").includes("orders"));
  assert.ok(fresh.prepare("SELECT 1 FROM schema_migrations WHERE version = 27").get());
  fresh.close();

  const file = path.join(tempRoot(), "hq.db");
  const old = openDb(file);
  old.exec(`
    ALTER TABLE approvals DROP COLUMN drawer; ALTER TABLE approvals DROP COLUMN order_name;
    ALTER TABLE approvals DROP COLUMN filed_path; ALTER TABLE rooms DROP COLUMN orders;
    DELETE FROM schema_migrations WHERE version = 27;
  `);
  old.prepare(
    "INSERT INTO approvals (room, agent_id, type, title, body, payload, status, created_at) VALUES ('shop', 'clerk', 'quote', 'Q', 'b', '{}', 'pending', '2026-11-15T10:00:00Z')",
  ).run();
  old.close();
  const upgraded = openDb(file);
  assert.deepEqual(upgraded.prepare("SELECT title, drawer, order_name, filed_path FROM approvals").all(), [
    { title: "Q", drawer: null, order_name: null, filed_path: null },
  ]);
  assert.ok(columns(upgraded, "rooms").includes("orders"));
  upgraded.close();
});

test("saveReceived: a name that would leave recu is neutralised, and the file lands inside the real recu", () => {
  const root = tempRoot();
  const recu = path.join(root, "shop", "recu");
  const cases: [string, string][] = [
    ["../x.png", "recu/x.png"],
    ["..\\x.png", "recu/x-2.png"],
    ["C:\\x.png", "recu/x-3.png"],
    ["C:x.png", "recu/Cx.png"],
    ["/etc/x", "recu/x"],
    ["...", "recu/fichier"],
    ["", "recu/fichier-2"],
    ["  ", "recu/fichier-3"],
  ];
  for (const [name, expected] of cases) {
    const saved = saveReceived(root, "shop", null, name, Buffer.from(name));
    assert.equal(saved, expected, JSON.stringify(name));
    const real = fs.realpathSync(path.join(root, "shop", saved));
    assert.equal(path.dirname(real), fs.realpathSync(recu), JSON.stringify(name));
  }
  assert.deepEqual(fs.readdirSync(root), ["shop"], "nothing written beside the room folder");
});

test("saveReceived: a Windows reserved device name is prefixed, trailing dots and spaces are stripped", () => {
  const root = tempRoot();
  const cases: [string, string][] = [
    ["con.txt", "recu/_con.txt"],
    ["CON", "recu/_CON"],
    ["Prn.png", "recu/_Prn.png"],
    ["aux.pdf", "recu/_aux.pdf"],
    ["NUL.txt", "recu/_NUL.txt"],
    ["com1.png", "recu/_com1.png"],
    ["COM9.png", "recu/_COM9.png"],
    ["lpt1.png", "recu/_lpt1.png"],
    ["Lpt9", "recu/_Lpt9"],
    ["nul.", "recu/_nul"],
    ["aux .txt", "recu/_aux .txt"],
    ["report.pdf.", "recu/report.pdf"],
    ["notes.txt  ", "recu/notes.txt"],
    ["note. . ", "recu/note"],
    ["com10.png", "recu/com10.png"],
    ["console.txt", "recu/console.txt"],
    ["com0.png", "recu/com0.png"],
    ["lpt9.tar.gz", "recu/_lpt9.tar.gz"],
  ];
  for (const [name, expected] of cases) {
    assert.equal(saveReceived(root, "shop", null, name, Buffer.from(name)), expected, JSON.stringify(name));
  }
});

test("saveReceived: a device name is tested on the part before the first dot, superscript COM and LPT included", () => {
  const root = tempRoot();
  const cases: [string, string][] = [
    ["nul.tar.gz", "recu/_nul.tar.gz"],
    ["CON.backup.txt", "recu/_CON.backup.txt"],
    ["COM¹.txt", "recu/_COM¹.txt"],
    ["com².png", "recu/_com².png"],
    ["COM³", "recu/_COM³"],
    ["LPT¹.pdf", "recu/_LPT¹.pdf"],
    ["lpt²", "recu/_lpt²"],
    ["Lpt³.x.y", "recu/_Lpt³.x.y"],
    ["nullable.tar.gz", "recu/nullable.tar.gz"],
  ];
  for (const [name, expected] of cases) {
    assert.equal(saveReceived(root, "shop", null, name, Buffer.from(name)), expected, JSON.stringify(name));
  }
});

test("roomFolder: a room named like a Windows device is refused, and nothing is created for it", () => {
  const root = tempRoot();
  const devices = ["con", "nul", "aux", "prn", "com1", "com9", "lpt1", "lpt9"];
  for (const room of devices) assert.throws(() => roomFolder(root, room), RoomFolderError, room);
  for (const room of devices) assert.throws(() => saveReceived(root, room, null, "a.pdf", Buffer.from("x")), RoomFolderError, room);
  assert.equal(roomFolder(root, "console"), path.join(root, "console"), "only the device names themselves");
  assert.deepEqual(fs.readdirSync(root), []);
});

// --- Received items moving into an order ---

/** An approved item filed loose in the recu of `room` (its file, and its .md twin when asked), recorded in the database. */
function filedItem(db: Db, root: string, room: string, name: string, extra: { twin?: boolean; forRoom?: string } = {}): number {
  const dir = path.join(root, room, "recu");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `bytes of ${name}`);
  if (extra.twin) fs.writeFileSync(path.join(dir, `${name.slice(0, name.length - path.extname(name).length)}.md`), "The body.\n");
  return Number(
    db
      .prepare(
        `INSERT INTO approvals (room, agent_id, type, title, body, payload, status, drawer, filed_path, for_room, decided_at, created_at)
         VALUES (?, 'clerk', 'client_mail', 'T', 'b', '{}', 'approved', 'recu', ?, ?, '2026-11-15T10:00:00Z', '2026-11-15T10:00:00Z')`,
      )
      .run(room, `${room}/recu/${name}`, extra.forRoom ?? null).lastInsertRowid,
  );
}

const filedPathOf = (db: Db, id: number) =>
  db.prepare("SELECT filed_path, order_name FROM approvals WHERE id = ?").get(id) as { filed_path: string; order_name: string | null };

test("moveIntoOrder: a move that fails halfway puts back what had moved, the database unchanged, and a retry succeeds", () => {
  const root = tempRoot();
  const db = openDb(path.join(tempRoot(), "hq.db"));
  const recu = path.join(root, "shop", "recu");
  const first = filedItem(db, root, "shop", "2026-11-15-brief.pdf", { twin: true });
  const second = filedItem(db, root, "shop", "2026-11-15-plan.pdf");
  fs.writeFileSync(path.join(recu, "loose.txt"), "loose");
  const entries = receivedEntries(db, root, "shop", [first, second]);
  const names = receivedNames(db, root, "shop", ["loose.txt"]);
  const { order } = openOrder(root, "shop", "acme", "sign", new Date("2026-11-15T10:00:00Z"), "UTC");
  // The second item's copy disappears after the checks (a real race): its move fails once the first has moved.
  fs.rmSync(path.join(recu, "2026-11-15-plan.pdf"));
  assert.throws(() => moveIntoOrder(db, root, "shop", order, entries, names));
  assert.deepEqual(fs.readdirSync(recu).sort(), ["2026-11-15-brief.md", "2026-11-15-brief.pdf", "loose.txt"], "the first item and its twin are back");
  assert.deepEqual(fs.readdirSync(path.join(root, "shop", order, "recu")), [], "nothing left in the order");
  assert.deepEqual(filedPathOf(db, first), { filed_path: "shop/recu/2026-11-15-brief.pdf", order_name: null });
  assert.deepEqual(filedPathOf(db, second), { filed_path: "shop/recu/2026-11-15-plan.pdf", order_name: null });

  fs.writeFileSync(path.join(recu, "2026-11-15-plan.pdf"), "back");
  const moved = moveIntoOrder(db, root, "shop", order, receivedEntries(db, root, "shop", [first, second]), receivedNames(db, root, "shop", ["loose.txt"]));
  const into = `shop/${order}/recu`;
  assert.deepEqual(moved, {
    received: [
      { id: first, filedPath: `${into}/2026-11-15-brief.pdf` },
      { id: second, filedPath: `${into}/2026-11-15-plan.pdf` },
    ],
    files: [`${into}/loose.txt`],
  });
  assert.deepEqual(fs.readdirSync(recu), []);
  assert.deepEqual(filedPathOf(db, first), { filed_path: `${into}/2026-11-15-brief.pdf`, order_name: order });
  db.close();
});

test("openOrder and moveIntoOrder: a room folder or an order that leads out of the root is refused before anything is created or moved", (t) => {
  const root = tempRoot();
  const outside = tempRoot();
  try {
    fs.symlinkSync(outside, path.join(root, "shop"), "junction");
  } catch {
    t.skip("cannot create a directory link here");
    return;
  }
  const at = new Date("2026-11-15T10:00:00Z");
  assert.throws(() => openOrder(root, "shop", "acme", "sign", at, "UTC"), RoomFolderError);
  assert.deepEqual(fs.readdirSync(outside), [], "no order made out of the root");
  const db = openDb(path.join(tempRoot(), "hq.db"));
  const id = filedItem(db, root, "office", "a.pdf", { forRoom: "shop" });
  fs.writeFileSync(path.join(root, "office", "recu", "loose.txt"), "loose");
  const loose = fs.realpathSync(path.join(root, "office", "recu", "loose.txt"));
  assert.throws(() => moveIntoOrder(db, root, "shop", "2026-11-acme-sign", [{ id, filedPath: "office/recu/a.pdf" }], []), RoomFolderError);
  assert.throws(() => moveIntoOrder(db, root, "shop", "2026-11-acme-sign", [], [loose]), RoomFolderError);
  assert.deepEqual(fs.readdirSync(outside), [], "nothing created or moved out of the root");
  assert.deepEqual(fs.readdirSync(path.join(root, "office", "recu")).sort(), ["a.pdf", "loose.txt"]);
  assert.equal(filedPathOf(db, id).filed_path, "office/recu/a.pdf");

  // A room folder inside the root whose order is a link out.
  const other = tempRoot();
  const away = tempRoot();
  fs.mkdirSync(path.join(other, "shop"));
  fs.symlinkSync(away, path.join(other, "shop", "2026-11-acme-sign"), "junction");
  assert.throws(() => openOrder(other, "shop", "acme", "sign", at, "UTC"), RoomFolderError);
  fs.mkdirSync(path.join(other, "office", "recu"), { recursive: true });
  fs.writeFileSync(path.join(other, "office", "recu", "b.txt"), "b");
  assert.throws(() => moveIntoOrder(db, other, "shop", "2026-11-acme-sign", [], [fs.realpathSync(path.join(other, "office", "recu", "b.txt"))]), RoomFolderError);
  assert.deepEqual(fs.readdirSync(away), [], "nothing created in the order's target");
  db.close();
});

test("moveExclusive: a target that appeared after its name was chosen is never replaced, for a file or a directory", () => {
  const dir = tempRoot();
  const at = (name: string) => path.join(dir, name);
  fs.writeFileSync(at("mine.txt"), "mine");
  fs.writeFileSync(at("taken.txt"), "theirs");
  assert.throws(() => moveExclusive(at("mine.txt"), at("taken.txt")), (e: NodeJS.ErrnoException) => e.code === "EEXIST");
  assert.equal(fs.readFileSync(at("taken.txt"), "utf8"), "theirs");
  assert.equal(fs.readFileSync(at("mine.txt"), "utf8"), "mine");

  fs.mkdirSync(at("folder"));
  fs.writeFileSync(at("folder/inside.txt"), "inside");
  fs.mkdirSync(at("busy"));
  fs.writeFileSync(at("busy/theirs.txt"), "theirs");
  fs.mkdirSync(at("empty"));
  for (const target of ["busy", "empty", "taken.txt"]) {
    assert.throws(() => moveExclusive(at("folder"), at(target)), (e: NodeJS.ErrnoException) => e.code === "EEXIST", target);
  }
  assert.deepEqual(fs.readdirSync(at("busy")), ["theirs.txt"]);
  assert.deepEqual(fs.readdirSync(at("empty")), []);
  assert.equal(fs.readFileSync(at("taken.txt"), "utf8"), "theirs");
  assert.deepEqual(fs.readdirSync(at("folder")), ["inside.txt"]);

  moveExclusive(at("mine.txt"), at("free.txt"));
  assert.equal(fs.readFileSync(at("free.txt"), "utf8"), "mine");
  assert.ok(!fs.existsSync(at("mine.txt")));
  moveExclusive(at("folder"), at("moved"));
  assert.equal(fs.readFileSync(at("moved/inside.txt"), "utf8"), "inside");
  assert.ok(!fs.existsSync(at("folder")));
});

test("moveExclusive: when the source cannot be unlinked (a file held open), the target just made is removed and the error thrown", (t) => {
  const dir = tempRoot();
  const source = path.join(dir, "held.pdf");
  const target = path.join(dir, "moved.pdf");
  fs.writeFileSync(source, "held");
  const real = fs.unlinkSync;
  let failed = false;
  t.mock.method(fs, "unlinkSync", (p: fs.PathLike) => {
    if (!failed && String(p) === source) {
      failed = true;
      throw Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
    }
    return real(p);
  });
  assert.throws(() => moveExclusive(source, target), (e: NodeJS.ErrnoException) => e.code === "EBUSY");
  assert.equal(fs.readFileSync(source, "utf8"), "held", "the source stays where it was");
  assert.ok(!fs.existsSync(target), "nothing at the target");
});

test("moveIntoOrder: a second move whose source cannot be unlinked leaves the first one undone", (t) => {
  const root = tempRoot();
  const db = openDb(path.join(tempRoot(), "hq.db"));
  const recu = path.join(root, "shop", "recu");
  const first = filedItem(db, root, "shop", "2026-11-15-brief.pdf", { twin: true });
  const second = filedItem(db, root, "shop", "2026-11-15-plan.pdf");
  const entries = receivedEntries(db, root, "shop", [first, second]);
  const { order } = openOrder(root, "shop", "acme", "sign", new Date("2026-11-15T10:00:00Z"), "UTC");
  const held = path.join(root, "shop", "recu", "2026-11-15-plan.pdf");
  const real = fs.unlinkSync;
  t.mock.method(fs, "unlinkSync", (p: fs.PathLike) => {
    if (String(p) === held) throw Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
    return real(p);
  });
  assert.throws(() => moveIntoOrder(db, root, "shop", order, entries, []), (e: NodeJS.ErrnoException) => e.code === "EBUSY");
  assert.deepEqual(fs.readdirSync(recu).sort(), ["2026-11-15-brief.md", "2026-11-15-brief.pdf", "2026-11-15-plan.pdf"]);
  assert.deepEqual(fs.readdirSync(path.join(root, "shop", order, "recu")), [], "nothing left in the order");
  assert.deepEqual(filedPathOf(db, first), { filed_path: "shop/recu/2026-11-15-brief.pdf", order_name: null });
  db.close();
});

test("receivedNames: a case variant of a filed item, or of its .md twin, is that item and moves by its id", () => {
  const root = tempRoot();
  const db = openDb(path.join(tempRoot(), "hq.db"));
  const id = filedItem(db, root, "shop", "2026-11-15-mail.pdf", { twin: true });
  for (const variant of ["2026-11-15-MAIL.pdf", "2026-11-15-Mail.MD", "2026-11-15-mail.MD"]) {
    const where = path.join(root, "shop", "recu", variant);
    // On a case-insensitive disk the variant is the filed file itself; elsewhere it is a file of its own, refused all the same.
    if (!fs.existsSync(where)) fs.writeFileSync(where, "variant");
    assert.throws(() => receivedNames(db, root, "shop", [variant]), new RegExp(`is item #${id}, filed by MyHQ`), variant);
  }
  db.close();
});

test("receivedNames: a backslash makes a name not plain, like a slash or a colon", () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, "shop", "recu"), { recursive: true });
  fs.writeFileSync(path.join(root, "shop", "recu", "x.png"), "png");
  const db = openDb(path.join(tempRoot(), "hq.db"));
  for (const bad of ["..\\x.png", "a\\b.png", "\\x.png", "sub/x.png", "C:x.png"]) {
    assert.throws(() => receivedNames(db, root, "shop", [bad]), /is not a plain name/, JSON.stringify(bad));
  }
  assert.deepEqual(receivedNames(db, root, "shop", ["x.png"]), [fs.realpathSync(path.join(root, "shop", "recu", "x.png"))]);
  db.close();
});

test("a room folder that is a link out of the root is refused for listing and reading", (t) => {
  const root = tempRoot();
  const outside = tempRoot();
  fs.writeFileSync(path.join(outside, "secret.pdf"), "secret");
  try {
    fs.symlinkSync(outside, path.join(root, "shop"), "junction");
  } catch {
    t.skip("cannot create a directory link here");
    return;
  }
  assert.throws(() => listRoomFolder(root, "shop", ""), RoomFolderError);
  assert.throws(() => resolveRoomFile(root, "shop", "secret.pdf"), RoomFolderError);
  assert.throws(() => saveReceived(root, "shop", null, "a.pdf", Buffer.from("x")), RoomFolderError);
  assert.deepEqual(fs.readdirSync(outside), ["secret.pdf"], "nothing created out of the root");
  assert.throws(() => listRoomFolder(root, "../x", ""), RoomFolderError, "a room name that climbs out");
});

// --- moveDroppedIntoReceived: a file of the assistant's drop folder, filed by an act of the owner ---

/** A drop folder with files, and the room folders root beside it. */
function dropSetup(files: Record<string, string>) {
  const dropDir = tempRoot();
  const root = tempRoot();
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dropDir, name), content);
  return { dropDir, root };
}

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof DroppedFileError, String(error));
    return error.code;
  }
  assert.fail("did not throw");
};

test("moveDroppedIntoReceived: moves the file into the recu of the room, or of an order, and never overwrites", () => {
  const { dropDir, root } = dropSetup({ "logo.png": "one", "logo2.png": "two" });
  assert.equal(moveDroppedIntoReceived(root, dropDir, "shop", null, "logo.png"), "shop/recu/logo.png");
  assert.equal(fs.readFileSync(path.join(root, "shop", "recu", "logo.png"), "utf8"), "one");
  assert.ok(!fs.existsSync(path.join(dropDir, "logo.png")), "moved, not copied");
  // The same name again: numbered, the first one untouched.
  fs.writeFileSync(path.join(dropDir, "logo.png"), "again");
  assert.equal(moveDroppedIntoReceived(root, dropDir, "shop", null, "logo.png"), "shop/recu/logo-2.png");
  assert.equal(fs.readFileSync(path.join(root, "shop", "recu", "logo.png"), "utf8"), "one");

  const { order } = openOrder(root, "shop", "acme", "sign", new Date("2026-11-15T10:00:00Z"), "UTC");
  assert.equal(moveDroppedIntoReceived(root, dropDir, "shop", order, "logo2.png"), `shop/${order}/recu/logo2.png`);
  assert.deepEqual(fs.readdirSync(dropDir), []);
});

test("moveDroppedIntoReceived: the companion note moves with the file, under the same free stem", () => {
  const { dropDir, root } = dropSetup({ "photo.jpg": "jpg", "photo.md": "Caption\n\n![photo.jpg](photo.jpg)\n", "other.md": "unrelated" });
  fs.mkdirSync(path.join(root, "shop", "recu"), { recursive: true });
  // Only the note's name is taken: the file follows it to -2.
  fs.writeFileSync(path.join(root, "shop", "recu", "photo.md"), "older");
  assert.equal(moveDroppedIntoReceived(root, dropDir, "shop", null, "photo.jpg"), "shop/recu/photo-2.jpg");
  assert.equal(fs.readFileSync(path.join(root, "shop", "recu", "photo-2.md"), "utf8"), "Caption\n\n![photo.jpg](photo.jpg)\n");
  assert.equal(fs.readFileSync(path.join(root, "shop", "recu", "photo.md"), "utf8"), "older");
  assert.deepEqual(fs.readdirSync(dropDir), ["other.md"], "an unrelated note stays");
  // A note given as the file moves alone, it is not its own companion.
  assert.equal(moveDroppedIntoReceived(root, dropDir, "shop", null, "other.md"), "shop/recu/other.md");
});

test("moveDroppedIntoReceived: a missing order lists the orders, and nothing is created", () => {
  const { dropDir, root } = dropSetup({ "a.pdf": "pdf" });
  assert.equal(codeOf(() => moveDroppedIntoReceived(root, dropDir, "shop", "2026-11-acme-sign", "a.pdf")), "no_such_order");
  assert.ok(!fs.existsSync(path.join(root, "shop")), "no room folder made for an order that is not there");
  openOrder(root, "shop", "acme", "mug", new Date("2026-10-10T10:00:00Z"), "UTC");
  openOrder(root, "shop", "beta", "cup", new Date("2026-11-10T10:00:00Z"), "UTC");
  try {
    moveDroppedIntoReceived(root, dropDir, "shop", "2026-11-acme-sign", "a.pdf");
    assert.fail("did not throw");
  } catch (error) {
    assert.ok(error instanceof DroppedFileError);
    assert.deepEqual(error.orders, ["2026-11-beta-cup", "2026-10-acme-mug"]);
  }
  assert.throws(() => moveDroppedIntoReceived(root, dropDir, "shop", "recu", "a.pdf"), RoomFolderError, "a drawer is not an order");
  assert.deepEqual(fs.readdirSync(dropDir), ["a.pdf"]);
});

test("moveDroppedIntoReceived: only a regular file directly in the drop folder, by a plain name", () => {
  const { dropDir, root } = dropSetup({ "a.pdf": "pdf" });
  fs.mkdirSync(path.join(dropDir, "sub"));
  fs.writeFileSync(path.join(dropDir, "sub", "b.pdf"), "pdf");
  fs.writeFileSync(path.join(root, "outside.pdf"), "pdf");
  assert.equal(codeOf(() => moveDroppedIntoReceived(root, dropDir, "shop", null, "missing.pdf")), "not_in_drop");
  assert.equal(codeOf(() => moveDroppedIntoReceived(root, dropDir, "shop", null, "sub")), "not_a_file");
  for (const bad of ["sub/b.pdf", "sub\\b.pdf", "../outside.pdf", "..", ".", "", "C:a.pdf"]) {
    assert.equal(codeOf(() => moveDroppedIntoReceived(root, dropDir, "shop", null, bad)), "not_in_drop", JSON.stringify(bad));
  }
  assert.throws(() => moveDroppedIntoReceived(root, dropDir, "../shop", null, "a.pdf"), RoomFolderError, "a room name that climbs out");
  assert.ok(fs.existsSync(path.join(dropDir, "a.pdf")) && fs.existsSync(path.join(root, "outside.pdf")));
  assert.ok(!fs.existsSync(path.join(root, "shop")));
});

test("moveDroppedIntoReceived: a link in the drop folder that leads out is refused, the target untouched", (t) => {
  const { dropDir, root } = dropSetup({});
  const outside = tempRoot();
  fs.writeFileSync(path.join(outside, "secret.pdf"), "secret");
  let linked = 0;
  try {
    fs.symlinkSync(path.join(outside, "secret.pdf"), path.join(dropDir, "link.pdf"), "file");
    assert.equal(codeOf(() => moveDroppedIntoReceived(root, dropDir, "shop", null, "link.pdf")), "leads_out");
    linked++;
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
  }
  try {
    fs.symlinkSync(outside, path.join(dropDir, "jump"), "junction");
    assert.equal(codeOf(() => moveDroppedIntoReceived(root, dropDir, "shop", null, "jump")), "leads_out");
    linked++;
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
  }
  if (linked === 0) {
    t.skip("cannot create a link here");
    return;
  }
  assert.equal(fs.readFileSync(path.join(outside, "secret.pdf"), "utf8"), "secret");
  assert.ok(!fs.existsSync(path.join(root, "shop")));
});

test("moveDroppedIntoReceived: a room folder that leads out of the root is refused, the file stays", (t) => {
  const { dropDir, root } = dropSetup({ "a.pdf": "pdf" });
  const outside = tempRoot();
  try {
    fs.symlinkSync(outside, path.join(root, "shop"), "junction");
  } catch {
    t.skip("cannot create a directory link here");
    return;
  }
  assert.throws(() => moveDroppedIntoReceived(root, dropDir, "shop", null, "a.pdf"), RoomFolderError);
  assert.deepEqual(fs.readdirSync(outside), [], "nothing written out of the root");
  assert.deepEqual(fs.readdirSync(dropDir), ["a.pdf"]);
});

test("moveDroppedIntoReceived: a hard link is refused like a link, and a hard-linked note does not move with its file", (t) => {
  const { dropDir, root } = dropSetup({ "photo.jpg": "jpg" });
  const outside = tempRoot();
  fs.writeFileSync(path.join(outside, "secret.pdf"), "secret");
  fs.writeFileSync(path.join(outside, "note.md"), "outside note");
  try {
    fs.linkSync(path.join(outside, "secret.pdf"), path.join(dropDir, "linked.pdf"));
    fs.linkSync(path.join(outside, "note.md"), path.join(dropDir, "photo.md"));
  } catch {
    t.skip("cannot create a hard link here");
    return;
  }
  assert.equal(codeOf(() => moveDroppedIntoReceived(root, dropDir, "shop", null, "linked.pdf")), "leads_out");
  assert.ok(fs.existsSync(path.join(dropDir, "linked.pdf")), "the hard link stays where it is");
  assert.equal(moveDroppedIntoReceived(root, dropDir, "shop", null, "photo.jpg"), "shop/recu/photo.jpg");
  assert.deepEqual(fs.readdirSync(path.join(root, "shop", "recu")), ["photo.jpg"], "the file moves alone");
  assert.ok(fs.existsSync(path.join(dropDir, "photo.md")), "the hard-linked note stays");
  assert.equal(fs.readFileSync(path.join(outside, "secret.pdf"), "utf8"), "secret");
  assert.equal(fs.readFileSync(path.join(outside, "note.md"), "utf8"), "outside note");
});

test("moveDroppedIntoReceived: a reserved device name is neutralised like a received one", () => {
  const { dropDir, root } = dropSetup({ "con.txt": "x" });
  assert.equal(moveDroppedIntoReceived(root, dropDir, "shop", null, "con.txt"), "shop/recu/_con.txt");
});

test("moveDroppedIntoReceived: when the move crosses volumes (EXDEV) the file is copied then removed", (t) => {
  const { dropDir, root } = dropSetup({ "a.png": "png", "a.md": "note" });
  const realDrop = fs.realpathSync(dropDir);
  const realLink = fs.linkSync;
  const realRename = fs.renameSync;
  const crossDevice = () => Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
  t.mock.method(fs, "linkSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(from).startsWith(realDrop)) throw crossDevice();
    return realLink(from, to);
  });
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(from).startsWith(realDrop)) throw crossDevice();
    return realRename(from, to);
  });
  assert.equal(moveDroppedIntoReceived(root, dropDir, "shop", null, "a.png"), "shop/recu/a.png");
  assert.equal(fs.readFileSync(path.join(root, "shop", "recu", "a.png"), "utf8"), "png");
  assert.equal(fs.readFileSync(path.join(root, "shop", "recu", "a.md"), "utf8"), "note");
  assert.deepEqual(fs.readdirSync(dropDir), [], "nothing left in the drop folder");
});
