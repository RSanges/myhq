import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import Database from "better-sqlite3";
import { POST as ask } from "../src/app/api/approvals/[id]/ask/route";
import { POST as seen } from "../src/app/api/approvals/[id]/seen/route";
import { parseButtonData, seenKeyboard } from "../src/assistant/approval-buttons";
import { Assistant } from "../src/assistant/assistant";
import { parseSelectionData } from "../src/assistant/selection-buttons";
import type { ChatOutcome, ChatRunner } from "../src/assistant/chat";
import { getChatService } from "../src/assistant/chat-service";
import { EMPTY_ASSISTANT_CONFIG } from "../src/assistant/home-config";
import { itemQuestion, ITEM_BODY_LIMIT } from "../src/assistant/item-ask";
import { Telegram } from "../src/assistant/telegram";
import { hqPending, hqReadDecisions, hqSubmit, type HqContext } from "../src/mcp/tools";
import { decideApproval, markApprovalSeen } from "../src/server/approvals";
import { getDbAt, openDb, type ApprovalRow, type Db } from "../src/server/db";
import { APPROVAL_SELECT, getState, toApproval, type ApprovalRowWithAction } from "../src/server/feed";
import { notify, notifyPendingApprovals, type Send } from "../src/server/notify";
import { loadHome, syncHome } from "../src/server/rooms";
import { schedulerInfo } from "../src/server/routines";
import { wakeAgents } from "../src/server/runner";
import { cutLine, excerpt } from "../src/ui/excerpt";
import { formatAge } from "../src/ui/format";
import { parseHash, resolveApprovalLink } from "../src/ui/deep-link";
import { initialModel, pendingTitle, reducer, selectHistory, selectPending, selectUnseen, typeLabel } from "../src/ui/model";
import type { State } from "../src/ui/schemas";
import { startFakeTelegram, type FakeTelegram } from "./fake-telegram";
import { chatConfig, makeHome } from "./helpers";

// Items of the « À regarder » section (notifyTypes): the excerpt of a folded
// line, the unseen/seen statuses and their migration, « Vu » from the API and
// from Telegram, « Demander à Rom2 » through the chat service, and no wake-up.

const TOKEN = "watch-token";
const CHAT = "42";

// --- The excerpt of a folded line ---------------------------------------------------

test("excerpt: the first meaningful line, stripped of its Markdown", () => {
  assert.equal(excerpt("# Mails du matin\n\nTrois mails à lire."), "Mails du matin");
  assert.equal(excerpt("\n\n   \n**Facture** de *Alice* : [voir le lien](https://example.com/x) et `code`."), "Facture de Alice : voir le lien et code.");
  assert.equal(excerpt("- [ ] Appeler le notaire\n- [x] Autre chose"), "Appeler le notaire");
  assert.equal(excerpt("1. Premier point\n2. Second"), "Premier point");
  assert.equal(excerpt("> Citation importante\n\nSuite"), "Citation importante");
  assert.equal(excerpt("---\n\n***\n\nAprès les filets"), "Après les filets");
  assert.equal(excerpt("```ts\nconst answer = 42;\n```\n\nTexte"), "const answer = 42;");
  assert.equal(excerpt("| Expéditeur | Objet |\n| --- | --- |\n| Alice | Facture |"), "Expéditeur · Objet");
  assert.equal(excerpt("Première ligne\nDeuxième ligne du même paragraphe"), "Première ligne");
  assert.equal(excerpt("  \t spaced    out \t words  "), "spaced out words");
  assert.equal(excerpt("![logo](https://example.com/l.png)"), "[logo]");
});

test("excerpt: a body that opens with its own title goes on to the next line", () => {
  const body = "# Contrat de prestation : derniers points\n\n**De :** Claire Fontaine\n\nBonjour";
  assert.equal(excerpt(body, "Contrat de prestation : derniers points"), "De : Claire Fontaine");
  assert.equal(excerpt(body, "contrat de prestation : derniers points."), "De : Claire Fontaine", "case and closing punctuation do not matter");
  assert.equal(excerpt(body), "Contrat de prestation : derniers points", "without a title, the first line is the heading");
  assert.equal(excerpt("# Seul le titre", "Seul le titre"), "", "nothing else to show");
  assert.equal(excerpt("Un autre début\n\n# Titre", "Titre"), "Un autre début");
});

test("excerpt: empty bodies give an empty line, and nothing throws on odd input", () => {
  assert.equal(excerpt(""), "");
  assert.equal(excerpt("   \n\n  "), "");
  assert.equal(excerpt("---"), "");
  assert.equal(excerpt("**"), "**");
  assert.equal(typeof excerpt("| | |\n|-|-|\n"), "string");
  assert.equal(typeof excerpt("[unclosed](link and <b>html</b> \\"), "string");
});

test("excerpt: cut around 120 characters on a word, with an ellipsis, and never longer", () => {
  const words = Array.from({ length: 60 }, (_, i) => `mot${i}`).join(" ");
  const out = excerpt(`# ${words}`);
  assert.ok(out.endsWith("..."));
  assert.ok(out.length <= 123, `${out.length}`);
  assert.ok(!/mot\d+\.\.\.$/.test(out) || words.includes(out.slice(0, -3)), "cut on a word boundary");
  assert.equal(words.startsWith(out.slice(0, -3)), true);
  assert.equal(excerpt("x".repeat(500)).length, 123, "a single long word is cut hard");
  assert.equal(excerpt("a".repeat(120)), "a".repeat(120), "exactly the limit is kept");
  assert.equal(cutLine("one two three", 7), "one two...", "no close word boundary: cut hard");
  assert.equal(cutLine("alpha beta gamma", 12), "alpha beta...");
  assert.equal(excerpt("# Titre court"), "Titre court");
});

test("formatAge: minutes, hours, days, then the date; a future date is now", () => {
  const at = Date.parse("2026-11-04T12:00:00.000Z");
  const ago = (ms: number) => new Date(at - ms).toISOString();
  assert.equal(formatAge(ago(20_000), at), "à l'instant");
  assert.equal(formatAge(ago(5 * 60_000), at), "il y a 5 min");
  assert.equal(formatAge(ago(59 * 60_000), at), "il y a 59 min");
  assert.equal(formatAge(ago(2 * 3_600_000 + 60_000), at), "il y a 2 h");
  assert.equal(formatAge(ago(3 * 86_400_000), at), "il y a 3 j");
  assert.match(formatAge(ago(30 * 86_400_000), at), /oct/);
  assert.equal(formatAge(new Date(at + 60_000).toISOString(), at), "à l'instant");
  assert.equal(formatAge("not a date", at), "not a date");
});

test("typeLabel and the title keep the two counts apart", () => {
  assert.equal(typeLabel("mail_alert"), "Alerte mail");
  assert.equal(typeLabel("some_new_type"), "some new type");
  assert.equal(pendingTitle("MyHQ", 3), "(3) MyHQ");
  assert.equal(pendingTitle("MyHQ", 3, 2), "(3) (2 à regarder) MyHQ");
  assert.equal(pendingTitle("MyHQ", 0, 2), "(2 à regarder) MyHQ");
  assert.equal(pendingTitle("MyHQ", 0, 0), "MyHQ");
});

// --- Helpers ---------------------------------------------------------------------------

function informationalHome() {
  const config = makeHome(
    {},
    {
      name: "demo",
      targetRepo: "../demo-project",
      agents: [{ id: "mailer", name: "Mailer", role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"], onApproval: "task" }],
    },
  );
  fs.writeFileSync(path.join(config.home, "myhq.json"), JSON.stringify({ notifyTypes: ["mail_alert", "brief"] }));
  const db = getDbAt(config.dbPath);
  syncHome(db, loadHome(config.home));
  db.prepare(
    "INSERT INTO runs (id, room, agent_id, engine, task, status, started_at) VALUES (1, 'demo', 'mailer', 'claude', 't', 'done', ?)",
  ).run(new Date().toISOString());
  const ctx: HqContext = { dbPath: config.dbPath, runId: 1, agentId: "mailer", room: "demo", home: config.home };
  return { config, db, ctx };
}

const LONG_BODY = `# Trois mails à lire\n\n${"Une ligne du **mail** avec [un lien](https://example.com).\n\n".repeat(40)}Fin.`;

function submitAlert(db: Db, ctx: HqContext, title = "Mails du matin", body = LONG_BODY, type = "mail_alert"): number {
  return hqSubmit(db, ctx, { type, title, body }).approvalId;
}

const row = (db: Db, id: number) => db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow;
const dto = (db: Db, id: number) => toApproval(db.prepare(`${APPROVAL_SELECT} WHERE a.id = ?`).get(id) as ApprovalRowWithAction);

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const params = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

const saved = process.env.MYHQ_HOME;
afterEach(() => {
  if (saved === undefined) delete process.env.MYHQ_HOME;
  else process.env.MYHQ_HOME = saved;
});

// --- The statuses and their migration --------------------------------------------------

test("migration 11: an existing database keeps its items, the old informational ones stay readable, and the new statuses work", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-migration-"));
  const file = path.join(dir, "hq.db");
  // A database as version 10 left it: only the tables migration 11 and the readers touch.
  const raw = new Database(file);
  raw.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE runs (id INTEGER PRIMARY KEY);
    CREATE TABLE rooms (name TEXT PRIMARY KEY);
    CREATE TABLE messages (id INTEGER PRIMARY KEY);
    CREATE TABLE changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, entity_id INTEGER NOT NULL);
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, source TEXT, ref_id INTEGER, status TEXT);
    CREATE TABLE approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, agent_id TEXT NOT NULL, run_id INTEGER, type TEXT NOT NULL,
      title TEXT NOT NULL, body TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'revise')),
      decision_note TEXT, decided_at TEXT, seen_by_agent_at TEXT, notified_at TEXT, created_at TEXT NOT NULL,
      annotations TEXT NOT NULL DEFAULT '[]', decision_history TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX approvals_status ON approvals (status);
    CREATE TRIGGER approvals_changed_insert AFTER INSERT ON approvals
      BEGIN INSERT INTO changes (entity, entity_id) VALUES ('approval', NEW.id); END;
  `);
  for (let version = 1; version <= 10; version++) raw.prepare("INSERT INTO schema_migrations VALUES (?, 'x')").run(version);
  const insert = raw.prepare(
    "INSERT INTO approvals (room, agent_id, type, title, body, status, decision_note, decided_at, created_at, annotations) VALUES ('demo', 'mailer', ?, ?, 'B', ?, ?, ?, '2026-11-01T08:00:00.000Z', ?)",
  );
  insert.run("mail_reply", "Pending one", "pending", null, null, "[]");
  insert.run("article", "Approved one", "approved", null, "2026-11-01T09:00:00.000Z", '[{"quote":"q","comment":"c","position":1}]');
  insert.run("mail_alert", "Old alert", "approved", "notification", "2026-11-01T08:00:00.000Z", "[]");
  raw.close();

  const db = openDb(file);
  assert.deepEqual(
    (db.prepare("SELECT id, status, title FROM approvals ORDER BY id").all() as { id: number; status: string; title: string }[]).map((r) => [r.id, r.status, r.title]),
    [[1, "pending", "Pending one"], [2, "approved", "Approved one"], [3, "approved", "Old alert"]],
  );
  assert.equal((row(db, 2).annotations), '[{"quote":"q","comment":"c","position":1}]', "columns survive");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 11").get() as { n: number }).n, 1);

  // The old informational item is still read as one (and is history, not « À regarder »).
  assert.equal(dto(db, 3).informational, true);
  assert.equal(dto(db, 2).informational, false);

  // The new statuses are accepted, the triggers are back, and the index too.
  const before = (db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM changes").get() as { n: number }).n;
  db.prepare("INSERT INTO approvals (room, agent_id, type, title, body, status, created_at) VALUES ('demo', 'mailer', 'brief', 'New', 'B', 'unseen', ?)").run(new Date().toISOString());
  const afterInsert = (db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM changes").get() as { n: number }).n;
  assert.ok(afterInsert > before, "an insert is announced to the live feed");
  markApprovalSeen(db, 4);
  assert.ok((db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM changes").get() as { n: number }).n > afterInsert, "a status change is announced too");
  assert.throws(() => db.prepare("UPDATE approvals SET status = 'bogus' WHERE id = 1").run(), /CHECK/);
  assert.equal((db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'approvals_status'").all()).length, 1);
  db.close();
  openDb(file).close(); // a second open does not migrate again
});

test("hq_submit: an informational item is unseen, stays on the watch list and out of the history until seen", () => {
  const { config, db, ctx } = informationalHome();
  const id = submitAlert(db, ctx);
  const reply = hqSubmit(db, ctx, { type: "mail_reply", title: "Reply", body: "Hello." }).approvalId;

  let state = getState(db, loadHome(config.home), schedulerInfo(config));
  assert.deepEqual(state.approvals.pending.map((a) => a.id), [reply]);
  assert.deepEqual(state.approvals.unseen.map((a) => a.id), [id]);
  assert.deepEqual(state.approvals.history, []);

  const done = markApprovalSeen(db, id);
  assert.equal(done.status, "seen");
  assert.equal(done.informational, true);
  assert.ok(done.decidedAt);
  state = getState(db, loadHome(config.home), schedulerInfo(config));
  assert.deepEqual(state.approvals.unseen, []);
  assert.deepEqual(state.approvals.history.map((a) => [a.id, a.status]), [[id, "seen"]]);

  // Idempotent: the desk and the Telegram button may both press it.
  assert.equal(markApprovalSeen(db, id).decidedAt, done.decidedAt);
  // Not for an item that waits for a decision.
  assert.throws(() => markApprovalSeen(db, reply), { code: "APPROVAL_NOT_WATCHABLE", status: 409 });
  assert.throws(() => markApprovalSeen(db, 999), { code: "APPROVAL_NOT_FOUND", status: 404 });
  // And nothing to decide on an informational item.
  const second = submitAlert(db, ctx, "Another", "Body");
  for (const decision of [{ decision: "approved" as const }, { decision: "revise" as const, note: "x" }]) {
    assert.throws(() => decideApproval(db, second, decision), { code: "APPROVAL_NOT_DECIDABLE", status: 409 });
    assert.throws(() => decideApproval(db, id, decision), { code: "APPROVAL_NOT_DECIDABLE", status: 409 });
  }
});

test("POST /api/approvals/[id]/seen", async () => {
  const { config, db, ctx } = informationalHome();
  process.env.MYHQ_HOME = config.home;
  const id = submitAlert(db, ctx);
  const pending = hqSubmit(db, ctx, { type: "mail_reply", title: "Reply", body: "Hello." }).approvalId;
  const post = (target: number | string) => seen(new Request(`http://127.0.0.1/api/approvals/${target}/seen`, { method: "POST" }), params(target) as never);

  const response = await post(id);
  assert.equal(response.status, 200);
  const body = (await response.json()) as Json;
  assert.equal(body.approval.id, id);
  assert.equal(body.approval.status, "seen");
  assert.equal(row(db, id).status, "seen");
  assert.equal((await post(id)).status, 200, "pressing twice is fine");
  assert.equal((await post(pending)).status, 409);
  assert.equal(row(db, pending).status, "pending");
  assert.equal((await post(4242)).status, 404);
  assert.equal((await post("abc")).status, 400);
});

// --- Nothing wakes, nothing waits for the user ------------------------------------------

test("informational items wake no agent and are no decision waiting for the user", () => {
  const { config, db, ctx } = informationalHome();
  const id = submitAlert(db, ctx);
  submitAlert(db, ctx, "Brief du jour", "## Brief\n\nRien de spécial.", "brief");
  const reply = hqSubmit(db, ctx, { type: "mail_reply", title: "Reply", body: "Hello." }).approvalId;

  // hq_pending (what a brief agent reads) lists only what needs a decision.
  assert.deepEqual(hqPending(db).pending.map((p) => p.id), [reply]);
  // Nothing to read back as a decision, before and after « Vu ».
  assert.deepEqual(hqReadDecisions(db, ctx).decisions, []);
  markApprovalSeen(db, id);
  assert.deepEqual(hqReadDecisions(db, ctx).decisions, []);
  // No task, so the wake-up finds nothing to start, even for an agent with onApproval: "task".
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n, 0);
  const runsBefore = (db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;
  assert.deepEqual(wakeAgents(config, db), []);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n, runsBefore);
});

// --- Telegram ----------------------------------------------------------------------------

let updateId = 1;
const press = (data: string, messageId = 7, text = "MyHQ : Mails du matin (#1)") => ({
  update_id: updateId++,
  callback_query: {
    id: `cb${updateId}`,
    from: { id: Number(CHAT) },
    message: { message_id: messageId, chat: { id: Number(CHAT) }, text },
    data,
  },
});
const callsOf = (fake: FakeTelegram, method: string) => fake.calls.filter((c) => c.method === method);

async function assistantFor(config: ReturnType<typeof makeHome>, db: Db) {
  const fake = await startFakeTelegram(TOKEN);
  const assistant = new Assistant({
    telegram: new Telegram(TOKEN, fake.url),
    chatId: CHAT,
    config,
    db,
    assistant: EMPTY_ASSISTANT_CONFIG,
    extensions: [],
    env: { PATH: process.env.PATH },
    chatMaxBudgetUsd: 0.5,
    log: () => undefined,
    typingIntervalMs: 20,
  });
  const handle = async (update: Record<string, unknown>) => {
    await assistant.handleUpdate(update as never);
    await assistant.idle();
  };
  return { fake, handle };
}

test("Telegram: the alert has a single Vu button, and pressing it does what the desk button does", async () => {
  const { config, db, ctx } = informationalHome();
  const { fake, handle } = await assistantFor(config, db);
  try {
    const id = submitAlert(db, ctx);
    const pending = hqSubmit(db, ctx, { type: "mail_reply", title: "Reply", body: "Hello." }).approvalId;
    const env = { HQ_TELEGRAM_BOT_TOKEN: TOKEN, HQ_TELEGRAM_CHAT_ID: CHAT, HQ_TELEGRAM_API_BASE: fake.url, HQ_TELEGRAM_POLLING: "true", HQ_PUBLIC_URL: "http://hq.example:4242" };
    const send: Send = (text, options) => notify(text, env, fetch, options);
    await notifyPendingApprovals(db, send, env);

    const alerts = callsOf(fake, "sendMessage").map((c) => c.params);
    const watch = alerts.filter((p) => String(p.text).includes(`(#${id})`) || String(p.text).includes("Une ligne du mail"));
    const last = watch.at(-1)!;
    assert.match(String(last.text), new RegExp(`…\\n\\nLire la suite : http://hq\\.example:4242/bureau#approval-${id}$`), "a long text is cut, the deep link is kept");
    assert.deepEqual((last.reply_markup as { inline_keyboard: unknown[][] }).inline_keyboard, [[{ text: "Vu", callback_data: `hq:w:${id}` }]]);
    assert.equal((last.reply_markup as { inline_keyboard: unknown[][] }).inline_keyboard.flat().length, 1, "a single button");
    assert.equal("reply_markup" in alerts.find((p) => String(p.text).includes(`(#${pending})`))!, true, "the pending alert keeps its buttons");

    await handle(press(`hq:w:${id}`, 9, String(last.text)));
    assert.equal(row(db, id).status, "seen");
    assert.equal(callsOf(fake, "answerCallbackQuery")[0]!.params.text, "Vu");
    const edit = callsOf(fake, "editMessageText")[0]!.params;
    assert.equal(edit.message_id, 9);
    assert.equal(edit.text, `${String(last.text)}\n\nVu`);
    assert.equal("reply_markup" in edit, false, "the button goes");
    // The same item is never an approval to decide: no task, no wake-up.
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n, 0);

    // A second press (or the desk got there first) is harmless.
    await handle(press(`hq:w:${id}`, 9, String(last.text)));
    assert.equal(callsOf(fake, "answerCallbackQuery")[1]!.params.text, "Vu");
    assert.equal(row(db, id).status, "seen");

    // « Vu » on an item that waits for a decision is refused and decides nothing.
    await handle(press(`hq:w:${pending}`, 10, "MyHQ : un item attend ta validation"));
    assert.equal(row(db, pending).status, "pending");
    assert.equal(callsOf(fake, "answerCallbackQuery")[2]!.params.text, "Cet item n'est pas à regarder : il attend une décision ou a déjà été traité.");
    assert.equal(callsOf(fake, "editMessageText").length, 2, "only the two Vu presses edited an alert");
  } finally {
    await fake.close();
  }
});

test("Telegram: without polling the alert carries no button, since nobody would receive the press", async () => {
  const { db, ctx } = informationalHome();
  const fake = await startFakeTelegram(TOKEN);
  try {
    submitAlert(db, ctx, "Mails", "Short body.");
    const env = { HQ_TELEGRAM_BOT_TOKEN: TOKEN, HQ_TELEGRAM_CHAT_ID: CHAT, HQ_TELEGRAM_API_BASE: fake.url };
    await notifyPendingApprovals(db, (text, options) => notify(text, env, fetch, options), env);
    const sent = callsOf(fake, "sendMessage").map((c) => c.params);
    assert.equal(sent.length, 1);
    assert.equal("reply_markup" in sent[0]!, false);
  } finally {
    await fake.close();
  }
});

// --- Demander à Rom2 -----------------------------------------------------------------------

function chatSetup(options: { chat?: boolean; answer?: (n: number) => ChatOutcome } = {}) {
  const { config, db, ctx } = informationalHome();
  process.env.MYHQ_HOME = config.home;
  const inputs: string[] = [];
  const runChat: ChatRunner = async (p) => {
    inputs.push(p.input);
    return options.answer ? options.answer(inputs.length) : { ok: true, text: "Voici un brouillon de réponse.", costUsd: 0 };
  };
  getChatService(config, {
    chat: options.chat === false ? null : chatConfig({ cwd: config.home }),
    env: { PATH: process.env.PATH },
    chatMaxBudgetUsd: 0.5,
    runChat,
    log: () => undefined,
  });
  const post = (id: number | string, body: unknown) =>
    ask(
      new Request(`http://127.0.0.1/api/approvals/${id}/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      params(id) as never,
    );
  return { config, db, ctx, inputs, post };
}

test("Demander à Rom2: the chat service gets the request with the item as context, then the item is seen", async () => {
  const { db, ctx, inputs, post } = chatSetup();
  const id = submitAlert(db, ctx, "Facture de la mairie", "Bonjour,\n\nMerci de régler la facture **avant vendredi**.\n\nCordialement");
  const response = await post(id, { text: "  Prépare une réponse à ce mail  " });
  assert.equal(response.status, 200);
  const body = (await response.json()) as Json;
  assert.equal(body.ok, true);
  assert.equal(body.reply, "Voici un brouillon de réponse.");
  assert.equal(body.approval.status, "seen");
  assert.equal(row(db, id).status, "seen");

  assert.equal(inputs.length, 1);
  assert.ok(inputs[0]!.startsWith("Prépare une réponse à ce mail\n\nContexte : item #"), inputs[0]);
  assert.ok(inputs[0]!.includes(`item #${id} (mail_alert) « Facture de la mairie », apporté par mailer (demo).`));
  assert.ok(inputs[0]!.includes("Merci de régler la facture **avant vendredi**."), "the body is the context");
  assert.deepEqual(
    (body.messages as Json[]).map((m) => [m.role, m.channel]),
    [["user", "desk"], ["assistant", "desk"]],
    "it goes through the conversation of the desk, like POST /api/chat",
  );
  // No task for any agent: it is the chat that answers.
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n, 0);
});

test("Demander à Rom2: a body too long is cut, and the chat message stays within its limit", () => {
  const { db, ctx } = chatSetup();
  const id = submitAlert(db, ctx, "Long", "x".repeat(ITEM_BODY_LIMIT * 3));
  const text = itemQuestion(dto(db, id), "Résume");
  assert.ok(text.length < ITEM_BODY_LIMIT + 400);
  assert.ok(text.endsWith("..."));
  assert.ok(text.length <= 20_000);
});

test("Demander à Rom2: a chat that does not answer leaves the item on the list; other refusals", async () => {
  const failing = chatSetup({ answer: () => ({ ok: false, reason: "budget", detail: "" }) });
  const id = submitAlert(failing.db, failing.ctx);
  const failed = await failing.post(id, { text: "Prépare une réponse" });
  assert.equal(failed.status, 200);
  const body = (await failed.json()) as Json;
  assert.equal(body.ok, false);
  assert.ok(String(body.reply).length > 0, "the reason is told");
  assert.equal(body.approval.status, "unseen");
  assert.equal(row(failing.db, id).status, "unseen");

  assert.equal((await failing.post(id, { text: "" })).status, 400);
  assert.equal((await failing.post(id, { text: "ok", extra: 1 })).status, 400);
  assert.equal((await failing.post(9999, { text: "ok" })).status, 404);
  const pending = hqSubmit(failing.db, failing.ctx, { type: "mail_reply", title: "Reply", body: "Hello." }).approvalId;
  assert.equal((await failing.post(pending, { text: "ok" })).status, 409);
  markApprovalSeen(failing.db, id);
  assert.equal((await failing.post(id, { text: "ok" })).status, 409, "an item already seen is not asked about");
  assert.equal(failing.inputs.length, 1, "the refusals never reached the chat");

  const unconfigured = chatSetup({ chat: false });
  const other = submitAlert(unconfigured.db, unconfigured.ctx);
  const refused = await unconfigured.post(other, { text: "Prépare une réponse" });
  assert.equal(refused.status, 404);
  assert.equal(((await refused.json()) as Json).error.code, "CHAT_NOT_CONFIGURED");
  assert.equal(row(unconfigured.db, other).status, "unseen");
});

// --- The desk's model ------------------------------------------------------------------------

test("the desk model keeps the three lists apart, and an SSE update moves an item from one to the other", () => {
  const base = (over: Partial<State["approvals"]["pending"][number]>): State["approvals"]["pending"][number] => ({
    id: 1, room: "demo", agentId: "mailer", runId: null, type: "mail_alert", title: "T", body: "B", payload: {}, status: "unseen",
    decisionNote: null, annotations: [], decisionHistory: [], actionDone: false, informational: true, decidedAt: null,
    createdAt: "2026-11-04T08:00:00.000Z", ...over,
  });
  const state = {
    cursor: 1, rooms: [], invalidRooms: [], reception: { room: null, sprite: null, runs: [] }, floor: { layout: "floor-per-project" as const },
    scheduler: { enabled: false, running: false, timeZone: "UTC" }, firings: [],
    approvals: {
      pending: [base({ id: 3, type: "mail_reply", status: "pending", informational: false })],
      unseen: [base({ id: 2, createdAt: "2026-11-04T09:00:00.000Z" }), base({ id: 1 })],
      history: [base({ id: 4, status: "seen", decidedAt: "2026-11-04T10:00:00.000Z" })],
    },
    recent: { events: [], messages: [] },
  } as State;
  let model = reducer(initialModel, { type: "state", state });
  assert.deepEqual(selectUnseen(model).map((a) => a.id), [1, 2], "oldest first");
  assert.deepEqual(selectPending(model).map((a) => a.id), [3]);
  assert.deepEqual(selectHistory(model).map((a) => a.id), [4]);
  model = reducer(model, { type: "approval", approval: base({ id: 1, status: "seen", decidedAt: "2026-11-04T11:00:00.000Z" }) });
  assert.deepEqual(selectUnseen(model).map((a) => a.id), [2]);
  assert.deepEqual(selectHistory(model).map((a) => a.id), [1, 4]);

  // A deep link to an unseen item keeps the tab (it sits above the tabs); the others pick theirs.
  const items = [...state.approvals.pending, ...state.approvals.unseen, ...state.approvals.history];
  assert.deepEqual(resolveApprovalLink(parseHash("#approval-2"), items), { id: 2, tab: null });
  assert.deepEqual(resolveApprovalLink(parseHash("#approval-3"), items), { id: 3, tab: "pending" });
  assert.deepEqual(resolveApprovalLink(parseHash("#approval-4"), items), { id: 4, tab: "history" });
});

test("the Vu button data is parsed, and does not collide with the selection keyboard's", () => {
  assert.deepEqual(parseButtonData("hq:w:12"), { action: "seen", approvalId: 12 });
  assert.deepEqual(seenKeyboard(12).inline_keyboard, [[{ text: "Vu", callback_data: "hq:w:12" }]]);
  assert.equal(parseButtonData("hq:s:12"), null, "hq:s: belongs to the selection lists");
  assert.notEqual(parseSelectionData("hq:w:12")?.action, "toggle");
  assert.equal(parseSelectionData("hq:w:12"), null);
});
