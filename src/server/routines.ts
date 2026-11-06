import path from "node:path";
import { z } from "zod";
import { homeOwnedElsewhere } from "./app";
import { liveConfig, type HqConfig } from "./config";
import { describeCron, nextFire, parseCron, type CronSummary } from "./cron";
import { getDbAt, now, type Db, type FiringOutcome, type FiringRow, type RunRow } from "./db";
import { HqError } from "./errors";
import { acquireLock, type Lock } from "./lock";
import { loadHome, syncHome, type Agent, type Home, type Room, type Routine } from "./rooms";
import { findAgent, resumeWaitingTasks, startRun, type RunnerDeps, type StartRunRequest } from "./runner";
import { watchStandard } from "./supervisor";

// --- Armed state ---------------------------------------------------------------

/**
 * Whether an agent's routines may start runs: the value stored in the
 * database once it has been changed (interface or assistant), the one of
 * room.json until then.
 */
export function isArmed(db: Db, room: string, agent: Agent): boolean {
  const row = db.prepare("SELECT armed FROM agents WHERE room = ? AND id = ?").get(room, agent.id) as
    | { armed: number | null }
    | undefined;
  return row?.armed === null || row?.armed === undefined ? agent.armed : row.armed === 1;
}

export const armSchema = z.strictObject({ armed: z.boolean() });

/** Arms or disarms an agent's routines. Throws ROOM_NOT_FOUND, ROOM_INVALID or AGENT_NOT_FOUND. */
export function setArmed(config: HqConfig, db: Db, roomName: string, agentId: string, armed: boolean): boolean {
  findAgent(config, roomName, agentId);
  syncHome(db, loadHome(config.home));
  db.prepare("UPDATE agents SET armed = ? WHERE room = ? AND id = ?").run(armed ? 1 : 0, roomName, agentId);
  return armed;
}

// --- Firings journal -----------------------------------------------------------

export type FiringDto = {
  id: number;
  room: string;
  agentId: string;
  cron: string;
  task: string | null;
  scheduledAt: string;
  outcome: FiringOutcome;
  runId: number | null;
  detail: string | null;
  createdAt: string;
};

export const toFiring = (r: FiringRow): FiringDto => ({
  id: r.id,
  room: r.room,
  agentId: r.agent_id,
  cron: r.cron,
  task: r.task,
  scheduledAt: r.scheduled_at,
  outcome: r.outcome,
  runId: r.run_id,
  detail: r.detail,
  createdAt: r.created_at,
});

/** The most recent firings, newest first. */
export function listFirings(db: Db, limit = 50): FiringDto[] {
  return (db.prepare("SELECT * FROM routine_firings ORDER BY id DESC LIMIT ?").all(limit) as FiringRow[]).map(
    toFiring,
  );
}

type FiringInput = {
  room: string;
  agentId: string;
  routine: Routine;
  scheduledAt: Date;
  outcome: FiringOutcome;
  runId?: number;
  detail?: string;
};

function recordFiring(db: Db, f: FiringInput): FiringDto {
  const id = Number(
    db
      .prepare(
        `INSERT INTO routine_firings (room, agent_id, cron, task, scheduled_at, outcome, run_id, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        f.room,
        f.agentId,
        f.routine.cron,
        f.routine.task,
        f.scheduledAt.toISOString(),
        f.outcome,
        f.runId ?? null,
        f.detail ?? null,
        now(),
      ).lastInsertRowid,
  );
  return toFiring(db.prepare("SELECT * FROM routine_firings WHERE id = ?").get(id) as FiringRow);
}

export type FireDeps = RunnerDeps & { start?: (request: StartRunRequest, deps: RunnerDeps) => RunRow };

/**
 * Handles one routine that came due: a disarmed agent is skipped, otherwise a
 * run starts through the same lock and daily cap as any other run. Every
 * outcome is written to the journal.
 */
export function fireRoutine(
  config: HqConfig,
  db: Db,
  room: Room,
  agent: Agent,
  routine: Routine,
  scheduledAt: Date,
  deps: FireDeps = {},
): FiringDto {
  const base = { room: room.name, agentId: agent.id, routine, scheduledAt };
  if (!isArmed(db, room.name, agent)) return recordFiring(db, { ...base, outcome: "skipped_unarmed" });
  const start = deps.start ?? startRun;
  try {
    const run = start(
      { room: room.name, agent: agent.id, ...(routine.task ? { task: routine.task } : {}) },
      // The motive of the run for the agent's `modelFor` and `prepare`: a routine has no reason.
      { ...deps, config, motive: "routine" },
    );
    return recordFiring(db, { ...base, outcome: "started", runId: run.id });
  } catch (error) {
    if (error instanceof HqError && (error.code === "AGENT_BUSY" || error.code === "RESOURCE_BUSY")) {
      return recordFiring(db, { ...base, outcome: "skipped_busy", detail: error.message });
    }
    if (error instanceof HqError && error.code === "DAILY_CAP_REACHED") {
      return recordFiring(db, { ...base, outcome: "skipped_cap", detail: error.message });
    }
    const detail = error instanceof Error ? error.message : String(error);
    return recordFiring(db, { ...base, outcome: "error", detail });
  }
}

/** The next fire of a routine, or null when its expression never fires. */
export function nextRoutineFire(routine: Routine, after: Date, timeZone: string): Date | null {
  return nextFire(parseCron(routine.cron), after, timeZone);
}

/** A routine as the interface sees it: its expression, its task, its next fire (UTC) and what its schedule says. */
export type RoutineDto = { cron: string; task: string | null; nextAt: string | null; schedule: CronSummary };

export function toRoutineDto(routine: Routine, after: Date, timeZone: string): RoutineDto {
  const schedule = parseCron(routine.cron);
  return {
    cron: routine.cron,
    task: routine.task,
    nextAt: nextFire(schedule, after, timeZone)?.toISOString() ?? null,
    schedule: describeCron(schedule),
  };
}

/** The armed state and the routines of every agent that has routines, for GET /api/routines. */
export function agentRoutines(
  db: Db,
  home: Home,
  after: Date,
  timeZone: string,
): { room: string; agentId: string; armed: boolean; routines: RoutineDto[] }[] {
  return home.rooms.flatMap((room) =>
    room.agents
      .filter((agent) => agent.routines.length > 0)
      .map((agent) => ({
        room: room.name,
        agentId: agent.id,
        armed: isArmed(db, room.name, agent),
        routines: agent.routines.map((routine) => toRoutineDto(routine, after, timeZone)),
      })),
  );
}

// --- Scheduler -------------------------------------------------------------------

/** A routine found more than this late (machine asleep, app stopped) is dropped, not caught up. */
export const LATE_LIMIT_MS = 5 * 60_000;
const TICK_MS = 15_000;

type Slot = { next: Date | null };

/**
 * The internal scheduler. Each tick re-reads the home (rooms and routines
 * edited by hand or added by onboarding are picked up without a restart) and
 * fires the routines whose time has come. A routine is first planned from
 * the moment the scheduler sees it, so nothing missed while the app was
 * stopped is caught up.
 */
export class Scheduler {
  private readonly slots = new Map<string, Slot>();

  constructor(
    private readonly config: HqConfig,
    private readonly db: Db,
    private readonly deps: FireDeps = {},
    private readonly log: (message: string) => void = (m) => console.log(`[scheduler] ${m}`),
  ) {}

  /** Fires what is due at `at`, and returns the journal rows written. `config` is the current one (time zone, daily cap). */
  tick(at: Date = new Date(), config: HqConfig = this.config): FiringDto[] {
    let home: Home;
    try {
      home = loadHome(config.home);
    } catch (error) {
      this.log(`home not readable: ${(error as Error).message}`);
      return [];
    }
    syncHome(this.db, home);
    const seen = new Set<string>();
    const fired: FiringDto[] = [];
    for (const room of home.rooms) {
      for (const agent of room.agents) {
        agent.routines.forEach((routine, index) => {
          const key = `${room.name}/${agent.id}#${index} ${routine.cron} ${routine.task ?? ""}`;
          seen.add(key);
          const slot = this.slots.get(key);
          if (!slot) {
            this.slots.set(key, { next: nextRoutineFire(routine, at, config.timeZone) });
            return;
          }
          if (!slot.next || at.getTime() < slot.next.getTime()) return;
          const due = slot.next;
          slot.next = nextRoutineFire(routine, at, config.timeZone);
          if (at.getTime() - due.getTime() > LATE_LIMIT_MS) {
            this.log(`${room.name}/${agent.id} "${routine.cron}" was due at ${due.toISOString()}: too late, skipped`);
            return;
          }
          const firing = fireRoutine(config, this.db, room, agent, routine, due, this.deps);
          const run = firing.runId ? ` (run #${firing.runId})` : "";
          this.log(`${room.name}/${agent.id} "${routine.cron}": ${firing.outcome}${run}`);
          fired.push(firing);
        });
      }
    }
    for (const key of [...this.slots.keys()]) if (!seen.has(key)) this.slots.delete(key);
    return fired;
  }
}

type RunningScheduler = { scheduler: Scheduler; lock: Lock };
type SchedulerHost = {
  config: HqConfig;
  timer: ReturnType<typeof setInterval>;
  running: RunningScheduler | null;
  /** The lock of another process was reported already. */
  lockedElsewhere: boolean;
};

const globalForScheduler = globalThis as unknown as { __myhqSchedulerHost?: SchedulerHost };

/** Whether this process runs the routines (the scheduler is on and the lock taken). */
export function schedulerRunning(): boolean {
  return Boolean(globalForScheduler.__myhqSchedulerHost?.running);
}

function currentConfig(host: SchedulerHost): HqConfig {
  try {
    return liveConfig(host.config);
  } catch {
    return host.config;
  }
}

/**
 * Brings the scheduler in line with the configuration as it is now
 * (HQ_SCHEDULER, overridden by `scheduler` in myhq.json), then ticks it: the
 * scheduler starts or stops without a restart. It runs in one process per
 * home only (a lock file in `data/`).
 */
function reconcile(host: SchedulerHost, at: Date = new Date()): void {
  const config = currentConfig(host);
  if (config.scheduler && !host.running) {
    const lock = acquireLock(path.join(config.dataDir, "scheduler.lock"));
    if (!lock) {
      if (!host.lockedElsewhere) console.log("[scheduler] another MyHQ process already runs the routines of this home");
      host.lockedElsewhere = true;
      return;
    }
    host.lockedElsewhere = false;
    host.running = { scheduler: new Scheduler(config, getDbAt(config.dbPath)), lock };
    console.log(`[scheduler] on, time zone ${config.timeZone}`);
  } else if (!config.scheduler && host.running) {
    host.running.lock.release();
    host.running = null;
    console.log("[scheduler] off: routines do not start runs");
  }
  if (!config.scheduler) host.lockedElsewhere = false;
  host.running?.scheduler.tick(at, config);
}

/**
 * Wakes the tasks that waited for the daily cap as soon as the counter allows
 * a run again (the day changed, or the cap was raised): see `resumeWaitingTasks`.
 * Then wakes the supervisor of the Standard when something is newly stuck, or
 * for its review (`watchStandard`). Runs at each tick of the timer and at
 * startup, scheduler on or off.
 */
function resumeWaiting(host: SchedulerHost): void {
  try {
    const config = currentConfig(host);
    // A second process on the same home (see app()) must not start runs that die with it.
    if (homeOwnedElsewhere(config.dbPath)) return;
    resumeWaitingTasks(config, getDbAt(config.dbPath));
  } catch (error) {
    console.error("[scheduler] resuming the waiting tasks failed", error);
  }
  try {
    const config = currentConfig(host);
    if (homeOwnedElsewhere(config.dbPath)) return;
    // The supervisor of the Standard, woken for what is newly stuck (supervisor.ts).
    watchStandard(config, getDbAt(config.dbPath));
  } catch (error) {
    console.error("[scheduler] waking the supervisor of the Standard failed", error);
  }
}

/**
 * Starts the scheduler once per process. It runs only while the scheduler is
 * on (HQ_SCHEDULER=on, or `scheduler` in myhq.json, which wins); the check is
 * repeated at each tick, so that switching it needs no restart.
 */
export function startScheduler(config: HqConfig): Scheduler | null {
  const existing = globalForScheduler.__myhqSchedulerHost;
  if (existing) return existing.running?.scheduler ?? null;
  const timer = setInterval(() => {
    try {
      reconcile(host);
    } catch (error) {
      console.error("[scheduler] tick failed", error);
    }
    resumeWaiting(host);
  }, TICK_MS);
  timer.unref();
  const host: SchedulerHost = { config, timer, running: null, lockedElsewhere: false };
  globalForScheduler.__myhqSchedulerHost = host;
  if (!currentConfig(host).scheduler) {
    console.log("[scheduler] off (HQ_SCHEDULER, scheduler in myhq.json): routines do not start runs");
  }
  reconcile(host);
  resumeWaiting(host);
  return host.running?.scheduler ?? null;
}

/** Applies a change of the scheduler setting now rather than at the next tick. Does nothing when the scheduler was never started. */
export function reconcileScheduler(): void {
  const host = globalForScheduler.__myhqSchedulerHost;
  if (host) reconcile(host);
}

/** What the interface and the assistant show about the scheduler. */
export function schedulerInfo(config: HqConfig): { enabled: boolean; running: boolean; timeZone: string } {
  return { enabled: config.scheduler, running: schedulerRunning(), timeZone: config.timeZone };
}
