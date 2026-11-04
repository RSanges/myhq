import type { Db } from "./db";

// Shared resources (room.json agents[].resources, for example "gpu"): two runs
// holding a common one never run at once. Each run stores the resources it
// holds (`runs.resources`), so the lock is read from the database alone.

export type ResourceHold = { resource: string; runId: number; room: string; agentId: string };

/** Every shared resource held by a run in progress, with that run. */
export function heldResources(db: Db): ResourceHold[] {
  return db
    .prepare(
      `SELECT j.value AS resource, r.id AS runId, r.room, r.agent_id AS agentId
       FROM runs r, json_each(r.resources) j WHERE r.status = 'running' ORDER BY r.id`,
    )
    .all() as ResourceHold[];
}

/** The first run in progress that holds one of `resources`, or null when they are all free. */
export function resourceHolder(db: Db, resources: readonly string[]): ResourceHold | null {
  if (resources.length === 0) return null;
  return heldResources(db).find((hold) => resources.includes(hold.resource)) ?? null;
}
