import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { mcpBundleEntry } from "../mcp/bundle";
import { ZERO_USAGE, type Engine, type RunEvent, type RunInput, type Usage } from "./engine";
import type { Env } from "./config";
import { HqError } from "./errors";
import type { McpServerConfig } from "./rooms";

/** Denied to every agent, whatever its whitelist says. */
export const DENIED_TOOLS = [
  "Bash(vercel *)",
  "Bash(npx vercel *)",
  "Bash(eas submit *)",
  "Bash(npx eas submit *)",
  "Bash(npm run db:push *)",
  "Bash(pnpm db:push *)",
  "Bash(npx drizzle-kit push *)",
  "Bash(npx prisma db push *)",
] as const;

const TEXT_LIMIT = 4_000;
const TOOL_RESULT_LIMIT = 2_000;

export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}... [${text.length - limit} more characters]`;
}

const warnedSources = new Set<string>();

/**
 * Command that starts the HQ MCP server, with absolute paths (the agent runs elsewhere).
 *
 * It runs the frozen copy made by `npm run build` (build/mcp/server.mjs), so
 * that the code of the working directory, which an agent may be editing, never
 * runs against the database in service. Without that copy (development,
 * tests) it falls back to the sources and says so once per process, since in
 * production this means unreviewed code could run.
 */
export function hqMcpServerCommand(
  repoRoot: string,
  warn: (message: string) => void = (message) => console.warn(message),
): { command: string; args: string[] } {
  const bundle = mcpBundleEntry(repoRoot);
  if (fs.existsSync(bundle)) return { command: process.execPath, args: [bundle] };
  if (!warnedSources.has(bundle)) {
    warnedSources.add(bundle);
    warn(
      `[runner] WARNING: no frozen HQ MCP server at ${bundle}; agents will run the sources of ${repoRoot}, ` +
        "uncommitted changes included. Run `npm run build` (or `npm run build:mcp`) to freeze a copy.",
    );
  }
  const loader = path.join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs");
  return {
    command: process.execPath,
    args: ["--import", pathToFileURL(loader).href, path.join(repoRoot, "src", "mcp", "server.ts")],
  };
}

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Replaces every `${NAME}` of a string with the value of the variable `NAME`
 * of `env`. A variable that is missing or empty is an error naming it (never
 * an empty string); the error never carries any value.
 */
export function expandPlaceholders(text: string, env: Env, where: string): string {
  return text.replace(PLACEHOLDER, (_match, name: string) => {
    const value = env[name];
    if (value === undefined || value.trim() === "") {
      throw new HqError(
        "MCP_ENV_MISSING",
        422,
        `MCP server config: ${where} uses \${${name}}, but the environment variable ${name} is not set (see .env.local).`,
      );
    }
    return value;
  });
}

/**
 * Expands the placeholders of the `env` values and the `args` of the agent's
 * MCP servers. Nothing else is touched (command, url, headers...).
 */
export function expandMcpServers(
  servers: Record<string, McpServerConfig>,
  env: Env,
): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(servers)) {
    const copy: Record<string, unknown> = { ...server };
    if (Array.isArray(copy.args)) {
      copy.args = copy.args.map((arg, i) => expandPlaceholders(String(arg), env, `${name}.args[${i}]`));
    }
    if (copy.env && typeof copy.env === "object") {
      copy.env = Object.fromEntries(
        Object.entries(copy.env as Record<string, string>).map(([key, value]) => [
          key,
          expandPlaceholders(value, env, `${name}.env.${key}`),
        ]),
      );
    }
    out[name] = copy as McpServerConfig;
  }
  return out;
}

/**
 * Writes the per-run `--mcp-config` file: the HQ server plus the agent's own
 * servers, with their `${NAME}` placeholders expanded from `env` (the app's
 * environment) and from the run's own variables (`hqEnv`: HQ_DB_PATH,
 * HQ_RUN_ID, HQ_AGENT_ID, HQ_ROOM), which win. Throws before writing anything
 * when a variable is missing. The file is readable by its owner only, and the
 * runner deletes it as soon as the CLI has loaded it (removeMcpConfig).
 */
export function writeMcpConfig(params: {
  file: string;
  repoRoot: string;
  hqEnv: Record<string, string>;
  extraServers: Record<string, McpServerConfig>;
  env?: Env;
}): void {
  const hq = hqMcpServerCommand(params.repoRoot);
  const config = {
    mcpServers: {
      ...expandMcpServers(params.extraServers, { ...(params.env ?? process.env), ...params.hqEnv }),
      hq: { type: "stdio", command: hq.command, args: hq.args, env: params.hqEnv },
    },
  };
  fs.mkdirSync(path.dirname(params.file), { recursive: true });
  // The file holds expanded secrets: owner-only where the OS has such modes (a no-op on Windows).
  fs.rmSync(params.file, { force: true });
  fs.writeFileSync(params.file, JSON.stringify(config, null, 2), { mode: 0o600 });
}

/**
 * Deletes a per-run MCP config file. Never throws: a failure (a file still
 * held open on Windows) is left to the next call, and to the startup sweep.
 * Returns whether the file is gone.
 */
export function removeMcpConfig(file: string): boolean {
  try {
    fs.rmSync(file, { force: true });
    return !fs.existsSync(file);
  } catch {
    return false;
  }
}

/** Name of a per-run MCP config file: `<run id>.mcp.json`, nothing else. */
const RUN_MCP_CONFIG = /^\d+\.mcp\.json$/;

/**
 * Startup sweep: deletes the `<run id>.mcp.json` files that previous versions
 * (which kept them) or a crash left in the runs directory. Nothing else is
 * touched (the `.jsonl` logs, the chat's own files). Returns how many were
 * deleted.
 */
export function purgeLeftoverMcpConfigs(runsDir: string): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !RUN_MCP_CONFIG.test(entry.name)) continue;
    if (removeMcpConfig(path.join(runsDir, entry.name))) removed += 1;
  }
  return removed;
}

/**
 * Built-in tools named by an agent's whitelist (`Bash(git *)` gives `Bash`).
 * Passed to `--tools` so that nothing else is even available: without it,
 * Claude Code would still run read-only Bash commands for any agent.
 */
export function builtInTools(allowedTools: string[]): string[] {
  const names = allowedTools
    .filter((tool) => !tool.startsWith("mcp__"))
    .map((tool) => tool.replace(/\(.*$/, "").trim())
    .filter(Boolean);
  return [...new Set(names)];
}

/**
 * Environment additions for every run. Tool search is off so that the MCP
 * tools are in the tool list from the start (with it, a model must first look
 * them up, which smaller models fail to do). MCP startup is made blocking: by
 * default (CLI 2.1.183) `claude -p` connects the servers in the background and
 * sends the first request at once, so a server slower to start than the CLI
 * (a `tsx` server on a busy machine) is still `pending` and the agent works
 * without its tools. The wait is bounded by MCP_CONNECT_TIMEOUT_MS (5 s by
 * default), raised to 60 s: a server can take 15 to 25 s to answer `initialize` on a
 * loaded machine, and the one still pending after it is caught by the runner.
 */
export const CLAUDE_ENV = {
  ENABLE_TOOL_SEARCH: "false",
  MCP_CONNECTION_NONBLOCKING: "0",
  MCP_CONNECT_TIMEOUT_MS: "60000",
} as const;

/** The exact argument list given to `claude`. */
export function buildClaudeArgs(input: RunInput): string[] {
  const args = [
    "-p",
    input.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    input.model,
    "--append-system-prompt-file",
    input.rolePath,
    "--mcp-config",
    input.mcpConfigPath,
    "--strict-mcp-config",
    // Only project and local settings: the user's personal hooks and plugins
    // do not run inside agents.
    "--setting-sources",
    "project,local",
  ];
  for (const dir of input.addDirs ?? []) args.push("--add-dir", dir);
  const tools = input.tools ?? builtInTools(input.allowedTools);
  args.push("--tools", ...(tools.length > 0 ? tools : [""]));
  if (input.allowedTools.length > 0) args.push("--allowedTools", ...input.allowedTools);
  args.push("--disallowedTools", ...new Set([...DENIED_TOOLS, ...(input.disallowedTools ?? [])]));
  args.push("--max-budget-usd", String(input.maxBudgetUsd));
  return args;
}

// Shapes of the stream-json messages we read. Unknown fields are kept and
// ignored; unknown message types produce no event.
const usageSchema = z.looseObject({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
});

const initSchema = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("init"),
  session_id: z.string().optional(),
  model: z.string().optional(),
  tools: z.array(z.string()).optional(),
  mcp_servers: z.array(z.looseObject({ name: z.string(), status: z.string() })).optional(),
});

const assistantSchema = z.looseObject({
  type: z.literal("assistant"),
  message: z.looseObject({
    content: z.array(
      z.looseObject({
        type: z.string(),
        text: z.string().optional(),
        id: z.string().optional(),
        name: z.string().optional(),
        input: z.unknown().optional(),
      }),
    ),
  }),
});

const userSchema = z.looseObject({
  type: z.literal("user"),
  message: z.looseObject({
    content: z.union([
      z.string(),
      z.array(
        z.looseObject({
          type: z.string(),
          tool_use_id: z.string().optional(),
          is_error: z.boolean().optional(),
          content: z.unknown().optional(),
        }),
      ),
    ]),
  }),
});

const resultSchema = z.looseObject({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  errors: z.array(z.string()).optional(),
  total_cost_usd: z.number().optional(),
  usage: usageSchema.optional(),
});

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && "text" in part && typeof part.text === "string"
          ? part.text
          : JSON.stringify(part),
      )
      .join("\n");
  }
  return content === undefined ? "" : JSON.stringify(content);
}

export function usageFrom(raw: z.infer<typeof usageSchema> | undefined): Usage {
  if (!raw) return { ...ZERO_USAGE };
  return {
    inputTokens: raw.input_tokens ?? 0,
    outputTokens: raw.output_tokens ?? 0,
    cacheCreationInputTokens: raw.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: raw.cache_read_input_tokens ?? 0,
  };
}

/** Turns one line of `claude -p --output-format stream-json` into run events. */
export function parseStreamLine(line: string): RunEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let message: unknown;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return [];
  }

  const init = initSchema.safeParse(message);
  if (init.success) {
    return [
      {
        type: "start",
        sessionId: init.data.session_id ?? null,
        model: init.data.model ?? null,
        tools: init.data.tools ?? [],
        mcpServers: (init.data.mcp_servers ?? []).map((s) => ({ name: s.name, status: s.status })),
      },
    ];
  }

  const assistant = assistantSchema.safeParse(message);
  if (assistant.success) {
    const events: RunEvent[] = [];
    for (const block of assistant.data.message.content) {
      if (block.type === "text" && block.text?.trim()) {
        events.push({ type: "text", text: truncate(block.text, TEXT_LIMIT) });
      } else if (block.type === "tool_use" && block.id && block.name) {
        events.push({ type: "tool_call", id: block.id, name: block.name, input: block.input ?? {} });
      }
    }
    return events;
  }

  const user = userSchema.safeParse(message);
  if (user.success) {
    const content = user.data.message.content;
    if (typeof content === "string") return [];
    return content
      .filter((block) => block.type === "tool_result" && block.tool_use_id)
      .map((block) => ({
        type: "tool_result" as const,
        toolUseId: block.tool_use_id as string,
        isError: block.is_error ?? false,
        content: truncate(toolResultText(block.content), TOOL_RESULT_LIMIT),
      }));
  }

  const result = resultSchema.safeParse(message);
  if (result.success) {
    const failed = result.data.is_error === true || result.data.subtype !== "success";
    const detail = result.data.result ?? result.data.errors?.join("; ") ?? "";
    return [
      {
        type: "end",
        status: failed ? "failed" : "done",
        reason: result.data.subtype,
        summary: truncate(detail || result.data.subtype, TEXT_LIMIT),
        usage: usageFrom(result.data.usage),
        costUsd: result.data.total_cost_usd ?? 0,
      },
    ];
  }

  return [];
}

/** Runs an agent with the official Claude Code binary in print mode. */
export class ClaudeEngine implements Engine {
  readonly name = "claude" as const;

  constructor(private readonly bin: string) {}

  async *run(input: RunInput): AsyncIterable<RunEvent> {
    const child = spawn(this.bin, buildClaudeArgs(input), {
      cwd: input.workDir,
      env: { ...input.env, ...CLAUDE_ENV } as unknown as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const kill = () => child.kill();
    if (input.signal.aborted) kill();
    input.signal.addEventListener("abort", kill, { once: true });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-TEXT_LIMIT);
    });
    const exited = new Promise<{ code: number | null; error: Error | null }>((resolve) => {
      child.once("error", (error) => resolve({ code: null, error }));
      child.once("close", (code) => resolve({ code, error: null }));
    });

    let ended = false;
    try {
      const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      for await (const line of lines) {
        input.onRawLine?.(line);
        for (const event of parseStreamLine(line)) {
          if (event.type === "end") ended = true;
          yield event;
        }
      }
      const { code, error } = await exited;
      if (!ended) {
        const why = error
          ? `could not start "${this.bin}": ${error.message}`
          : input.signal.aborted
            ? "run aborted"
            : `claude exited with code ${code} without a result`;
        yield {
          type: "end",
          status: "failed",
          reason: error ? "spawn_error" : input.signal.aborted ? "aborted" : "no_result",
          summary: truncate([why, stderr.trim()].filter(Boolean).join("\n"), TEXT_LIMIT),
          usage: { ...ZERO_USAGE },
          costUsd: 0,
        };
      }
    } finally {
      input.signal.removeEventListener("abort", kill);
      if (child.exitCode === null && !child.killed) child.kill();
    }
  }
}
