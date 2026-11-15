import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CHAT_ACTIONS, describeAction, takeChatActions } from "../src/assistant/actions";
import type { ChatOutcome, ChatRunner } from "../src/assistant/chat";
import { getChatService } from "../src/assistant/chat-service";
import { getDbAt } from "../src/server/db";
import { openOrder } from "../src/server/room-folders";
import { strings } from "../src/ui/strings";
import { chatConfig, makeHome } from "./helpers";

// The chat action `file_received`: a file of the assistant's drop folder moves into a room's recu/ drawer, on the owner's act.

const t = strings.assistant.actions;
const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// --- The action file ----------------------------------------------------------------------

/** Writes one action file in a fresh requests directory and takes it. */
function take(file: unknown, allowed: readonly (typeof CHAT_ACTIONS)[number][] = CHAT_ACTIONS) {
  const dir = tmp("myhq-requests-");
  fs.writeFileSync(path.join(dir, "a.json"), JSON.stringify(file));
  const logs: string[] = [];
  const taken = takeChatActions(dir, allowed, (m) => logs.push(m));
  return { ...taken, logs, rejected: fs.existsSync(path.join(dir, "rejected")) ? fs.readdirSync(path.join(dir, "rejected")) : [] };
}

test("file_received is a chat action; its file shape is taken as given, the room required, the order optional", () => {
  assert.ok((CHAT_ACTIONS as readonly string[]).includes("file_received"));
  const plain = take({ action: "file_received", file: "logo.png", room: "shop" });
  assert.deepEqual(plain.actions, [{ action: "file_received", file: "logo.png", room: "shop" }]);
  assert.deepEqual(plain.refused, []);
  const ordered = take({ action: "file_received", file: "Mon logo (1).png", room: "shop", order: "2026-11-acme-sign" });
  assert.deepEqual(ordered.actions, [{ action: "file_received", file: "Mon logo (1).png", room: "shop", order: "2026-11-acme-sign" }]);
  assert.deepEqual(take({ action: "file_received", file: ".hidden", room: "shop" }).refused, [], "a name with a dot is fine, only dots are not");
  assert.deepEqual(take({ action: "file_received", file: "a".repeat(255), room: "shop" }).refused, []);
});

test("file_received: zod refuses an empty name, a separator, .., only dots, a drive prefix, more than 255 characters", () => {
  const bad: [string, Record<string, unknown>][] = [
    ["empty name", { file: "" }],
    ["slash", { file: "a/b.png" }],
    ["backslash", { file: "a\\b.png" }],
    ["leading slash", { file: "/etc/passwd" }],
    ["dot dot", { file: ".." }],
    ["parent path", { file: "../x.png" }],
    ["one dot", { file: "." }],
    ["only dots", { file: "..." }],
    ["drive prefix", { file: "C:x.png" }],
    ["lowercase drive", { file: "c:" }],
    ["too long", { file: "a".repeat(256) }],
    ["no file", {}],
    ["file not a string", { file: 12 }],
    ["no room", { file: "logo.png", room: undefined }],
    ["empty room", { file: "logo.png", room: "" }],
    ["bad order", { file: "logo.png", order: "acme sign" }],
    ["order of a drawer", { file: "logo.png", order: "recu" }],
  ];
  for (const [why, fields] of bad) {
    const { actions, refused, logs, rejected } = take({ action: "file_received", room: "shop", ...fields });
    assert.deepEqual(actions, [], why);
    assert.deepEqual(refused, [t.invalid], why);
    assert.equal(rejected.length, 1, `${why}: the file is set aside`);
    assert.equal(logs.length, 1, why);
  }
});

test("file_received: outside chat.requests.actions it is refused like any other action", () => {
  const { actions, refused } = take({ action: "file_received", file: "logo.png", room: "shop" }, ["approve"]);
  assert.deepEqual(actions, []);
  assert.deepEqual(refused, [t.notAllowed("file_received")]);
});

test("describeAction: the confirmation question names the file, the room and the order", () => {
  assert.equal(
    describeAction({ action: "file_received", file: "logo.png", room: "shop" }),
    "ranger « logo.png » dans les fichiers reçus de shop",
  );
  assert.equal(
    describeAction({ action: "file_received", file: "logo.png", room: "shop", order: "2026-11-acme-sign" }),
    "ranger « logo.png » dans les fichiers reçus de shop (commande 2026-11-acme-sign)",
  );
});

// --- The execution, through the chat service ----------------------------------------------

/** Adds a room of one agent to a test home. */
function addRoom(home: string, name: string, extra: Record<string, unknown> = {}) {
  const dir = path.join(home, "rooms", name);
  fs.mkdirSync(path.join(dir, "roles"), { recursive: true });
  fs.writeFileSync(path.join(dir, "roles", "clerk.md"), "You are a test agent.\n");
  fs.writeFileSync(
    path.join(dir, "room.json"),
    JSON.stringify({
      name,
      targetRepo: `../${name}-project`,
      ...extra,
      agents: [{ id: "clerk", name: "Clerk", role: "roles/clerk.md", model: "haiku", allowedTools: ["mcp__hq__*"] }],
    }),
  );
}

/** A home with `demo` (no orders) and `shop` (orders), a drop folder holding `files`, and a chat whose turn asks for `actions`. */
function setup(options: { files?: Record<string, string>; actions: Record<string, unknown>[]; tools?: string[]; dropDir?: "none" }) {
  const config = makeHome();
  addRoom(config.home, "shop", { orders: true });
  const dropDir = path.join(config.home, "inbox");
  fs.mkdirSync(dropDir, { recursive: true });
  for (const [name, content] of Object.entries(options.files ?? {})) fs.writeFileSync(path.join(dropDir, name), content);
  const root = path.join(config.home, "folders");
  const requestsDir = path.join(config.home, "chat", "requests");
  const logs: string[] = [];
  const runChat: ChatRunner = async (): Promise<ChatOutcome> => {
    fs.mkdirSync(requestsDir, { recursive: true });
    options.actions.forEach((action, i) => fs.writeFileSync(path.join(requestsDir, `act-${i}.json`), JSON.stringify(action)));
    return { ok: true, text: "Réponse", costUsd: 0, ...(options.tools ? { tools: options.tools } : {}) };
  };
  const service = getChatService(config, {
    chat: chatConfig({
      cwd: config.home,
      requestsDir,
      actions: ["file_received"],
      mcpServers: { mail: { command: "node" } },
    }),
    dropDir: options.dropDir === "none" ? null : dropDir,
    env: { PATH: process.env.PATH },
    chatMaxBudgetUsd: 0.5,
    runChat,
    log: (m) => logs.push(m),
  });
  const ask = async (text: string) => (await service.ask(text, "desk")).reply;
  /** The lines the core added to the reply, after the chat's own text. */
  const linesOf = (reply: string) => reply.split("\n\n").slice(1).join("\n\n").split("\n");
  return { config, dropDir, root, service, logs, ask, linesOf, db: getDbAt(config.dbPath) };
}

const ask = (what: string) => `Je n'ai pas pu ranger « ${what}`;

test("file_received by a turn that read nothing untrusted: the file moves into the recu of the room at once", async () => {
  const s = setup({ files: { "logo.png": "png" }, actions: [{ action: "file_received", file: "logo.png", room: "demo" }], tools: [] });
  assert.deepEqual(s.linesOf(await s.ask("Range le logo")), ["Rangé dans demo/recu/logo.png."]);
  assert.equal(fs.readFileSync(path.join(s.root, "demo", "recu", "logo.png"), "utf8"), "png");
  assert.deepEqual(fs.readdirSync(s.dropDir), []);
});

test("file_received into an order, with its companion note, and a taken name is numbered, never overwritten", async () => {
  const s = setup({
    files: { "logo.png": "new", "logo.md": "Le logo du client.\n\n![logo.png](logo.png)\n" },
    actions: [{ action: "file_received", file: "logo.png", room: "shop", order: "2026-11-acme-sign" }],
    tools: [],
  });
  openOrder(s.root, "shop", "acme", "sign", new Date("2026-11-15T10:00:00Z"), "UTC");
  const recu = path.join(s.root, "shop", "2026-11-acme-sign", "recu");
  fs.writeFileSync(path.join(recu, "logo.png"), "older");
  assert.deepEqual(s.linesOf(await s.ask("Range le logo dans la commande")), ["Rangé dans shop/2026-11-acme-sign/recu/logo-2.png."]);
  assert.equal(fs.readFileSync(path.join(recu, "logo.png"), "utf8"), "older");
  assert.equal(fs.readFileSync(path.join(recu, "logo-2.png"), "utf8"), "new");
  assert.equal(fs.readFileSync(path.join(recu, "logo-2.md"), "utf8"), "Le logo du client.\n\n![logo.png](logo.png)\n");
  assert.deepEqual(fs.readdirSync(s.dropDir), []);
});

test("file_received without a note: only the file moves, and a note of another name stays", async () => {
  const s = setup({
    files: { "brief.pdf": "pdf", "notes.md": "other" },
    actions: [{ action: "file_received", file: "brief.pdf", room: "demo" }],
    tools: [],
  });
  assert.deepEqual(s.linesOf(await s.ask("Range le brief")), ["Rangé dans demo/recu/brief.pdf."]);
  assert.deepEqual(fs.readdirSync(path.join(s.root, "demo", "recu")), ["brief.pdf"]);
  assert.deepEqual(fs.readdirSync(s.dropDir), ["notes.md"]);
});

test("file_received failures: one French line each, and nothing moves", async () => {
  const cases: { why: string; action: Record<string, unknown>; line: RegExp; setupOrders?: boolean }[] = [
    {
      why: "unknown room",
      action: { action: "file_received", file: "logo.png", room: "ghost" },
      line: /^Je n'ai pas pu ranger « logo\.png » dans les fichiers reçus de ghost : je ne connais aucune salle « ghost »\.$/,
    },
    {
      why: "room without orders given an order",
      action: { action: "file_received", file: "logo.png", room: "demo", order: "2026-11-acme-sign" },
      line: /^Je n'ai pas pu ranger .* : la salle demo n'a pas de commande ouverte\.$/,
    },
    {
      why: "room with orders but none open",
      action: { action: "file_received", file: "logo.png", room: "shop", order: "2026-11-acme-sign" },
      line: /^Je n'ai pas pu ranger .* : la salle shop n'a pas de commande ouverte\.$/,
    },
    {
      why: "unknown order lists the orders",
      action: { action: "file_received", file: "logo.png", room: "shop", order: "2026-11-acme-sign" },
      line: /: la commande « 2026-11-acme-sign » n'existe pas dans la salle shop \(commandes : 2026-11-beta-cup, 2026-10-acme-mug\)\.$/,
      setupOrders: true,
    },
    {
      why: "a file that is not in the drop folder",
      action: { action: "file_received", file: "missing.png", room: "demo" },
      line: /^Je n'ai pas pu ranger « missing\.png » .* : « missing\.png » n'est pas dans le dossier de dépôt\.$/,
    },
    {
      why: "a folder, not a file",
      action: { action: "file_received", file: "sub", room: "demo" },
      line: /: « sub » n'est pas un fichier\.$/,
    },
  ];
  for (const { why, action, line, setupOrders } of cases) {
    const s = setup({ files: { "logo.png": "png" }, actions: [action], tools: [] });
    fs.mkdirSync(path.join(s.dropDir, "sub"));
    if (setupOrders) {
      openOrder(s.root, "shop", "acme", "mug", new Date("2026-10-10T10:00:00Z"), "UTC");
      openOrder(s.root, "shop", "beta", "cup", new Date("2026-11-10T10:00:00Z"), "UTC");
    }
    const lines = s.linesOf(await s.ask("Range"));
    assert.equal(lines.length, 1, why);
    assert.match(lines[0]!, line, why);
    assert.ok(lines[0]!.startsWith(ask(String(action.file))), why);
    assert.ok(fs.existsSync(path.join(s.dropDir, "logo.png")), `${why}: the file stays in the drop folder`);
    assert.ok(!fs.existsSync(path.join(s.root, "demo")), `${why}: nothing made for the room`);
  }
});

test("file_received without a drop folder in assistant.json says so", async () => {
  const s = setup({ files: { "logo.png": "png" }, actions: [{ action: "file_received", file: "logo.png", room: "demo" }], tools: [], dropDir: "none" });
  assert.deepEqual(s.linesOf(await s.ask("Range")), [
    "Je n'ai pas pu ranger « logo.png » dans les fichiers reçus de demo : aucun dossier de dépôt n'est configuré (dropDir dans assistant.json).",
  ]);
  assert.ok(fs.existsSync(path.join(s.dropDir, "logo.png")));
});

test("file_received: a link in the drop folder that leads out is refused", async (t) => {
  const s = setup({ actions: [{ action: "file_received", file: "link", room: "demo" }], tools: [] });
  const outside = tmp("myhq-outside-");
  fs.writeFileSync(path.join(outside, "secret.pdf"), "secret");
  // A file link where the platform allows it, else a directory junction: both lead out of the drop folder.
  try {
    fs.symlinkSync(path.join(outside, "secret.pdf"), path.join(s.dropDir, "link"), "file");
  } catch {
    try {
      fs.symlinkSync(outside, path.join(s.dropDir, "link"), "junction");
    } catch {
      t.skip("cannot create a link here");
      return;
    }
  }
  assert.deepEqual(s.linesOf(await s.ask("Range")), [
    "Je n'ai pas pu ranger « link » dans les fichiers reçus de demo : « link » mène hors du dossier de dépôt, je ne le déplace pas.",
  ]);
  assert.equal(fs.readFileSync(path.join(outside, "secret.pdf"), "utf8"), "secret");
  assert.ok(!fs.existsSync(path.join(s.root, "demo")));
});

// --- The confirmation guard ---------------------------------------------------------------

test("file_received is held for a yes after an untrusted read, like approve or run, and executes only on oui", async () => {
  const s = setup({
    files: { "logo.png": "png" },
    actions: [{ action: "file_received", file: "logo.png", room: "demo" }],
    tools: ["mcp__mail__mail_search"],
  });
  const reply = await s.ask("Range la pièce jointe du mail");
  assert.match(reply, /^Réponse\n\nCette réponse s'appuie sur du courrier ou du web/);
  assert.ok(reply.includes("ranger « logo.png » dans les fichiers reçus de demo"));
  assert.ok(s.logs.some((l) => /held for confirmation \(untrusted: mcp__mail__mail_search\)/.test(l)));
  assert.deepEqual(s.service.state().pendingConfirmation, { summary: "ranger « logo.png » dans les fichiers reçus de demo" });
  assert.ok(fs.existsSync(path.join(s.dropDir, "logo.png")), "nothing moves before the yes");
  assert.ok(!fs.existsSync(path.join(s.root, "demo")));

  assert.equal(await s.ask("Oui !"), "Rangé dans demo/recu/logo.png.");
  assert.ok(!fs.existsSync(path.join(s.dropDir, "logo.png")));
  assert.equal(fs.readFileSync(path.join(s.root, "demo", "recu", "logo.png"), "utf8"), "png");
});

test("file_received is held too when the runner does not say which tools the turn called, and dropped by a no", async () => {
  const s = setup({ files: { "logo.png": "png" }, actions: [{ action: "file_received", file: "logo.png", room: "demo" }] });
  const reply = await s.ask("Range le logo");
  assert.match(reply, /Cette réponse s'appuie sur du courrier ou du web/);
  assert.equal(await s.ask("non"), "D'accord, je n'en fais rien.");
  assert.ok(fs.existsSync(path.join(s.dropDir, "logo.png")));
  assert.equal(s.service.state().pendingConfirmation, null);
});
