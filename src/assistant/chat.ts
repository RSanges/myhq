import { spawn } from "node:child_process";
import { z } from "zod";
import { builtInTools, CLAUDE_ENV, DENIED_TOOLS } from "../server/claude-engine";
import type { Env } from "../server/config";
import { agentEnv } from "../server/runner";
import type { ChatConfig } from "./home-config";

/**
 * The exact argument list of a chat turn. The message itself is written to
 * stdin. Same isolation as agent runs: only the whitelisted built-in tools
 * exist, no MCP server, no user settings, and the deploy commands are denied.
 */
export function buildChatArgs(chat: ChatConfig, options: { continue: boolean; maxBudgetUsd: number }): string[] {
  const args = ["-p"];
  if (options.continue) args.push("--continue");
  args.push("--output-format", "json", "--model", chat.model);
  for (const dir of chat.addDirs) args.push("--add-dir", dir);
  args.push("--permission-mode", chat.permissionMode, "--setting-sources", "project,local", "--strict-mcp-config");
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
});

export type ChatOutcome =
  | { ok: true; text: string; costUsd: number }
  | { ok: false; reason: "no_conversation" | "budget" | "timeout" | "error"; detail: string };

/** Reads the output of `claude -p --output-format json`. */
export function parseChatOutput(code: number | null, stdout: string, stderr: string): ChatOutcome {
  let message: unknown = null;
  try {
    message = JSON.parse(stdout.trim());
  } catch {
    // Not JSON: the CLI stopped before answering (bad flag, no conversation...).
  }
  const result = resultSchema.safeParse(message);
  if (result.success) {
    const r = result.data;
    if (r.subtype === "error_max_budget_usd") return { ok: false, reason: "budget", detail: r.subtype };
    if (r.is_error === true || r.subtype !== "success") {
      return { ok: false, reason: "error", detail: r.result ?? r.errors?.join("; ") ?? r.subtype };
    }
    return { ok: true, text: r.result ?? "", costUsd: r.total_cost_usd ?? 0 };
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
  run?: ChatRunner;
}): Promise<ChatOutcome> {
  const run = params.run ?? spawnChat;
  const attempt = (resume: boolean) =>
    run({
      bin: params.bin,
      args: buildChatArgs(params.chat, { continue: resume, maxBudgetUsd: params.maxBudgetUsd }),
      cwd: params.chat.cwd,
      env: params.env,
      input: params.text,
      timeoutMs: params.chat.timeoutMs,
    });
  const first = await attempt(params.continue);
  if (params.continue && !first.ok && first.reason === "no_conversation") return attempt(false);
  return first;
}
