import { z } from "zod";
import type { Env } from "../server/config";

export const DEFAULT_TELEGRAM_API_BASE = "https://api.telegram.org";

const settingsSchema = z.object({
  HQ_TELEGRAM_BOT_TOKEN: z.string().trim().min(1).optional(),
  HQ_TELEGRAM_CHAT_ID: z
    .string()
    .trim()
    .regex(/^-?\d+$/, "a numeric Telegram chat id")
    .optional(),
  HQ_TELEGRAM_POLLING: z
    .string()
    .trim()
    .toLowerCase()
    .optional()
    .transform((value) => value === "true"),
  // For tests only: a fake server standing in for api.telegram.org.
  HQ_TELEGRAM_API_BASE: z.url().optional(),
  HQ_CHAT_MAX_BUDGET_USD: z.coerce.number().positive().default(0.5),
});

export type AssistantSettings = {
  token: string | null;
  chatId: string | null;
  /** True when HQ_TELEGRAM_POLLING=true: MyHQ is the bot's only reader. */
  polling: boolean;
  apiBase: string;
  chatMaxBudgetUsd: number;
};

function blankToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

/** Reads the assistant's variables. Throws an explicit error when one is invalid. */
export function readSettings(env: Env): AssistantSettings {
  const raw: Record<string, string | undefined> = {};
  for (const key of Object.keys(settingsSchema.shape)) raw[key] = blankToUndefined(env[key]);
  const parsed = settingsSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid assistant environment: ${details}`);
  }
  const vars = parsed.data;
  return {
    token: vars.HQ_TELEGRAM_BOT_TOKEN ?? null,
    chatId: vars.HQ_TELEGRAM_CHAT_ID ?? null,
    polling: vars.HQ_TELEGRAM_POLLING,
    apiBase: (vars.HQ_TELEGRAM_API_BASE ?? DEFAULT_TELEGRAM_API_BASE).replace(/\/+$/, ""),
    chatMaxBudgetUsd: vars.HQ_CHAT_MAX_BUDGET_USD,
  };
}

/** Polling flag only, for code that must never throw (alerts). */
export function pollingEnabled(env: Env): boolean {
  return env.HQ_TELEGRAM_POLLING?.trim().toLowerCase() === "true";
}

/**
 * Environment handed to extensions and to the home's shell commands
 * (transcription, afterReply): the app's environment without the Telegram
 * variables and without the Claude token, which only `claude -p` children get.
 */
export function extensionEnv(env: Env): Env {
  const out: Env = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^HQ_TELEGRAM_/i.test(key) || /^HQ_CLAUDE_OAUTH_TOKEN$/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}
