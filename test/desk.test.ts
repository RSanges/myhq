import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { DeskCommands, parseCommandOutput, type CommandSpec } from "../src/server/desk-command";
import { POST as seenRoute } from "../src/app/api/desk/[id]/seen/route";
import {
  commandSpec,
  defaultDesk,
  deskCounts,
  deskResponse,
  markDeskSeen,
  readDeskConfig,
  resolveDesk,
  watchDesk,
  type DeskCountsDto,
  type DeskDto,
} from "../src/server/desk";
import { getDbAt, type Db } from "../src/server/db";
import { eventStreamResponse } from "../src/server/event-stream";
import { readNotifyTypes } from "../src/server/home-settings";
import { makeHome } from "./helpers";

// The desk as objects (myhq.json `desk`): the block and its defaults, the
// runner of the home commands, GET /api/desk and the `desk` event.

const saved = process.env.MYHQ_HOME;
afterEach(() => {
  if (saved === undefined) delete process.env.MYHQ_HOME;
  else process.env.MYHQ_HOME = saved;
});

const ROOM = {
  name: "demo",
  targetRepo: "../demo-project",
  color: "#ff3d7f",
  agents: [
    { id: "scout", name: "Scout", role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"] },
    { id: "brief", name: "Brief", role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"], notifyRuns: "summary" },
  ],
};

function writeSettings(home: string, settings: unknown): void {
  fs.writeFileSync(path.join(home, "myhq.json"), JSON.stringify(settings));
}

/** A home command of the tests: `node desk-cmd.mjs <mode>`, counting its runs in runs.txt. */
function writeCommand(home: string): void {
  fs.writeFileSync(
    path.join(home, "desk-cmd.mjs"),
    `import fs from "node:fs";
fs.appendFileSync("runs.txt", "x");
const mode = process.argv[2];
if (mode === "ok") console.log(JSON.stringify({ count: 2, items: [
  { id: "a", title: "Appeler le garage", at: "2026-11-04", tone: "alert" },
  { title: "Réserver le train", body: "**vite**", href: "https://example.com/train", extra: "dropped" },
], slots: [{ start: "2026-11-04T14:00:00+01:00", end: "2026-11-04T16:00:00+01:00" }], note: "Lu du cache" }));
else if (mode === "slow") setTimeout(() => console.log("{}"), 5000);
else if (mode === "notjson") console.log("bonjour");
else if (mode === "wrong") console.log(JSON.stringify({ count: -1, items: [{ title: "" }] }));
else if (mode === "badhref") console.log(JSON.stringify({ count: 1, items: [{ title: "x", href: "javascript:alert(1)" }] }));
else { console.error("boom"); process.exit(3); }
`,
  );
}

const spec = (home: string, mode: string, overrides: Partial<CommandSpec> = {}): CommandSpec => ({
  command: `node desk-cmd.mjs ${mode}`,
  cwd: home,
  timeoutMs: 5_000,
  cacheMs: 60_000,
  ...overrides,
});

const runsOf = (home: string): number => {
  const file = path.join(home, "runs.txt");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").length : 0;
};

// --- The block and its defaults -------------------------------------------------------

test("desk config: the default desk without myhq.json, without the block, and with an invalid block", () => {
  const { home } = makeHome();
  assert.deepEqual(readDeskConfig(home), { desk: defaultDesk(), error: null });
  assert.deepEqual(
    defaultDesk().objects.map((object) => [object.id, object.object, object.source]),
    [
      ["signer", "pile", "approvals"],
      ["courrier", "tray", "watch:mail_alert"],
      ["journal", "newspaper", ["watch:brief", "summaries"]],
      ["telephone", "phone", "blocked"],
    ],
    "pile, tray, newspaper and phone (the Standard); no post-its nor calendar unless configured",
  );
  writeSettings(home, { language: "fr" });
  assert.deepEqual(readDeskConfig(home), { desk: defaultDesk(), error: null });

  writeSettings(home, {
    notifyTypes: ["mail_alert"],
    desk: {
      objects: [
        { id: "signer", object: "pile", label: "À signer", source: "approvals" },
        { id: "signer", object: "tray", label: "Courrier", source: "watch:Mail" },
        { id: "agenda", object: "calendar", label: "Agenda", source: { command: "node a.mjs", shell: true } },
      ],
    },
  });
  const invalid = readDeskConfig(home);
  assert.deepEqual(invalid.desk, defaultDesk());
  assert.match(invalid.error ?? "", /desk\.objects\.1\.source/);
  assert.match(invalid.error ?? "", /used twice/);
  assert.deepEqual(readNotifyTypes(home), ["mail_alert"], "an invalid desk block leaves the rest of myhq.json alone");

  fs.writeFileSync(path.join(home, "myhq.json"), "{ not json");
  assert.match(readDeskConfig(home).error ?? "", /not valid JSON/);
});

test("desk config: a valid block, with the defaults of a command source", () => {
  const { home } = makeHome();
  writeSettings(home, {
    desk: {
      objects: [
        { id: "signer", object: "pile", label: "À signer", source: "approvals" },
        { id: "tout", object: "tray", label: "Tout", source: "watch:*" },
        { id: "postits", object: "postits", label: "Post-it", source: { command: "node tools/afaire.mjs", cwd: "tools" } },
      ],
    },
  });
  const { desk, error } = readDeskConfig(home);
  assert.equal(error, null);
  assert.deepEqual(desk.objects[2]!.source, { command: "node tools/afaire.mjs", cwd: "tools", timeoutSeconds: 10, cacheSeconds: 60 });

  for (const bad of [
    { id: "Signer", object: "pile", label: "x", source: "approvals" },
    { id: "a", object: "lamp", label: "x", source: "approvals" },
    { id: "a", object: "pile", label: "", source: "approvals" },
    { id: "a", object: "pile", label: "x", source: "everything" },
    { id: "a", object: "pile", label: "x", source: { command: "x", timeoutSeconds: 600 } },
  ]) {
    writeSettings(home, { desk: { objects: [bad] } });
    assert.notEqual(readDeskConfig(home).error, null, JSON.stringify(bad));
  }
  writeSettings(home, {
    desk: {
      objects: [
        { id: "a", object: "pile", label: "A", source: "approvals" },
        { id: "b", object: "pile", label: "B", source: "chat" },
      ],
    },
  });
  assert.match(readDeskConfig(home).error ?? "", /one pile/);
  assert.deepEqual(commandSpec(home, { command: "x", cwd: "../elsewhere", timeoutSeconds: 1, cacheSeconds: 1 }), {
    error: 'cwd "../elsewhere" is outside the home',
  });
});

// --- The runner of the home commands --------------------------------------------------

test("command output: the contract, unknown fields dropped, a BOM allowed, unsafe links refused", () => {
  const ok = parseCommandOutput(`﻿${JSON.stringify({ count: 1, items: [{ title: "T", at: "2026-11-04T09:00:00Z", more: 1 }] })}`);
  assert.ok(ok.ok);
  assert.deepEqual(ok.output.items, [{ title: "T", at: "2026-11-04T09:00:00Z" }]);
  assert.equal(parseCommandOutput("nope").ok, false);
  assert.equal(parseCommandOutput(JSON.stringify({ count: 1 })).ok, false);
  assert.equal(parseCommandOutput(JSON.stringify({ count: 0, items: [{ title: "x", at: "demain" }] })).ok, false);
  assert.equal(parseCommandOutput(JSON.stringify({ count: 0, items: [{ title: "x", href: "//evil.example" }] })).ok, false);
  assert.ok(parseCommandOutput(JSON.stringify({ count: 0, items: [{ title: "x", href: "/bureau/agenda" }] })).ok);
});

test("command runner: a good command, then its cache, then a run again once stale", async () => {
  const { home } = makeHome();
  writeCommand(home);
  let now = 1_000_000;
  const logs: string[] = [];
  const commands = new DeskCommands({ env: { PATH: process.env.PATH }, now: () => now, log: (m) => logs.push(m) });
  const first = await commands.get(spec(home, "ok"));
  assert.ok(first.ok);
  assert.equal(first.output.count, 2);
  assert.deepEqual(first.output.items[1], { title: "Réserver le train", body: "**vite**", href: "https://example.com/train" });
  assert.equal(runsOf(home), 1);
  now += 30_000;
  assert.equal(await commands.get(spec(home, "ok")), first, "served from the cache");
  assert.equal(runsOf(home), 1);
  now += 31_000;
  await commands.get(spec(home, "ok"));
  assert.equal(runsOf(home), 2, "run again after cacheMs");
  const both = await Promise.all([commands.get(spec(home, "ok", { cacheMs: 0 })), commands.get(spec(home, "ok", { cacheMs: 0 }))]);
  assert.equal(both[0], both[1], "two callers at once share one run");
  assert.equal(runsOf(home), 3);
  assert.deepEqual(logs, []);
});

test("command runner: timeout, exit code, invalid JSON and a wrong shape are error values, cached, logged with stderr", async () => {
  const { home } = makeHome();
  writeCommand(home);
  const logs: string[] = [];
  const commands = new DeskCommands({ env: { PATH: process.env.PATH }, log: (m) => logs.push(m) });
  const started = Date.now();
  const slow = await commands.get(spec(home, "slow", { timeoutMs: 800 }));
  assert.equal(slow.ok, false);
  assert.equal(!slow.ok && slow.code, "COMMAND_TIMEOUT");
  assert.ok(Date.now() - started < 4_000, "the desk does not wait for the command");
  const failed = await commands.get(spec(home, "fail"));
  assert.equal(!failed.ok && failed.code, "COMMAND_FAILED");
  assert.equal(!failed.ok && failed.message, "exited with code 3");
  assert.ok(logs.some((line) => /exited with code 3: boom/.test(line)), "stderr goes to the log");
  const notJson = await commands.get(spec(home, "notjson"));
  assert.equal(!notJson.ok && notJson.code, "COMMAND_INVALID_OUTPUT");
  const wrong = await commands.get(spec(home, "wrong"));
  assert.equal(!wrong.ok && wrong.code, "COMMAND_INVALID_OUTPUT");
  assert.match(!wrong.ok ? wrong.message : "", /count/);
  const badHref = await commands.get(spec(home, "badhref"));
  assert.equal(!badHref.ok && badHref.code, "COMMAND_INVALID_OUTPUT");
  const before = runsOf(home);
  await commands.get(spec(home, "fail"));
  assert.equal(runsOf(home), before, "a failure is cached too");
});

// --- GET /api/desk ----------------------------------------------------------------------

function seed(db: Db): void {
  const insert = db.prepare(
    "INSERT INTO approvals (room, agent_id, type, title, body, status, decision_note, decided_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insert.run("demo", "scout", "community_reply", "Réponse au fil", "Corps", "pending", null, null, "2026-11-04T08:00:00.000Z");
  insert.run("_hq", "onboarding", "room_proposal", "Proposition", "Salle", "pending", null, null, "2026-11-04T09:00:00.000Z");
  insert.run("demo", "scout", "mail_alert", "Mail de la banque", "Lire", "unseen", null, null, "2026-11-04T07:00:00.000Z");
  insert.run("demo", "scout", "mail_alert", "Ancien mail", "Lu", "seen", null, "2026-11-03T10:00:00.000Z", "2026-11-03T09:00:00.000Z");
  insert.run("demo", "scout", "mail_alert", "Très ancien", "Lu", "approved", "notification", "2026-11-01T10:00:00.000Z", "2026-11-01T10:00:00.000Z");
  insert.run("demo", "scout", "brief", "Brief du matin", "Bonjour", "unseen", null, null, "2026-11-04T06:00:00.000Z");
  db.prepare(
    "INSERT INTO runs (room, agent_id, engine, task, status, started_at, ended_at, summary) VALUES ('demo', 'brief', 'claude', 't', 'done', ?, ?, ?)",
  ).run("2026-11-04T17:59:00.000Z", "2026-11-04T18:00:00.000Z", "Le récap du soir.");
  db.prepare(
    "INSERT INTO runs (room, agent_id, engine, task, status, started_at, ended_at, summary) VALUES ('demo', 'scout', 'claude', 't', 'done', ?, ?, ?)",
  ).run("2026-11-04T17:00:00.000Z", "2026-11-04T17:01:00.000Z", "Not a brief agent.");
  const chat = db.prepare("INSERT INTO chat_messages (role, kind, channel, text, created_at) VALUES (?, ?, 'telegram', ?, ?)");
  chat.run("user", null, "Salut", "2026-11-04T08:00:00.000Z");
  chat.run("assistant", null, "Bonjour", "2026-11-04T08:00:05.000Z");
  chat.run("bot", "alert", "Un item attend", "2026-11-04T09:00:00.000Z");
}

test("GET /api/desk: the default desk with its counts, items, spines and links", async () => {
  const config = makeHome({}, ROOM);
  process.env.MYHQ_HOME = config.home;
  seed(getDbAt(config.dbPath));
  const response = await deskResponse();
  assert.equal(response.status, 200);
  const desk = (await response.json()) as DeskDto;
  assert.equal(desk.configError, null);
  const byId = Object.fromEntries(desk.objects.map((object) => [object.id, object]));

  const pile = byId.signer!;
  assert.equal(pile.count, 2);
  assert.deepEqual(pile.items.map((item) => item.title), ["Réponse au fil", "Proposition"], "oldest first");
  assert.equal(pile.items[0]!.href, `/bureau/signer#approval-${pile.items[0]!.ref!.id}`);
  assert.deepEqual(
    pile.spines!.map((spine) => [spine.room, spine.color]),
    [
      ["demo", "#ff3d7f"],
      ["_hq", null],
    ],
  );

  const tray = byId.courrier!;
  assert.equal(tray.count, 1);
  assert.deepEqual(
    tray.items.map((item) => [item.title, item.tone]),
    [
      ["Mail de la banque", null],
      ["Ancien mail", "muted"],
      ["Très ancien", "muted"],
    ],
    "unseen first, then the seen ones, newest first",
  );
  assert.equal(tray.spines, null);

  const journal = byId.journal!;
  assert.equal(journal.source, "watch:brief+summaries");
  assert.deepEqual(journal.items.map((item) => [item.title, item.ref?.kind]), [
    ["Brief", "run"],
    ["Brief du matin", "approval"],
  ]);
  assert.equal(journal.items[0]!.body, "Le récap du soir.");

  const phone = byId.telephone!;
  assert.equal(phone.label, "Standard");
  assert.equal(phone.source, "blocked");
  assert.equal(phone.count, 0, "nothing stuck at the agents");
  assert.deepEqual(phone.items, []);
});

test("GET /api/desk: a command object, ok or failing, never fails the route", async () => {
  const config = makeHome({}, ROOM);
  process.env.MYHQ_HOME = config.home;
  writeCommand(config.home);
  writeSettings(config.home, {
    desk: {
      objects: [
        { id: "postits", object: "postits", label: "Post-it", source: { command: "node desk-cmd.mjs ok", cacheSeconds: 0 } },
        { id: "agenda", object: "calendar", label: "Agenda", source: { command: "node desk-cmd.mjs fail", cacheSeconds: 0 } },
      ],
    },
  });
  const desk = (await (await deskResponse()).json()) as DeskDto;
  const [postits, agenda] = desk.objects;
  assert.equal(postits!.status, "ok");
  assert.equal(postits!.count, 2);
  assert.deepEqual(
    postits!.items.map((item) => [item.id, item.title, item.tone, item.allDay]),
    [
      ["a", "Appeler le garage", "alert", false],
      ["item-2", "Réserver le train", null, false],
    ],
  );
  assert.deepEqual(postits!.slots, [{ start: "2026-11-04T14:00:00+01:00", end: "2026-11-04T16:00:00+01:00", label: null }]);
  assert.equal(postits!.note, "Lu du cache");
  assert.equal(agenda!.status, "error");
  assert.deepEqual(agenda!.error, { code: "COMMAND_FAILED", message: "exited with code 3" });
  assert.equal(agenda!.count, 0);
});

// --- The `desk` event -------------------------------------------------------------------

test("watchDesk: announces a change of count, not the first reading nor a reading that did not change", async () => {
  const config = makeHome({}, ROOM);
  const db = getDbAt(config.dbPath);
  const commands = new DeskCommands({ env: {} });
  const seen: DeskCountsDto[] = [];
  const stop = watchDesk(() => deskCounts({ config, db, commands }), (counts) => seen.push(counts), 30);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(seen.length, 0);
  db.prepare(
    "INSERT INTO approvals (room, agent_id, type, title, body, status, created_at) VALUES ('demo', 'scout', 'mail_alert', 'M', 'B', 'unseen', ?)",
  ).run(new Date().toISOString());
  await new Promise((resolve) => setTimeout(resolve, 150));
  stop();
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]!.objects.find((object) => object.id === "courrier"), { id: "courrier", count: 1, status: "ok" });
});

test("the live stream carries a `desk` event when a count changes", async () => {
  const config = makeHome({}, ROOM);
  process.env.MYHQ_HOME = config.home;
  const db = getDbAt(config.dbPath);
  const controller = new AbortController();
  const response = eventStreamResponse(new Request("http://127.0.0.1/api/events", { signal: controller.signal }));
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  // One read at a time: a read left pending by a timeout still gets the next chunk.
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  const read = async (until: RegExp, ms: number) => {
    const deadline = Date.now() + ms;
    while (!until.test(text)) {
      if (Date.now() > deadline) throw new Error(`no ${until} in ${text}`);
      pending ??= reader.read();
      const chunk = await Promise.race([pending, new Promise<null>((resolve) => setTimeout(() => resolve(null), 200))]);
      if (chunk) {
        pending = null;
        if (!chunk.done) text += decoder.decode(chunk.value);
      }
    }
  };
  try {
    await read(/event: ready/, 3_000);
    // The first reading of the counts is the baseline.
    await new Promise((resolve) => setTimeout(resolve, 500));
    db.prepare(
      "INSERT INTO approvals (room, agent_id, type, title, body, status, created_at) VALUES ('demo', 'scout', 'community_reply', 'T', 'B', 'pending', ?)",
    ).run(new Date().toISOString());
    await read(/event: desk/, 8_000);
  } finally {
    controller.abort();
  }
  const frame = text.split("\n\n").find((each) => each.startsWith("event: desk"))!;
  assert.ok(!/^id:/m.test(frame), "not a stored change: no id");
  const data = JSON.parse(frame.split("\ndata: ")[1]!) as DeskCountsDto & { at: string };
  assert.deepEqual(data.objects.find((object) => object.id === "signer"), { id: "signer", count: 1, status: "ok" });
  assert.ok(Date.parse(data.at) > 0);
});

test("resolveDesk: the counts of the summaries are the ones of today", async () => {
  const config = makeHome({}, ROOM);
  const db = getDbAt(config.dbPath);
  seed(db);
  const commands = new DeskCommands({ env: {} });
  const day = await resolveDesk({ config, db, commands, at: new Date("2026-11-04T20:00:00.000Z") });
  const later = await resolveDesk({ config, db, commands, at: new Date("2026-11-06T20:00:00.000Z") });
  const journal = (desk: DeskDto) => desk.objects.find((object) => object.id === "journal")!;
  assert.equal(journal(day).count, 2, "the unseen brief and the summary of the day");
  assert.equal(journal(later).count, 1, "only the unseen brief two days later");
});

// --- Seen -------------------------------------------------------------------------------

test("seen: opening the newspaper sets its summaries back to zero, what comes after counts again; the unseen brief keeps its « Vu »", async () => {
  const config = makeHome({}, ROOM);
  const db = getDbAt(config.dbPath);
  seed(db);
  const commands = new DeskCommands({ env: {} });
  const at = new Date("2026-11-04T20:00:00.000Z");
  const journal = async () => (await resolveDesk({ config, db, commands, at })).objects.find((object) => object.id === "journal")!;
  assert.equal((await journal()).count, 2, "never opened: the unseen brief and the summary of the day");

  markDeskSeen(db, "journal", "2026-11-04T19:00:00.000Z");
  assert.equal((await journal()).count, 1, "the summary that existed is seen; the brief waits for its « Vu »");
  assert.equal((await journal()).items.length, 2, "the items stay on the page");
  assert.deepEqual((await deskCounts({ config, db, commands, at })).objects.find((object) => object.id === "journal")?.count, 1);

  db.prepare(
    "INSERT INTO runs (room, agent_id, engine, task, status, started_at, ended_at, summary) VALUES ('demo', 'brief', 'claude', 't', 'done', ?, ?, ?)",
  ).run("2026-11-04T19:29:00.000Z", "2026-11-04T19:30:00.000Z", "Le récap de la nuit.");
  assert.equal((await journal()).count, 2, "a summary that came after counts");
  assert.equal((await resolveDesk({ config, db, commands, at: new Date("2026-11-06T09:00:00.000Z") })).objects.find((object) => object.id === "journal")!.count, 2, "no reset at midnight any more");
  db.prepare("UPDATE approvals SET status = 'seen' WHERE type = 'brief'").run();
  assert.equal((await journal()).count, 1);
});

test("seen: the chat source counts the messages of the bot since the user wrote and since its page was opened, for any home", async () => {
  const config = makeHome({}, ROOM);
  writeSettings(config.home, { desk: { objects: [{ id: "tel", object: "phone", label: "Téléphone", source: "chat" }] } });
  const db = getDbAt(config.dbPath);
  seed(db);
  const commands = new DeskCommands({ env: {} });
  const phone = async () => (await resolveDesk({ config, db, commands })).objects[0]!;
  assert.equal((await phone()).count, 2, "the reply and the alert since the user last wrote");
  assert.deepEqual((await phone()).items.map((item) => item.body), ["Salut", "Bonjour", "Un item attend"]);
  markDeskSeen(db, "tel", "2026-11-04T08:30:00.000Z");
  assert.equal((await phone()).count, 1, "the reply was there when the page opened; the alert came after");
  markDeskSeen(db, "tel", "2026-11-04T10:00:00.000Z");
  assert.equal((await phone()).count, 0);
  db.prepare("INSERT INTO chat_messages (role, kind, channel, text, created_at) VALUES ('bot', 'alert', 'telegram', 'Encore', ?)").run(
    "2026-11-04T11:00:00.000Z",
  );
  assert.equal((await phone()).count, 1);
  assert.equal(markDeskSeen(db, "other", "2026-11-04T12:00:00.000Z"), "2026-11-04T12:00:00.000Z");
  assert.equal((await phone()).count, 1, "the mark is per object");
});

test("POST /api/desk/<id>/seen: marks an object of the desk, 404 for another id, 400 for an invalid one", async () => {
  const config = makeHome({}, ROOM);
  process.env.MYHQ_HOME = config.home;
  const db = getDbAt(config.dbPath);
  const post = (id: string) => seenRoute(new Request(`http://127.0.0.1/api/desk/${id}/seen`, { method: "POST" }), { params: Promise.resolve({ id }) });
  const ok = await post("journal");
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as { id: string; seenAt: string };
  assert.equal(body.id, "journal");
  assert.equal((db.prepare("SELECT seen_at FROM desk_seen WHERE object_id = 'journal'").get() as { seen_at: string }).seen_at, body.seenAt);
  const missing = await post("agenda");
  assert.equal(missing.status, 404);
  assert.equal(((await missing.json()) as { error: { code: string } }).error.code, "DESK_OBJECT_NOT_FOUND");
  assert.equal((await post("Not An Id")).status, 400);
});
