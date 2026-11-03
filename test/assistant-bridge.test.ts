import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Assistant, freeName, safeFileName, type AssistantDeps } from "../src/assistant/assistant";
import { acquireLock, startBridge } from "../src/assistant/bridge";
import type { ChatRunner } from "../src/assistant/chat";
import { EMPTY_ASSISTANT_CONFIG, type AssistantConfig } from "../src/assistant/home-config";
import { PendingQuestions } from "../src/assistant/pending";
import { processChatRequests } from "../src/assistant/requests";
import { Telegram } from "../src/assistant/telegram";
import type { HqConfig } from "../src/server/config";
import { getDbAt, type ApprovalRow, type Db, type RunRow } from "../src/server/db";
import type { Engine, RunInput } from "../src/server/engine";
import { HqError } from "../src/server/errors";
import { notifyPendingApprovals } from "../src/server/notify";
import { loadHome, syncHome } from "../src/server/rooms";
import { startRun, type StartRunRequest } from "../src/server/runner";
import { startFakeTelegram, type FakeTelegram } from "./fake-telegram";
import { makeHome, waitForRun } from "./helpers";

const TOKEN = "test-token";
const CHAT = "42";

function addApproval(db: Db, title = "Reply to a thread"): number {
  return Number(
    db
      .prepare(
        "INSERT INTO approvals (room, agent_id, type, title, body, status, created_at) VALUES ('demo', 'scout', 'community_reply', ?, 'body', 'pending', ?)",
      )
      .run(title, new Date().toISOString()).lastInsertRowid,
  );
}

function approval(db: Db, id: number): ApprovalRow {
  return db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow;
}

let updateId = 1;
const message = (text: string, chatId = Number(CHAT)) => ({
  update_id: updateId++,
  message: { message_id: updateId, chat: { id: chatId, type: "private" }, from: { id: chatId }, date: 1, text },
});
const press = (data: string, messageId = 7, text = "MyHQ : un item attend ta validation") => ({
  update_id: updateId++,
  callback_query: {
    id: `cb${updateId}`,
    from: { id: Number(CHAT) },
    message: { message_id: messageId, chat: { id: Number(CHAT) }, text },
    data,
  },
});

/** An Assistant wired to a fake Bot API, for the tests that drive it directly. */
async function setup(
  options: {
    assistant?: AssistantConfig;
    runChat?: ChatRunner;
    startRun?: AssistantDeps["startRun"];
    questions?: PendingQuestions;
    config?: HqConfig;
  } = {},
) {
  const config = options.config ?? makeHome();
  const db = getDbAt(config.dbPath);
  syncHome(db, loadHome(config.home));
  const fake = await startFakeTelegram(TOKEN);
  const logs: string[] = [];
  const assistant = new Assistant({
    telegram: new Telegram(TOKEN, fake.url),
    chatId: CHAT,
    config,
    db,
    assistant: options.assistant ?? EMPTY_ASSISTANT_CONFIG,
    extensions: [],
    env: { PATH: process.env.PATH },
    chatMaxBudgetUsd: 0.5,
    runChat: options.runChat,
    startRun: options.startRun,
    questions: options.questions,
    log: (m) => logs.push(m),
    typingIntervalMs: 20,
  });
  return { config, db, fake, assistant, logs };
}

async function handle(assistant: Assistant, update: Record<string, unknown>) {
  await assistant.handleUpdate(update as never);
  await assistant.idle();
}

const callsOf = (fake: FakeTelegram, method: string) => fake.calls.filter((c) => c.method === method);

// --- Button presses ------------------------------------------------------------

test("Approuver decides at once and edits the alert", async () => {
  const { db, fake, assistant } = await setup();
  const id = addApproval(db);
  await handle(assistant, press(`hq:a:${id}`));
  assert.equal(approval(db, id).status, "approved");
  assert.deepEqual(callsOf(fake, "answerCallbackQuery")[0]!.params.text, "Approuvé");
  const edit = callsOf(fake, "editMessageText")[0]!.params;
  assert.equal(edit.message_id, 7);
  assert.equal(edit.text, "MyHQ : un item attend ta validation\n\nDécision : Approuvé");
  assert.equal("reply_markup" in edit, false);

  // A second press on the same alert says it is already decided.
  await handle(assistant, press(`hq:a:${id}`));
  assert.equal(callsOf(fake, "answerCallbackQuery")[1]!.params.text, "Cet item a déjà été traité.");
  await fake.close();
});

/** A pending approval with a body and a payload. */
function addThreadReply(db: Db, body: string, payload: Record<string, unknown> = { url: "https://example.com/r/thread" }): number {
  return Number(
    db
      .prepare(
        "INSERT INTO approvals (room, agent_id, type, title, body, payload, status, created_at) VALUES ('demo', 'scout', 'community_reply', 'Reply', ?, ?, 'pending', ?)",
      )
      .run(body, JSON.stringify(payload), new Date().toISOString()).lastInsertRowid,
  );
}

test("approving an item with a link hands over its body, then the link (button)", async () => {
  const { db, fake, assistant } = await setup();
  const body = "**Hello** there,\n\nthis is the reply.";
  const id = addThreadReply(db, body);
  await handle(assistant, press(`hq:a:${id}`));
  assert.equal(approval(db, id).status, "approved");
  // The alert is edited first, then the body goes out untouched (no Markdown stripping), then the link.
  assert.deepEqual(
    fake.calls.filter((c) => ["answerCallbackQuery", "editMessageText", "sendMessage"].includes(c.method)).map((c) => c.method),
    ["answerCallbackQuery", "editMessageText", "sendMessage", "sendMessage"],
  );
  assert.deepEqual(fake.sent(), [body, "https://example.com/r/thread"]);
  await fake.close();
});

test("approving with /approve hands over the body and the link after the decision", async () => {
  const { db, fake, assistant } = await setup();
  const id = addThreadReply(db, "The reply.");
  await handle(assistant, message(`/approve ${id}`));
  assert.deepEqual(fake.sent(), [`Item #${id} : Approuvé.`, "The reply.", "https://example.com/r/thread"]);
  await fake.close();
});

test("a long body is cut at 4000 characters, the link comes last", async () => {
  const { db, fake, assistant } = await setup();
  const body = `${"a".repeat(3000)}\n${"b".repeat(3000)}`;
  const id = addThreadReply(db, body);
  await handle(assistant, press(`hq:a:${id}`));
  const sent = fake.sent();
  assert.equal(sent.length, 3);
  assert.ok(sent.every((text) => text.length <= 4000));
  assert.equal(sent[0], "a".repeat(3000));
  assert.equal(sent[1], "b".repeat(3000));
  assert.equal(sent[2], "https://example.com/r/thread");
  await fake.close();
});

test("approving a pull request on a local branch hands over the branch, then the commands", async () => {
  const { db, fake, assistant } = await setup();
  const id = Number(
    db
      .prepare(
        "INSERT INTO approvals (room, agent_id, type, title, body, payload, status, created_at) VALUES ('demo', 'scout', 'pull_request', 'Fix', 'Diff summary', ?, 'pending', ?)",
      )
      .run(JSON.stringify({ branch: "hq/scout-fix", sha: "abcdef1234567", title: "Fix", summary: "Fixes it" }), new Date().toISOString())
      .lastInsertRowid,
  );
  await handle(assistant, message(`/approve ${id}`));
  const sent = fake.sent();
  assert.equal(sent.length, 3);
  assert.match(sent[1]!, /^Branche hq\/scout-fix \(commit abcdef1234\)/);
  assert.equal(
    sent[2],
    'git push -u origin hq/scout-fix\ngh pr create --head hq/scout-fix --title "Fix" --body "Fixes it"',
  );
  await fake.close();
});

test("items without an http(s) url, and other decisions, send no hand-over", async () => {
  const { db, fake, assistant } = await setup();
  const plain = addApproval(db);
  const odd = addThreadReply(db, "x", { url: "javascript:alert(1)" });
  const rejected = addThreadReply(db, "y");
  await handle(assistant, press(`hq:a:${plain}`));
  await handle(assistant, message(`/approve ${odd}`));
  await handle(assistant, message(`/reject ${rejected} no`));
  assert.deepEqual(fake.sent(), [`Item #${odd} : Approuvé.`, `Item #${rejected} : Refusé.`]);
  await fake.close();
});

test("Refuser asks for the reason, then decides with the next message", async () => {
  const { db, fake, assistant } = await setup();
  const id = addApproval(db);
  await handle(assistant, press(`hq:r:${id}`));
  assert.equal(approval(db, id).status, "pending");
  assert.match(fake.sent()[0]!, new RegExp(`Motif du refus de l'item #${id}`));

  await handle(assistant, message("Trop promotionnel."));
  const row = approval(db, id);
  assert.equal(row.status, "rejected");
  assert.equal(row.decision_note, "Trop promotionnel.");
  assert.equal(callsOf(fake, "editMessageText")[0]!.params.text, "MyHQ : un item attend ta validation\n\nDécision : Refusé");
  assert.equal(fake.sent()[1], `Item #${id} : Refusé.`);
  await fake.close();
});

test("À retravailler creates a task for the agent with the comment", async () => {
  const { db, fake, assistant } = await setup();
  const id = addApproval(db);
  await handle(assistant, press(`hq:v:${id}`));
  // A command typed meanwhile runs normally and the question stays open.
  await handle(assistant, message("/pending"));
  assert.match(fake.sent()[1]!, /1 item attend ta validation/);
  await handle(assistant, message("Plus court."));
  assert.equal(approval(db, id).status, "revise");
  const task = db.prepare("SELECT * FROM tasks WHERE source = 'revise' AND ref_id = ?").get(id) as { text: string };
  assert.match(task.text, /Plus court\./);
  await fake.close();
});

test("an expired question is dropped and the message goes on to the chat", async () => {
  const questions = new PendingQuestions(0);
  const chats: string[] = [];
  const { db, fake, assistant } = await setup({
    questions,
    assistant: { ...EMPTY_ASSISTANT_CONFIG, chat: { cwd: process.cwd(), addDirs: [], model: "haiku", allowedTools: [], permissionMode: "default", timeoutMs: 1000, afterReply: null, mcpServers: {}, requestsDir: null } },
    runChat: async (params) => (chats.push(params.input), { ok: true, text: "**Bonjour**", costUsd: 0 }),
  });
  const id = addApproval(db);
  await handle(assistant, press(`hq:r:${id}`));
  await new Promise((r) => setTimeout(r, 5));
  await handle(assistant, message("Salut"));
  assert.equal(approval(db, id).status, "pending");
  assert.deepEqual(chats, ["Salut"]);
  assert.deepEqual(fake.sent().slice(1), [`Ma question sur l'item #${id} date de plus d'une heure, je l'ai abandonnée.`, "Bonjour"]);
  assert.ok(callsOf(fake, "sendChatAction").length >= 1);
  await fake.close();
});

test("button presses from another chat are ignored", async () => {
  const { db, fake, assistant } = await setup();
  const id = addApproval(db);
  const foreign = press(`hq:a:${id}`);
  (foreign.callback_query.message.chat as { id: number }).id = 99;
  await handle(assistant, foreign);
  assert.equal(approval(db, id).status, "pending");
  assert.equal(fake.calls.length, 0);
  await fake.close();
});

// --- Core commands -------------------------------------------------------------

test("core commands: approve, reject, revise, run and status", async () => {
  const config = makeHome();
  const { db, fake, assistant } = await setup({ config });
  const a = addApproval(db, "First");
  const b = addApproval(db, "Second");
  await handle(assistant, message("/approve"));
  await handle(assistant, message(`/approve ${a}`));
  await handle(assistant, message(`/approve ${a}`));
  await handle(assistant, message(`/reject ${b}`));
  await handle(assistant, message(`/revise ${b} Shorter please`));
  await handle(assistant, message("/run demo/nobody"));
  await handle(assistant, message("/status"));
  const sent = fake.sent();
  assert.equal(sent[0], "Usage : /approve <id>");
  assert.equal(sent[1], `Item #${a} : Approuvé.`);
  assert.equal(sent[2], "Cet item a déjà été traité.");
  assert.equal(sent[3], "Usage : /reject <id> <motif>");
  assert.equal(sent[4], `Item #${b} : À retravailler.`);
  assert.equal(sent[5], "Agent introuvable.");
  assert.match(sent[6]!, /^Aujourd'hui : 0 tour\(s\)/);
  assert.match(sent[6]!, /Tours restants aujourd'hui : 12 sur 12/);
  assert.match(sent[6]!, /demo \/ Scout : Inactif/);
  await fake.close();
});

test("/arm and /disarm change the armed state, /status shows it with the scheduler, budget and journal", async () => {
  const config = makeHome(
    { weeklyBudgetUsd: 10 },
    {
      name: "demo",
      targetRepo: "../demo-project",
      agents: [
        { id: "scout", name: "Scout", role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"], cron: "0 7 * * *" },
      ],
    },
  );
  const { db, fake, assistant } = await setup({ config });
  db.prepare(
    "INSERT INTO routine_firings (room, agent_id, cron, scheduled_at, outcome, created_at) VALUES ('demo', 'scout', '0 7 * * *', ?, 'skipped_unarmed', ?)",
  ).run(new Date().toISOString(), new Date().toISOString());
  await handle(assistant, message("/arm"));
  await handle(assistant, message("/arm demo/nobody"));
  await handle(assistant, message("/arm demo/scout"));
  await handle(assistant, message("/status"));
  await handle(assistant, message("/disarm demo/scout"));
  const sent = fake.sent();
  assert.equal(sent[0], "Usage : /arm <salle>/<agent>");
  assert.equal(sent[1], "Agent introuvable.");
  assert.equal(sent[2], "Routines de demo / scout armées.");
  assert.match(sent[3]!, /demo \/ Scout : Inactif, armé, prochain /);
  assert.match(sent[3]!, /Planificateur : éteint \(HQ_SCHEDULER=off\)/);
  assert.match(sent[3]!, /Budget de la semaine : 0 %/);
  assert.match(sent[3]!, /Dernières routines :\n.* demo \/ scout : Sautée, désarmée/);
  assert.equal(sent[4], "Routines de demo / scout désarmées.");
  const row = db.prepare("SELECT armed FROM agents WHERE room = 'demo' AND id = 'scout'").get() as { armed: number };
  assert.equal(row.armed, 0);
  await fake.close();
});

test("/run starts a run of the agent", async () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const fake = await startFakeTelegram(TOKEN);
  const requests: unknown[] = [];
  const assistant = new Assistant({
    telegram: new Telegram(TOKEN, fake.url),
    chatId: CHAT,
    config,
    db,
    assistant: EMPTY_ASSISTANT_CONFIG,
    extensions: [],
    env: {},
    chatMaxBudgetUsd: 0.5,
    startRun: (request) => {
      requests.push(request);
      return { id: 9, room: request.room, agent_id: request.agent } as RunRow;
    },
    log: () => undefined,
  });
  await handle(assistant, message("/run demo/scout Find three threads."));
  assert.deepEqual(requests, [{ room: "demo", agent: "scout", task: "Find three threads." }]);
  assert.equal(fake.sent()[0], "Tour #9 lancé pour demo / scout.");
  await fake.close();
});

test("/salle starts an onboarding run; an approved room proposal hands over the CLAUDE.md block", async () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const fake = await startFakeTelegram(TOKEN);
  const requests: unknown[] = [];
  const assistant = new Assistant({
    telegram: new Telegram(TOKEN, fake.url),
    chatId: CHAT,
    config,
    db,
    assistant: EMPTY_ASSISTANT_CONFIG,
    extensions: [],
    env: {},
    chatMaxBudgetUsd: 0.5,
    startOnboarding: (request) => {
      requests.push(request);
      return { id: 11, room: "_hq", agent_id: "onboarding" } as RunRow;
    },
    log: () => undefined,
  });
  await handle(assistant, message("/salle"));
  await handle(assistant, message("/salle ../my-project"));
  assert.deepEqual(requests, [{ path: "../my-project" }]);

  // A proposal already normalized by hq_submit, for a room that already exists: refused, still pending.
  const room = { name: "demo", targetRepo: "../demo-project", agents: [{ id: "scout", name: "Scout", role: "roles/scout.md", model: "haiku", allowedTools: [] }] };
  const payload = { room, roles: { scout: { template: "dev", content: "# Role" } }, claudeMd: "## HQ agents\n\nNever deploy." };
  const id = Number(
    db
      .prepare("INSERT INTO approvals (room, agent_id, type, title, body, payload, status, created_at) VALUES ('_hq', 'onboarding', 'room_proposal', 'Room', 'b', ?, 'pending', ?)")
      .run(JSON.stringify(payload), new Date().toISOString()).lastInsertRowid,
  );
  await handle(assistant, message(`/approve ${id}`));
  // Under another name, with a target that exists, it is written and the block is handed over.
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "other-project-"));
  const targetRepo = path.relative(config.home, target).split(path.sep).join("/");
  const other = { ...payload, room: { ...room, name: "other", targetRepo } };
  db.prepare("UPDATE approvals SET payload = ? WHERE id = ?").run(JSON.stringify(other), id);
  await handle(assistant, message(`/approve ${id}`));

  const sent = fake.sent();
  assert.equal(sent[0], "Usage : /salle <chemin du dépôt, relatif au dossier MYHQ_HOME>");
  assert.equal(sent[1], "Tour d'accueil #11 lancé pour ../my-project. La proposition de salle arrivera dans la file.");
  assert.match(sent[2]!, /Une salle de ce nom existe déjà/);
  assert.equal(sent[3], `Item #${id} : Approuvé.`);
  assert.equal(
    sent[4],
    `Salle créée. Ajoute le bloc du message suivant au CLAUDE.md du projet (${targetRepo}) : MyHQ ne l'écrit jamais lui-même.`,
  );
  assert.equal(sent[5], "## HQ agents\n\nNever deploy.");
  assert.ok(fs.existsSync(path.join(config.home, "rooms", "other", "room.json")));
  await fake.close();
});

// --- Voice notes and files ------------------------------------------------------

test("a voice note is transcribed by the home's command, deleted, then handled as text", async () => {
  const config = makeHome();
  const script = path.join(import.meta.dirname, "fixtures", "transcribe.mjs");
  const quoted = process.platform === "win32" ? `"${script}"` : `'${script}'`;
  const chats: string[] = [];
  const { fake, assistant } = await setup({
    config,
    assistant: {
      ...EMPTY_ASSISTANT_CONFIG,
      transcribe: `"${process.execPath}" ${quoted} {file}`,
      chat: { cwd: config.home, addDirs: [], model: "haiku", allowedTools: [], permissionMode: "default", timeoutMs: 1000, afterReply: null, mcpServers: {}, requestsDir: null },
    },
    runChat: async (params) => (chats.push(params.input), { ok: true, text: "Compris.", costUsd: 0 }),
  });
  fake.addFile("voice-1", "Rappelle-moi le dentiste");
  await handle(assistant, {
    update_id: updateId++,
    message: { message_id: 50, chat: { id: Number(CHAT) }, voice: { file_id: "voice-1", file_size: 2000, duration: 2 } },
  });
  assert.deepEqual(chats, ["Rappelle-moi le dentiste"]);
  assert.deepEqual(fake.sent(), ["Compris."]);
  assert.deepEqual(fs.readdirSync(path.join(config.dataDir, "assistant", "voice")), []);
  await fake.close();
});

test("voice without a transcribe command, and files above 20 MB, get a French answer", async () => {
  const { fake, assistant } = await setup({ assistant: { ...EMPTY_ASSISTANT_CONFIG, dropDir: "/unused" } });
  await handle(assistant, { update_id: updateId++, message: { message_id: 1, chat: { id: 42 }, voice: { file_id: "v" } } });
  await handle(assistant, {
    update_id: updateId++,
    message: { message_id: 2, chat: { id: 42 }, document: { file_id: "d", file_name: "big.zip", file_size: 21 * 1024 * 1024 } },
  });
  await handle(assistant, { update_id: updateId++, message: { message_id: 3, chat: { id: 42 }, sticker: { file_id: "s" } } });
  assert.deepEqual(fake.sent(), [
    "Les vocaux ne sont pas configurés (transcribe dans assistant.json).",
    "Ce fichier dépasse 20 Mo, la limite de Telegram pour les bots.",
    "Je sais lire le texte, les vocaux, les photos et les documents. Ceci, pas encore.",
  ]);
  await fake.close();
});

test("a photo with a caption lands in dropDir with a companion note, never overwriting", async () => {
  const config = makeHome();
  const dropDir = path.join(config.home, "inbox");
  const { fake, assistant } = await setup({ config, assistant: { ...EMPTY_ASSISTANT_CONFIG, dropDir } });
  fake.addFile("big", "JPEGDATA");
  const photo = () => ({
    update_id: updateId++,
    message: {
      message_id: 60,
      chat: { id: Number(CHAT) },
      caption: "Ticket du garage",
      photo: [
        { file_id: "small", width: 90, height: 60 },
        { file_id: "big", width: 1280, height: 853 },
      ],
    },
  });
  await handle(assistant, photo());
  await handle(assistant, photo());
  const files = fs.readdirSync(dropDir).sort();
  assert.equal(files.length, 4);
  const images = files.filter((f) => f.endsWith(".jpg"));
  assert.match(images[0]!, /^Photo \d{4}-\d{2}-\d{2} \d{2}h\d{2}( \(2\))?\.jpg$/);
  assert.equal(fs.readFileSync(path.join(dropDir, images[0]!), "utf8"), "JPEGDATA");
  const note = fs.readFileSync(path.join(dropDir, images[0]!.replace(/\.jpg$/, ".md")), "utf8");
  assert.equal(note, `Ticket du garage\n\n![${images[0]}](${encodeURI(images[0]!)})\n`);
  assert.match(fake.sent()[0]!, /^Reçu : Photo .*\.jpg\. Déposé dans inbox\.$/);
  await fake.close();
});

test("received file names are made safe and never overwrite", () => {
  assert.equal(safeFileName("../../etc/passwd"), "passwd");
  assert.equal(safeFileName("C:\\x\\in:voice?.pdf"), "in_voice_.pdf");
  assert.equal(safeFileName(" ... "), null);
  assert.equal(safeFileName(undefined), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-drop-"));
  assert.equal(freeName(dir, "a.pdf"), "a.pdf");
  fs.writeFileSync(path.join(dir, "a.pdf"), "");
  fs.writeFileSync(path.join(dir, "a (2).pdf"), "");
  assert.equal(freeName(dir, "a.pdf"), "a (3).pdf");
});

// --- Alerts ------------------------------------------------------------------------

test("pending-approval alerts carry buttons only when polling is on", async () => {
  const fake = await startFakeTelegram(TOKEN);
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const env = { HQ_TELEGRAM_BOT_TOKEN: TOKEN, HQ_TELEGRAM_CHAT_ID: CHAT, HQ_TELEGRAM_API_BASE: fake.url };
  const { notify } = await import("../src/server/notify");
  const id = addApproval(db);
  await notifyPendingApprovals(db, (text, options) => notify(text, env, fetch, options));
  const second = addApproval(db);
  await notifyPendingApprovals(db, (text, options) => notify(text, { ...env, HQ_TELEGRAM_POLLING: "true" }, fetch, options));
  const [plain, withButtons] = callsOf(fake, "sendMessage").map((c) => c.params);
  assert.match(String(plain!.text), new RegExp(`#${id}`));
  assert.equal("reply_markup" in plain!, false);
  assert.match(String(withButtons!.text), new RegExp(`#${second}`));
  assert.deepEqual(withButtons!.reply_markup, {
    inline_keyboard: [
      [
        { text: "Approuver", callback_data: `hq:a:${second}` },
        { text: "Refuser", callback_data: `hq:r:${second}` },
        { text: "À retravailler", callback_data: `hq:v:${second}` },
      ],
    ],
  });
  await fake.close();
});

// --- Lock -------------------------------------------------------------------------------

test("the single-instance lock refuses a second reader and takes over a dead one", () => {
  const config = makeHome();
  const file = path.join(config.dataDir, "assistant", "bridge.lock");
  const lock = acquireLock(file);
  assert.ok(lock);
  assert.equal(fs.readFileSync(file, "utf8"), String(process.pid));
  assert.equal(acquireLock(file), null);
  lock.release();
  assert.equal(fs.existsSync(file), false);
  fs.writeFileSync(file, "999999999");
  const taken = acquireLock(file);
  assert.ok(taken);
  taken.release();
});

// --- End to end ------------------------------------------------------------------------

test("end to end: a core command, an extension command and a button press, through a fake Telegram", async () => {
  const fake = await startFakeTelegram(TOKEN);
  const config = makeHome();
  const commands = path.join(config.home, "assistant", "commands");
  fs.mkdirSync(commands, { recursive: true });
  fs.copyFileSync(path.join(import.meta.dirname, "fixtures", "extensions", "echo.ts"), path.join(commands, "echo.ts"));
  fs.writeFileSync(
    path.join(config.home, "assistant.json"),
    JSON.stringify({ extensions: ["assistant/commands/echo.ts"] }),
  );
  const db = getDbAt(config.dbPath);
  syncHome(db, loadHome(config.home));
  const id = addApproval(db, "A reply to approve");
  const logs: string[] = [];
  const env = {
    PATH: process.env.PATH,
    HQ_TELEGRAM_BOT_TOKEN: TOKEN,
    HQ_TELEGRAM_CHAT_ID: CHAT,
    HQ_TELEGRAM_POLLING: "true",
    HQ_TELEGRAM_API_BASE: fake.url,
    ECHO_SECRET: "s3cret",
  };
  const bridge = await startBridge({ env, config, pollTimeoutSec: 0, retryMs: 20, log: (m) => logs.push(m) });
  assert.ok(bridge, logs.join("\n"));
  // A second bridge in the same home is refused by the lock.
  assert.equal(await startBridge({ env, config, log: (m) => logs.push(m) }), null);

  const menu = callsOf(fake, "setMyCommands")[0]!.params.commands as { command: string }[];
  assert.deepEqual(
    menu.map((c) => c.command),
    ["start", "new", "pending", "approve", "reject", "revise", "run", "status", "arm", "disarm", "salle", "echo"],
  );

  fake.push(message("/pending"));
  fake.push(message("/pending", 99));
  fake.push(message("/echo bonjour"));
  fake.push(message("/ask"));
  fake.push(message("ma réponse"));
  fake.push(message("/boom"));
  await fake.waitFor(() => fake.sent().length >= 5);
  const button = press(`hq:a:${id}`, 77, "MyHQ : un item attend ta validation (#1)");
  fake.push(button);
  await fake.waitFor(() => callsOf(fake, "editMessageText").length === 1);
  await bridge.stop();

  assert.deepEqual(fake.sent(), [
    `1 item attend ta validation :\n#${id} demo / Scout : A reply to approve`,
    "echo: bonjour (s3cret, telegram hidden)",
    "Question?",
    "Noted: ma réponse",
    "La commande a échoué de mon côté (echo). Le détail est dans le journal.",
  ]);
  assert.equal(approval(db, id).status, "approved");
  assert.equal(callsOf(fake, "editMessageText")[0]!.params.text, "MyHQ : un item attend ta validation (#1)\n\nDécision : Approuvé");
  assert.ok(logs.some((l) => /chat 99 ignored/.test(l)));
  assert.ok(logs.some((l) => /extension echo failed: boom/.test(l)));
  assert.ok(logs.some((l) => /\[echo\] echo called/.test(l)));
  assert.equal(Number(fs.readFileSync(path.join(config.dataDir, "assistant", "offset.txt"), "utf8")), button.update_id);
  assert.equal(fs.existsSync(path.join(config.dataDir, "assistant", "bridge.lock")), false);
  assert.ok(logs.every((l) => !l.includes(TOKEN)));
  await fake.close();
});

test("the bridge does not start when polling is off", async () => {
  const logs: string[] = [];
  const bridge = await startBridge({
    env: { HQ_TELEGRAM_BOT_TOKEN: TOKEN, HQ_TELEGRAM_CHAT_ID: CHAT },
    config: makeHome(),
    log: (m) => logs.push(m),
  });
  assert.equal(bridge, null);
  assert.match(logs[0]!, /polling is off/);
});

// --- Chat requests ---------------------------------------------------------------

const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

test("a request file written by the chat creates a task and starts a run", async () => {
  const config = makeHome();
  const requestsDir = path.join(config.home, "chat", "requests");
  const chatConfig = {
    cwd: config.home,
    addDirs: [],
    model: "haiku" as const,
    allowedTools: [],
    mcpServers: {},
    requestsDir,
    permissionMode: "default" as const,
    timeoutMs: 1000,
    afterReply: null,
  };
  const inputs: RunInput[] = [];
  const engine: Engine = {
    name: "claude",
    async *run(input) {
      inputs.push(input);
      yield { type: "end", status: "done", reason: "success", summary: "ok", usage, costUsd: 0 };
    },
  };
  const started: RunRow[] = [];
  const { db, assistant, fake, logs } = await setup({
    config,
    assistant: { ...EMPTY_ASSISTANT_CONFIG, chat: chatConfig },
    runChat: async () => {
      fs.mkdirSync(requestsDir, { recursive: true });
      fs.writeFileSync(
        path.join(requestsDir, "a.json"),
        JSON.stringify({ room: "demo", agent: "scout", task: "Prepare a reply to the landlord." }),
      );
      fs.writeFileSync(path.join(requestsDir, "bad.json"), "{ nope");
      fs.writeFileSync(path.join(requestsDir, "ghost.json"), JSON.stringify({ room: "demo", agent: "ghost", task: "x" }));
      fs.writeFileSync(path.join(requestsDir, "shape.json"), JSON.stringify({ room: "demo", agent: "scout" }));
      fs.writeFileSync(path.join(requestsDir, "notes.txt"), "left alone");
      return { ok: true, text: "Je transmets.", costUsd: 0 };
    },
    startRun: (request) => {
      const run = startRun(request, { config, engine });
      started.push(run);
      return run;
    },
  });
  await handle(assistant, message("Réponds au propriétaire"));
  assert.equal(started.length, 1);
  assert.equal(started[0]!.reason, "chat");
  const run = await waitForRun(db, started[0]!.id);
  assert.equal(run.status, "done");
  assert.equal(inputs.length, 1);
  assert.match(inputs[0]!.prompt, /\[task \d+, chat\] Prepare a reply to the landlord\./);
  const task = db.prepare("SELECT * FROM tasks WHERE source = 'chat'").get() as { text: string; status: string };
  assert.equal(task.text, "Prepare a reply to the landlord.");
  assert.equal(task.status, "done");

  // The handled file is gone, the malformed ones are moved aside, the rest is untouched.
  assert.deepEqual(fs.readdirSync(requestsDir).sort(), ["notes.txt", "rejected"]);
  assert.deepEqual(fs.readdirSync(path.join(requestsDir, "rejected")).sort(), ["bad.json", "ghost.json", "shape.json"]);
  assert.ok(logs.some((l) => /bad\.json rejected: not valid JSON/.test(l)));
  assert.ok(logs.some((l) => /ghost\.json rejected/.test(l)));
  assert.ok(logs.some((l) => /shape\.json rejected: task/.test(l)));
  await fake.close();
});

test("a request for a busy agent leaves its task pending, and its own reason is kept", async () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  syncHome(db, loadHome(config.home));
  const dir = path.join(config.home, "requests");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "1.json"), JSON.stringify({ room: "demo", agent: "scout", task: "Later.", reason: "mail_followup" }));
  const logs: string[] = [];
  const requests: StartRunRequest[] = [];
  const created = processChatRequests(dir, {
    config,
    db,
    log: (m) => logs.push(m),
    startRun: (request) => {
      requests.push(request);
      throw new HqError("AGENT_BUSY", 409, "busy");
    },
  });
  assert.equal(created, 1);
  assert.equal(requests[0]!.reason, "mail_followup");
  assert.equal((db.prepare("SELECT status FROM tasks WHERE source = 'chat'").get() as { status: string }).status, "pending");
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.ok(logs.some((l) => /waits for the agent's next run/.test(l)));
  assert.equal(processChatRequests(path.join(config.home, "missing"), { config, db, log: () => undefined }), 0);
});
