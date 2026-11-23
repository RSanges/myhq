import { strings } from "../ui/strings";
import type { RoomFile } from "./rooms";

// The room brief (room.json `brief`, docs/home-layout.md "The room brief"):
// the draft MyHQ proposes when a room is created. Loading and joining a brief
// to a run live in rooms.ts and runner.ts.

/** Where the draft goes when the room declares no brief: next to room.json. */
export const BRIEF_DRAFT_FILE = "brief.md";

/**
 * The brief draft of a room: generic headings to fill in, with what MyHQ
 * knows without a model (the room's name, its repository, its agents).
 */
export function briefDraft(room: Pick<RoomFile, "name" | "targetRepo"> & { label?: string; agents: { id: string; name: string }[] }): string {
  return strings.roomBrief.draft({
    title: room.label ?? room.name,
    name: room.name,
    targetRepo: room.targetRepo,
    agents: room.agents.map((agent) => `${agent.id} (${agent.name})`),
  });
}
