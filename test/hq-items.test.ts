import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { openDb, type Db } from "../src/server/db";
import { hqItems, ITEM_BODY_DEFAULT, ITEM_BODY_MAX, ITEMS_LIST_MAX, ToolError, type HqContext } from "../src/mcp/tools";

let dir: string;
let db: Db;

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

const ctx = (room: string, agentId: string): HqContext => ({ dbPath: path.join(dir, "hq.db"), runId: 1, agentId, room });

type ItemFields = {
  room: string;
  agent: string;
  title: string;
  status?: string;
  type?: string;
  forRoom?: string | null;
  createdAt?: string;
  note?: string;
  decidedAt?: string;
  annotations?: unknown[];
};

function item(fields: ItemFields): number {
  return Number(
    db
      .prepare(
        `INSERT INTO approvals (room, agent_id, type, title, body, status, decision_note, decided_at, annotations, for_room, created_at)
         VALUES (?, ?, ?, ?, 'a long body', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fields.room,
        fields.agent,
        fields.type ?? "script",
        fields.title,
        fields.status ?? "pending",
        fields.note ?? null,
        fields.decidedAt ?? null,
        JSON.stringify(fields.annotations ?? []),
        fields.forRoom ?? null,
        fields.createdAt ?? new Date().toISOString(),
      ).lastInsertRowid,
  );
}

let own: number; // planygo/social, approved
let revised: number; // planygo/redac, revise, with remarks and a file
let studioForPlanygo: number; // creation/motion for planygo
let studioForOther: number; // creation/motion for other
let studioOwn: number; // creation/motion, no forRoom
let otherItem: number; // other/mailer
let old: number; // planygo, older than 30 days

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-items-"));
  db = openDb(path.join(dir, "hq.db"));
  const at = new Date().toISOString();
  const room = db.prepare("INSERT INTO rooms (name, target_repo, synced_at) VALUES (?, '../x', ?)");
  for (const name of ["planygo", "creation", "other"]) room.run(name, at);
  db.prepare("UPDATE rooms SET shared = 1 WHERE name = 'creation'").run();
  const agent = db.prepare("INSERT INTO agents (room, id, name, model, role_path, synced_at) VALUES (?, ?, ?, 'sonnet', 'r.md', ?)");
  agent.run("planygo", "social", "Social", at);
  agent.run("planygo", "redac", "Redac", at);
  agent.run("creation", "motion", "Motion", at);
  agent.run("other", "mailer", "Mailer", at);
  // planygo ordered from creation; the room "other" never did.
  db.prepare(
    `INSERT INTO tasks (room, agent_id, source, text, status, from_room, from_agent, created_at, updated_at)
     VALUES ('creation', 'motion', 'message', 'order', 'done', 'planygo', 'social', ?, ?)`,
  ).run(at, at);

  own = item({ room: "planygo", agent: "social", title: "Revised script", status: "approved", note: "Go", decidedAt: ago(0.2) });
  revised = item({
    room: "planygo",
    agent: "redac",
    title: "Post",
    status: "revise",
    note: "Shorter",
    decidedAt: ago(1),
    annotations: [
      { quote: "first line", comment: "too long" },
      { quote: "clip.png", comment: "crop here", point: { fileId: 1, kind: "image", x: 0.5, y: 0.25 } },
    ],
  });
  db.prepare("INSERT INTO approval_files (approval_id, name, mime, size, sha256, created_at) VALUES (?, 'clip.png', 'image/png', 1, '', ?)").run(
    revised,
    at,
  );
  studioForPlanygo = item({ room: "creation", agent: "motion", title: "Clip for planygo", type: "clip_video", forRoom: "planygo" });
  studioForOther = item({ room: "creation", agent: "motion", title: "Clip for other", type: "clip_video", forRoom: "other" });
  studioOwn = item({ room: "creation", agent: "motion", title: "Studio own", type: "clip_video" });
  otherItem = item({ room: "other", agent: "mailer", title: "Mail", type: "mail_reply" });
  old = item({ room: "planygo", agent: "social", title: "Ancient", status: "approved", createdAt: ago(45), decidedAt: ago(44) });
});

after(() => {
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

type Listed = { items: { id: number; status: string }[]; truncated: boolean };
const list = (c: HqContext, args: Record<string, unknown> = {}) => hqItems(db, c, args as never) as Listed;
const idsOf = (c: HqContext, args: Record<string, unknown> = {}) => list(c, args).items.map((i) => i.id);

test("hq_items by id gives the state, decision, remarks, producer, forRoom and file names", () => {
  const got = hqItems(db, ctx("planygo", "social"), { id: revised }) as Record<string, unknown>;
  assert.equal(got.id, revised);
  assert.equal(got.type, "script");
  assert.equal(got.title, "Post");
  assert.equal(got.status, "revise");
  assert.equal(got.room, "planygo");
  assert.equal(got.agent, "redac");
  assert.equal(got.forRoom, null);
  assert.equal(got.note, "Shorter");
  assert.equal(typeof got.decidedAt, "string");
  assert.deepEqual(got.remarks, [
    { quote: "first line", comment: "too long" },
    { quote: "clip.png", comment: "crop here", point: { fileId: 1, kind: "image", x: 0.5, y: 0.25 } },
  ]);
  assert.equal(got.body, "a long body");
  assert.equal(got.bodyTruncated, false);
  // The copy is not on disk yet: the name alone.
  assert.deepEqual(got.files, [{ name: "clip.png" }]);
  const approved = hqItems(db, ctx("planygo", "social"), { id: own }) as Record<string, unknown>;
  assert.equal(approved.status, "approved");
  assert.equal(approved.note, "Go");
});

test("hq_items gives the body, cut to maxChars, and the path of a file copy once it is on disk", () => {
  const social = ctx("planygo", "social");
  const cut = hqItems(db, social, { id: revised, maxChars: 6 }) as { body: string; bodyTruncated: boolean };
  assert.deepEqual([cut.body, cut.bodyTruncated], ["a long", true]);
  const exact = hqItems(db, social, { id: revised, maxChars: 11 }) as { body: string; bodyTruncated: boolean };
  assert.deepEqual([exact.body, exact.bodyTruncated], ["a long body", false]);
  const big = item({ room: "planygo", agent: "social", title: "Big", status: "approved" });
  db.prepare("UPDATE approvals SET body = ? WHERE id = ?").run("x".repeat(ITEM_BODY_DEFAULT + 5), big);
  const dflt = hqItems(db, social, { id: big }) as { body: string; bodyTruncated: boolean };
  assert.equal(dflt.body.length, ITEM_BODY_DEFAULT);
  assert.equal(dflt.bodyTruncated, true);
  assert.throws(() => hqItems(db, social, { id: big, maxChars: ITEM_BODY_MAX + 1 }));
  assert.throws(() => hqItems(db, social, { maxChars: 10 }), /give its id/);
  // The frozen copy sits at attachments/<approvalId>/<fileId><ext> next to the database.
  const fileId = (db.prepare("SELECT id FROM approval_files WHERE approval_id = ?").get(revised) as { id: number }).id;
  const copy = path.join(dir, "attachments", String(revised), `${fileId}.png`);
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.writeFileSync(copy, "png");
  const got = hqItems(db, social, { id: revised }) as { files: { name: string; path?: string }[] };
  assert.deepEqual(got.files, [{ name: "clip.png", path: copy }]);
  assert.equal(fs.readFileSync(got.files[0]!.path!, "utf8"), "png");
  // No body in the list.
  assert.ok(list(social).items.every((entry) => !("body" in entry)));
  db.prepare("DELETE FROM approvals WHERE id = ?").run(big);
});

test("hq_items can be read again and again: it marks nothing seen", () => {
  const seen = () =>
    (db.prepare("SELECT seen_by_agent_at FROM approvals WHERE id = ?").get(own) as { seen_by_agent_at: string | null }).seen_by_agent_at;
  const first = seen();
  hqItems(db, ctx("planygo", "social"), { id: own });
  hqItems(db, ctx("planygo", "social"), { id: own });
  assert.equal(seen(), first);
});

test("the list: 30 days, newest first, own room and delivered for it, never another room's", () => {
  const ids = idsOf(ctx("planygo", "social"));
  assert.deepEqual(ids, [studioForPlanygo, revised, own]);
  assert.ok(!ids.includes(old), "older than 30 days");
  // An agent of the room sees what its colleagues produced too.
  assert.deepEqual(idsOf(ctx("planygo", "redac")), ids);
  assert.deepEqual(idsOf(ctx("other", "mailer")), [otherItem, studioForOther]);
});

test("the list filters by status and type", () => {
  const social = ctx("planygo", "social");
  assert.deepEqual(idsOf(social, { status: "approved" }), [own]);
  assert.deepEqual(idsOf(social, { status: "revise" }), [revised]);
  assert.deepEqual(idsOf(social, { type: "clip_video" }), [studioForPlanygo]);
  assert.deepEqual(idsOf(social, { type: "clip_video", status: "approved" }), []);
  assert.throws(() => hqItems(db, social, { status: "nonsense" } as never));
});

test("a decision made in the last 30 days keeps an older item in the list", () => {
  const id = item({ room: "planygo", agent: "social", title: "Old but decided", status: "approved", createdAt: ago(40), decidedAt: ago(2) });
  assert.ok(idsOf(ctx("planygo", "social")).includes(id));
  db.prepare("DELETE FROM approvals WHERE id = ?").run(id);
});

test("an agent of a shared room reads its room, what it delivered, and the items of the rooms that ordered from it", () => {
  const motion = ctx("creation", "motion");
  // planygo ordered: its own items (the revised script of the incident) are readable; "other" never ordered.
  assert.deepEqual(idsOf(motion), [studioOwn, studioForOther, studioForPlanygo, revised, own]);
  assert.equal((hqItems(db, motion, { id: own }) as { status: string }).status, "approved");
  assert.throws(() => hqItems(db, motion, { id: otherItem }), ToolError);
  assert.equal((hqItems(db, motion, { id: studioForOther }) as { forRoom: string }).forRoom, "other");
});

test("access: a room reads neither another room's items nor those delivered for another room", () => {
  const social = ctx("planygo", "social");
  for (const id of [otherItem, studioForOther, studioOwn]) {
    assert.throws(
      () => hqItems(db, social, { id }),
      (error: unknown) => error instanceof ToolError && /outside what you may read/.test(error.message),
      `#${id}`,
    );
  }
  // A room that is not shared gains nothing from being answered by a studio.
  db.prepare(
    `INSERT INTO tasks (room, agent_id, source, text, status, from_room, from_agent, created_at, updated_at)
     VALUES ('planygo', 'social', 'message', 'answer', 'done', 'creation', 'motion', ?, ?)`,
  ).run(ago(0), ago(0));
  assert.throws(() => hqItems(db, social, { id: studioOwn }), ToolError);
  assert.ok(!idsOf(social).includes(studioOwn));
  // Nor does a room read the items of a room it only ordered from.
  assert.throws(() => hqItems(db, ctx("other", "mailer"), { id: own }), ToolError);
});

test("errors: an unknown item says so, id does not combine with filters", () => {
  const social = ctx("planygo", "social");
  assert.throws(() => hqItems(db, social, { id: 999_999 }), /No item #999999 exists/);
  assert.throws(() => hqItems(db, social, { id: own, status: "approved" }), /do not combine/);
  assert.throws(() => hqItems(db, social, { id: 0 } as never));
});

test("the list is capped and says when it is truncated", () => {
  const insert = db.prepare(
    "INSERT INTO approvals (room, agent_id, type, title, body, status, created_at) VALUES ('other', 'mailer', 'bulk', ?, 'b', 'pending', ?)",
  );
  for (let i = 0; i < ITEMS_LIST_MAX + 5; i++) insert.run(`Bulk ${i}`, new Date().toISOString());
  const result = list(ctx("other", "mailer"));
  assert.equal(result.items.length, ITEMS_LIST_MAX);
  assert.equal(result.truncated, true);
  assert.equal(list(ctx("planygo", "social")).truncated, false);
});
