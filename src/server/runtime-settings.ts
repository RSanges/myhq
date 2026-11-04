import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { isValidTimeZone } from "./time";

// Runtime settings that also exist as environment variables and are not
// secrets: `scheduler` (HQ_SCHEDULER), `timeZone` (HQ_TIMEZONE) and
// `maxRunsPerDay` (HQ_MAX_RUNS_PER_DAY). When `<home>/myhq.json` sets one, it
// wins over the variable; the variable stays the fallback. Each key is parsed
// apart, so that an invalid value never breaks the others nor the rest of the
// file. This module only needs the file system and zod (config.ts imports it).

/** `scheduler` of myhq.json: routines start runs on their own. */
export const schedulerSettingSchema = z.boolean();

/** `timeZone` of myhq.json: an IANA time zone such as Europe/Paris. */
export const timeZoneSettingSchema = z
  .string()
  .trim()
  .refine(isValidTimeZone, "an IANA time zone such as Europe/Paris");

/** `maxRunsPerDay` of myhq.json: runs per local day, all agents together (0 stops every run). */
export const maxRunsSettingSchema = z.number().int().min(0);

export const RUNTIME_KEYS = ["scheduler", "timeZone", "maxRunsPerDay"] as const;
export type RuntimeKey = (typeof RUNTIME_KEYS)[number];

export type RuntimeOverrides = { scheduler?: boolean; timeZone?: string; maxRunsPerDay?: number };

const keySchemas: Record<RuntimeKey, z.ZodType> = {
  scheduler: schedulerSettingSchema,
  timeZone: timeZoneSettingSchema,
  maxRunsPerDay: maxRunsSettingSchema,
};

/** The raw content of `<home>/myhq.json`: null when absent, an `error` when it is not a JSON object. */
export function readRawHomeFile(home: string): { data: Record<string, unknown> | null; error: string | null } {
  const file = path.join(home, "myhq.json");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { data: null, error: null };
    return { data: null, error: `myhq.json cannot be read: ${(error as Error).message}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { data: null, error: `myhq.json is not valid JSON: ${(error as Error).message}` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { data: null, error: "myhq.json must contain a JSON object" };
  }
  return { data: raw as Record<string, unknown>, error: null };
}

/**
 * The runtime overrides of the home. A key that is absent is not an
 * override; a key that is invalid is reported in `errors` and ignored (the
 * environment applies), without touching the other keys. Never throws.
 */
export function readRuntimeOverrides(home: string): { overrides: RuntimeOverrides; errors: string[] } {
  const { data, error } = readRawHomeFile(home);
  if (error) return { overrides: {}, errors: [error] };
  const overrides: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const key of RUNTIME_KEYS) {
    const value = data?.[key];
    if (value === undefined) continue;
    const parsed = keySchemas[key].safeParse(value);
    if (parsed.success) overrides[key] = parsed.data;
    else errors.push(`myhq.json ${key}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return { overrides: overrides as RuntimeOverrides, errors };
}
