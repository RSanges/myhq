import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ZERO_USAGE, type Engine, type RunEvent, type RunInput, type Usage } from "./engine";
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

/** Command that starts the HQ MCP server, with absolute paths (the agent runs elsewhere). */
export function hqMcpServerCommand(repoRoot: string): { command: string; args: string[] } {
  const loader = path.join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs");
  return {
    command: process.execPath,
    args: ["--import", pathToFileURL(loader).href, path.join(repoRoot, "src", "mcp", "server.ts")],
  };
}

/** Writes the per-run `--mcp-config` file: the HQ server plus the agent's own servers. */
export function writeMcpConfig(params: {
  file: string;
  repoRoot: string;
  hqEnv: Record<string, string>;
  extraServers: Record<string, McpServerConfig>;
}): void {
  const hq = hqMcpServerCommand(params.repoRoot);
  const config = {
    mcpServers: {
      ...params.extraServers,
      hq: { type: "stdio", command: hq.command, args: hq.args, env: params.hqEnv },
    },
  };
  fs.mkdirSync(path.dirname(params.file), { recursive: true });
  fs.writeFileSync(params.file, JSON.stringify(config, null, 2));
}

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
  if (input.allowedTools.length > 0) args.push("--allowedTools", ...input.allowedTools);
  args.push("--disallowedTools", ...DENIED_TOOLS);
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
      env: input.env as NodeJS.ProcessEnv,
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
