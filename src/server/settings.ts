import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { FLOOR_LAYOUTS } from "../ui/floor-mode";
import { liveConfig, type Env, type HqConfig } from "./config";
import type { Db } from "./db";
import { describeCron, parseCron } from "./cron";
import { HqError } from "./errors";
import { readHomeFileForWrite, writeHomeKeys, writeJsonAtomic } from "./home-file";
import { attachmentMaxBytes } from "./attachments";
import {
  approvalTypeSchema,
  DEFAULT_LANGUAGE,
  DEFAULT_PORTIER,
  languageTagSchema,
  readArchivedRooms,
  readFloorLayout,
  readPortierSetting,
  readRunSummariesSetting,
} from "./home-settings";
import { roomPauses } from "./room-manage";
import { runsToday } from "./runner";
import { roomWeekTotals } from "./usage";
import { recentVerdicts } from "./portier";
import { machineView } from "./machine";
import { readDoorConfig, recentDoorRequests } from "./door";
import { idSchema, loadHome, MODELS, roomColorSchema, roomFileSchema, roomLabelSchema, type Home, type Room } from "./rooms";
import {
  budgetSettingSchema,
  maxRunsSettingSchema,
  minutesSettingSchema,
  readRawHomeFile,
  readRuntimeOverrides,
  schedulerSettingSchema,
  timeZoneSettingSchema,
} from "./runtime-settings";
import { quietHoursSchema, readQuietHours } from "./quiet-hours";
import { isArmed, reconcileScheduler, schedulerRunning, setArmed } from "./routines";
import type { SettingsView } from "./settings-schema";

// The settings page (/reglages): reading the settings of the home as one
// view, and writing them back. The files stay the source of truth, so that
// editing them by hand keeps working: `<home>/myhq.json` for the home,
// `rooms/<room>/room.json` for rooms and agents, the database for the armed
// state. Every write is validated with zod first, goes through a temporary
// file and a rename, keeps the keys it does not know, and uses 2-space JSON.

/** Languages the product has texts for (see docs/home-layout.md, `language`). */
export const LANGUAGES = ["fr", "en"] as const;

/** Approval types the core handles itself: never informational. */
const CORE_TYPES = new Set(["room_proposal", "agent_proposal"]);

// --- Inputs ------------------------------------------------------------------

/** « Disposition et langue »: `floor.layout`, `language`, `timeZone` (null: back to HQ_TIMEZONE). */
export const layoutInputSchema = z.strictObject({
  layout: z.enum(FLOOR_LAYOUTS),
  language: languageTagSchema,
  timeZone: timeZoneSettingSchema.nullable(),
});

/**
 * « Limites et coûts »: `scheduler`, `maxRunsPerDay`, the budgets and the run
 * durations (null: back to the environment; left out: unchanged), and the
 * small model calls outside runs (`portier.enabled`, `runSummaries.enabled`).
 */
export const limitsInputSchema = z.strictObject({
  scheduler: schedulerSettingSchema.nullable(),
  maxRunsPerDay: maxRunsSettingSchema.nullable(),
  defaultMaxBudgetUsd: budgetSettingSchema.nullable().optional(),
  weeklyBudgetUsd: budgetSettingSchema.nullable().optional(),
  runTimeoutMinutes: minutesSettingSchema.nullable().optional(),
  runHardLimitMinutes: minutesSettingSchema.nullable().optional(),
  portier: z.boolean().optional(),
  runSummaries: z.boolean().optional(),
});

/**
 * « Notifications »: `notifyTypes`, `notifyRuns` of the agents named (`summary`
 * false removes it), and `quietHours` (null removes it, absent keeps it).
 */
export const notificationsInputSchema = z.strictObject({
  notifyTypes: z.array(approvalTypeSchema).max(200),
  quietHours: quietHoursSchema.nullable().optional(),
  summaries: z
    .array(z.strictObject({ room: idSchema, agent: idSchema, summary: z.boolean() }))
    .max(1000)
    .default([]),
});

/** « Salles et agents »: colour of each room, model, armed state and budget of each agent. */
export const roomsInputSchema = z.strictObject({
  rooms: z
    .array(
      z.strictObject({
        name: idSchema,
        /** The name shown to the owner, null to show `name`; left out, unchanged. */
        label: roomLabelSchema.nullable().optional(),
        /** A CSS hex colour, null for the neutral look. */
        color: roomColorSchema.nullable(),
        agents: z
          .array(
            z.strictObject({
              id: idSchema,
              model: z.enum(MODELS),
              armed: z.boolean(),
              /** --max-budget-usd of each run, null to fall back to HQ_DEFAULT_MAX_BUDGET_USD. */
              maxBudgetUsd: z.number().positive().max(10_000).nullable(),
            }),
          )
          .max(200),
      }),
    )
    .max(200),
});

export type LayoutInput = z.infer<typeof layoutInputSchema>;
export type LimitsInput = z.infer<typeof limitsInputSchema>;
export type NotificationsInput = z.infer<typeof notificationsInputSchema>;
export type RoomsInput = z.infer<typeof roomsInputSchema>;

/** The groups of the page, as they appear in `PUT /api/settings/<group>`. */
export const SETTINGS_GROUPS = {
  layout: layoutInputSchema,
  limits: limitsInputSchema,
  notifications: notificationsInputSchema,
  rooms: roomsInputSchema,
} as const;
export type SettingsGroup = keyof typeof SETTINGS_GROUPS;

// --- Files -------------------------------------------------------------------

export { writeJsonAtomic, writeHomeKeys } from "./home-file";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// --- Groups ------------------------------------------------------------------

export function saveLayout(config: HqConfig, input: LayoutInput): void {
  const { data } = readHomeFileForWrite(config.home);
  // Unknown keys of an existing `floor` block stay.
  const floor = isRecord(data.floor) ? { ...data.floor, layout: input.layout } : { layout: input.layout };
  writeHomeKeys(config.home, { floor, language: input.language, timeZone: input.timeZone ?? undefined });
}

export function saveLimits(config: HqConfig, input: LimitsInput): void {
  const { data } = readHomeFileForWrite(config.home);
  const fromEnv = liveConfig(config).fromEnv;
  // The soft deadline must come before the hard limit, as they will be in force. Only checked when the
  // save changes one of them: a switch of the same tab never fails on durations the owner did not touch.
  type Duration = "runTimeoutMinutes" | "runHardLimitMinutes";
  const kept = (key: Duration): number | undefined => {
    const parsed = minutesSettingSchema.safeParse(data[key]);
    return parsed.success ? parsed.data : undefined;
  };
  /** The value the file will hold for `key` after the save, undefined when none. */
  const after = (key: Duration): number | undefined => (input[key] !== undefined ? (input[key] ?? undefined) : kept(key));
  const touched = (key: Duration) => after(key) !== kept(key);
  if (touched("runTimeoutMinutes") || touched("runHardLimitMinutes")) {
    const timeout = after("runTimeoutMinutes") ?? fromEnv.runTimeoutMs / 60_000;
    const hard = after("runHardLimitMinutes") ?? fromEnv.runHardLimitMs / 60_000;
    if (timeout >= hard) throw new HqError("INVALID_INPUT", 400, "runTimeoutMinutes must be shorter than runHardLimitMinutes.");
  }
  const changes: Record<string, unknown> = {
    scheduler: input.scheduler ?? undefined,
    maxRunsPerDay: input.maxRunsPerDay ?? undefined,
  };
  for (const key of ["defaultMaxBudgetUsd", "weeklyBudgetUsd", "runTimeoutMinutes", "runHardLimitMinutes"] as const) {
    if (input[key] !== undefined) changes[key] = input[key] ?? undefined;
  }
  // The switches keep the other keys of their block (the portier's model).
  const portier = readPortierSetting(config.home, config.portier ?? DEFAULT_PORTIER);
  if (input.portier !== undefined && (portier.fromFile || input.portier !== portier.setting.enabled)) {
    changes.portier = { ...(isRecord(data.portier) ? data.portier : {}), enabled: input.portier };
  }
  const summaries = readRunSummariesSetting(config.home);
  if (input.runSummaries !== undefined && (summaries.fromFile || input.runSummaries !== summaries.enabled)) {
    changes.runSummaries = { ...(isRecord(data.runSummaries) ? data.runSummaries : {}), enabled: input.runSummaries };
  }
  writeHomeKeys(config.home, changes);
  // The scheduler starts or stops now, without waiting for its next tick.
  reconcileScheduler();
}

type AgentEdit = { model?: (typeof MODELS)[number]; maxBudgetUsd?: number | null; notifySummary?: boolean };
type RoomEdit = { color?: string | null; label?: string | null; agents: Map<string, AgentEdit> };

/**
 * Applies edits to the room.json files. Everything is checked first (the
 * room and agent exist, the result still passes the room schema); only then
 * are the files written, each one atomically.
 */
function editRooms(home: Home, edits: Map<string, RoomEdit>): void {
  const writes: { file: string; value: unknown }[] = [];
  for (const [name, edit] of edits) {
    const room = home.rooms.find((each) => each.name === name);
    if (!room) {
      const invalid = home.invalid.find((each) => path.basename(each.dir) === name);
      if (invalid) throw new HqError("ROOM_INVALID", 422, invalid.error);
      throw new HqError("ROOM_NOT_FOUND", 404, `Room "${name}" does not exist.`);
    }
    const file = path.join(room.dir, "room.json");
    const before = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const raw = JSON.parse(JSON.stringify(before)) as Record<string, unknown>;
    const agents = Array.isArray(raw.agents) ? (raw.agents as Record<string, unknown>[]) : [];
    if (edit.color !== undefined) {
      if (edit.color === null) delete raw.color;
      else raw.color = edit.color.toLowerCase();
    }
    if (edit.label !== undefined) {
      if (edit.label === null) delete raw.label;
      else raw.label = edit.label;
    }
    for (const [id, change] of edit.agents) {
      const agent = agents.find((each) => each.id === id);
      if (!agent) throw new HqError("AGENT_NOT_FOUND", 404, `Room "${name}" has no agent "${id}".`);
      if (change.model !== undefined) agent.model = change.model;
      if (change.maxBudgetUsd !== undefined) {
        if (change.maxBudgetUsd === null) delete agent.maxBudgetUsd;
        else agent.maxBudgetUsd = change.maxBudgetUsd;
      }
      if (change.notifySummary !== undefined) {
        if (change.notifySummary) agent.notifyRuns = "summary";
        else delete agent.notifyRuns;
      }
    }
    const checked = roomFileSchema.safeParse(raw);
    if (!checked.success) {
      const details = checked.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
      throw new HqError("ROOM_INVALID", 422, `${file}: ${details}`);
    }
    if (JSON.stringify(before) !== JSON.stringify(raw)) writes.push({ file, value: raw });
  }
  for (const write of writes) writeJsonAtomic(write.file, write.value);
}

export function saveNotifications(config: HqConfig, input: NotificationsInput): void {
  readHomeFileForWrite(config.home); // refuses an unreadable myhq.json before anything is written
  const edits = new Map<string, RoomEdit>();
  for (const { room, agent, summary } of input.summaries) {
    const edit = edits.get(room) ?? { agents: new Map<string, AgentEdit>() };
    edit.agents.set(agent, { ...edit.agents.get(agent), notifySummary: summary });
    edits.set(room, edit);
  }
  editRooms(loadHome(config.home), edits);
  const types = [...new Set(input.notifyTypes)];
  writeHomeKeys(config.home, {
    notifyTypes: types.length > 0 ? types : undefined,
    ...(input.quietHours !== undefined ? { quietHours: input.quietHours ?? undefined } : {}),
  });
}

export function saveRooms(config: HqConfig, db: Db, input: RoomsInput): void {
  const home = loadHome(config.home);
  const edits = new Map<string, RoomEdit>();
  const arming: { room: string; agent: string; armed: boolean }[] = [];
  for (const sent of input.rooms) {
    const room = home.rooms.find((each) => each.name === sent.name);
    // An unknown or invalid room is refused by editRooms with the right code.
    const edit: RoomEdit = { agents: new Map() };
    if (!room || room.color?.toLowerCase() !== sent.color?.toLowerCase()) edit.color = sent.color;
    if (sent.label !== undefined && (!room || (room.label ?? null) !== sent.label)) edit.label = sent.label;
    for (const agent of sent.agents) {
      const current = room?.agents.find((each) => each.id === agent.id);
      const change: AgentEdit = {};
      if (!current || current.model !== agent.model) change.model = agent.model;
      if (!current || current.maxBudgetUsd !== agent.maxBudgetUsd) change.maxBudgetUsd = agent.maxBudgetUsd;
      if (Object.keys(change).length > 0) edit.agents.set(agent.id, change);
      if (room && current && isArmed(db, room.name, current) !== agent.armed) {
        arming.push({ room: sent.name, agent: agent.id, armed: agent.armed });
      }
    }
    if (edit.color !== undefined || edit.label !== undefined || edit.agents.size > 0) edits.set(sent.name, edit);
  }
  editRooms(home, edits);
  // The existing arming mechanism: the database value wins over room.json.
  for (const { room, agent, armed } of arming) setArmed(config, db, room, agent, armed);
}

/** Validates and saves one group; the caller reads the view again. */
export function saveSettings(config: HqConfig, db: Db, group: SettingsGroup, body: unknown): void {
  switch (group) {
    case "layout":
      return saveLayout(config, layoutInputSchema.parse(body));
    case "limits":
      return saveLimits(config, limitsInputSchema.parse(body));
    case "notifications":
      return saveNotifications(config, notificationsInputSchema.parse(body));
    case "rooms":
      return saveRooms(config, db, roomsInputSchema.parse(body));
  }
}

// --- The view ----------------------------------------------------------------

const present = (value: string | undefined): boolean => value !== undefined && value.trim() !== "";

/** The secrets of .env.local the page says are set or not (never their value). */
const SECRET_VARIABLES = ["HQ_TELEGRAM_BOT_TOKEN", "HQ_TELEGRAM_CHAT_ID", "HQ_CLAUDE_OAUTH_TOKEN", "HQ_TRIGGER_TOKEN"] as const;

/** Types an agent's role says it submits: the bullets « - `type`: ... » under a heading that names `hq_submit`. */
function submittedTypes(room: Room): string[] {
  const found: string[] = [];
  for (const agent of room.agents) {
    let text: string;
    try {
      text = fs.readFileSync(agent.rolePath, "utf8");
    } catch {
      continue;
    }
    let inSection = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^#{1,6}\s/.test(line)) inSection = /hq_submit/.test(line);
      else if (inSection) {
        const type = /^\s*[-*]\s+`([a-z][a-z0-9_]*)`/.exec(line)?.[1];
        if (type && approvalTypeSchema.safeParse(type).success) found.push(type);
      }
    }
  }
  return found;
}

/** The approval types seen in the database and in the roles of the home, never the core ones. */
function knownApprovalTypes(db: Db, home: Home): string[] {
  const types = new Set<string>();
  for (const row of db.prepare("SELECT DISTINCT type FROM approvals").all() as { type: string }[]) types.add(row.type);
  for (const room of home.rooms) for (const type of submittedTypes(room)) types.add(type);
  for (const type of CORE_TYPES) types.delete(type);
  return [...types].filter((type) => approvalTypeSchema.safeParse(type).success).sort();
}

const issues = (error: z.ZodError): string => error.issues.map((issue) => issue.message).join("; ");

/**
 * Everything the page shows, read fresh: myhq.json key by key (an invalid key
 * is reported in `errors` and shown with its fallback), the rooms, the armed
 * state in force and the scheduler.
 */
export function buildSettingsView(config: HqConfig, db: Db, env: Env = process.env): SettingsView {
  const live = liveConfig(config);
  const fromEnv = live.fromEnv;
  const errors: string[] = [];
  const raw = readRawHomeFile(live.home);
  if (raw.error) errors.push(raw.error);
  const data = raw.data ?? {};

  const floor = readFloorLayout(live.home);
  if (floor.error && !raw.error) errors.push(floor.error);

  let language = DEFAULT_LANGUAGE;
  if (data.language !== undefined) {
    const parsed = languageTagSchema.safeParse(data.language);
    if (parsed.success) language = parsed.data;
    else errors.push(`myhq.json language: ${issues(parsed.error)}`);
  }
  const languages: string[] = [...LANGUAGES];
  if (!languages.includes(language)) languages.push(language);

  const { overrides, errors: runtimeErrors } = readRuntimeOverrides(live.home);
  if (!raw.error) errors.push(...runtimeErrors);
  if (live.durationsError) errors.push(`myhq.json runTimeoutMinutes, runHardLimitMinutes: ${live.durationsError}`);

  let selected: string[] = [];
  if (data.notifyTypes !== undefined) {
    const parsed = z.array(approvalTypeSchema).safeParse(data.notifyTypes);
    if (parsed.success) selected = parsed.data;
    else errors.push(`myhq.json notifyTypes: ${issues(parsed.error)}`);
  }

  const quiet = readQuietHours(live.home);
  if (quiet.error && !raw.error) errors.push(quiet.error);

  const home = loadHome(live.home);
  const known = knownApprovalTypes(db, home).filter((type) => !selected.includes(type));

  const portier = readPortierSetting(live.home, config.portier ?? DEFAULT_PORTIER);
  if (portier.error && !raw.error) errors.push(portier.error);
  const verdicts = recentVerdicts(db);
  let doorOpen = false;
  try {
    doorOpen = readDoorConfig(live.home) !== null;
  } catch (error) {
    errors.push((error as Error).message);
  }
  const door = recentDoorRequests(db);
  const summaries = readRunSummariesSetting(live.home);
  if (summaries.error && !raw.error) errors.push(summaries.error);
  const archivedList = readArchivedRooms(live.home);
  if (archivedList.error && !raw.error) errors.push(archivedList.error);
  const { error: machineError, ...machine } = machineView(
    db,
    live,
    home.rooms.flatMap((room) => room.agents.map((agent) => ({ room: room.name, agent }))),
  );
  if (machineError && !raw.error) errors.push(machineError);

  const pauses = roomPauses(db);
  const weeks = roomWeekTotals(db);
  const lastRun = db.prepare("SELECT agent_id, status, started_at, ended_at FROM runs WHERE room = ? ORDER BY id DESC LIMIT 1");
  const running = db.prepare("SELECT agent_id, started_at FROM runs WHERE room = ? AND status = 'running' ORDER BY id DESC LIMIT 1");
  const pending = db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending' AND (room = ? OR for_room = ?)");
  const totals = db.prepare("SELECT COUNT(*) AS runs, COALESCE(SUM(cost_usd), 0) AS costUsd FROM runs WHERE room = ?");
  const runtime = (key: "defaultMaxBudgetUsd" | "weeklyBudgetUsd" | "runTimeoutMinutes" | "runHardLimitMinutes", variable: string) =>
    overrides[key] !== undefined ? ("file" as const) : present(env[variable]) ? ("env" as const) : ("default" as const);
  const minutes = (ms: number) => ms / 60_000;
  const summaryWeek = db
    .prepare("SELECT COUNT(*) AS calls, COALESCE(SUM(cost_usd), 0) AS costUsd FROM run_summaries WHERE created_at >= ?")
    .get(new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString()) as { calls: number; costUsd: number };
  const proposals = (
    db
      .prepare("SELECT id, title, payload, created_at FROM approvals WHERE type = 'room_proposal' AND status = 'pending' ORDER BY id")
      .all() as { id: number; title: string; payload: string; created_at: string }[]
  ).map((row) => {
    let room: string | null = null;
    try {
      const parsed = idSchema.safeParse((JSON.parse(row.payload) as { room?: { name?: unknown } }).room?.name);
      if (parsed.success) room = parsed.data;
    } catch {
      // The title says what it is.
    }
    return { id: row.id, room, title: row.title, at: row.created_at };
  });

  return {
    layout: floor.layout,
    language: { value: language, options: languages },
    timeZone: {
      file: overrides.timeZone ?? null,
      effective: live.timeZone,
      source: overrides.timeZone !== undefined ? "file" : present(env.HQ_TIMEZONE) ? "env" : "system",
      fallback: fromEnv.timeZone,
    },
    scheduler: {
      file: overrides.scheduler ?? null,
      effective: live.scheduler,
      source: overrides.scheduler !== undefined ? "file" : present(env.HQ_SCHEDULER) ? "env" : "default",
      fallback: fromEnv.scheduler,
      running: schedulerRunning(),
    },
    maxRunsPerDay: {
      file: overrides.maxRunsPerDay ?? null,
      effective: live.maxRunsPerDay,
      source: overrides.maxRunsPerDay !== undefined ? "file" : present(env.HQ_MAX_RUNS_PER_DAY) ? "env" : "default",
      fallback: fromEnv.maxRunsPerDay,
    },
    notifyTypes: { selected, known },
    quietHours: quiet.quietHours,
    rooms: home.rooms.map((room) => {
      const pause = pauses.get(room.name) ?? null;
      const last = lastRun.get(room.name) as { agent_id: string; status: string; started_at: string; ended_at: string | null } | undefined;
      const current = running.get(room.name) as { agent_id: string; started_at: string } | undefined;
      return {
        name: room.name,
        label: room.label ?? null,
        color: room.color,
        shared: room.shared,
        state: pause ? ("paused" as const) : ("active" as const),
        pause,
        week: weeks.get(room.name) ?? { runs: 0, costUsd: 0 },
        lastRun: last ? { agent: last.agent_id, status: last.status, at: last.ended_at ?? last.started_at } : null,
        running: current ? { agent: current.agent_id, since: current.started_at } : null,
        pending: (pending.get(room.name, room.name) as { n: number }).n,
        agents: room.agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        model: agent.model,
        armed: isArmed(db, room.name, agent),
        hasRoutines: agent.routines.length > 0,
        routines: agent.routines.map((routine) => ({ cron: routine.cron, schedule: describeCron(parseCron(routine.cron)) })),
        maxBudgetUsd: agent.maxBudgetUsd,
        notifySummary: agent.notifyRuns === "summary",
        })),
      };
    }),
    invalidRooms: home.invalid.map((invalid) => ({ name: path.basename(invalid.dir), error: invalid.error })),
    archivedRooms: (home.archived ?? []).map(({ room, archivedAt }) => {
      const total = totals.get(room.name) as { runs: number; costUsd: number };
      return {
        name: room.name,
        label: room.label ?? null,
        color: room.color,
        archivedAt,
        agents: room.agents.length,
        totalRuns: total.runs,
        totalCostUsd: total.costUsd,
      };
    }),
    roomProposals: proposals,
    defaultMaxBudgetUsd: live.defaultMaxBudgetUsd,
    budgets: {
      defaultMaxBudgetUsd: {
        file: overrides.defaultMaxBudgetUsd ?? null,
        effective: live.defaultMaxBudgetUsd,
        source: runtime("defaultMaxBudgetUsd", "HQ_DEFAULT_MAX_BUDGET_USD"),
        fallback: fromEnv.defaultMaxBudgetUsd,
      },
      weeklyBudgetUsd: {
        file: overrides.weeklyBudgetUsd ?? null,
        effective: live.weeklyBudgetUsd,
        source: runtime("weeklyBudgetUsd", "HQ_WEEKLY_BUDGET_USD"),
        fallback: fromEnv.weeklyBudgetUsd,
      },
      runTimeoutMinutes: {
        file: overrides.runTimeoutMinutes ?? null,
        effective: minutes(live.runTimeoutMs),
        source: runtime("runTimeoutMinutes", "HQ_RUN_TIMEOUT_MINUTES"),
        fallback: minutes(fromEnv.runTimeoutMs),
      },
      runHardLimitMinutes: {
        file: overrides.runHardLimitMinutes ?? null,
        effective: minutes(live.runHardLimitMs),
        source: runtime("runHardLimitMinutes", "HQ_RUN_HARD_LIMIT_MINUTES"),
        fallback: minutes(fromEnv.runHardLimitMs),
      },
    },
    runsToday: runsToday(db),
    spend: {
      totalUsd: [...weeks.values()].reduce((sum, week) => sum + week.costUsd, 0),
      byRoom: [...weeks.entries()]
        .filter(([, week]) => week.costUsd > 0)
        .sort((a, b) => b[1].costUsd - a[1].costUsd)
        .map(([name, week]) => {
          const room = home.rooms.find((each) => each.name === name) ?? home.archived?.find((each) => each.room.name === name)?.room;
          return { room: name, label: room?.label ?? null, color: room?.color ?? null, costUsd: week.costUsd };
        }),
    },
    summaries: {
      enabled: summaries.enabled,
      source: summaries.fromFile ? "file" : "default",
      week: { calls: summaryWeek.calls, costUsd: Math.round(summaryWeek.costUsd * 10_000) / 10_000 },
    },
    secrets: SECRET_VARIABLES.map((name) => ({ name, set: present(env[name]) })),
    attachmentMaxMb: Math.round(attachmentMaxBytes(env) / (1024 * 1024)),
    portier: {
      enabled: portier.setting.enabled,
      model: portier.setting.model,
      source: portier.fromFile ? "file" : "default",
      week: verdicts.week,
      verdicts: verdicts.verdicts,
    },
    door: { enabled: doorOpen, week: door.week, requests: door.requests },
    machine,
    errors,
  };
}
