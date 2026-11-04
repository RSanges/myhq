import path from "node:path";
import { z } from "zod";
import type { HqConfig } from "./config";
import { nextFire, parseCron } from "./cron";
import { getDbAt, now, type Db, type FiringOutcome, type FiringRow, type RunRow } from "./db";
import { HqError } from "./errors";
import { acquireLock, type Lock } from "./lock";
import { loadHome, syncHome, type Agent, type Home, type Room, type Routine } from "./rooms";
import { findAgent, startRun, type RunnerDeps, type StartRunRequest } from "./runner";

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
      { ...deps, config },
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

  /** Fires what is due at `at`, and returns the journal rows written. */
  tick(at: Date = new Date()): FiringDto[] {
    let home: Home;
    try {
      home = loadHome(this.config.home);
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
            this.slots.set(key, { next: nextRoutineFire(routine, at, this.config.timeZone) });
            return;
          }
          if (!slot.next || at.getTime() < slot.next.getTime()) return;
          const due = slot.next;
          slot.next = nextRoutineFire(routine, at, this.config.timeZone);
          if (at.getTime() - due.getTime() > LATE_LIMIT_MS) {
            this.log(`${room.name}/${agent.id} "${routine.cron}" was due at ${due.toISOString()}: too late, skipped`);
            return;
          }
          const firing = fireRoutine(this.config, this.db, room, agent, routine, due, this.deps);
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

const globalForScheduler = globalThis as unknown as {
  __myhqScheduler?: { scheduler: Scheduler; timer: ReturnType<typeof setInterval>; lock: Lock } | null;
};

/** Whether this process runs the routines (HQ_SCHEDULER=on and the lock taken). */
export function schedulerRunning(): boolean {
  return Boolean(globalForScheduler.__myhqScheduler);
}

/**
 * Starts the scheduler once per process, only when HQ_SCHEDULER=on, and in
 * one process per home only (a lock file in `data/`).
 */
export function startScheduler(config: HqConfig): Scheduler | null {
  if (globalForScheduler.__myhqScheduler !== undefined) return globalForScheduler.__myhqScheduler?.scheduler ?? null;
  if (!config.scheduler) {
    console.log("[scheduler] off (HQ_SCHEDULER): routines do not start runs");
    globalForScheduler.__myhqScheduler = null;
    return null;
  }
  const lock = acquireLock(path.join(config.dataDir, "scheduler.lock"));
  if (!lock) {
    console.log("[scheduler] another MyHQ process already runs the routines of this home");
    globalForScheduler.__myhqScheduler = null;
    return null;
  }
  const scheduler = new Scheduler(config, getDbAt(config.dbPath));
  scheduler.tick();
  const timer = setInterval(() => {
    try {
      scheduler.tick();
    } catch (error) {
      console.error("[scheduler] tick failed", error);
    }
  }, TICK_MS);
  timer.unref();
  globalForScheduler.__myhqScheduler = { scheduler, timer, lock };
  console.log(`[scheduler] on, time zone ${config.timeZone}`);
  return scheduler;
}

/** What the interface and the assistant show about the scheduler. */
export function schedulerInfo(config: HqConfig): { enabled: boolean; running: boolean; timeZone: string } {
  return { enabled: config.scheduler, running: schedulerRunning(), timeZone: config.timeZone };
}
