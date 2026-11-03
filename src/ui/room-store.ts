import { RECEPTION_AGENT, RECEPTION_ROOM } from "./reception";
import type { Approval, HqEvent, Run, State } from "./schemas";
import { applyInput, createRoomModel, type RoomModel } from "./room-model";
import { strings } from "./strings";

// The room models of the page, one per room, fed by the entities the page
// already receives (the state snapshot, then the SSE stream). Plain TypeScript
// outside React: the canvas reads it on every frame without a render.

/** One thing received from the API, as `useHq` sees it. */
export type HqChange =
  | { kind: "state"; state: State }
  | { kind: "run"; run: Run }
  | { kind: "event"; event: HqEvent }
  | { kind: "approval"; approval: Approval };

export type RoomStore = {
  /** The model of a room (an empty one for a room that is not known). */
  get(room: string): RoomModel;
  /** Applies a change received at `at` (epoch milliseconds). */
  ingest(change: HqChange, at: number): void;
  /** Called after every change; returns the function that stops it. */
  subscribe(listener: () => void): () => void;
};

export function createRoomStore(): RoomStore {
  const models = new Map<string, RoomModel>();
  const listeners = new Set<() => void>();
  /** The floor that has the reception desk: the entities of the reserved room `_hq` go to its model. */
  let receptionRoom: string | null = null;
  const notify = () => listeners.forEach((listener) => listener());

  const update = (room: string, change: (model: RoomModel) => RoomModel) => {
    const model = models.get(room === RECEPTION_ROOM ? (receptionRoom ?? room) : room);
    if (!model) return;
    const next = change(model);
    if (next !== model) {
      models.set(model.room, next);
      notify();
    }
  };

  return {
    get: (room) => models.get(room) ?? createRoomModel(room),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ingest(change, at) {
      switch (change.kind) {
        case "state": {
          const { state } = change;
          receptionRoom = state.reception.room;
          for (const room of state.rooms) {
            const here = room.name === receptionRoom;
            const model = models.get(room.name) ?? createRoomModel(room.name);
            models.set(
              room.name,
              applyInput(
                model,
                {
                  type: "hydrate",
                  agents: room.agents.map((agent) => ({ id: agent.id, name: agent.name, lastRun: agent.lastRun })),
                  approvals: state.approvals.pending.filter(
                    (approval) => approval.room === room.name || (here && approval.room === RECEPTION_ROOM),
                  ),
                  reception: here
                    ? { id: RECEPTION_AGENT, name: strings.room.reception.name, lastRun: state.reception.runs[0] ?? null }
                    : null,
                },
                at,
              ),
            );
          }
          for (const name of [...models.keys()]) {
            if (!state.rooms.some((room) => room.name === name)) models.delete(name);
          }
          notify();
          return;
        }
        case "run":
          return update(change.run.room, (model) => applyInput(model, { type: "run", run: change.run }, at));
        case "event":
          return update(change.event.room, (model) => applyInput(model, { type: "event", event: change.event }, at));
        case "approval":
          return update(change.approval.room, (model) =>
            applyInput(model, { type: "approval", approval: change.approval }, at),
          );
      }
    },
  };
}
