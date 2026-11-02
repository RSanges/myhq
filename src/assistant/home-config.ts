import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { MODELS } from "../server/rooms";

const relativePath = z.string().trim().min(1);

/** Permission modes of `claude -p` the chat may use (never bypassPermissions). */
export const CHAT_PERMISSION_MODES = ["default", "acceptEdits", "plan", "dontAsk", "auto"] as const;

const chatSchema = z.strictObject({
  cwd: relativePath,
  model: z.enum(MODELS).default("sonnet"),
  addDirs: z.array(relativePath).default([]),
  allowedTools: z.array(z.string().min(1)).default([]),
  permissionMode: z.enum(CHAT_PERMISSION_MODES).default("default"),
  timeoutMinutes: z.number().positive().max(120).default(10),
  afterReply: z.string().trim().min(1).optional(),
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
  addDirs: string[];
  model: (typeof MODELS)[number];
  allowedTools: string[];
  permissionMode: (typeof CHAT_PERMISSION_MODES)[number];
  timeoutMs: number;
  afterReply: string | null;
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
          addDirs: data.chat.addDirs.map(resolve),
          model: data.chat.model,
          allowedTools: data.chat.allowedTools,
          permissionMode: data.chat.permissionMode,
          timeoutMs: data.chat.timeoutMinutes * 60_000,
          afterReply: data.chat.afterReply ?? null,
        }
      : null,
    transcribe: data.transcribe ?? null,
    dropDir: data.dropDir ? resolve(data.dropDir) : null,
    extensions: data.extensions,
  };
}
