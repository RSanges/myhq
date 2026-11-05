import type { TeamAgent } from "./model";

/** The agents of one room, as the recipient picker of the chat lists them under the room's name. */
export type RoomGroup = { room: string; color: string | null; agents: TeamAgent[] };

/** The agents grouped by room, rooms and agents in the order they come. */
export function groupByRoom(agents: readonly TeamAgent[]): RoomGroup[] {
  const groups = new Map<string, RoomGroup>();
  for (const agent of agents) {
    const group = groups.get(agent.room) ?? { room: agent.room, color: agent.color, agents: [] };
    group.agents.push(agent);
    groups.set(agent.room, group);
  }
  return [...groups.values()];
}
