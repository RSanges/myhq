// How the floor (the home page) draws the home (myhq.json `floor.layout`, docs/home-layout.md):
// one floor per room of the home, chosen with the buttons at the top (each a
// hand-designed template, room-layout.ts), or a single floor where each room
// of the home is one room of the floor (floor-plan.ts). Pure: shared by the
// server (the state snapshot) and the interface.

export const FLOOR_LAYOUTS = ["floor-per-project", "room-per-project"] as const;
export type FloorLayoutMode = (typeof FLOOR_LAYOUTS)[number];
export const DEFAULT_FLOOR_LAYOUT: FloorLayoutMode = "floor-per-project";

/**
 * Where the user's desk of a room of the single floor leads: the page of the
 * pile of decisions (the desk object whose source is `approvals`) filtered to
 * that room, or the desk itself when the home's desk has no such object.
 */
export function pileHref(objects: readonly { id: string; source: string }[] | null, room: string): string {
  const pile = objects?.find((object) => object.source.split("+").includes("approvals"));
  return pile ? `/bureau/${pile.id}?room=${encodeURIComponent(room)}` : "/bureau";
}
