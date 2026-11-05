import type { HqConfig } from "./config";
import { now, type Db, type RunRow } from "./db";
import { HqError } from "./errors";
import { startRun, WAITS, WAKE_TASK, type RunnerDeps } from "./runner";

// The relaunches a supervisor asked for with hq_relaunch (supervisor.ts). The
// HQ MCP server, another process, put the tasks back to pending and recorded
// the request; the app starts the run here, from `wakeAgents`, so on the tool
// result of that very call. This module imports nothing that reads the runner
// at load time: the runner imports it.

/** Why a relaunch started a run (`runs.reason`): the owner's « Relancer » and a supervisor's hq_relaunch alike. */
export const RELAUNCH_REASON = "relaunch";

/**
 * Starts the run of each relaunch request not handled yet, oldest first, with
 * the rules of « Relancer »: the agent lock, its shared resources, the daily
 * cap. A request is handled once: `run_id` is the run started, `waiting` the
 * code of what held it back (its tasks then stay pending, and its entry stays
 * on the Standard). Never throws; returns the runs started.
 */
export function startRelaunchRequests(config: HqConfig, db: Db, deps: RunnerDeps = {}): RunRow[] {
  const requests = db
    .prepare("SELECT id, room, agent_id FROM supervisor_relaunches WHERE handled_at IS NULL ORDER BY id")
    .all() as { id: number; room: string; agent_id: string }[];
  const started: RunRow[] = [];
  const claim = db.prepare("UPDATE supervisor_relaunches SET handled_at = ? WHERE id = ? AND handled_at IS NULL");
  const record = db.prepare("UPDATE supervisor_relaunches SET run_id = ?, waiting = ? WHERE id = ?");
  for (const request of requests) {
    // Claimed before the start: a wake-up during the start never takes it a second time.
    if (claim.run(now(), request.id).changes === 0) continue;
    try {
      const run = startRun(
        { room: request.room, agent: request.agent_id, task: WAKE_TASK, reason: RELAUNCH_REASON },
        { ...deps, config },
      );
      record.run(run.id, null, request.id);
      started.push(run);
    } catch (error) {
      const code = error instanceof HqError ? error.code : "ERROR";
      record.run(null, code, request.id);
      if (!(error instanceof HqError && WAITS.has(error.code))) {
        console.error(`[supervisor] could not start relaunch request #${request.id}`, error);
      }
    }
  }
  return started;
}
