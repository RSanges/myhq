import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DRAWERS, isOrderName as serverIsOrderName, openOrder } from "../src/server/room-folders";
import {
  addressFromParams,
  cleanPath,
  depositProblem,
  depositTarget,
  DRAWER_NAMES,
  emptyText,
  filedHref,
  folderCrumbs,
  folderFileUrl,
  foldersHref,
  formatSize,
  groupEntries,
  isOrderName,
  orderPreview,
  previewKind,
} from "../src/ui/folders-model";
import type { FolderEntry } from "../src/ui/schemas";
import { strings } from "../src/ui/strings";

const entry = (name: string, over: Partial<FolderEntry> = {}): FolderEntry => ({
  name,
  path: name,
  type: "dir",
  size: 0,
  modifiedAt: "2026-11-15T10:00:00.000Z",
  role: null,
  kind: null,
  ...over,
});

test("the drawers and the order rule are the server's", () => {
  assert.deepEqual([...DRAWER_NAMES], [...DRAWERS]);
  for (const name of ["2026-11-acme-sign", "2026-1-acme", "recu", "2026-11-ACME", "2026-11-a--b", "notes"]) {
    assert.equal(isOrderName(name), serverIsOrderName(name), name);
  }
  for (const drawer of DRAWERS) assert.ok(strings.folders.drawers[drawer], `a label and a hint for ${drawer}`);
});

test("address: the room and the place in its folder, kept in the query, nothing that climbs out", () => {
  const params = (query: string) => new URLSearchParams(query);
  assert.deepEqual(addressFromParams(params("salle=shop&chemin=2026-11-acme-sign/devis")), { room: "shop", path: "2026-11-acme-sign/devis" });
  assert.deepEqual(addressFromParams(params("salle=shop&chemin=../x")), { room: "shop", path: "" });
  assert.deepEqual(addressFromParams(params("salle=Shop&chemin=recu")), { room: null, path: "" });
  assert.deepEqual(addressFromParams(params("")), { room: null, path: "" });
  assert.equal(cleanPath("/etc"), "");
  assert.equal(cleanPath("C:\\x"), "");
  assert.equal(cleanPath("a//b/./c/"), "a/b/c");
  assert.equal(cleanPath("a\\b"), "a/b");
  assert.equal(foldersHref({ room: "shop", path: "" }), "/dossiers?salle=shop");
  assert.equal(foldersHref({ room: "shop", path: "2026-11-acme-sign/recu" }), "/dossiers?salle=shop&chemin=2026-11-acme-sign%2Frecu");
  assert.equal(foldersHref({ room: null, path: "x" }), "/dossiers");
  const back = addressFromParams(new URL(`http://x${foldersHref({ room: "demo", path: "visuels/été 1.png" })}`).searchParams);
  assert.deepEqual(back, { room: "demo", path: "visuels/été 1.png" }, "an address reads back as it was written");
});

test("filed link: the room is the first segment of the path filed, the rest is the place", () => {
  assert.equal(filedHref("shop/2026-11-acme-sign/devis/2026-11-15-quote.pdf"), "/dossiers?salle=shop&chemin=2026-11-acme-sign%2Fdevis%2F2026-11-15-quote.pdf");
  assert.equal(filedHref("demo/visuels/2026-11-15-cover"), "/dossiers?salle=demo&chemin=visuels%2F2026-11-15-cover");
  assert.equal(filedHref("Bad Room/x"), null);
  assert.equal(filedHref(""), null);
});

test("crumbs: the room, then each folder, a drawer by its French name at the root and in an order only", () => {
  assert.deepEqual(folderCrumbs("Boutique", ""), [{ label: "Boutique", path: "" }]);
  assert.deepEqual(folderCrumbs("Boutique", "2026-11-acme-sign/modeles-3d/v2"), [
    { label: "Boutique", path: "" },
    { label: "2026-11-acme-sign", path: "2026-11-acme-sign" },
    { label: "Modèles 3D", path: "2026-11-acme-sign/modeles-3d" },
    { label: "v2", path: "2026-11-acme-sign/modeles-3d/v2" },
  ]);
  assert.deepEqual(
    folderCrumbs("Demo", "recu/recu").map((crumb) => crumb.label),
    ["Demo", "Reçu", "recu"],
    "a folder named like a drawer deeper down keeps its name",
  );
});

test("groups: orders newest first, drawers in the order of the list, then folders and files", () => {
  const groups = groupEntries([
    entry("2026-10-acme-box", { role: "order" }),
    entry("2026-11-acme-sign", { role: "order" }),
    entry("devis", { role: "drawer" }),
    entry("recu", { role: "drawer" }),
    entry("visuels", { role: "drawer" }),
    entry("archive"),
    entry("notes.txt", { type: "file", size: 3 }),
  ]);
  assert.deepEqual(groups.orders.map((each) => each.name), ["2026-11-acme-sign", "2026-10-acme-box"]);
  assert.deepEqual(groups.drawers.map((each) => each.name), ["recu", "visuels", "devis"]);
  assert.deepEqual(groups.folders.map((each) => each.name), ["archive"]);
  assert.deepEqual(groups.files.map((each) => each.name), ["notes.txt"]);
});

test("deposit target: the recu/ of the room or of an order, nowhere else", () => {
  assert.deepEqual(depositTarget("recu"), { order: null });
  assert.deepEqual(depositTarget("2026-11-acme-sign/recu"), { order: "2026-11-acme-sign" });
  assert.equal(depositTarget(""), null);
  assert.equal(depositTarget("visuels"), null);
  assert.equal(depositTarget("recu/sub"), null);
  assert.equal(depositTarget("archive/recu"), null);
  assert.equal(emptyText(""), strings.folders.empty.room);
  assert.equal(emptyText("recu"), strings.folders.empty.recu);
  assert.equal(emptyText("2026-11-acme-sign/devis"), strings.folders.empty.drawer);
  assert.equal(emptyText("visuels/old"), strings.folders.empty.folder);
});

test("order preview: the name openOrder gives, null while client or subject leaves nothing", () => {
  const now = new Date("2026-11-15T12:00:00Z");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-folders-ui-"));
  for (const [client, subject] of [
    ["ACME Corp", "Enseigne été"],
    ["  Société Générale d'Éclairage ", "Lettres n°2 !"],
    ["x".repeat(80), "Long"],
  ] as const) {
    const expected = openOrder(root, "shop", client, subject, now, "UTC").order;
    assert.equal(orderPreview(client, subject, now), expected, `${client} / ${subject}`);
  }
  assert.equal(orderPreview("!!!", "Sign", now), null);
  assert.equal(orderPreview("ACME", "  ", now), null);
});

test("sizes, file addresses and how a file is shown", () => {
  assert.equal(formatSize(0), "0 o");
  assert.equal(formatSize(512), "512 o");
  assert.equal(formatSize(1536), "1,5 Ko");
  assert.equal(formatSize(12 * 1024 * 1024), "12 Mo");
  assert.equal(formatSize(150.4 * 1024 * 1024), "150 Mo");
  assert.equal(formatSize(1.25 * 1024 ** 3), "1,3 Go");
  assert.equal(folderFileUrl("shop", "recu/a b.png"), "/api/rooms/shop/folder/file?path=recu%2Fa%20b.png");
  assert.equal(folderFileUrl("shop", "recu/x.svg", true), "/api/rooms/shop/folder/file?path=recu%2Fx.svg&download=1");
  assert.equal(previewKind({ kind: "image" }), "image");
  assert.equal(previewKind({ kind: null }), "download");
  assert.equal(previewKind({ kind: "file" }), "download", "a client's piece is never previewed");
});

test("deposit checks: the count, an empty file, a file over the cap", () => {
  const caps = { maxFiles: 2, maxFileBytes: 1024 };
  assert.equal(depositProblem([{ name: "a.png", size: 10 }], caps), null);
  assert.equal(depositProblem([{ name: "a", size: 1 }, { name: "b", size: 1 }, { name: "c", size: 1 }], caps), strings.folders.deposit.tooMany(2));
  assert.equal(depositProblem([{ name: "a.png", size: 0 }], caps), strings.folders.deposit.emptyFile("a.png"));
  assert.equal(depositProblem([{ name: "big.mov", size: 2048 }], caps), strings.folders.deposit.tooLarge("big.mov", "1 Ko"));
});
