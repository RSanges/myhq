import { z } from "zod";
import { FLOOR_LAYOUTS } from "../ui/floor-mode";

// The shape of GET /api/settings (and of the response of every save), shared
// by the server (src/server/settings.ts) and the page. Pure: zod only.

const sourceSchema = z.enum(["file", "env", "default"]);

/** A runtime setting of myhq.json over its environment variable (runtime-settings.ts). */
const runtimeValue = <T extends z.ZodType>(value: T) =>
  z.object({ file: value.nullable(), effective: value, source: sourceSchema, fallback: value });

/** Totals of the week since Monday (local time), as usage.ts counts them. */
const weekSchema = z.object({ runs: z.number(), costUsd: z.number() });

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
      /** room.json `label`, null to show the name. */
      label: z.string().nullable(),
      color: z.string().nullable(),
      shared: z.boolean(),
      /** Paused from the settings page (room-manage.ts): its routines were disarmed at once. */
      state: z.enum(["active", "paused"]),
      pause: z.object({ armed: z.array(z.string()), pausedAt: z.string() }).nullable(),
      week: weekSchema,
      lastRun: z.object({ agent: z.string(), status: z.string(), at: z.string() }).nullable(),
      running: z.object({ agent: z.string(), since: z.string() }).nullable(),
      /** Items of the room, or addressed to it, that wait for a decision. */
      pending: z.number(),
      agents: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          model: z.enum(["opus", "sonnet", "haiku"]),
          /** The armed state in force (the database wins over room.json). */
          armed: z.boolean(),
          hasRoutines: z.boolean(),
          /** Its routines: the cron expression and its summary (cron.ts `describeCron`), for words. */
          routines: z.array(
            z.object({
              cron: z.string(),
              schedule: z.object({
                times: z.array(z.string()).nullable(),
                weekdays: z.array(z.number()).nullable(),
                monthDays: z.array(z.number()).nullable(),
                months: z.array(z.number()).nullable(),
                dayRule: z.enum(["or", "and"]),
              }),
            }),
          ),
          maxBudgetUsd: z.number().nullable(),
          /** `notifyRuns: "summary"`. */
          notifySummary: z.boolean(),
        }),
      ),
    }),
  ),
  invalidRooms: z.array(z.object({ name: z.string(), error: z.string() })),
  /** The rooms archived from the settings page (myhq.json `archivedRooms`), out of the floor. */
  archivedRooms: z.array(
    z.object({
      name: z.string(),
      label: z.string().nullable(),
      color: z.string().nullable(),
      archivedAt: z.string(),
      agents: z.number(),
      totalRuns: z.number(),
      totalCostUsd: z.number(),
    }),
  ),
  /** Room proposals of the receptionist waiting on the desk. */
  roomProposals: z.array(z.object({ id: z.number(), room: z.string().nullable(), title: z.string(), at: z.string() })),
  /** --max-budget-usd of an agent that sets none, in force (myhq.json over HQ_DEFAULT_MAX_BUDGET_USD). */
  defaultMaxBudgetUsd: z.number(),
  /** The budgets and run durations of myhq.json over their environment variables. */
  budgets: z.object({
    defaultMaxBudgetUsd: runtimeValue(z.number()),
    weeklyBudgetUsd: runtimeValue(z.number().nullable()),
    runTimeoutMinutes: runtimeValue(z.number()),
    runHardLimitMinutes: runtimeValue(z.number()),
  }),
  /** Runs started today (the daily cap counts them). */
  runsToday: z.number(),
  /** What the runs cost since Monday, by room (rooms without cost left out). */
  spend: z.object({
    totalUsd: z.number(),
    byRoom: z.array(z.object({ room: z.string(), label: z.string().nullable(), color: z.string().nullable(), costUsd: z.number() })),
  }),
  /** The run summaries (run-summary.ts): on or off (myhq.json `runSummaries`) and their calls over 7 days. */
  summaries: z.object({
    enabled: z.boolean(),
    source: z.enum(["file", "default"]),
    week: z.object({ calls: z.number(), costUsd: z.number() }),
  }),
  /** Whether each secret of the environment is set (never its value). */
  secrets: z.array(z.object({ name: z.string(), set: z.boolean() })),
  /** The cap on one attached file, in MB (HQ_ATTACHMENT_MAX_MB). */
  attachmentMaxMb: z.number(),
  /** The portier (myhq.json `portier`) and its latest verdicts, newest first. */
  portier: z.object({
    enabled: z.boolean(),
    model: z.string(),
    source: z.enum(["file", "default"]),
    week: z.object({ calls: z.number(), skips: z.number(), costUsd: z.number() }),
    verdicts: z.array(
      z.object({
        id: z.number(),
        room: z.string(),
        agent: z.string(),
        verdict: z.enum(["wake", "skip"]),
        reason: z.string(),
        model: z.string(),
        costUsd: z.number(),
        messages: z.number(),
        from: z.string().nullable(),
        excerpt: z.string(),
        failed: z.boolean(),
        at: z.string(),
      }),
    ),
  }),
  /** Problems found in myhq.json, one line each; the keys concerned fall back to their defaults. */
  errors: z.array(z.string()),
});

export type SettingsView = z.infer<typeof settingsViewSchema>;

export const settingsResponseSchema = z.object({ settings: settingsViewSchema });

/** GET /api/rooms/<room>/deletion: what deleting a room would do, and what blocks it now (room-manage.ts). */
export const deletionCheckSchema = z.object({
  room: z.string(),
  label: z.string().nullable(),
  archived: z.boolean(),
  running: z.object({ agent: z.string(), since: z.string() }).nullable(),
  pending: z.number(),
  workDirs: z.array(
    z.object({
      agent: z.string(),
      dir: z.string(),
      problem: z
        .discriminatedUnion("kind", [
          z.object({ kind: z.literal("dirty"), files: z.number() }),
          z.object({ kind: z.literal("unmerged"), commits: z.number(), branch: z.string() }),
          z.object({ kind: z.literal("unchecked"), detail: z.string() }),
        ])
        .nullable(),
      /** A working directory with its own repository: never inspected with Git, noted without blocking. */
      notice: z.object({ kind: z.literal("ownRepo"), gitdir: z.string() }).nullable(),
    }),
  ),
  blocked: z.array(z.enum(["running", "pending", "workDirs"])),
  configDir: z.string(),
  destination: z.string(),
  history: z.object({ runs: z.number(), costUsd: z.number(), items: z.number() }),
  agents: z.number(),
});

export type DeletionCheckView = z.infer<typeof deletionCheckSchema>;

export const deletionCheckResponseSchema = z.object({ check: deletionCheckSchema });
export const roomDeletedResponseSchema = z.object({ destination: z.string(), settings: settingsViewSchema });
