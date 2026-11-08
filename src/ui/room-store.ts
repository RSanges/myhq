import { RECEPTION_AGENT, RECEPTION_ROOM } from "./reception";
import type { Approval, HqEvent, Run, State } from "./schemas";
import { applyInput, createRoomModel, FLOOR_MODEL, pileRoomOf, type RoomModel } from "./room-model";
import { strings } from "./strings";

// The room models of the page, one per room, fed by the entities the page
// already receives (the state snapshot, then the SSE stream). On the single
// floor of the home (`floor.layout: "room-per-project"`) there is one model,
// FLOOR_MODEL, fed with every room. Plain TypeScript outside React: the
// canvas reads it on every frame without a render.

/** One thing received from the API, as `useHq` sees it. */
export type HqChange =
  | { kind: "state"; state: State }
  | { kind: "run"; run: Run }
  | { kind: "event"; event: HqEvent }
  | { kind: "approval"; approval: Approval };

export type RoomStore = {
  /** The model of a room, or of the single floor with FLOOR_MODEL (an empty one for a room that is not known). */
  get(room: string): RoomModel;
  /** Applies a change received at `at` (epoch milliseconds). */
  ingest(change: HqChange, at: number): void;
  /** A turn of the chat began or ended (`running` of its turn state): the owner of the single floor types meanwhile. */
  setOwnerBusy(busy: boolean, at: number): void;
  /** Called after every change; returns the function that stops it. */
  subscribe(listener: () => void): () => void;
};

export function createRoomStore(): RoomStore {
  const models = new Map<string, RoomModel>();
  const listeners = new Set<() => void>();
  /** The floor that has the reception desk: the entities of the reserved room `_hq` go to its model. */
  let receptionRoom: string | null = null;
  /** The home is drawn as one floor: every entity goes to its model. */
  let single = false;
  /** A turn of the chat is in progress, kept for the next snapshot of the floor. */
  let ownerBusy = false;
  const notify = () => listeners.forEach((listener) => listener());

  const update = (room: string, change: (model: RoomModel) => RoomModel) => {
    const model = models.get(single ? FLOOR_MODEL : room === RECEPTION_ROOM ? (receptionRoom ?? room) : room);
    if (!model) return;
    const next = change(model);
    if (next !== model) {
      models.set(model.room, next);
      notify();
    }
  };

  return {
    get: (room) => models.get(room) ?? createRoomModel(room),
    setOwnerBusy(busy, at) {
      ownerBusy = busy;
      const model = models.get(FLOOR_MODEL);
      if (!model) return;
      const next = applyInput(model, { type: "owner", busy }, at);
      if (next !== model) {
        models.set(FLOOR_MODEL, next);
        notify();
      }
    },
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
          single = state.floor.layout === "room-per-project";
          if (single) {
            const model = models.get(FLOOR_MODEL) ?? createRoomModel(FLOOR_MODEL);
            models.clear();
            const hydrated = applyInput(
              model,
              {
                type: "hydrate-floor",
                rooms: state.rooms.map((room) => ({
                  name: room.name,
                  color: room.color,
                  agents: room.agents.map((agent) => ({
                    id: agent.id,
                    name: agent.name,
                    lastRun: agent.lastRun,
                    roam: agent.roam ?? false,
                    roamAlways: agent.roamAlways ?? false,
                  })),
                })),
                approvals: state.approvals.pending,
                reception: {
                  room: receptionRoom,
                  agent: { id: RECEPTION_AGENT, name: strings.room.reception.name, lastRun: state.reception.runs[0] ?? null },
                },
                owner: state.floor.owner ? { name: state.floor.owner.name } : null,
              },
              at,
            );
            models.set(FLOOR_MODEL, applyInput(hydrated, { type: "owner", busy: ownerBusy }, at));
            notify();
            return;
          }
          models.delete(FLOOR_MODEL);
          for (const room of state.rooms) {
            const here = room.name === receptionRoom;
            const model = models.get(room.name) ?? createRoomModel(room.name);
            models.set(
              room.name,
              applyInput(
                model,
                {
                  type: "hydrate",
                  agents: room.agents.map((agent) => ({ id: agent.id, name: agent.name, lastRun: agent.lastRun, roam: agent.roam ?? false })),
                  approvals: state.approvals.pending.filter(
                    (approval) => pileRoomOf(approval) === room.name || (here && pileRoomOf(approval) === RECEPTION_ROOM),
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
          // An item delivered by a shared room lands in the pile of the room that ordered it.
          return update(pileRoomOf(change.approval), (model) =>
            applyInput(model, { type: "approval", approval: change.approval }, at),
          );
      }
    },
  };
}
