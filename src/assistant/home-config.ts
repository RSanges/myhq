import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { MODELS, mcpServersSchema, type McpServerConfig } from "../server/rooms";
import { CHAT_ACTIONS, type ChatActionName } from "./actions";
import { DEFAULT_FRESH_AFTER_MINUTES } from "./chat-resume";
import { PREAMBLE_FIELDS, type PreambleConfig } from "./preamble";

const relativePath = z.string().trim().min(1);

/** Permission modes of `claude -p` the chat may use (never bypassPermissions). */
export const CHAT_PERMISSION_MODES = ["default", "acceptEdits", "plan", "dontAsk", "auto"] as const;

/** `chat.preamble`: the facts given before each message. */
const preambleSchema = z
  .strictObject({
    fields: z.array(z.enum(PREAMBLE_FIELDS)).default([...PREAMBLE_FIELDS]),
    /** Shell command run in the home; its stdout ends the preamble. */
    command: z.string().trim().min(1).optional(),
    /** Or a text file of the home (relative path) whose content ends it. */
    file: relativePath.optional(),
    maxChars: z.number().int().min(100).max(4_000).default(600),
    timeoutSeconds: z.number().positive().max(30).default(3),
  })
  .refine((p) => !(p.command && p.file), { message: "give command or file, not both", path: ["file"] });

const chatSchema = z.strictObject({
  cwd: relativePath,
  /** System prompt file of the conversation, passed with --system-prompt-file (relative to the home). */
  systemPrompt: relativePath.optional(),
  model: z.enum(MODELS).default("sonnet"),
  addDirs: z.array(relativePath).default([]),
  /** Folders outside `cwd` the chat may write (relative to the home); every other folder is read-only (write-guard.ts). */
  writeDirs: z.array(relativePath).default([]),
  allowedTools: z.array(z.string().min(1)).default([]),
  /**
   * Same shape and placeholders as `agents[].mcpServers` of room.json; never
   * `hq`. Each server may add `"untrusted": false` (default true): see actions.ts.
   */
  mcpServers: mcpServersSchema.default({}).superRefine((servers, ctx) => {
    for (const [name, server] of Object.entries(servers)) {
      const flag = (server as { untrusted?: unknown }).untrusted;
      if (flag !== undefined && typeof flag !== "boolean") {
        ctx.addIssue({ code: "custom", message: "must be true or false", path: [name, "untrusted"] });
      }
    }
  }),
  /** Where the chat leaves requests for the agents and actions for the core (relative to the home). */
  requests: z
    .strictObject({ dir: relativePath, actions: z.array(z.enum(CHAT_ACTIONS)).default([]) })
    .optional(),
  /** Tools whose results are untrusted, besides the web tools and the untrusted servers (`name` or `prefix*`). */
  untrustedTools: z.array(z.string().trim().min(1)).default([]),
  permissionMode: z.enum(CHAT_PERMISSION_MODES).default("default"),
  timeoutMinutes: z.number().positive().max(120).default(10),
  afterReply: z.string().trim().min(1).optional(),
  /** Exchanges of the conversation MyHQ gives back at the start of a turn (0: none). */
  historyTurns: z.number().int().min(0).max(100).default(12),
  /** Characters of that transcript, at most. */
  historyMaxChars: z.number().int().min(200).max(100_000).default(8_000),
  /** "cli": resume with --continue while the engine is Claude; "history": always a fresh turn with MyHQ's transcript. */
  resume: z.enum(["cli", "history"]).default("cli"),
  /**
   * Pause (minutes since the previous turn) after which a "cli" chat starts a
   * new conversation with MyHQ's transcript instead of resuming the CLI's: the
   * CLI's cache lasts an hour, so resuming later rewrites the whole conversation.
   */
  freshAfterMinutes: z.number().positive().max(10_080).default(DEFAULT_FRESH_AFTER_MINUTES),
  preamble: preambleSchema.optional(),
});

/** `<home>/assistant.json`. Every path is relative to the home (or absolute). */
export const assistantFileSchema = z.strictObject({
  chat: chatSchema.optional(),
  transcribe: z
    .string()
    .trim()
    .min(1)
    .refine((command) => command.includes("{file}"), "must contain {file}")
    .optional(),
  dropDir: relativePath.optional(),
  extensions: z.array(relativePath).default([]),
});

export type ChatConfig = {
  /** Absolute paths. */
  cwd: string;
  /** Absolute path of the system prompt file, or null (the CLI's default prompt). */
  systemPrompt: string | null;
  addDirs: string[];
  /** Absolute folders outside `cwd` that the chat may write (its write guard's `writeDirs`). */
  writeDirs: string[];
  model: (typeof MODELS)[number];
  allowedTools: string[];
  mcpServers: Record<string, McpServerConfig>;
  /** Absolute path of the directory the chat writes its requests to, or null. */
  requestsDir: string | null;
  /** Actions on the HQ the chat may ask for in that directory (none by default). */
  actions: ChatActionName[];
  /** MCP servers of the chat marked `"untrusted": false`. */
  trustedServers: string[];
  /** Extra untrusted tools (`chat.untrustedTools`). */
  untrustedTools: string[];
  permissionMode: (typeof CHAT_PERMISSION_MODES)[number];
  timeoutMs: number;
  afterReply: string | null;
  historyTurns: number;
  historyMaxChars: number;
  resume: "cli" | "history";
  /** Pause in minutes after which a "cli" chat starts a new conversation (see `chat.freshAfterMinutes`). */
  freshAfterMinutes: number;
  /** The facts given before each message, or null (none). */
  preamble: PreambleConfig | null;
};

export type AssistantConfig = {
  chat: ChatConfig | null;
  transcribe: string | null;
  /** Absolute path. */
  dropDir: string | null;
  /** As written in the file (relative to the home). */
  extensions: string[];
};

export const EMPTY_ASSISTANT_CONFIG: AssistantConfig = { chat: null, transcribe: null, dropDir: null, extensions: [] };

/**
 * Reads `<home>/assistant.json`. A missing file gives the empty configuration
 * (core commands and alerts only); an invalid one throws an explicit error.
 */
export function loadAssistantConfig(home: string): AssistantConfig {
  const file = path.join(home, "assistant.json");
  if (!fs.existsSync(file)) return EMPTY_ASSISTANT_CONFIG;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  const parsed = assistantFileSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`${file}: ${details}`);
  }
  const data = parsed.data;
  const resolve = (p: string) => path.resolve(home, p);
  return {
    chat: data.chat
      ? {
          cwd: resolve(data.chat.cwd),
          systemPrompt: data.chat.systemPrompt ? resolve(data.chat.systemPrompt) : null,
          addDirs: data.chat.addDirs.map(resolve),
          writeDirs: data.chat.writeDirs.map(resolve),
          model: data.chat.model,
          allowedTools: data.chat.allowedTools,
          // The flag is MyHQ's: it never reaches the CLI's MCP config.
          mcpServers: Object.fromEntries(
            Object.entries(data.chat.mcpServers).map(([name, server]) => {
              const copy = { ...server } as McpServerConfig & { untrusted?: boolean };
              delete copy.untrusted;
              return [name, copy];
            }),
          ),
          requestsDir: data.chat.requests ? resolve(data.chat.requests.dir) : null,
          actions: data.chat.requests?.actions ?? [],
          trustedServers: Object.entries(data.chat.mcpServers)
            .filter(([, server]) => (server as { untrusted?: boolean }).untrusted === false)
            .map(([name]) => name),
          untrustedTools: data.chat.untrustedTools,
          permissionMode: data.chat.permissionMode,
          timeoutMs: data.chat.timeoutMinutes * 60_000,
          afterReply: data.chat.afterReply ?? null,
          historyTurns: data.chat.historyTurns,
          historyMaxChars: data.chat.historyMaxChars,
          resume: data.chat.resume,
          freshAfterMinutes: data.chat.freshAfterMinutes,
          preamble: data.chat.preamble
            ? {
                fields: data.chat.preamble.fields,
                command: data.chat.preamble.command ?? null,
                file: data.chat.preamble.file ? resolve(data.chat.preamble.file) : null,
                maxChars: data.chat.preamble.maxChars,
                timeoutMs: data.chat.preamble.timeoutSeconds * 1000,
              }
            : null,
        }
      : null,
    transcribe: data.transcribe ?? null,
    dropDir: data.dropDir ? resolve(data.dropDir) : null,
    extensions: data.extensions,
  };
}
