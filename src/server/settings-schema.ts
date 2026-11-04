import { z } from "zod";
import { FLOOR_LAYOUTS } from "../ui/floor-mode";

// The shape of GET /api/settings (and of the response of every save), shared
// by the server (src/server/settings.ts) and the page. Pure: zod only.

const sourceSchema = z.enum(["file", "env", "default"]);

export const settingsViewSchema = z.object({
  layout: z.enum(FLOOR_LAYOUTS),
  language: z.object({
    value: z.string(),
    /** The languages the product has texts for, plus the current tag when it is another one. */
    options: z.array(z.string()),
  }),
  timeZone: z.object({
    /** The `timeZone` key of myhq.json, null when it is not set. */
    file: z.string().nullable(),
    /** The time zone in use. */
    effective: z.string(),
    /** Where `effective` comes from: the file, HQ_TIMEZONE, or the machine. */
    source: z.enum(["file", "env", "system"]),
    /** What applies without the file key. */
    fallback: z.string(),
  }),
  scheduler: z.object({
    file: z.boolean().nullable(),
    effective: z.boolean(),
    source: sourceSchema,
    fallback: z.boolean(),
    /** This process holds the lock and runs the routines now. */
    running: z.boolean(),
  }),
  maxRunsPerDay: z.object({
    file: z.number().nullable(),
    effective: z.number(),
    source: sourceSchema,
    fallback: z.number(),
  }),
  notifyTypes: z.object({
    selected: z.array(z.string()),
    /** Types seen in the database and in the roles of the home, not yet selected or not. */
    known: z.array(z.string()),
  }),
  /** `quietHours` of myhq.json, null when it is not set (or invalid, reported in `errors`). */
  quietHours: z.object({ start: z.string(), end: z.string() }).nullable(),
  rooms: z.array(
    z.object({
      name: z.string(),
      color: z.string().nullable(),
      shared: z.boolean(),
      agents: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          model: z.enum(["opus", "sonnet", "haiku"]),
          /** The armed state in force (the database wins over room.json). */
          armed: z.boolean(),
          hasRoutines: z.boolean(),
          maxBudgetUsd: z.number().nullable(),
          /** `notifyRuns: "summary"`. */
          notifySummary: z.boolean(),
        }),
      ),
    }),
  ),
  invalidRooms: z.array(z.object({ name: z.string(), error: z.string() })),
  /** --max-budget-usd of an agent that sets none (HQ_DEFAULT_MAX_BUDGET_USD). */
  defaultMaxBudgetUsd: z.number(),
  /** Problems found in myhq.json, one line each; the keys concerned fall back to their defaults. */
  errors: z.array(z.string()),
});

export type SettingsView = z.infer<typeof settingsViewSchema>;

export const settingsResponseSchema = z.object({ settings: settingsViewSchema });
