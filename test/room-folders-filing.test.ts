import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { hqOrderOpen, hqOrders, hqSubmit, ToolError, type HqContext } from "../src/mcp/tools";
import { decideApproval } from "../src/server/approvals";
import type { HqConfig } from "../src/server/config";
import { getDbAt, type ApprovalRow, type Db } from "../src/server/db";
import { fileApproval, listOrders, openOrder, pendingFilings } from "../src/server/room-folders";
import { loadHome, syncHome } from "../src/server/rooms";
import { writeMessage } from "../src/server/supervisor";
import { dayKey } from "../src/server/time";
import { fileApproved, parseArgs } from "../scripts/file-approved";
import { makeHome } from "./helpers";

/** Adds a room of one agent to a test home. */
function addRoom(home: string, name: string, agent: string, extra: Record<string, unknown> = {}, agentExtra: Record<string, unknown> = {}) {
  const dir = path.join(home, "rooms", name);
  fs.mkdirSync(path.join(dir, "roles"), { recursive: true });
  fs.writeFileSync(path.join(dir, "roles", `${agent}.md`), "You are a test agent.\n");
  fs.writeFileSync(
    path.join(dir, "room.json"),
    JSON.stringify({
      name,
      targetRepo: `../${name}-project`,
      ...extra,
      agents: [{ id: agent, name: agent, role: `roles/${agent}.md`, model: "haiku", allowedTools: ["mcp__hq__*"], ...agentExtra }],
    }),
  );
}

type Office = { config: HqConfig; db: Db; root: string; ctx: (room: string, agent: string) => HqContext; work: (room: string, agent: string) => string };

/**
 * A home with `shop` (orders, agent clerk), `studio` (shared, agent maker),
 * `office` (agent mail) and `watch` (the supervisor, agent boss).
 */
function office(): Office {
  const config = makeHome();
  addRoom(config.home, "shop", "clerk", { orders: true });
  addRoom(config.home, "studio", "maker", { shared: true });
  addRoom(config.home, "office", "mail");
  addRoom(config.home, "watch", "boss", {}, { supervisor: true });
  const db = getDbAt(config.dbPath);
  syncHome(db, loadHome(config.home));
  db.prepare(
    "INSERT INTO runs (id, room, agent_id, engine, task, status, started_at) VALUES (1, 'shop', 'clerk', 'claude', 't', 'running', ?)",
  ).run(new Date().toISOString());
  const work = (room: string, agent: string) => {
    const dir = path.join(config.home, "data", "work", room, agent);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const ctx = (room: string, agent: string): HqContext => ({
    dbPath: config.dbPath,
    runId: 1,
    agentId: agent,
    room,
    home: config.home,
    workDir: work(room, agent),
  });
  return { config, db, root: path.join(config.home, "folders"), ctx, work };
}

/** Writes files in an agent's working directory, returns their relative paths. */
function files(dir: string, names: string[]): { path: string }[] {
  return names.map((name) => {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), `bytes of ${name}`);
    return { path: name };
  });
}

const today = () => dayKey(new Date(), "Europe/Paris");
const row = (db: Db, id: number) => db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow;
const approve = (o: Office, id: number) => decideApproval(o.db, id, { decision: "approved" }, o.config);
const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

test("filing: one file without drawer goes flat to the drawer of its kind, without its body", () => {
  const o = office();
  const clerk = o.ctx("shop", "clerk");
  const { approvalId } = hqSubmit(o.db, clerk, {
    type: "visual",
    title: "Cover Art, été",
    body: "The cover.",
    attachments: files(clerk.workDir!, ["renders/cover.png"]),
  });
  const dto = approve(o, approvalId);
  const expected = `shop/visuels/${today()}-cover-art-ete.png`;
  assert.equal(dto.filedPath, expected);
  assert.equal(dto.drawer, null);
  assert.equal(dto.order, null);
  assert.equal(row(o.db, approvalId).filed_path, expected);
  assert.equal(read(o.root, expected), "bytes of renders/cover.png");
  assert.deepEqual(fs.readdirSync(path.join(o.root, "shop", "visuels")), [`${today()}-cover-art-ete.png`], "no .md without a drawer named");
  assert.ok(fs.existsSync(path.join(o.config.dataDir, "attachments", String(approvalId))), "the frozen copies stay");
});

test("filing: the default drawer goes by what the files are, not by the first one", () => {
  const o = office();
  const clerk = o.ctx("shop", "clerk");
  const cases: [string[], string][] = [
    [["a/part_sheet.png", "a/part.3mf"], "modeles-3d"],
    [["b/clip.mp4", "b/thumb.png"], "videos"],
    [["c/voice.wav", "c/thumb.png"], "sons"],
  ];
  for (const [names, drawer] of cases) {
    const { approvalId } = hqSubmit(o.db, clerk, { type: "piece", title: `Piece ${drawer}`, body: "b", attachments: files(clerk.workDir!, names) });
    assert.equal(approve(o, approvalId).filedPath, `shop/${drawer}/${today()}-piece-${drawer}`);
  }
});

test("filing: a named drawer keeps the body as Markdown beside the file, or alone without a file", () => {
  const o = office();
  const clerk = o.ctx("shop", "clerk");
  const quote = hqSubmit(o.db, clerk, {
    type: "quote",
    title: "Quote",
    body: "# Quote\n\n120 EUR",
    drawer: "devis",
    attachments: files(clerk.workDir!, ["quote.pdf"]),
  });
  const filed = approve(o, quote.approvalId).filedPath!;
  assert.equal(filed, `shop/devis/${today()}-quote.pdf`);
  assert.equal(read(o.root, `shop/devis/${today()}-quote.md`), "# Quote\n\n120 EUR\n");
  assert.equal(row(o.db, quote.approvalId).drawer, "devis");

  const post = hqSubmit(o.db, clerk, { type: "post", title: "Launch post", body: "We open today.", drawer: "social" });
  assert.equal(approve(o, post.approvalId).filedPath, `shop/social/${today()}-launch-post.md`);
  assert.equal(read(o.root, `shop/social/${today()}-launch-post.md`), "We open today.\n");
});

test("filing: a taken name gets -2, the file and its .md under the same suffix, never overwritten", () => {
  const o = office();
  const clerk = o.ctx("shop", "clerk");
  const dir = path.join(o.root, "shop", "devis");
  fs.mkdirSync(dir, { recursive: true });
  // Only the .md is taken: the file must follow it to -2.
  fs.writeFileSync(path.join(dir, `${today()}-quote.md`), "older");
  const { approvalId } = hqSubmit(o.db, clerk, {
    type: "quote",
    title: "Quote",
    body: "new",
    drawer: "devis",
    attachments: files(clerk.workDir!, ["quote.pdf"]),
  });
  assert.equal(approve(o, approvalId).filedPath, `shop/devis/${today()}-quote-2.pdf`);
  assert.equal(read(o.root, `shop/devis/${today()}-quote-2.md`), "new\n");
  assert.equal(read(o.root, `shop/devis/${today()}-quote.md`), "older");
  assert.ok(!fs.existsSync(path.join(dir, `${today()}-quote.pdf`)));
});

test("filing: two files or more go to a folder, under their own names, a repeated one numbered, the body inside", () => {
  const o = office();
  const clerk = o.ctx("shop", "clerk");
  const { approvalId } = hqSubmit(o.db, clerk, {
    type: "render",
    title: "Lamp renders",
    body: "Three views.",
    drawer: "rendus",
    attachments: files(clerk.workDir!, ["front/view.png", "back/view.png", "side.png"]),
  });
  const folder = `shop/rendus/${today()}-lamp-renders`;
  assert.equal(approve(o, approvalId).filedPath, folder);
  assert.deepEqual(fs.readdirSync(path.join(o.root, folder)).sort(), [`${today()}-lamp-renders.md`, "side.png", "view-2.png", "view.png"]);
  assert.equal(read(o.root, `${folder}/view.png`), "bytes of front/view.png");
  assert.equal(read(o.root, `${folder}/view-2.png`), "bytes of back/view.png");

  // The same title again: a second folder, and no body without a named drawer.
  const again = hqSubmit(o.db, clerk, {
    type: "render",
    title: "Lamp renders",
    body: "Other views.",
    drawer: "rendus",
    attachments: files(clerk.workDir!, ["x/a.png", "x/b.png"]),
  });
  assert.equal(approve(o, again.approvalId).filedPath, `${folder}-2`);
  assert.ok(fs.existsSync(path.join(o.root, `${folder}-2`, `${today()}-lamp-renders-2.md`)));
});

test("filing: an item of an order lands in that order's drawer", () => {
  const o = office();
  const clerk = o.ctx("shop", "clerk");
  const { order } = openOrder(o.root, "shop", "acme", "sign", new Date(), "Europe/Paris");
  const { approvalId } = hqSubmit(o.db, clerk, {
    type: "quote",
    title: "Sign quote",
    body: "b",
    order,
    attachments: files(clerk.workDir!, ["sign.pdf"]),
  });
  assert.equal(row(o.db, approvalId).order_name, order);
  const dto = approve(o, approvalId);
  assert.equal(dto.order, order);
  assert.equal(dto.filedPath, `shop/${order}/documents/${today()}-sign-quote.pdf`);
});

test("filing: a shared room's delivery with forRoom lands in the ordering room's folder, in its order", () => {
  const o = office();
  const maker = o.ctx("studio", "maker");
  const { order } = openOrder(o.root, "shop", "acme", "mug", new Date(), "Europe/Paris");
  orderFrom(o, "shop", "clerk", "studio", "maker");
  const { approvalId } = hqSubmit(o.db, maker, {
    type: "clip",
    title: "Mug clip",
    body: "b",
    forRoom: "shop",
    order,
    attachments: files(maker.workDir!, ["clip.mp4"]),
  });
  assert.equal(approve(o, approvalId).filedPath, `shop/${order}/videos/${today()}-mug-clip.mp4`);
  assert.ok(!fs.existsSync(path.join(o.root, "studio")), "nothing in the producing room's folder");
});

test("filing: nothing for a rejected item, an item without file nor drawer, an informational one or a question", () => {
  const o = office();
  const clerk = o.ctx("shop", "clerk");
  const rejected = hqSubmit(o.db, clerk, { type: "visual", title: "No", body: "b", attachments: files(clerk.workDir!, ["no.png"]) });
  decideApproval(o.db, rejected.approvalId, { decision: "rejected", note: "no" }, o.config);
  assert.equal(row(o.db, rejected.approvalId).filed_path, null);

  const plain = hqSubmit(o.db, clerk, { type: "reply", title: "Plain", body: "b" });
  assert.equal(approve(o, plain.approvalId).filedPath, null);

  fs.writeFileSync(path.join(o.config.home, "myhq.json"), JSON.stringify({ notifyTypes: ["digest"] }));
  const info = hqSubmit(o.db, clerk, { type: "digest", title: "Digest", body: "b", drawer: "documents" });
  assert.equal(info.status, "unseen");
  assert.equal(fileApproval(o.db, o.config, info.approvalId), null);

  // A question approved by its answers, written as it is stored, named drawer or not.
  const at = new Date().toISOString();
  const question = Number(
    o.db
      .prepare(
        `INSERT INTO approvals (room, agent_id, type, title, body, payload, status, drawer, decided_at, created_at)
         VALUES ('shop', 'clerk', 'question', 'Q', 'b', '{}', 'approved', 'documents', ?, ?)`,
      )
      .run(at, at).lastInsertRowid,
  );
  assert.equal(fileApproval(o.db, o.config, question), null);
  assert.ok(!fs.existsSync(o.root), "no folder written at all");
});

test("filing: idempotent, and a revision of an approved item keeps its filed copy", () => {
  const o = office();
  const clerk = o.ctx("shop", "clerk");
  const { approvalId } = hqSubmit(o.db, clerk, { type: "visual", title: "Once", body: "b", attachments: files(clerk.workDir!, ["once.png"]) });
  const filed = approve(o, approvalId).filedPath!;
  assert.equal(fileApproval(o.db, o.config, approvalId), filed);
  assert.deepEqual(fs.readdirSync(path.join(o.root, "shop", "visuels")), [path.basename(filed)]);
  decideApproval(o.db, approvalId, { decision: "revise", note: "brighter" }, o.config);
  assert.equal(row(o.db, approvalId).filed_path, filed);
  assert.ok(fs.existsSync(path.join(o.root, filed)));
});

test("filing: a failure leaves the item approved with filed_path NULL, logged, and nothing half written", (t) => {
  const o = office();
  const clerk = o.ctx("shop", "clerk");
  const { approvalId } = hqSubmit(o.db, clerk, { type: "visual", title: "Fails", body: "b", attachments: files(clerk.workDir!, ["f.png"]) });
  // The root is a file: no drawer can be made under it.
  const blocker = path.join(o.config.home, "not-a-dir");
  fs.writeFileSync(blocker, "x");
  fs.writeFileSync(path.join(o.config.home, "myhq.json"), JSON.stringify({ folders: { dir: "not-a-dir" } }));
  const errors: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => errors.push(args));
  const dto = approve(o, approvalId);
  assert.equal(dto.status, "approved");
  assert.equal(dto.filedPath, null);
  assert.equal(row(o.db, approvalId).filed_path, null);
  assert.ok(errors.some((args) => String(args[0]).startsWith("[room-folders]")));
});

test("filing: a room folder that is a link out of the root files nothing, writes nothing outside, filed_path stays NULL", (t) => {
  const o = office();
  const clerk = o.ctx("shop", "clerk");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-outside-"));
  fs.mkdirSync(o.root, { recursive: true });
  try {
    fs.symlinkSync(outside, path.join(o.root, "shop"), "junction");
  } catch {
    t.skip("cannot create a directory link here");
    return;
  }
  const { approvalId } = hqSubmit(o.db, clerk, { type: "visual", title: "Escape", body: "b", attachments: files(clerk.workDir!, ["e.png"]) });
  const errors: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => errors.push(args));
  const dto = approve(o, approvalId);
  assert.equal(dto.status, "approved");
  assert.equal(dto.filedPath, null);
  assert.equal(row(o.db, approvalId).filed_path, null);
  assert.deepEqual(fs.readdirSync(outside), [], "nothing written outside the root");
  assert.ok(errors.some((args) => String(args[0]).startsWith("[room-folders]")));
});

test("hq_submit: drawer and order are checked, with errors that say what to do", () => {
  const o = office();
  const clerk = o.ctx("shop", "clerk");
  const mail = o.ctx("office", "mail");
  const boss = o.ctx("watch", "boss");
  const base = { type: "quote", title: "T", body: "b" };
  assert.throws(() => hqSubmit(o.db, clerk, { ...base, drawer: "drafts" as "devis" }), /drawer/);
  assert.throws(() => hqSubmit(o.db, mail, { ...base, order: "2026-11-acme-sign" }), (e: Error) => e instanceof ToolError && /takes no orders/.test(e.message));
  assert.throws(() => hqSubmit(o.db, clerk, { ...base, order: "acme sign" }), /an order name such as/, "a zod error, as for every input");
  assert.throws(() => hqSubmit(o.db, clerk, { ...base, order: "2026-11-acme-sign" }), (e: Error) => e instanceof ToolError && /has no orders yet.*hq_order_open/.test(e.message));
  openOrder(o.root, "shop", "acme", "mug", new Date("2026-10-10T10:00:00Z"), "UTC");
  openOrder(o.root, "shop", "beta", "cup", new Date("2026-11-10T10:00:00Z"), "UTC");
  assert.throws(
    () => hqSubmit(o.db, clerk, { ...base, order: "2026-11-acme-sign" }),
    (e: Error) => e instanceof ToolError && /no order "2026-11-acme-sign".*2026-11-beta-cup, 2026-10-acme-mug/.test(e.message),
  );
  for (const type of ["question", "room_proposal", "agent_proposal"]) {
    assert.throws(() => hqSubmit(o.db, clerk, { ...base, type, drawer: "devis" }), (e: Error) => e instanceof ToolError && /drawer and order/.test(e.message), type);
  }
  assert.throws(() => hqSubmit(o.db, boss, { ...base, type: "owner_note", drawer: "documents" }), (e: Error) => e instanceof ToolError && /drawer and order/.test(e.message));
  assert.equal((o.db.prepare("SELECT COUNT(*) AS n FROM approvals").get() as { n: number }).n, 0, "nothing submitted");
});

/** `room/agent` sends a message to `to` of room `toRoom`: a task of that room whose from_room is `room` (what "ordered from" means). */
const orderFrom = (o: Office, room: string, agent: string, toRoom: string, to: string) =>
  writeMessage(o.db, { room, agentId: agent, runId: 1 }, { room: toRoom, agentId: to }, "Please make this.");

const ONLY_ORDERED = "You may list the orders of a room only when it ordered from your room.";

test("hq_orders: the orders of the agent's room, or of a room that ordered from the agent's shared room", () => {
  const o = office();
  openOrder(o.root, "shop", "acme", "sign", new Date("2026-10-10T10:00:00Z"), "UTC");
  openOrder(o.root, "shop", "acme", "mug", new Date("2026-11-10T10:00:00Z"), "UTC");
  const expected = { room: "shop", orders: ["2026-11-acme-mug", "2026-10-acme-sign"] };
  assert.deepEqual(hqOrders(o.db, o.ctx("shop", "clerk"), {}), expected);
  assert.throws(() => hqOrders(o.db, o.ctx("office", "mail"), {}), /takes no orders/);
  assert.throws(() => hqOrders(o.db, o.ctx("office", "mail"), { room: "shop" }), /shared room/);
  const maker = o.ctx("studio", "maker");
  // The same refusal whether the room exists, takes orders or not: nothing to probe.
  for (const room of ["shop", "office", "ghost"]) {
    assert.throws(() => hqOrders(o.db, maker, { room }), (e: Error) => e instanceof ToolError && e.message === ONLY_ORDERED, room);
  }
  orderFrom(o, "shop", "clerk", "studio", "maker");
  assert.deepEqual(hqOrders(o.db, maker, { room: "shop" }), expected, "once shop ordered from the studio");
  assert.throws(() => hqOrders(o.db, maker, { room: "office" }), (e: Error) => e.message === ONLY_ORDERED, "office still did not");
});

test("hq_submit forRoom with an unknown order: the destination's orders are listed only when it ordered from the caller's room", () => {
  const o = office();
  openOrder(o.root, "shop", "acme", "mug", new Date("2026-10-10T10:00:00Z"), "UTC");
  const maker = o.ctx("studio", "maker");
  const submit = () => hqSubmit(o.db, maker, { type: "clip", title: "Clip", body: "b", forRoom: "shop", order: "2026-11-acme-none" });
  assert.throws(submit, (e: Error) => e instanceof ToolError && e.message === 'Room "shop" has no order "2026-11-acme-none".');
  assert.throws(
    () => hqSubmit(o.db, maker, { type: "clip", title: "Clip", body: "b", forRoom: "office", order: "2026-11-acme-none" }),
    (e: Error) => e instanceof ToolError && e.message === 'Room "office" has no order "2026-11-acme-none".',
    "not even whether the room takes orders",
  );
  orderFrom(o, "shop", "clerk", "studio", "maker");
  assert.throws(submit, (e: Error) => e instanceof ToolError && /no order "2026-11-acme-none"\. Its orders, newest first: 2026-10-acme-mug\./.test(e.message));
});

test("hq_submit forRoom with a real order of a room that never ordered: the same generic refusal, nothing created, accepted once it ordered", () => {
  const o = office();
  const { order } = openOrder(o.root, "shop", "acme", "mug", new Date("2026-10-10T10:00:00Z"), "UTC");
  const maker = o.ctx("studio", "maker");
  const submit = () => hqSubmit(o.db, maker, { type: "clip", title: "Clip", body: "b", forRoom: "shop", order });
  assert.throws(submit, (e: Error) => e instanceof ToolError && e.message === `Room "shop" has no order "${order}".`);
  assert.equal((o.db.prepare("SELECT COUNT(*) AS n FROM approvals").get() as { n: number }).n, 0, "no item created");
  orderFrom(o, "shop", "clerk", "studio", "maker");
  const { approvalId } = submit();
  assert.equal(row(o.db, approvalId).order_name, order);
  assert.equal(row(o.db, approvalId).for_room, "shop");
});

test("hq_order_open: an agent of a room with orders opens one in its own room, idempotent", () => {
  const o = office();
  const clerk = o.ctx("shop", "clerk");
  const first = hqOrderOpen(o.db, clerk, { client: "ACME", subject: "Neon sign" });
  const order = `${dayKey(new Date(), "Europe/Paris").slice(0, 7)}-acme-neon-sign`;
  assert.deepEqual(first, { order, created: true, path: `shop/${order}`, received: [] });
  assert.ok(fs.existsSync(path.join(o.root, "shop", order, "recu")));
  assert.equal(hqOrderOpen(o.db, clerk, { client: "acme", subject: "neon sign" }).created, false);
  assert.throws(() => hqOrderOpen(o.db, o.ctx("office", "mail"), { client: "acme", subject: "x" }), /takes no orders/);
  assert.throws(() => hqOrderOpen(o.db, clerk, { client: "!!", subject: "x" }), (e: Error) => e instanceof ToolError && /client/.test(e.message));
});

/**
 * An item of office/mail filed in office/recu: what a client sent, approved
 * before any order existed. By default the mail agent relays it to shop/clerk
 * on approval (onApprove), which the clerk asked it to do: the quote request
 * the clerk then pulls into an order.
 */
function receivedInOffice(o: Office, title: string, relay = true): number {
  const mail = o.ctx("office", "mail");
  if (relay && !o.db.prepare("SELECT 1 FROM tasks WHERE room = 'office' AND from_room = 'shop'").get()) {
    orderFrom(o, "shop", "clerk", "office", "mail");
  }
  const { approvalId } = hqSubmit(o.db, mail, {
    type: "client_mail",
    title,
    body: "The client's request.",
    drawer: "recu",
    attachments: files(mail.workDir!, [`${title}.pdf`]),
    ...(relay ? { onApprove: [{ to: "shop/clerk", text: "A quote request for you." }] } : {}),
  });
  approve(o, approvalId);
  return approvalId;
}

const refusedPull = (id: number) => (e: Error) =>
  e instanceof ToolError && e.message === `received: item #${id} cannot be pulled into an order of your room: nothing was moved.`;

test("hq_order_open received: an item of another room, relayed to an agent of the caller's room, moves into the new order, from its id alone", () => {
  const o = office();
  const id = receivedInOffice(o, "brief");
  const name = `${today()}-brief`;
  assert.equal(row(o.db, id).filed_path, `office/recu/${name}.pdf`);
  assert.ok(o.db.prepare("SELECT 1 FROM approval_relays WHERE approval_id = ? AND delivered_at IS NOT NULL").get(id), "relayed by MyHQ");
  // The clerk is given no directory of office: the tool works from the item id.
  const clerk = o.ctx("shop", "clerk");
  const result = hqOrderOpen(o.db, clerk, { client: "acme", subject: "sign", received: [id] });
  const recu = `shop/${result.order}/recu`;
  assert.equal(result.path, `shop/${result.order}`);
  assert.deepEqual(result.received, [`${recu}/${name}.pdf`]);
  assert.equal(read(o.root, `${recu}/${name}.pdf`), "bytes of brief.pdf");
  assert.equal(read(o.root, `${recu}/${name}.md`), "The client's request.\n", "its .md twin moves with it");
  assert.deepEqual(fs.readdirSync(path.join(o.root, "office", "recu")), [], "nothing left in office/recu");
  const moved = row(o.db, id);
  assert.equal(moved.filed_path, `${recu}/${name}.pdf`);
  assert.equal(moved.order_name, result.order);
  assert.equal(moved.for_room, null, "for_room is left alone");
  assert.throws(() => hqOrderOpen(o.db, clerk, { client: "acme", subject: "sign", received: [id] }), refusedPull(id), "already in an order");
});

test("hq_order_open received: an item of an unrelated room is refused with one generic message, the same for an unknown id and a pending item", () => {
  const o = office();
  const foreign = receivedInOffice(o, "secret", false);
  const clerk = o.ctx("shop", "clerk");
  const pending = hqSubmit(o.db, clerk, { type: "quote", title: "P", body: "b", drawer: "recu" });
  for (const id of [foreign, 999, pending.approvalId]) {
    assert.throws(() => hqOrderOpen(o.db, clerk, { client: "acme", subject: "sign", received: [id] }), refusedPull(id), String(id));
  }
  assert.equal(row(o.db, foreign).filed_path, `office/recu/${today()}-secret.pdf`, "nothing moved");
  assert.equal(listOrders(o.root, "shop").length, 0, "no order opened");
});

test("hq_order_open received: a relay recorded but not yet delivered does not qualify", () => {
  const o = office();
  const id = receivedInOffice(o, "late");
  o.db.prepare("UPDATE approval_relays SET delivered_at = NULL WHERE approval_id = ?").run(id);
  assert.throws(() => hqOrderOpen(o.db, o.ctx("shop", "clerk"), { client: "acme", subject: "sign", received: [id] }), refusedPull(id));
  assert.equal(row(o.db, id).filed_path, `office/recu/${today()}-late.pdf`);
});

test("hq_order_open received: an item a studio delivered forRoom the caller's room is pulled by it", () => {
  const o = office();
  const maker = o.ctx("studio", "maker");
  const { approvalId } = hqSubmit(o.db, maker, {
    type: "client_mail",
    title: "Brief",
    body: "b",
    forRoom: "shop",
    drawer: "recu",
    attachments: files(maker.workDir!, ["brief.pdf"]),
  });
  assert.equal(approve(o, approvalId).filedPath, `shop/recu/${today()}-brief.pdf`);
  const result = hqOrderOpen(o.db, o.ctx("shop", "clerk"), { client: "acme", subject: "sign", received: [approvalId] });
  assert.deepEqual(result.received, [`shop/${result.order}/recu/${today()}-brief.pdf`]);
});

test("hq_order_open received: all or nothing, the first id that does not qualify is named and nothing moves", () => {
  const o = office();
  const good = receivedInOffice(o, "plan");
  const clerk = o.ctx("shop", "clerk");
  const visual = hqSubmit(o.db, clerk, { type: "visual", title: "V", body: "b", attachments: files(clerk.workDir!, ["v.png"]) });
  approve(o, visual.approvalId);
  const pending = hqSubmit(o.db, clerk, { type: "quote", title: "P", body: "b", drawer: "recu" });
  for (const bad of [visual.approvalId, pending.approvalId, 999]) {
    assert.throws(
      () => hqOrderOpen(o.db, clerk, { client: "acme", subject: "lamp", received: [good, bad] }),
      (e: Error) => e instanceof ToolError && e.message.includes(`#${bad}`),
    );
  }
  assert.equal(row(o.db, good).filed_path, `office/recu/${today()}-plan.pdf`, "nothing moved");
  assert.deepEqual(fs.readdirSync(path.join(o.root, "shop")).filter((n) => n.includes("lamp")), [], "no order opened");
  assert.throws(() => hqOrderOpen(o.db, clerk, { client: "acme", subject: "lamp", received: Array.from({ length: 21 }, (_, i) => i + 1) }));
});

test("hq_order_open receivedFiles: entries of the caller's own recu move into the order, all or nothing", () => {
  const o = office();
  const clerk = o.ctx("shop", "clerk");
  const recu = path.join(o.root, "shop", "recu");
  fs.mkdirSync(path.join(recu, "photos"), { recursive: true });
  fs.writeFileSync(path.join(recu, "photos", "1.jpg"), "jpg");
  fs.writeFileSync(path.join(recu, "logo.svg"), "svg");
  fs.mkdirSync(path.join(o.root, "office", "recu"), { recursive: true });
  fs.writeFileSync(path.join(o.root, "office", "recu", "other.pdf"), "pdf");
  const filed = hqSubmit(o.db, clerk, { type: "client_mail", title: "Mail", body: "b", drawer: "recu" });
  approve(o, filed.approvalId);
  const filedName = path.basename(row(o.db, filed.approvalId).filed_path!);

  for (const bad of ["missing.pdf", "../office/recu/other.pdf", "..", "photos/1.jpg", "C:\\x.png", filedName]) {
    assert.throws(
      () => hqOrderOpen(o.db, clerk, { client: "acme", subject: "sign", receivedFiles: ["logo.svg", bad] }),
      (e: Error) => e instanceof ToolError && e.message.includes(bad),
      bad,
    );
  }
  assert.ok(fs.existsSync(path.join(recu, "logo.svg")), "nothing moved");
  assert.equal(listOrders(o.root, "shop").length, 0, "no order opened");

  const { order } = openOrder(o.root, "shop", "acme", "sign", new Date(), "Europe/Paris");
  fs.writeFileSync(path.join(o.root, "shop", order, "recu", "logo.svg"), "older");
  const result = hqOrderOpen(o.db, clerk, { client: "acme", subject: "sign", receivedFiles: ["logo.svg", "photos"] });
  assert.equal(result.created, false);
  assert.deepEqual(result.received, [`shop/${order}/recu/logo-2.svg`, `shop/${order}/recu/photos`]);
  assert.equal(read(o.root, `shop/${order}/recu/logo.svg`), "older", "never overwritten");
  assert.equal(read(o.root, `shop/${order}/recu/photos/1.jpg`), "jpg");
  assert.deepEqual(fs.readdirSync(recu), [filedName]);
  assert.throws(() => hqOrderOpen(o.db, clerk, { client: "acme", subject: "sign", receivedFiles: Array.from({ length: 51 }, (_, i) => `f${i}`) }));
});

/** Approves an item, then forgets its filing (the caller clears the root): what an item approved before the folders existed looks like. */
function approvedUnfiled(o: Office, submitted: { approvalId: number }): number {
  approve(o, submitted.approvalId);
  o.db.prepare("UPDATE approvals SET filed_path = NULL WHERE id = ?").run(submitted.approvalId);
  return submitted.approvalId;
}

test("pendingFilings: the approved items that fileApproval would file and has not, by id, with their destination", () => {
  const o = office();
  const clerk = o.ctx("shop", "clerk");
  const maker = o.ctx("studio", "maker");
  const { order } = openOrder(o.root, "shop", "acme", "sign", new Date(), "Europe/Paris");
  const visual = approvedUnfiled(o, hqSubmit(o.db, clerk, { type: "visual", title: "Cover", body: "b", attachments: files(clerk.workDir!, ["c.png"]) }));
  const quote = approvedUnfiled(o, hqSubmit(o.db, clerk, { type: "quote", title: "Sign quote", body: "b", order, drawer: "devis" }));
  const clip = approvedUnfiled(
    o,
    hqSubmit(o.db, maker, { type: "clip", title: "Mug clip", body: "b", forRoom: "shop", attachments: files(maker.workDir!, ["a.mp4", "b.mp4"]) }),
  );
  // Never in the list: no file nor drawer, rejected, pending, already filed, a question.
  approvedUnfiled(o, hqSubmit(o.db, clerk, { type: "reply", title: "Plain", body: "b" }));
  const rejected = hqSubmit(o.db, clerk, { type: "visual", title: "No", body: "b", attachments: files(clerk.workDir!, ["no.png"]) });
  decideApproval(o.db, rejected.approvalId, { decision: "rejected", note: "no" }, o.config);
  hqSubmit(o.db, clerk, { type: "visual", title: "Waiting", body: "b", attachments: files(clerk.workDir!, ["w.png"]) });
  const filed = hqSubmit(o.db, clerk, { type: "visual", title: "Filed", body: "b", attachments: files(clerk.workDir!, ["f.png"]) });
  approve(o, filed.approvalId);
  const at = new Date().toISOString();
  o.db
    .prepare(
      "INSERT INTO approvals (room, agent_id, type, title, body, payload, status, drawer, decided_at, created_at) VALUES ('shop', 'clerk', 'question', 'Q', 'b', '{}', 'approved', 'documents', ?, ?)",
    )
    .run(at, at);

  fs.rmSync(o.root, { recursive: true, force: true });
  assert.deepEqual(
    pendingFilings(o.db).map((p) => [p.id, p.room, p.type, p.title, p.fileCount, p.order, p.drawer, p.folder]),
    [
      [visual, "shop", "visual", "Cover", 1, null, "visuels", "shop/visuels"],
      [quote, "shop", "quote", "Sign quote", 0, order, "devis", `shop/${order}/devis`],
      [clip, "shop", "clip", "Mug clip", 2, null, "videos", "shop/videos"],
    ],
  );
  assert.ok(!fs.existsSync(o.root), "listing writes nothing");
  assert.equal(fileApproval(o.db, o.config, visual), `shop/visuels/${today()}-cover.png`);
  assert.deepEqual(pendingFilings(o.db).map((p) => p.id), [quote, clip], "a filed item leaves the list");
});

test("filing: when another process filed the item meanwhile, what was just written is removed and the recorded path returned", (t) => {
  const o = office();
  const clerk = o.ctx("shop", "clerk");
  const id = approvedUnfiled(o, hqSubmit(o.db, clerk, { type: "visual", title: "Race", body: "b", attachments: files(clerk.workDir!, ["r.png"]) }));
  fs.rmSync(o.root, { recursive: true, force: true });
  const real = fs.copyFileSync;
  // The other process records its filing between the plan and the final update.
  t.mock.method(fs, "copyFileSync", (from: fs.PathLike, to: fs.PathLike, mode?: number) => {
    o.db.prepare("UPDATE approvals SET filed_path = 'shop/visuels/elsewhere.png' WHERE id = ?").run(id);
    return real(from, to, mode);
  });
  assert.equal(fileApproval(o.db, o.config, id), "shop/visuels/elsewhere.png");
  assert.equal(row(o.db, id).filed_path, "shop/visuels/elsewhere.png");
  assert.deepEqual(fs.readdirSync(path.join(o.root, "shop", "visuels")), [], "the copy just written is removed");
});

test("file-approved: a dry run prints and changes nothing, --only restricts, --apply files and says where", () => {
  const o = office();
  const clerk = o.ctx("shop", "clerk");
  const a = approvedUnfiled(o, hqSubmit(o.db, clerk, { type: "visual", title: "One", body: "b", attachments: files(clerk.workDir!, ["1.png"]) }));
  const b = approvedUnfiled(o, hqSubmit(o.db, clerk, { type: "visual", title: "Two", body: "b", attachments: files(clerk.workDir!, ["2.png"]) }));
  fs.rmSync(o.root, { recursive: true, force: true });
  const out: string[] = [];
  const log = (line: string) => out.push(line);

  assert.equal(parseArgs(["--apply", "--only", "1,2"])?.apply, true);
  assert.deepEqual(parseArgs(["--only", "12,15"]), { apply: false, only: [12, 15] });
  for (const bad of [["--only"], ["--only", "a"], ["--only", "1,"], ["--nope"]]) assert.equal(parseArgs(bad), null, bad.join(" "));

  assert.equal(fileApproved(o.db, o.config, { apply: false, only: null }, log), 0);
  assert.equal(out.length, 3, "a title and one line per item");
  assert.equal(out[1], `  #${a} shop (visual) « One » : 1 fichier(s) vers shop/visuels/`);
  assert.ok(out[2]!.includes(`#${b}`));
  assert.equal(row(o.db, a).filed_path, null);
  assert.equal(row(o.db, b).filed_path, null);
  assert.ok(!fs.existsSync(o.root), "a dry run files nothing");

  out.length = 0;
  fileApproved(o.db, o.config, { apply: true, only: [b, 999] }, log);
  assert.ok(out.some((line) => line.includes("#999")), "an id that is not pending is said");
  assert.ok(out.includes(`  #${b} rangé dans shop/visuels/${today()}-two.png`));
  assert.equal(row(o.db, b).filed_path, `shop/visuels/${today()}-two.png`);
  assert.equal(row(o.db, a).filed_path, null, "only the given id was filed");

  out.length = 0;
  fileApproved(o.db, o.config, { apply: true, only: null }, log);
  assert.ok(out.includes(`  #${a} rangé dans shop/visuels/${today()}-one.png`));
  assert.equal(read(o.root, `shop/visuels/${today()}-one.png`), "bytes of 1.png");
  out.length = 0;
  assert.equal(fileApproved(o.db, o.config, { apply: true, only: null }, log), 0);
  assert.deepEqual(out, ["Aucun item approuvé en attente de rangement."]);
});

test("file-approved: an item that cannot be filed is counted as a failure and stays pending", (t) => {
  const o = office();
  const clerk = o.ctx("shop", "clerk");
  const id = approvedUnfiled(o, hqSubmit(o.db, clerk, { type: "visual", title: "Stuck", body: "b", attachments: files(clerk.workDir!, ["s.png"]) }));
  const blocker = path.join(o.config.home, "not-a-dir");
  fs.writeFileSync(blocker, "x");
  fs.writeFileSync(path.join(o.config.home, "myhq.json"), JSON.stringify({ folders: { dir: "not-a-dir" } }));
  t.mock.method(console, "error", () => undefined);
  const out: string[] = [];
  assert.equal(fileApproved(o.db, o.config, { apply: true, only: null }, (line) => out.push(line)), 1);
  assert.ok(out.includes(`  #${id} non rangé (voir le journal d'erreurs ci-dessus)`));
  assert.equal(row(o.db, id).filed_path, null);
});
