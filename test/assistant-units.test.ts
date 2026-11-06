import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { approvalKeyboard, parseButtonData } from "../src/assistant/approval-buttons";
import { askChat, buildChatArgs, chatEnv, parseChatOutput, type ChatRunner } from "../src/assistant/chat";
import { parseApproveArgs, parseCommand, parseNoteArgs, parseRunArgs } from "../src/assistant/commands";
import { loadAssistantConfig, type ChatConfig } from "../src/assistant/home-config";
import { PendingQuestions } from "../src/assistant/pending";
import { extensionEnv, readSettings } from "../src/assistant/settings";
import { fillTemplate } from "../src/assistant/shell";
import { parseUpdate } from "../src/assistant/telegram";
import { splitMessage, stripMarkdown } from "../src/assistant/text";

const EM = "\u2014";
const EN = "\u2013";

// --- Update parser -----------------------------------------------------------

test("parses a text message, a voice note, a photo and a button press", () => {
  const text = parseUpdate({
    update_id: 10,
    message: { message_id: 1, chat: { id: 42, type: "private" }, from: { id: 42 }, date: 1, text: "/pending" },
  } as { update_id: number });
  assert.ok(text.ok);
  assert.equal(text.update.message?.text, "/pending");

  const voice = parseUpdate({
    update_id: 11,
    message: { message_id: 2, chat: { id: 42 }, voice: { file_id: "v1", file_size: 1200, duration: 3 } },
  } as { update_id: number });
  assert.ok(voice.ok);
  assert.equal(voice.update.message?.voice?.file_id, "v1");

  const photo = parseUpdate({
    update_id: 12,
    message: {
      message_id: 3,
      chat: { id: 42 },
      caption: "Receipt",
      photo: [
        { file_id: "small", width: 90, height: 60 },
        { file_id: "large", width: 1280, height: 853, file_size: 90_000 },
      ],
    },
  } as { update_id: number });
  assert.ok(photo.ok);
  assert.equal(photo.update.message?.photo?.length, 2);

  const button = parseUpdate({
    update_id: 13,
    callback_query: { id: "cb1", from: { id: 42 }, message: { message_id: 7, chat: { id: 42 }, text: "alert" }, data: "hq:a:3" },
  } as { update_id: number });
  assert.ok(button.ok);
  assert.equal(button.update.callback_query?.data, "hq:a:3");
});

test("an update of the wrong shape is reported with its id, never thrown", () => {
  const bad = parseUpdate({ update_id: 14, message: { message_id: "x", chat: {} } } as { update_id: number });
  assert.equal(bad.ok, false);
  assert.equal(bad.updateId, 14);
  if (!bad.ok) assert.match(bad.error, /message\.message_id/);
});

// --- Commands ----------------------------------------------------------------

test("parses commands, with or without the bot's name", () => {
  assert.deepEqual(parseCommand("/pending"), { name: "pending", args: "" });
  assert.deepEqual(parseCommand("/Approve@MyBot 12"), { name: "approve", args: "12" });
  assert.deepEqual(parseCommand("  /reject 3   too long\nand off topic "), {
    name: "reject",
    args: "3   too long\nand off topic",
  });
  assert.equal(parseCommand("hello /pending"), null);
  assert.equal(parseCommand("/"), null);
  assert.equal(parseCommand("/a-b"), null);
});

test("parses the arguments of the core commands", () => {
  assert.deepEqual(parseApproveArgs("12"), { id: 12 });
  assert.deepEqual(parseApproveArgs("#12"), { id: 12 });
  assert.equal(parseApproveArgs("12 now"), null);
  assert.equal(parseApproveArgs(""), null);
  assert.deepEqual(parseNoteArgs("3 Too promotional."), { id: 3, note: "Too promotional." });
  assert.equal(parseNoteArgs("3"), null);
  assert.equal(parseNoteArgs("x reason"), null);
  assert.deepEqual(parseRunArgs("demo/scout"), { room: "demo", agent: "scout" });
  assert.deepEqual(parseRunArgs("demo/scout Find three threads."), {
    room: "demo",
    agent: "scout",
    task: "Find three threads.",
  });
  assert.equal(parseRunArgs("demo"), null);
  assert.equal(parseRunArgs("Demo/scout"), null);
});

test("approval buttons round-trip through their callback data", () => {
  const keyboard = approvalKeyboard(7);
  const data = keyboard.inline_keyboard[0]!.map((b) => b.callback_data);
  assert.deepEqual(data, ["hq:a:7", "hq:r:7", "hq:v:7"]);
  assert.deepEqual(
    keyboard.inline_keyboard[0]!.map((b) => b.text),
    ["Approuver", "Refuser", "À retravailler"],
  );
  assert.deepEqual(parseButtonData("hq:a:7"), { action: "approve", approvalId: 7 });
  assert.deepEqual(parseButtonData("hq:r:7"), { action: "reject", approvalId: 7 });
  assert.deepEqual(parseButtonData("hq:v:7"), { action: "revise", approvalId: 7 });
  assert.equal(parseButtonData("hq:x:7"), null);
  assert.equal(parseButtonData(undefined), null);
});

// --- Markdown stripping and splitting -----------------------------------------

test("strips Markdown and dashes for plain text", () => {
  assert.equal(stripMarkdown("# Title\n**bold** and __under__ and `code`"), "Title\nbold and under and code");
  assert.equal(stripMarkdown("* one\n  * two\n- three"), "- one\n  - two\n- three");
  assert.equal(stripMarkdown(`It works ${EM} mostly.`), "It works, mostly.");
  assert.equal(stripMarkdown(`From 9${EN}11.`), "From 9-11.");
  assert.equal(stripMarkdown(`Done ${EM}`), "Done,");
  assert.equal(stripMarkdown(`${EM} start`), ", start");
  assert.doesNotMatch(stripMarkdown(`a ${EM} b ${EN} c${EM}d`), /[\u2013\u2014]/);
});

test("splits long replies at a line break, never above the limit", () => {
  assert.deepEqual(splitMessage("short"), ["short"]);
  assert.deepEqual(splitMessage("  \n "), []);
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
  const parts = splitMessage(lines, 4000);
  assert.ok(parts.length > 1);
  for (const part of parts) assert.ok(part.length <= 4000);
  assert.ok(parts.slice(0, -1).every((part) => !part.endsWith("\n") && part.split("\n").every((l) => l.startsWith("line "))));
  assert.equal(parts.join("\n"), lines);
  const block = "y".repeat(9000);
  assert.deepEqual(
    splitMessage(block, 4000).map((p) => p.length),
    [4000, 4000, 1000],
  );
  const emoji = `${"z".repeat(3999)}\u{1F600}tail`;
  const [first, second] = splitMessage(emoji, 4000);
  assert.equal(first!.length, 3999);
  assert.ok(second!.startsWith("\u{1F600}"));
});

// --- Pending questions ---------------------------------------------------------

test("a pending question is answered within the hour, then expires", () => {
  const questions = new PendingQuestions(60 * 60 * 1000);
  assert.deepEqual(questions.peek(0), { status: "none" });
  const question = { decision: "rejected" as const, approvalId: 3, alert: null };
  questions.ask(question, 1_000);
  assert.deepEqual(questions.peek(1_000 + 59 * 60 * 1000), { status: "active", question });
  assert.deepEqual(questions.peek(1_000 + 60 * 60 * 1000 + 1), { status: "expired", question });
  assert.deepEqual(questions.peek(1_000 + 60 * 60 * 1000 + 2), { status: "none" });
  questions.ask(question, 0);
  questions.clear();
  assert.deepEqual(questions.peek(1), { status: "none" });
});

// --- Settings and assistant.json -------------------------------------------------

test("reads the assistant settings", () => {
  const settings = readSettings({
    HQ_TELEGRAM_BOT_TOKEN: "t",
    HQ_TELEGRAM_CHAT_ID: "42",
    HQ_TELEGRAM_POLLING: "TRUE",
    HQ_CHAT_MAX_BUDGET_USD: "",
  });
  assert.deepEqual(settings, {
    token: "t",
    chatId: "42",
    polling: true,
    apiBase: "https://api.telegram.org",
    chatMaxBudgetUsd: 0.5,
  });
  assert.equal(readSettings({}).polling, false);
  assert.equal(readSettings({ HQ_TELEGRAM_POLLING: "1" }).polling, false);
  assert.throws(() => readSettings({ HQ_TELEGRAM_CHAT_ID: "me" }), /HQ_TELEGRAM_CHAT_ID/);
});

test("extensions never see the Telegram variables nor the Claude token", () => {
  assert.deepEqual(
    extensionEnv({ PATH: "/bin", HQ_TELEGRAM_BOT_TOKEN: "t", HQ_TELEGRAM_CHAT_ID: "1", HQ_CLAUDE_OAUTH_TOKEN: "c", MY_KEY: "k" }),
    { PATH: "/bin", MY_KEY: "k" },
  );
});

test("validates assistant.json and resolves its paths from the home", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-assistant-"));
  assert.deepEqual(loadAssistantConfig(home), { chat: null, transcribe: null, dropDir: null, extensions: [] });
  fs.writeFileSync(
    path.join(home, "assistant.json"),
    JSON.stringify({
      chat: { cwd: "chat", addDirs: ["../vault"], allowedTools: ["Read"], permissionMode: "acceptEdits" },
      transcribe: "stt --lang fr {file}",
      dropDir: "../vault/inbox",
      extensions: ["assistant/commands/echo.ts"],
    }),
  );
  const config = loadAssistantConfig(home);
  assert.deepEqual(config.chat, {
    cwd: path.join(home, "chat"),
    systemPrompt: null,
    addDirs: [path.resolve(home, "../vault")],
    writeDirs: [],
    model: "sonnet",
    allowedTools: ["Read"],
    permissionMode: "acceptEdits",
    mcpServers: {},
    requestsDir: null,
    actions: [],
    trustedServers: [],
    untrustedTools: [],
    timeoutMs: 600_000,
    afterReply: null,
    historyTurns: 12,
    historyMaxChars: 8_000,
    resume: "cli",
    freshAfterMinutes: 60,
    preamble: null,
  });
  assert.equal(config.dropDir, path.resolve(home, "../vault/inbox"));
  assert.deepEqual(config.extensions, ["assistant/commands/echo.ts"]);

  fs.writeFileSync(path.join(home, "assistant.json"), JSON.stringify({ transcribe: "stt", other: 1 }));
  assert.throws(() => loadAssistantConfig(home), /transcribe: must contain \{file\}/);
  assert.throws(() => loadAssistantConfig(home), /"other"/);
  fs.writeFileSync(path.join(home, "assistant.json"), JSON.stringify({ chat: { cwd: ".", permissionMode: "bypassPermissions" } }));
  assert.throws(() => loadAssistantConfig(home), /chat\.permissionMode/);
  fs.writeFileSync(path.join(home, "assistant.json"), "{ nope");
  assert.throws(() => loadAssistantConfig(home), /not valid JSON/);
});

test("fills the transcription template with a quoted path", () => {
  assert.equal(fillTemplate("stt {file}", "C:\\a b\\v.oga", "win32"), 'stt "C:\\a b\\v.oga"');
  assert.equal(fillTemplate("stt {file} > /dev/null", "/a b/it's.oga", "linux"), "stt '/a b/it'\\''s.oga' > /dev/null");
});

// --- Chat ------------------------------------------------------------------------

const chat: ChatConfig = {
  cwd: "/h/chat",
  systemPrompt: null,
  addDirs: ["/h/vault", "/h/notes"],
  writeDirs: [],
  model: "sonnet",
  allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch"],
  permissionMode: "acceptEdits",
  mcpServers: {},
  requestsDir: null,
  actions: [],
  trustedServers: [],
  untrustedTools: [],
  timeoutMs: 600_000,
  afterReply: null,
  historyTurns: 12,
  historyMaxChars: 8_000,
  resume: "cli",
  freshAfterMinutes: 60,
  preamble: null,
};

test("builds the exact chat command line", () => {
  const expected = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "chat-argv.json"), "utf8")) as {
    continue: string[];
    fresh: string[];
  };
  assert.deepEqual(buildChatArgs(chat, { continue: true, maxBudgetUsd: 0.5 }), expected.continue);
  assert.deepEqual(buildChatArgs(chat, { continue: false, maxBudgetUsd: 0.5 }), expected.fresh);
  const bare = buildChatArgs({ ...chat, addDirs: [], allowedTools: [] }, { continue: false, maxBudgetUsd: 1 });
  assert.deepEqual(bare.slice(bare.indexOf("--tools"), bare.indexOf("--tools") + 3), ["--tools", "", "--disallowedTools"]);
});

test("the conversation's system prompt file of the home is passed explicitly", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-assistant-"));
  fs.writeFileSync(
    path.join(home, "assistant.json"),
    JSON.stringify({ chat: { cwd: "assistant/chat", systemPrompt: "assistant/chat/prompt.md" } }),
  );
  const config = loadAssistantConfig(home).chat!;
  assert.equal(config.systemPrompt, path.join(home, "assistant", "chat", "prompt.md"));
  const args = buildChatArgs({ ...chat, systemPrompt: "/h/chat/prompt.md" }, { continue: true, maxBudgetUsd: 0.5 });
  assert.deepEqual(args.slice(0, 9), [
    "-p",
    "--continue",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    "sonnet",
    "--system-prompt-file",
    "/h/chat/prompt.md",
  ]);
  assert.ok(!buildChatArgs(chat, { continue: false, maxBudgetUsd: 0.5 }).includes("--system-prompt-file"));
});

test("the chat environment is the agents' one, with tool search off and blocking MCP startup", () => {
  assert.deepEqual(chatEnv({ PATH: "/bin", HQ_TELEGRAM_BOT_TOKEN: "t", HQ_CLAUDE_OAUTH_TOKEN: "c", MYHQ_HOME: "x" }), {
    PATH: "/bin",
    CLAUDE_CODE_OAUTH_TOKEN: "c",
    ENABLE_TOOL_SEARCH: "false",
    MCP_CONNECTION_NONBLOCKING: "0",
    MCP_CONNECT_TIMEOUT_MS: "60000",
  });
});

const NO_USAGE = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

test("reads the chat output: answer, budget, error, nothing to continue", () => {
  assert.deepEqual(
    parseChatOutput(0, JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Hi", total_cost_usd: 0.02 }), ""),
    { ok: true, text: "Hi", costUsd: 0.02, model: null, usage: NO_USAGE, tools: [] },
  );
  assert.deepEqual(
    parseChatOutput(1, JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true, errors: ["Reached maximum budget ($0.01)"] }), ""),
    { ok: false, reason: "budget", detail: "error_max_budget_usd", costUsd: 0, model: null, usage: NO_USAGE, tools: [] },
  );
  assert.equal(parseChatOutput(1, "", "No conversation found to continue").ok, false);
  assert.equal((parseChatOutput(1, "", "No conversation found to continue") as { reason: string }).reason, "no_conversation");
  assert.equal((parseChatOutput(1, "", "boom") as { reason: string }).reason, "error");
});

test("retries without --continue when there is no conversation to continue", async () => {
  const seen: string[][] = [];
  const run: ChatRunner = async (params) => {
    seen.push(params.args);
    return params.args.includes("--continue")
      ? { ok: false, reason: "no_conversation", detail: "No conversation found to continue" }
      : { ok: true, text: "Fresh answer", costUsd: 0.01 };
  };
  const outcome = await askChat({ chat, text: "hello", continue: true, bin: "claude", env: {}, maxBudgetUsd: 0.5, run });
  assert.deepEqual(outcome, { ok: true, text: "Fresh answer", costUsd: 0.01, continued: false });
  assert.equal(seen.length, 2);
  assert.ok(seen[0]!.includes("--continue"));
  assert.ok(!seen[1]!.includes("--continue"));
});

test("assistant.json: chat.mcpServers and chat.requests, hq refused", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-assistant-"));
  const write = (chatConfig: unknown) =>
    fs.writeFileSync(path.join(home, "assistant.json"), JSON.stringify({ chat: { cwd: "chat", ...(chatConfig as object) } }));
  write({ mcpServers: { mail: { command: "node", args: ["m.js"] } }, requests: { dir: "chat/requests" } });
  const config = loadAssistantConfig(home).chat!;
  assert.deepEqual(config.mcpServers, { mail: { command: "node", args: ["m.js"] } });
  assert.equal(config.requestsDir, path.join(home, "chat", "requests"));
  write({ mcpServers: { hq: { command: "node" } } });
  assert.throws(() => loadAssistantConfig(home), /reserved/);
  write({ requests: {} });
  assert.throws(() => loadAssistantConfig(home), /chat\.requests\.dir/);
});

test("the chat gets an --mcp-config file with its expanded servers and per-chat variables", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-chat-mcp-"));
  const withMail: ChatConfig = {
    ...chat,
    allowedTools: ["Read", "mcp__mail__*"],
    mcpServers: {
      mail: {
        command: "node",
        args: ["mail.js", "--user", "${MAIL_USER}"],
        env: {
          MAIL_PASSWORD: "${HQ_EXT_MAIL_PASSWORD}",
          HQ_DB_PATH: "${HQ_DB_PATH}",
          HQ_ROOM: "${HQ_ROOM}",
          HQ_AGENT_ID: "${HQ_AGENT_ID}",
          HQ_RUN_ID: "${HQ_RUN_ID}",
        },
      },
    },
  };
  const mcp = { dir, dbPath: "/h/data/hq.db", appEnv: { MAIL_USER: "romain", HQ_EXT_MAIL_PASSWORD: "s3cret" } };
  let file = "";
  let content: { mcpServers: Record<string, { args: string[]; env: Record<string, string> }> } | null = null;
  let args: string[] = [];
  const run: ChatRunner = async (params) => {
    args = params.args;
    file = params.args[params.args.indexOf("--mcp-config") + 1]!;
    content = JSON.parse(fs.readFileSync(file, "utf8"));
    return { ok: true, text: "ok", costUsd: 0 };
  };
  await askChat({ chat: withMail, text: "hi", continue: false, bin: "claude", env: {}, maxBudgetUsd: 0.5, mcp, run });
  assert.equal(args[args.indexOf("--mcp-config") + 2], "--strict-mcp-config");
  const server = content!.mcpServers.mail!;
  assert.deepEqual(Object.keys(content!.mcpServers), ["mail"], "no hq server in the chat");
  assert.deepEqual(server.args, ["mail.js", "--user", "romain"]);
  assert.equal(server.env.MAIL_PASSWORD, "s3cret");
  assert.equal(server.env.HQ_DB_PATH, "/h/data/hq.db");
  assert.equal(server.env.HQ_ROOM, "_chat");
  assert.equal(server.env.HQ_AGENT_ID, "chat");
  assert.match(server.env.HQ_RUN_ID!, /^chat-\d+-\d+$/);
  assert.ok(args.includes("mcp__mail__*"));
  assert.ok(!fs.existsSync(file), "the file only lives for the turn");

  // A missing variable fails the turn with its name, and nothing is run.
  let ran = false;
  const outcome = await askChat({
    chat: withMail,
    text: "hi",
    continue: false,
    bin: "claude",
    env: {},
    maxBudgetUsd: 0.5,
    mcp: { ...mcp, appEnv: {} },
    run: async () => ((ran = true), { ok: true, text: "", costUsd: 0 }),
  });
  assert.equal(outcome.ok, false);
  assert.match((outcome as { detail: string }).detail, /MAIL_USER/);
  assert.equal(ran, false);

  // Without servers, no --mcp-config.
  const bare = buildChatArgs(chat, { continue: false, maxBudgetUsd: 0.5 });
  assert.ok(!bare.includes("--mcp-config"));
});

test("reads a stream-json chat turn: the full answer, the model, the usage and every tool called", () => {
  const lines = [
    { type: "system", subtype: "init", model: "claude-haiku-4-5", tools: ["Read"] },
    { type: "assistant", message: { content: [{ type: "text", text: "Je regarde." }, { type: "tool_use", id: "t1", name: "mcp__mail__mail_search", input: {} }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "3 mails" }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Read", input: {} }] } },
    "not json",
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "x".repeat(5000),
      total_cost_usd: 0.031,
      usage: { input_tokens: 12, output_tokens: 340, cache_creation_input_tokens: 9000, cache_read_input_tokens: 21000 },
    },
  ];
  const stdout = lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n");
  assert.deepEqual(parseChatOutput(0, stdout, ""), {
    ok: true,
    text: "x".repeat(5000),
    costUsd: 0.031,
    model: "claude-haiku-4-5",
    usage: { inputTokens: 12, outputTokens: 340, cacheCreationInputTokens: 9000, cacheReadInputTokens: 21000 },
    tools: ["mcp__mail__mail_search", "Read"],
  });
});
