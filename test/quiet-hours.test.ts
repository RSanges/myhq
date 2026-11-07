import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { getDbAt, type Db } from "../src/server/db";
import { notifyPendingApprovals, type Send, type SendOptions } from "../src/server/notify";
import { isQuiet, isUrgentPayload, lastQuietEnd, readQuietHours } from "../src/server/quiet-hours";
import { buildSettingsView, saveSettings } from "../src/server/settings";
import { makeHome } from "./helpers";

const PARIS = "Europe/Paris";
const NIGHT = { start: "21:00", end: "08:00" };

function writeMyhq(home: string, settings: unknown): void {
  fs.writeFileSync(path.join(home, "myhq.json"), JSON.stringify(settings));
}

/** A sender that records what it is given. */
function recorder(): { send: Send; sent: { text: string; options?: SendOptions }[] } {
  const sent: { text: string; options?: SendOptions }[] = [];
  return { sent, send: async (text, options) => (sent.push({ text, ...(options ? { options } : {}) }), true) };
}

/** A home declaring mail_alert informational, with quiet hours at night, in Paris. */
function quietHome() {
  const config = makeHome();
  writeMyhq(config.home, { notifyTypes: ["mail_alert"], timeZone: PARIS, quietHours: NIGHT });
  return config;
}

function insert(db: Db, p: { type?: string; title: string; status?: string; payload?: unknown; createdAt: string }): number {
  const result = db
    .prepare(
      "INSERT INTO approvals (room, agent_id, type, title, body, payload, status, created_at) VALUES ('demo', 'scout', ?, ?, ?, ?, ?, ?)",
    )
    .run(p.type ?? "mail_alert", p.title, `Body of ${p.title}.`, JSON.stringify(p.payload ?? {}), p.status ?? "unseen", p.createdAt);
  return Number(result.lastInsertRowid);
}

const notifiedAt = (db: Db, id: number) =>
  (db.prepare("SELECT notified_at FROM approvals WHERE id = ?").get(id) as { notified_at: string | null }).notified_at;

test("quietHours: read apart, absent or invalid gives none with the reason", () => {
  const config = makeHome();
  assert.deepEqual(readQuietHours(config.home), { quietHours: null, error: null });
  writeMyhq(config.home, { quietHours: NIGHT, language: "fr" });
  assert.deepEqual(readQuietHours(config.home), { quietHours: NIGHT, error: null });
  writeMyhq(config.home, { quietHours: { start: "21:00", end: "21:00" } });
  assert.match(readQuietHours(config.home).error ?? "", /quietHours: start and end must differ/);
  writeMyhq(config.home, { quietHours: { start: "9:00", end: "25:00" } });
  assert.equal(readQuietHours(config.home).quietHours, null);
  assert.match(readQuietHours(config.home).error ?? "", /HH:MM/);
});

test("quietHours: a range across midnight, a range within the day, and the last end", () => {
  // 2026-11-04 is in winter time: Paris is UTC+1.
  assert.equal(isQuiet(new Date("2026-11-04T19:59:00Z"), NIGHT, PARIS), false, "20:59");
  assert.equal(isQuiet(new Date("2026-11-04T20:00:00Z"), NIGHT, PARIS), true, "21:00");
  assert.equal(isQuiet(new Date("2026-11-05T02:00:00Z"), NIGHT, PARIS), true, "03:00");
  assert.equal(isQuiet(new Date("2026-11-05T07:00:00Z"), NIGHT, PARIS), false, "08:00 is the end, excluded");
  const lunch = { start: "12:00", end: "14:00" };
  assert.equal(isQuiet(new Date("2026-11-04T11:30:00Z"), lunch, PARIS), true, "12:30");
  assert.equal(isQuiet(new Date("2026-11-04T13:30:00Z"), lunch, PARIS), false, "14:30");
  assert.equal(lastQuietEnd(new Date("2026-11-05T09:00:00Z"), NIGHT, PARIS).toISOString(), "2026-11-05T07:00:00.000Z");
  assert.equal(lastQuietEnd(new Date("2026-11-05T06:00:00Z"), NIGHT, PARIS).toISOString(), "2026-11-04T07:00:00.000Z");
  // Summer time (UTC+2), and an end inside the spring-forward gap moves to the first minute that exists.
  assert.equal(lastQuietEnd(new Date("2026-07-01T12:00:00Z"), NIGHT, PARIS).toISOString(), "2026-07-01T06:00:00.000Z");
  const gap = { start: "01:00", end: "02:30" };
  assert.equal(lastQuietEnd(new Date("2026-03-29T10:00:00Z"), gap, PARIS).toISOString(), "2026-03-29T01:00:00.000Z");
});

test("urgent: only a payload with urgent true", () => {
  assert.equal(isUrgentPayload('{"urgent":true,"mails":[]}'), true);
  assert.equal(isUrgentPayload('{"urgent":"yes"}'), false);
  assert.equal(isUrgentPayload("{}"), false);
  assert.equal(isUrgentPayload("not json"), false);
});

test("during the quiet hours an informational item waits, an urgent one and an approval go at once", async () => {
  const config = quietHome();
  const db = getDbAt(config.dbPath);
  const night = new Date("2026-11-04T22:30:00Z"); // 23:30 in Paris
  const quietOne = insert(db, { title: "Colis à retirer", createdAt: "2026-11-04T22:00:00Z" });
  const urgent = insert(db, { title: "Carte gelée", payload: { urgent: true }, createdAt: "2026-11-04T22:10:00Z" });
  const approval = insert(db, { type: "mail_reply", title: "Réponse à Alice", status: "pending", createdAt: "2026-11-04T22:20:00Z" });
  const { send, sent } = recorder();
  await notifyPendingApprovals(db, send, {}, night);
  assert.deepEqual(
    sent.map((s) => s.options),
    [{ seenId: urgent }, { approvalId: approval }],
    "the urgent item keeps its « Vu » button, the approval its buttons",
  );
  assert.match(sent[0]!.text, /Carte gelée/);
  assert.equal(notifiedAt(db, quietOne), null, "held, not marked: a later sweep sends it");
  // A second sweep in the night sends nothing more.
  await notifyPendingApprovals(db, send, {}, night);
  assert.equal(sent.length, 2);
});

test("at the end of the quiet hours the items held leave together in one message; later ones go alone", async () => {
  const config = quietHome();
  const db = getDbAt(config.dbPath);
  const first = insert(db, { title: "Colis à retirer", createdAt: "2026-11-04T22:00:00Z" });
  const second = insert(db, { title: "Facture disponible", createdAt: "2026-11-05T05:00:00Z" });
  const morning = new Date("2026-11-05T07:01:00Z"); // 08:01 in Paris
  const { send, sent } = recorder();
  await notifyPendingApprovals(db, send, { HQ_PUBLIC_URL: "http://desk.example:4242" }, morning);
  assert.equal(sent.length, 1, "one message");
  assert.equal(sent[0]!.options, undefined, "no « Vu » button: the items stay under « À regarder »");
  const text = sent[0]!.text;
  assert.ok(text.startsWith("MyHQ : 2 alertes arrivées pendant les heures calmes (de 21:00 à 08:00)"));
  assert.ok(text.indexOf("Colis à retirer") < text.indexOf("Facture disponible"), "in order");
  assert.match(text, /Body of Colis à retirer\./);
  assert.match(text, new RegExp(`bureau#approval-${second}`));
  assert.ok(notifiedAt(db, first) && notifiedAt(db, second));
  const status = (db.prepare("SELECT status FROM approvals WHERE id = ?").get(first) as { status: string }).status;
  assert.equal(status, "unseen", "still on the desk");

  // An item of the day goes the usual way.
  const day = insert(db, { title: "Badge reçu", createdAt: "2026-11-05T09:00:00Z" });
  await notifyPendingApprovals(db, send, {}, new Date("2026-11-05T09:00:05Z"));
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1]!.options, { seenId: day });
});

test("the items held are cut like a single one, each with its link, and still leave in one message when they can", async () => {
  const config = quietHome();
  const db = getDbAt(config.dbPath);
  const long = (title: string) => `${title} begins here.\n\n${"A sentence that goes on and on and on. ".repeat(80)}`;
  const ids = ["Un", "Deux", "Trois"].map((title, i) => insert(db, { title, createdAt: `2026-11-04T22:0${i}:00Z` }));
  for (const id of ids) db.prepare("UPDATE approvals SET body = ? WHERE id = ?").run(long(`Item ${id}`), id);
  const { send, sent } = recorder();
  await notifyPendingApprovals(db, send, { HQ_PUBLIC_URL: "http://desk.example:4242" }, new Date("2026-11-05T07:01:00Z"));
  assert.equal(sent.length, 1, "three long items, one message");
  const text = sent[0]!.text;
  assert.ok(text.length <= 4000, `${text.length} characters`);
  for (const id of ids) {
    assert.match(text, new RegExp(`Item ${id} begins here`));
    assert.match(text, new RegExp(`…\n\nLire la suite : http://desk\.example:4242/bureau#approval-${id}`), "each one is cut and linked");
  }
  assert.equal(text.includes("Ouvrir :"), false);
  assert.ok(ids.every((id) => notifiedAt(db, id)));

  // Without an address, the mention of the item in MyHQ stands in for the link.
  const other = quietHome();
  const db2 = getDbAt(other.dbPath);
  const pair = ["Un", "Deux"].map((title) => insert(db2, { title, createdAt: "2026-11-04T22:00:00Z" }));
  for (const id of pair) db2.prepare("UPDATE approvals SET body = ? WHERE id = ?").run(long(`Item ${id}`), id);
  const second = recorder();
  await notifyPendingApprovals(db2, second.send, {}, new Date("2026-11-05T07:01:00Z"));
  assert.equal(second.sent.length, 1);
  for (const id of pair) assert.ok(second.sent[0]!.text.includes(`(suite dans MyHQ, item #${id})`));
});

test("a single item held is sent the usual way, and without quietHours nothing is held", async () => {
  const config = quietHome();
  const db = getDbAt(config.dbPath);
  const only = insert(db, { title: "Colis à retirer", createdAt: "2026-11-04T22:00:00Z" });
  const { send, sent } = recorder();
  await notifyPendingApprovals(db, send, {}, new Date("2026-11-05T07:30:00Z"));
  assert.deepEqual(sent.map((s) => s.options), [{ seenId: only }]);
  assert.match(sent[0]!.text, /^MyHQ : Colis à retirer/);

  const plain = makeHome();
  writeMyhq(plain.home, { notifyTypes: ["mail_alert"], timeZone: PARIS });
  const other = getDbAt(plain.dbPath);
  const night = insert(other, { title: "Colis", createdAt: "2026-11-04T22:00:00Z" });
  await notifyPendingApprovals(other, send, {}, new Date("2026-11-04T22:30:00Z"));
  assert.deepEqual(sent.at(-1)!.options, { seenId: night });
});

test("settings: quietHours is shown and saved with the notifications, null removes it, absent keeps it", () => {
  const config = makeHome();
  writeMyhq(config.home, { notifyTypes: ["mail_alert"] });
  const db = getDbAt(config.dbPath);
  assert.equal(buildSettingsView(config, db, {}).quietHours, null);
  saveSettings(config, db, "notifications", { notifyTypes: ["mail_alert"], quietHours: NIGHT });
  const file = path.join(config.home, "myhq.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).quietHours, NIGHT);
  assert.deepEqual(buildSettingsView(config, db, {}).quietHours, NIGHT);
  saveSettings(config, db, "notifications", { notifyTypes: ["mail_alert"] });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).quietHours, NIGHT, "absent: kept");
  saveSettings(config, db, "notifications", { notifyTypes: ["mail_alert"], quietHours: null });
  assert.equal("quietHours" in JSON.parse(fs.readFileSync(file, "utf8")), false);
  assert.throws(() => saveSettings(config, db, "notifications", { notifyTypes: [], quietHours: { start: "8:00", end: "21:00" } }));
  writeMyhq(config.home, { quietHours: { start: "x", end: "y" } });
  const view = buildSettingsView(config, db, {});
  assert.equal(view.quietHours, null);
  assert.match(view.errors.join("\n"), /quietHours/);
});
