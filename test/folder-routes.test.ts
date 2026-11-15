import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { app } from "../src/server/app";
import { folderFileResponse, folderListingResponse, openOrderResponse, receivedResponse } from "../src/server/folder-routes";
import { makeHome } from "./helpers";

// One temporary home for the whole file: "demo" takes no orders, "shop" does.
const config = makeHome();
const shopDir = path.join(config.home, "rooms", "shop");
fs.mkdirSync(path.join(shopDir, "roles"), { recursive: true });
fs.writeFileSync(path.join(shopDir, "roles", "scout.md"), "You are a test agent.\n");
fs.writeFileSync(
  path.join(shopDir, "room.json"),
  JSON.stringify({
    name: "shop",
    targetRepo: "../shop-project",
    orders: true,
    agents: [{ id: "scout", name: "Scout", role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"] }],
  }),
);
const root = path.join(config.home, "folders");

function withHome<T>(run: () => Promise<T>): Promise<T> {
  const saved = process.env.MYHQ_HOME;
  process.env.MYHQ_HOME = config.home;
  return run().finally(() => {
    if (saved === undefined) delete process.env.MYHQ_HOME;
    else process.env.MYHQ_HOME = saved;
  });
}

const list = (room: string, rel?: string) =>
  folderListingResponse(new Request(`http://localhost/api/rooms/${room}/folder${rel === undefined ? "" : `?path=${encodeURIComponent(rel)}`}`), room);
const serve = (room: string, rel: string, init?: RequestInit) =>
  folderFileResponse(new Request(`http://localhost/api/rooms/${room}/folder/file?path=${encodeURIComponent(rel)}`, init), room);
const order = (room: string, body: unknown) =>
  openOrderResponse(
    new Request(`http://localhost/api/rooms/${room}/folder/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    room,
  );
/** Posts a deposit as a browser does: the multipart body encoded, with its Content-Type and its Content-Length. */
async function deposit(room: string, files: { name: string; data: string | Uint8Array<ArrayBuffer> }[], extra?: { order?: string; headers?: Record<string, string> }) {
  const form = new FormData();
  for (const file of files) form.append("file", new File([file.data], file.name));
  if (extra?.order !== undefined) form.append("order", extra.order);
  const encoded = new Request("http://localhost/", { method: "POST", body: form });
  const body = new Uint8Array(await encoded.arrayBuffer());
  const headers = { "content-type": encoded.headers.get("content-type")!, "content-length": String(body.byteLength), ...extra?.headers };
  return receivedResponse(new Request(`http://localhost/api/rooms/${room}/folder/received`, { method: "POST", body, headers }), room);
}
const codeOf = async (response: Response) => ((await response.json()) as { error: { code: string } }).error.code;

test("listing: the first listing creates the room folder with its recu/, then lists drawers, orders and files", () =>
  withHome(async () => {
    app();
    const first = await list("demo");
    assert.equal(first.status, 200);
    const body = (await first.json()) as {
      room: string;
      path: string;
      location: string;
      orders: boolean;
      file: string | null;
      entries: { name: string; role: string | null; type: string }[];
      deposit: { maxFiles: number; maxFileBytes: number };
    };
    assert.equal(body.room, "demo");
    assert.equal(body.path, "");
    assert.equal(body.orders, false);
    assert.equal(body.file, null);
    assert.equal(fs.realpathSync(body.location), fs.realpathSync(path.join(root, "demo")));
    assert.deepEqual(body.entries.map((entry) => [entry.name, entry.role]), [["recu", "drawer"]]);
    assert.equal(body.deposit.maxFiles, 20);
    assert.ok(body.deposit.maxFileBytes > 0);

    fs.mkdirSync(path.join(root, "demo", "visuels"), { recursive: true });
    fs.writeFileSync(path.join(root, "demo", "visuels", "cover.png"), "png");
    const inner = (await (await list("demo", "visuels")).json()) as { path: string; location: string; entries: { path: string; kind: string | null }[] };
    assert.equal(inner.path, "visuels");
    assert.equal(fs.realpathSync(inner.location), fs.realpathSync(path.join(root, "demo", "visuels")));
    assert.deepEqual(inner.entries.map((entry) => [entry.path, entry.kind]), [["visuels/cover.png", "image"]]);

    const pointed = (await (await list("demo", "visuels/cover.png")).json()) as { path: string; file: string | null };
    assert.equal(pointed.path, "visuels", "a path to a file lists its directory");
    assert.equal(pointed.file, "visuels/cover.png");
  }));

test("listing: a path that climbs out, an absolute path, a missing one, an unknown room", () =>
  withHome(async () => {
    for (const bad of ["..", "../demo", "recu/../../x", "/etc", "C:\\Windows"]) {
      const refused = await list("demo", bad);
      assert.equal(refused.status, 400, bad);
      assert.equal(await codeOf(refused), "FOLDER_PATH_INVALID");
    }
    assert.equal((await list("demo", "nothing-here")).status, 400);
    const unknown = await list("ghost");
    assert.equal(unknown.status, 404);
    assert.equal(await codeOf(unknown), "ROOM_NOT_FOUND");
    assert.equal((await list("Not A Room")).status, 404);
    assert.equal(fs.existsSync(path.join(root, "ghost")), false, "nothing is created for an unknown room");
  }));

test("file: a known kind inline with its type, anything else download only, never rendered", () =>
  withHome(async () => {
    const dir = path.join(root, "demo", "documents");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    fs.writeFileSync(path.join(dir, "page.html"), "<html><script>alert(1)</script></html>");
    fs.writeFileSync(path.join(dir, "shot.png"), "png bytes");

    const png = await serve("demo", "documents/shot.png");
    assert.equal(png.status, 200);
    assert.equal(png.headers.get("content-type"), "image/png");
    assert.match(png.headers.get("content-disposition")!, /^inline; filename="shot\.png"/);
    assert.equal(png.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await png.text(), "png bytes");
    const ranged = await serve("demo", "documents/shot.png", { headers: { range: "bytes=0-2" } });
    assert.equal(ranged.status, 206);
    assert.equal(await ranged.text(), "png");
    const asked = await serve("demo", "documents/shot.png?x", {});
    assert.equal(asked.status, 404, "the query is the path, nothing else");

    for (const name of ["logo.svg", "page.html"]) {
      const response = await serve("demo", `documents/${name}`);
      assert.equal(response.status, 200, name);
      assert.equal(response.headers.get("content-type"), "application/octet-stream", name);
      assert.equal(response.headers.get("content-disposition"), `attachment; filename="${name}"; filename*=UTF-8''${name}`, name);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff", name);
      assert.match(response.headers.get("content-security-policy")!, /sandbox/, name);
      await response.arrayBuffer();
    }
    fs.writeFileSync(path.join(dir, "devis été.html"), "x");
    const encoded = await serve("demo", "documents/devis été.html");
    assert.equal(encoded.headers.get("content-disposition"), `attachment; filename="devis _t_.html"; filename*=UTF-8''devis%20%C3%A9t%C3%A9.html`);
    await encoded.arrayBuffer();

    const missing = await serve("demo", "documents/none.png");
    assert.equal(missing.status, 404);
    assert.equal((await serve("demo", "../demo/documents/shot.png")).status, 404);
    assert.equal((await serve("demo", "documents")).status, 404, "a directory is not a file");
    assert.equal((await serve("ghost", "x.png")).status, 404);
  }));

test("orders: opened in a room that takes them, named from the client and the subject; a 409 elsewhere", () =>
  withHome(async () => {
    const created = await order("shop", { client: "ACME Corp", subject: "Enseigne été" });
    assert.equal(created.status, 201);
    const body = (await created.json()) as { order: string; created: boolean; path: string };
    assert.match(body.order, /^\d{4}-\d{2}-acme-corp-enseigne-ete$/);
    assert.equal(body.created, true);
    assert.equal(body.path, `shop/${body.order}`);
    assert.equal(fs.statSync(path.join(root, "shop", body.order, "recu")).isDirectory(), true);
    const again = await order("shop", { client: "ACME Corp", subject: "Enseigne été" });
    assert.equal(again.status, 200);
    assert.equal(((await again.json()) as { created: boolean }).created, false);

    const listing = (await (await list("shop")).json()) as { orders: boolean; entries: { name: string; role: string | null }[] };
    assert.equal(listing.orders, true);
    assert.ok(listing.entries.some((entry) => entry.name === body.order && entry.role === "order"));

    const refused = await order("demo", { client: "ACME", subject: "Sign" });
    assert.equal(refused.status, 409);
    assert.equal(await codeOf(refused), "ORDERS_NOT_TAKEN");
    assert.equal((await order("shop", { client: "!!!", subject: "Sign" })).status, 400);
    assert.equal((await order("shop", { client: "ACME" })).status, 400);
    assert.equal((await order("ghost", { client: "a", subject: "b" })).status, 404);
    const plain = await openOrderResponse(new Request("http://localhost/x", { method: "POST", body: "{}" }), "shop");
    assert.equal(plain.status, 415, "a JSON body only");
  }));

test("deposit: hostile names stay inside recu/, into an order's recu/ too, nothing climbs out", () =>
  withHome(async () => {
    const response = await deposit("demo", [
      { name: "../x.png", data: "a" },
      { name: "C:\\x.png", data: "b" },
      { name: "..\\..\\evil.html", data: "c" },
      { name: "notes.txt", data: "d" },
    ]);
    assert.equal(response.status, 201);
    const body = (await response.json()) as { room: string; order: string | null; saved: string[] };
    assert.equal(body.order, null);
    assert.deepEqual(body.saved, ["recu/x.png", "recu/x-2.png", "recu/evil.html", "recu/notes.txt"], "the base name only, numbered when taken");
    const recu = fs.realpathSync(path.join(root, "demo", "recu"));
    for (const saved of body.saved) {
      assert.match(saved, /^recu\/[^/\\]+$/, saved);
      assert.equal(path.dirname(fs.realpathSync(path.join(root, "demo", saved))), recu, saved);
    }
    assert.equal(fs.existsSync(path.join(root, "demo", "x.png")), false);
    assert.equal(fs.existsSync(path.join(root, "x.png")), false);
    assert.equal(fs.existsSync(path.join(root, "evil.html")), false);

    const opened = (await (await order("shop", { client: "Client", subject: "Box" })).json()) as { order: string };
    const into = await deposit("shop", [{ name: "brief.pdf", data: "pdf" }], { order: opened.order });
    assert.equal(into.status, 201);
    assert.deepEqual(((await into.json()) as { saved: string[] }).saved, [`${opened.order}/recu/brief.pdf`]);
    assert.equal((await deposit("shop", [{ name: "a.pdf", data: "x" }], { order: "2026-01-none-here" })).status, 400);
    assert.equal((await deposit("shop", [{ name: "a.pdf", data: "x" }], { order: "../demo" })).status, 400);
    const noOrders = await deposit("demo", [{ name: "a.pdf", data: "x" }], { order: "2026-01-acme-sign" });
    assert.equal(noOrders.status, 409);
  }));

test("deposit: the caps on count and size, an empty file, no file, another site, not multipart", () =>
  withHome(async () => {
    const before = fs.readdirSync(path.join(root, "demo", "recu")).length;
    const many = Array.from({ length: 21 }, (_, index) => ({ name: `f${index}.txt`, data: "x" }));
    const tooMany = await deposit("demo", many);
    assert.equal(tooMany.status, 400);
    assert.equal(await codeOf(tooMany), "TOO_MANY_FILES");
    assert.equal((await deposit("demo", many.slice(0, 20))).status, 201, "20 files pass");

    const savedCap = process.env.HQ_ATTACHMENT_MAX_MB;
    process.env.HQ_ATTACHMENT_MAX_MB = "0.001";
    try {
      const big = await deposit("demo", [
        { name: "small.txt", data: "x" },
        { name: "big.bin", data: new Uint8Array(2_000) },
      ]);
      assert.equal(big.status, 413);
      assert.equal(await codeOf(big), "FILE_TOO_LARGE");
      const declared = await receivedResponse(
        new Request("http://localhost/x", {
          method: "POST",
          headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(50 * 1024 * 1024) },
          body: "--x--",
        }),
        "demo",
      );
      assert.equal(declared.status, 413, "a body declared over the caps is refused before it is read");
    } finally {
      if (savedCap === undefined) delete process.env.HQ_ATTACHMENT_MAX_MB;
      else process.env.HQ_ATTACHMENT_MAX_MB = savedCap;
    }
    assert.equal(fs.readdirSync(path.join(root, "demo", "recu")).length, before + 20, "a refused deposit writes nothing");

    const empty = await deposit("demo", [{ name: "empty.txt", data: "" }]);
    assert.equal(empty.status, 400);
    assert.equal(await codeOf(empty), "EMPTY_FILE");
    assert.equal(await codeOf(await deposit("demo", [])), "NO_FILE");
    const cross = await deposit("demo", [{ name: "a.txt", data: "x" }], { headers: { "sec-fetch-site": "cross-site" } });
    assert.equal(cross.status, 403);
    const otherOrigin = await deposit("demo", [{ name: "a.txt", data: "x" }], { headers: { origin: "http://evil.example" } });
    assert.equal(otherOrigin.status, 403);
    const sameOrigin = await deposit("demo", [{ name: "a.txt", data: "x" }], { headers: { origin: "http://localhost", "sec-fetch-site": "same-origin" } });
    assert.equal(sameOrigin.status, 201);
    const json = await receivedResponse(
      new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      "demo",
    );
    assert.equal(json.status, 415);
    assert.equal((await deposit("ghost", [{ name: "a.txt", data: "x" }])).status, 404);
  }));

test("deposit: without a Content-Length, or with one that is not a non negative number, a 411 before the body is read", () =>
  withHome(async () => {
    const before = fs.readdirSync(path.join(root, "demo", "recu")).length;
    const form = new FormData();
    form.append("file", new File(["x"], "a.txt"));
    const encoded = new Request("http://localhost/", { method: "POST", body: form });
    const type = encoded.headers.get("content-type")!;
    const body = new Uint8Array(await encoded.arrayBuffer());
    for (const length of [undefined, "", "abc", "-5", "1.5", "1e3"]) {
      const headers: Record<string, string> = { "content-type": type };
      if (length !== undefined) headers["content-length"] = length;
      const refused = await receivedResponse(new Request("http://localhost/x", { method: "POST", headers, body }), "demo");
      assert.equal(refused.status, 411, String(length));
      assert.equal(await codeOf(refused), "LENGTH_REQUIRED", String(length));
    }
    assert.equal(fs.readdirSync(path.join(root, "demo", "recu")).length, before, "nothing written");
  }));
