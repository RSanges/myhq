// The reception: the onboarding agent seen from the floor. Its runs belong to
// the reserved room `_hq`, which no folder of the home can take, so no floor
// owns it; one floor of the home (the `reception` setting of myhq.json) draws
// it at a counter in the lobby. Pure: shared by the server (the state
// snapshot, the onboarding run) and the interface (the room model, the sheet).

/** The reserved room of the onboarding runs. */
export const RECEPTION_ROOM = "_hq";
/** The onboarding agent, the receptionist. */
export const RECEPTION_AGENT = "onboarding";
/** Key (`room/agent`) of the receptionist in the room model, the strip and the canvas. */
export const RECEPTION_KEY = `${RECEPTION_ROOM}/${RECEPTION_AGENT}`;
/**
 * The owner of the floor seated in the user's own office (`floor.owner` of
 * myhq.json): no agent, it belongs to the reserved room too, so no room of the
 * home can take its key nor its sheet's URL.
 */
export const OWNER_AGENT = "owner";
export const OWNER_KEY = `${RECEPTION_ROOM}/${OWNER_AGENT}`;
/** The room that gets the reception when the home does not say, if it exists. */
export const DEFAULT_RECEPTION_ROOM = "assistant";

/**
 * The floor that draws the reception: the room the home names (`reception.room`
 * in myhq.json) when it exists, else the room called `assistant`, else the
 * first room, or none when the home has no room.
 */
export function resolveReceptionRoom(rooms: string[], configured: string | null): string | null {
  if (configured !== null && rooms.includes(configured)) return configured;
  if (rooms.includes(DEFAULT_RECEPTION_ROOM)) return DEFAULT_RECEPTION_ROOM;
  return rooms[0] ?? null;
}

const TASK_PREFIX = "Propose a room for the repository ";

/** The task of an onboarding run for a target (relative to the home, or absolute). */
export function onboardingTask(target: string): string {
  return `${TASK_PREFIX}${target}.`;
}

/** The target of an onboarding run, read back from its task, or null for a task of another shape. */
export function onboardingTarget(task: string): string | null {
  if (!task.startsWith(TASK_PREFIX) || !task.endsWith(".")) return null;
  const target = task.slice(TASK_PREFIX.length, -1);
  return target === "" ? null : target;
}
