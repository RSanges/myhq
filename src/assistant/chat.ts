import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { builtInTools, CLAUDE_ENV, DENIED_TOOLS, expandMcpServers, usageFrom } from "../server/claude-engine";
import type { Env } from "../server/config";
import type { Usage } from "../server/engine";
import { agentEnv } from "../server/runner";
import type { ChatConfig } from "./home-config";

/** Room and agent the chat's per-turn variables name (the chat is not an agent). */
export const CHAT_ROOM = "_chat";
export const CHAT_AGENT = "chat";

/**
 * The exact argument list of a chat turn. The message itself is written to
 * stdin. Same isolation as agent runs: only the whitelisted built-in tools
 * exist, only the MCP servers of `--mcp-config` (the chat's own, never `hq`;
 * none when the path is left out), no user settings, and the deploy commands
 * are denied. The output is the stream-json event stream, so that MyHQ sees
 * the tools a turn called (the confirmation guard of chat actions) and its
 * usage (the meter). The home's system prompt file, when there is one,
 * replaces the CLI's default prompt (`--system-prompt-file`).
 */
export function buildChatArgs(
  chat: ChatConfig,
  options: { continue: boolean; maxBudgetUsd: number; mcpConfigPath?: string },
): string[] {
  const args = ["-p"];
  if (options.continue) args.push("--continue");
  args.push("--output-format", "stream-json", "--verbose", "--model", chat.model);
  if (chat.systemPrompt) args.push("--system-prompt-file", chat.systemPrompt);
  for (const dir of chat.addDirs) args.push("--add-dir", dir);
  args.push("--permission-mode", chat.permissionMode, "--setting-sources", "project,local");
  if (options.mcpConfigPath) args.push("--mcp-config", options.mcpConfigPath);
  args.push("--strict-mcp-config");
  const tools = builtInTools(chat.allowedTools);
  args.push("--tools", ...(tools.length > 0 ? tools : [""]));
  if (chat.allowedTools.length > 0) args.push("--allowedTools", ...chat.allowedTools);
  args.push("--disallowedTools", ...DENIED_TOOLS);
  args.push("--max-budget-usd", String(options.maxBudgetUsd));
  return args;
}

/** Environment of the chat process: the agents' one, tool search off. */
export function chatEnv(base: Env): Env {
  return { ...agentEnv(base, {}), ...CLAUDE_ENV };
}

const resultSchema = z.looseObject({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  errors: z.array(z.string()).optional(),
  total_cost_usd: z.number().optional(),
  usage: z
    .looseObject({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
    })
    .optional(),
});

const initSchema = z.looseObject({ type: z.literal("system"), subtype: z.literal("init"), model: z.string().optional() });

const assistantSchema = z.looseObject({
  type: z.literal("assistant"),
  message: z.looseObject({
    content: z.array(z.looseObject({ type: z.string(), name: z.string().optional() })),
  }),
});

/** What a turn did, for the meter and the confirmation guard. Optional: a runner may not know it. */
export type ChatTurnInfo = {
  /** Model reported by the CLI, when it said. */
  model?: string | null;
  usage?: Usage;
  /** Names of the tools the turn called, in order (`Read`, `mcp__mail__mail_search`...). */
  tools?: string[];
};

export type ChatOutcome =
  | ({ ok: true; text: string; costUsd: number } & ChatTurnInfo)
  | ({ ok: false; reason: "no_conversation" | "budget" | "timeout" | "error"; detail: string; costUsd?: number } & ChatTurnInfo);

/**
 * Reads the output of a chat turn: the stream-json lines of
 * `claude -p --output-format stream-json --verbose` (the single result
 * object of `--output-format json` reads the same way).
 */
export function parseChatOutput(code: number | null, stdout: string, stderr: string): ChatOutcome {
  let model: string | null = null;
  const tools: string[] = [];
  let result: z.infer<typeof resultSchema> | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // Not JSON: the CLI stopped before answering (bad flag, no conversation...).
      continue;
    }
    const init = initSchema.safeParse(message);
    if (init.success) {
      model = init.data.model ?? null;
      continue;
    }
    const assistant = assistantSchema.safeParse(message);
    if (assistant.success) {
      for (const block of assistant.data.message.content) {
        if (block.type === "tool_use" && block.name) tools.push(block.name);
      }
      continue;
    }
    const parsed = resultSchema.safeParse(message);
    if (parsed.success) result = parsed.data;
  }
  if (result) {
    const r = result;
    const info = { model, usage: usageFrom(r.usage), tools, costUsd: r.total_cost_usd ?? 0 };
    if (r.subtype === "error_max_budget_usd") return { ok: false, reason: "budget", detail: r.subtype, ...info };
    if (r.is_error === true || r.subtype !== "success") {
      return { ok: false, reason: "error", detail: r.result ?? r.errors?.join("; ") ?? r.subtype, ...info };
    }
    return { ok: true, text: r.result ?? "", ...info };
  }
  const output = `${stdout}\n${stderr}`.trim();
  if (/no conversation/i.test(output)) return { ok: false, reason: "no_conversation", detail: output };
  return {
    ok: false,
    reason: "error",
    detail: output.slice(-1000) || `claude exited with code ${code} without an answer`,
  };
}

export type ChatRunner = (params: {
  bin: string;
  args: string[];
  cwd: string;
  env: Env;
  input: string;
  timeoutMs: number;
}) => Promise<ChatOutcome>;

/** Runs one `claude -p` chat turn. */
export const spawnChat: ChatRunner = (params) =>
  new Promise((resolve) => {
    const child = spawn(params.bin, params.args, {
      cwd: params.cwd,
      env: params.env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-4000)));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, params.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: "error", detail: `could not start "${params.bin}": ${error.message}` });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) resolve({ ok: false, reason: "timeout", detail: "timed out" });
      else resolve(parseChatOutput(code, stdout, stderr));
    });
    child.stdin.on("error", () => {
      // The process may exit before reading stdin; its exit code tells why.
    });
    child.stdin.end(params.input, "utf8");
  });

/** Where the per-turn MCP file goes, and what its placeholders are expanded from. */
export type ChatMcp = {
  /** Directory of the per-turn file (the file is deleted when the turn ends). */
  dir: string;
  /** HQ_DB_PATH of the per-chat variables. */
  dbPath: string;
  /** The app's own environment: `${NAME}` placeholders are expanded from it. */
  appEnv: Env;
};

let turnCounter = 0;

/**
 * Writes the per-turn `--mcp-config` file: the chat's servers with their
 * placeholders expanded from the app's environment and the per-chat variables
 * (HQ_DB_PATH, HQ_ROOM, HQ_AGENT_ID, HQ_RUN_ID = the turn id), which win.
 * Throws before writing anything when a variable is missing.
 */
export function writeChatMcpConfig(chat: ChatConfig, mcp: ChatMcp, turnId: string): string {
  const variables = { HQ_DB_PATH: mcp.dbPath, HQ_ROOM: CHAT_ROOM, HQ_AGENT_ID: CHAT_AGENT, HQ_RUN_ID: turnId };
  const servers = expandMcpServers(chat.mcpServers, { ...mcp.appEnv, ...variables });
  const file = path.join(mcp.dir, `${turnId}.mcp.json`);
  fs.mkdirSync(mcp.dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }, null, 2));
  return file;
}

/**
 * One chat turn with continuation: `--continue` unless the conversation was
 * reset, and a retry without it when the CLI says there is nothing to continue.
 */
export async function askChat(params: {
  chat: ChatConfig;
  text: string;
  continue: boolean;
  bin: string;
  env: Env;
  maxBudgetUsd: number;
  /** Needed for the chat's MCP servers; without it none is configured. */
  mcp?: ChatMcp;
  run?: ChatRunner;
}): Promise<ChatOutcome> {
  const run = params.run ?? spawnChat;
  let mcpConfigPath: string | undefined;
  if (params.mcp && Object.keys(params.chat.mcpServers).length > 0) {
    try {
      mcpConfigPath = writeChatMcpConfig(params.chat, params.mcp, `chat-${Date.now()}-${++turnCounter}`);
    } catch (error) {
      return { ok: false, reason: "error", detail: error instanceof Error ? error.message : String(error) };
    }
  }
  const attempt = (resume: boolean) =>
    run({
      bin: params.bin,
      args: buildChatArgs(params.chat, { continue: resume, maxBudgetUsd: params.maxBudgetUsd, mcpConfigPath }),
      cwd: params.chat.cwd,
      env: params.env,
      input: params.text,
      timeoutMs: params.chat.timeoutMs,
    });
  try {
    const first = await attempt(params.continue);
    if (params.continue && !first.ok && first.reason === "no_conversation") return await attempt(false);
    return first;
  } finally {
    // The file holds expanded secrets: it only lives for the turn.
    if (mcpConfigPath) fs.rmSync(mcpConfigPath, { force: true });
  }
}
