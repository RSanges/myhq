import { agentKey, viewEvent } from "./model";
import type { Approval, HqEvent, Run } from "./schemas";
import { deskOf, layoutRoom, visitSpot, type DeskSpot, type Point, type RoomLayout } from "./room-layout";

// The animation model of the room: what each agent is doing, derived from the
// entities of the SSE stream (docs/api.md). Pure and testable: no canvas, no
// real clock. Time is a number of milliseconds (epoch) that the caller passes
// in, both when an entity arrives (`applyInput`) and when the room is read
// (`snapshotRoom`), so a replay in a test runs on a fake clock. Positions are
// straight lines with a soft ease, there is no path finding. Nothing here is
// worded for the user: the interface turns `AgentStatus` into French.

// ---- Durations and speeds (all named, all in milliseconds unless said) ----------

/** A tool call makes the agent type for this long. */
export const TYPING_MS = 2_500;
/** A thought bubble (the beginning of a `text` event) stays this long. */
export const THOUGHT_MS = 5_000;
/** A visitor stays at the colleague's desk for this long (`hq_message`). */
export const VISIT_STAY_MS = 3_000;
/** The agent stays at the user's desk for this long (`hq_submit`). */
export const DROP_STAY_MS = 2_200;
/** After arriving at the user's desk, the folder is in the tray at this point of the stay. */
export const FOLDER_DROP_MS = 700;
/** No run for this long: the agent falls asleep. */
export const ASLEEP_AFTER_MS = 60_000;
/** Walking speed, in world units per second. */
export const WALK_SPEED = 96;
/** The shortest walk leg, so that a neighbour is not reached in a blink. */
export const MIN_LEG_MS = 500;
/** With reduced motion, a move is a fade out then a fade in of this length. */
export const FADE_MS = 360;
/** Characters of a `text` event kept in the thought bubble. */
export const THOUGHT_CHARS = 64;
/** Trips queued behind the current one, at most (a flurry of messages does not walk forever). */
export const MAX_QUEUED_TRIPS = 3;

export const HQ_MESSAGE_TOOL = "mcp__hq__hq_message";
export const HQ_SUBMIT_TOOL = "mcp__hq__hq_submit";
export const HQ_TASK_UPDATE_TOOL = "mcp__hq__hq_task_update";

// ---- Poses and sheet rows -------------------------------------------------------

export type Pose = "sit" | "type" | "walk" | "stand" | "think" | "sleep";

/**
 * Rows of the character sheet (docs/home-layout.md): sit and type (2 frames),
 * walk (4), think (2), sleep (2). `ms` is the time of one frame, 0 for a pose
 * held on its first frame (sitting is the first frame of the typing row, and
 * standing the first frame of the walking row).
 */
export const POSES: Record<Pose, { row: number; frames: number; ms: number }> = {
  sit: { row: 0, frames: 1, ms: 0 },
  type: { row: 0, frames: 2, ms: 260 },
  walk: { row: 1, frames: 4, ms: 150 },
  stand: { row: 1, frames: 1, ms: 0 },
  think: { row: 2, frames: 2, ms: 700 },
  sleep: { row: 3, frames: 2, ms: 1_100 },
};

/** Frame index of a pose at `at`; held on the first frame with reduced motion. */
export function poseFrame(pose: Pose, at: number, phase: number, reduced: boolean): number {
  const { frames, ms } = POSES[pose];
  if (reduced || ms === 0 || frames === 1) return 0;
  return Math.floor((at + phase) / ms) % frames;
}

// ---- What the model is fed with ---------------------------------------------------

export type RunSeed = Pick<Run, "id" | "room" | "agentId" | "status" | "startedAt" | "endedAt">;
export type ApprovalSeed = Pick<Approval, "id" | "room" | "agentId" | "status">;
export type AgentSeed = { id: string; name: string; lastRun: RunSeed | null };

export type RoomInput =
  /** The room as the snapshot of /api/state describes it (first load, reconnection). */
  | { type: "hydrate"; agents: AgentSeed[]; approvals: ApprovalSeed[] }
  | { type: "run"; run: RunSeed }
  | { type: "event"; event: HqEvent }
  | { type: "approval"; approval: ApprovalSeed };

// ---- State --------------------------------------------------------------------------

type Trip = {
  kind: "visit" | "submit";
  /** Name of the colleague, for the label (null for the user's desk). */
  targetName: string | null;
  start: number;
  legMs: number;
  stayMs: number;
  from: Point;
  to: Point;
  /** Direction the character faces while it stays. */
  faceStay: 1 | -1;
  /** The approval this trip carries, once the `approval` event arrived. */
  approvalId: number | null;
};

type AgentRuntime = {
  key: string;
  id: string;
  name: string;
  running: boolean;
  runId: number;
  lastActive: number;
  /** A "?" until the user acts or the next run starts. */
  question: "failed" | "blocked" | null;
  typingUntil: number;
  thought: { text: string; until: number } | null;
  trips: Trip[];
};

type ApprovalState = { agentKey: string; status: Approval["status"]; shownAt: number };

export type RoomModel = {
  room: string;
  layout: RoomLayout;
  agents: AgentRuntime[];
  approvals: Record<number, ApprovalState>;
};

export function createRoomModel(room: string): RoomModel {
  return { room, layout: layoutRoom([]), agents: [], approvals: {} };
}

const tripEnd = (trip: Trip): number => trip.start + trip.legMs * 2 + trip.stayMs;
/** The moment the folder of a `submit` trip is in the tray. */
const tripDropAt = (trip: Trip): number => trip.start + trip.legMs + FOLDER_DROP_MS;

const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
const sign = (value: number, fallback: 1 | -1): 1 | -1 => (value > 0.5 ? 1 : value < -0.5 ? -1 : fallback);

function parseTime(iso: string | null): number {
  if (iso === null) return Number.NEGATIVE_INFINITY;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

function replaceAgent(model: RoomModel, key: string, change: (agent: AgentRuntime) => AgentRuntime): RoomModel {
  const index = model.agents.findIndex((agent) => agent.key === key);
  if (index < 0) return model;
  const agents = model.agents.slice();
  agents[index] = change(model.agents[index]!);
  return { ...model, agents };
}

/** The first line of a text, collapsed and cut for a thought bubble. */
export function thoughtText(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > THOUGHT_CHARS ? `${flat.slice(0, THOUGHT_CHARS - 3).trimEnd()}...` : flat;
}

function toolInput(input: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(input);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Queues a trip behind the ones in progress, or drops it when the queue is full. */
function withTrip(agent: AgentRuntime, trip: Omit<Trip, "start">, at: number): AgentRuntime {
  const queued = agent.trips.filter((existing) => tripEnd(existing) > at);
  if (queued.length > MAX_QUEUED_TRIPS) return { ...agent, trips: queued };
  const start = queued.length > 0 ? Math.max(at, tripEnd(queued[queued.length - 1]!)) : at;
  return { ...agent, trips: [...queued, { ...trip, start }] };
}

function walkLeg(from: Point, to: Point): number {
  return Math.max(MIN_LEG_MS, (distance(from, to) / WALK_SPEED) * 1000);
}

function startVisit(model: RoomModel, agent: AgentRuntime, targetId: string, at: number): AgentRuntime {
  const self = deskOf(model.layout, agent.key);
  const targetKey = agentKey(model.room, targetId);
  const target = deskOf(model.layout, targetKey);
  const targetAgent = model.agents.find((candidate) => candidate.key === targetKey);
  if (!self || !target || !targetAgent || targetKey === agent.key) return agent;
  const to = visitSpot(self, target);
  return withTrip(
    agent,
    {
      kind: "visit",
      targetName: targetAgent.name,
      legMs: walkLeg(self.seat, to),
      stayMs: VISIT_STAY_MS,
      from: self.seat,
      to,
      faceStay: sign(target.seat.x - to.x, 1),
      approvalId: null,
    },
    at,
  );
}

function startSubmit(model: RoomModel, agent: AgentRuntime, at: number): AgentRuntime {
  const self = deskOf(model.layout, agent.key);
  if (!self) return agent;
  const to = model.layout.trayStand;
  return withTrip(
    agent,
    {
      kind: "submit",
      targetName: null,
      legMs: walkLeg(self.seat, to),
      stayMs: DROP_STAY_MS,
      from: self.seat,
      to,
      faceStay: sign(to.x - self.seat.x, 1),
      approvalId: null,
    },
    at,
  );
}

function applyEvent(model: RoomModel, event: HqEvent, at: number): RoomModel {
  if (event.room !== model.room) return model;
  const view = viewEvent(event);
  return replaceAgent(model, agentKey(event.room, event.agentId), (agent) => {
    const active = { ...agent, lastActive: at };
    switch (view.kind) {
      case "text":
        return { ...active, thought: { text: thoughtText(view.text), until: at + THOUGHT_MS }, typingUntil: 0 };
      case "tool_call": {
        const input = toolInput(view.input);
        const typing = { ...active, typingUntil: at + TYPING_MS, thought: null };
        if (view.name === HQ_MESSAGE_TOOL) {
          // A message to nobody in this room is just a tool call.
          const trip = startVisit(model, active, typeof input.to === "string" ? input.to : "", at);
          return trip === active ? typing : { ...trip, thought: null };
        }
        if (view.name === HQ_SUBMIT_TOOL) {
          const trip = startSubmit(model, active, at);
          return trip === active ? typing : { ...trip, thought: null };
        }
        if (view.name === HQ_TASK_UPDATE_TOOL && input.status === "blocked") {
          return { ...active, question: "blocked", thought: null };
        }
        return typing;
      }
      case "end":
        return view.status === "failed" ? { ...active, question: "failed" } : active;
      default:
        return active;
    }
  });
}

function applyRun(model: RoomModel, run: RunSeed, at: number): RoomModel {
  if (run.room !== model.room) return model;
  return replaceAgent(model, agentKey(run.room, run.agentId), (agent) => {
    if (run.id < agent.runId) return agent;
    if (run.status === "running") {
      if (run.id > agent.runId) {
        // A new run starts afresh: no question mark, no leftover bubble. The same run seen again changes nothing.
        return { ...agent, running: true, runId: run.id, lastActive: at, question: null, thought: null, typingUntil: 0 };
      }
      return { ...agent, running: true, lastActive: at };
    }
    return {
      ...agent,
      running: false,
      runId: run.id,
      lastActive: at,
      question: run.status === "failed" ? "failed" : agent.question,
    };
  });
}

function applyApproval(model: RoomModel, approval: ApprovalSeed, at: number): RoomModel {
  if (approval.room !== model.room) return model;
  const key = agentKey(approval.room, approval.agentId);
  const known = model.approvals[approval.id];
  if (approval.status !== "pending") {
    // The user acted: the question mark of the agent that brought the item goes.
    const next = replaceAgent(model, key, (agent) => (agent.question ? { ...agent, question: null } : agent));
    return {
      ...next,
      approvals: { ...next.approvals, [approval.id]: { agentKey: key, status: approval.status, shownAt: known?.shownAt ?? at } },
    };
  }
  if (known) return { ...model, approvals: { ...model.approvals, [approval.id]: { ...known, status: "pending" } } };

  // A new item that an agent is carrying shows in the tray when the folder is dropped.
  let shownAt = at;
  const next = replaceAgent(model, key, (agent) => {
    const index = agent.trips.findIndex(
      (trip) => trip.kind === "submit" && trip.approvalId === null && tripEnd(trip) > at,
    );
    if (index < 0) return agent;
    const trips = agent.trips.slice();
    const trip = { ...trips[index]!, approvalId: approval.id };
    trips[index] = trip;
    shownAt = Math.max(at, tripDropAt(trip));
    return { ...agent, trips };
  });
  return { ...next, approvals: { ...next.approvals, [approval.id]: { agentKey: key, status: "pending", shownAt } } };
}

function applyHydrate(model: RoomModel, input: Extract<RoomInput, { type: "hydrate" }>, at: number): RoomModel {
  const keys = input.agents.map((agent) => agentKey(model.room, agent.id));
  const agents = input.agents.map((seed, index): AgentRuntime => {
    const key = keys[index]!;
    const kept = model.agents.find((agent) => agent.key === key);
    if (kept) return { ...kept, name: seed.name };
    const run = seed.lastRun;
    const running = run?.status === "running";
    return {
      key,
      id: seed.id,
      name: seed.name,
      running,
      runId: run?.id ?? 0,
      lastActive: running ? at : run ? parseTime(run.endedAt ?? run.startedAt) : Number.NEGATIVE_INFINITY,
      question: run?.status === "failed" ? "failed" : null,
      typingUntil: 0,
      thought: null,
      trips: [],
    };
  });
  const approvals: Record<number, ApprovalState> = {};
  for (const approval of input.approvals) {
    if (approval.room !== model.room) continue;
    approvals[approval.id] = {
      agentKey: agentKey(approval.room, approval.agentId),
      status: approval.status,
      shownAt: model.approvals[approval.id]?.shownAt ?? Number.NEGATIVE_INFINITY,
    };
  }
  const sameKeys = keys.length === model.agents.length && keys.every((key, index) => key === model.agents[index]?.key);
  return { ...model, layout: sameKeys ? model.layout : layoutRoom(keys), agents, approvals };
}

/** Feeds one entity of the stream (or a snapshot) to the model, at time `at`. */
export function applyInput(model: RoomModel, input: RoomInput, at: number): RoomModel {
  switch (input.type) {
    case "hydrate":
      return applyHydrate(model, input, at);
    case "run":
      return applyRun(model, input.run, at);
    case "event":
      return applyEvent(model, input.event, at);
    case "approval":
      return applyApproval(model, input.approval, at);
  }
}

// ---- Reading the room ---------------------------------------------------------------

/** What an agent is doing, without any wording. */
export type AgentStatus =
  | { kind: "asleep" }
  | { kind: "seated" }
  | { kind: "typing" }
  | { kind: "thinking" }
  | { kind: "visiting"; target: string }
  | { kind: "talking"; target: string }
  | { kind: "carrying" }
  | { kind: "dropping" }
  | { kind: "returning" }
  | { kind: "failed" }
  | { kind: "blocked" };

/** The coarse state announced to a screen reader: it changes far less often than `AgentStatus`. */
export type Coarse =
  | { kind: "asleep" }
  | { kind: "working" }
  | { kind: "visiting"; target: string }
  | { kind: "carrying" }
  | { kind: "stuck" };

export type Bubble = { kind: "thought"; text: string } | { kind: "question" } | { kind: "talk" } | { kind: "zzz" };

export type AgentView = {
  key: string;
  id: string;
  name: string;
  /** Position in the room: the order of the desks, which also picks the tint. */
  index: number;
  x: number;
  y: number;
  facing: 1 | -1;
  /** 1 normally, less during the fade of a reduced-motion move. */
  alpha: number;
  pose: Pose;
  /** Row of the character sheet, and frame in it. */
  row: number;
  frame: number;
  /** At its desk (drawn behind the desk) rather than walking around (drawn on top). */
  seated: boolean;
  carrying: boolean;
  bubble: Bubble | null;
  status: AgentStatus;
  coarse: Coarse;
};

export type RoomView = {
  layout: RoomLayout;
  agents: AgentView[];
  /** Items in the tray, counting only the folders already dropped. */
  pending: number;
  /** Frames per second the drawing needs right now: 0 when nothing moves. */
  fps: number;
  /** The next time something changes by itself (a bubble ends, a trip stage ends, sleep begins), or Infinity. */
  nextChangeAt: number;
};

const ease = (value: number): number => {
  const t = Math.min(1, Math.max(0, value));
  return t * t * (3 - 2 * t);
};
const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

type TripPose = {
  x: number;
  y: number;
  facing: 1 | -1;
  alpha: number;
  stage: "out" | "stay" | "back";
  carrying: boolean;
};

/** Where a trip puts the character at `at` (the trip is in progress). */
function tripPose(trip: Trip, at: number, reduced: boolean): TripPose {
  const t = at - trip.start;
  const arrival = sign(trip.to.x - trip.from.x, trip.faceStay);
  const leg = (progress: number, from: Point, to: Point, facing: 1 | -1) => {
    if (!reduced) {
      const p = lerp(from, to, ease(progress));
      return { x: p.x, y: p.y, facing, alpha: 1 };
    }
    // Reduced motion: the character fades out where it is and fades in where it goes.
    const half = FADE_MS / 2;
    const elapsed = progress * trip.legMs;
    const middle = trip.legMs / 2;
    const alpha = Math.min(1, Math.abs(elapsed - middle) / half);
    const p = elapsed < middle ? from : to;
    return { x: p.x, y: p.y, facing: facing, alpha };
  };
  const dropped = t - trip.legMs >= FOLDER_DROP_MS;
  if (t < trip.legMs) {
    return { ...leg(t / trip.legMs, trip.from, trip.to, arrival), stage: "out", carrying: trip.kind === "submit" };
  }
  if (t < trip.legMs + trip.stayMs) {
    return {
      x: trip.to.x,
      y: trip.to.y,
      facing: trip.faceStay,
      alpha: 1,
      stage: "stay",
      carrying: trip.kind === "submit" && !dropped,
    };
  }
  const back = (t - trip.legMs - trip.stayMs) / trip.legMs;
  return { ...leg(back, trip.to, trip.from, (arrival === 1 ? -1 : 1) as 1 | -1), stage: "back", carrying: false };
}

const isAwake = (agent: AgentRuntime, at: number): boolean => agent.running || at - agent.lastActive < ASLEEP_AFTER_MS;

function viewAgent(agent: AgentRuntime, index: number, spot: DeskSpot, at: number, reduced: boolean): AgentView {
  const base = { key: agent.key, id: agent.id, name: agent.name, index };
  const phase = index * 137;
  const trip = agent.trips.find((candidate) => at >= candidate.start && at < tripEnd(candidate));
  const make = (
    pose: Pose,
    status: AgentStatus,
    coarse: Coarse,
    bubble: Bubble | null,
    where: { x: number; y: number; facing?: 1 | -1; alpha?: number } = spot.seat,
    extra: { seated?: boolean; carrying?: boolean } = {},
  ): AgentView => ({
    ...base,
    x: where.x,
    y: where.y,
    facing: where.facing ?? 1,
    alpha: where.alpha ?? 1,
    pose,
    row: POSES[pose].row,
    frame: poseFrame(pose, at, phase, reduced),
    seated: extra.seated ?? true,
    carrying: extra.carrying ?? false,
    bubble,
    status,
    coarse,
  });

  if (trip) {
    const at2 = tripPose(trip, at, reduced);
    const target = trip.targetName ?? "";
    const coarse: Coarse = trip.kind === "visit" ? { kind: "visiting", target } : { kind: "carrying" };
    const extra = { seated: false, carrying: at2.carrying };
    if (at2.stage === "out") {
      return make("walk", trip.kind === "visit" ? { kind: "visiting", target } : { kind: "carrying" }, coarse, null, at2, extra);
    }
    if (at2.stage === "stay") {
      return trip.kind === "visit"
        ? make("stand", { kind: "talking", target }, coarse, { kind: "talk" }, at2, extra)
        : make("stand", { kind: "dropping" }, coarse, null, at2, extra);
    }
    return make("walk", { kind: "returning" }, coarse, null, at2, extra);
  }
  if (agent.question) {
    return make("sit", { kind: agent.question }, { kind: "stuck" }, { kind: "question" });
  }
  if (agent.thought && at < agent.thought.until) {
    return make("think", { kind: "thinking" }, { kind: "working" }, { kind: "thought", text: agent.thought.text });
  }
  if (at < agent.typingUntil) return make("type", { kind: "typing" }, { kind: "working" }, null);
  if (isAwake(agent, at)) return make("sit", { kind: "seated" }, { kind: "working" }, null);
  return make("sleep", { kind: "asleep" }, { kind: "asleep" }, { kind: "zzz" });
}

/** The number of items shown in the tray at `at`. */
export function pendingShown(model: RoomModel, at: number): number {
  return Object.values(model.approvals).filter((approval) => approval.status === "pending" && approval.shownAt <= at).length;
}

/** The earliest time after `at` at which something changes without any new input. */
export function nextChangeAt(model: RoomModel, at: number): number {
  let next = Number.POSITIVE_INFINITY;
  const consider = (time: number) => {
    if (time > at && time < next) next = time;
  };
  for (const agent of model.agents) {
    consider(agent.typingUntil);
    if (agent.thought) consider(agent.thought.until);
    if (!agent.running) consider(agent.lastActive + ASLEEP_AFTER_MS);
    for (const trip of agent.trips) {
      consider(trip.start);
      consider(trip.start + trip.legMs);
      consider(trip.start + trip.legMs + FOLDER_DROP_MS);
      consider(trip.start + trip.legMs + trip.stayMs);
      consider(tripEnd(trip));
    }
  }
  for (const approval of Object.values(model.approvals)) consider(approval.shownAt);
  return next;
}

/** Idle redraw rate: slow animations (typing, thinking, sleeping) and the coffee steam. */
export const IDLE_FPS = 10;
export const MOVE_FPS = 60;

/**
 * The room at time `at`. With `reduced` (prefers-reduced-motion) nobody walks:
 * poses are held on their first frame and a move is a crossfade, so only a
 * fade asks for frames, and the rest of the time the room is redrawn when its
 * state changes (see `nextChangeAt`).
 */
export function snapshotRoom(model: RoomModel, at: number, reduced = false): RoomView {
  const agents = model.agents.map((agent, index) => {
    const spot = deskOf(model.layout, agent.key);
    return spot ? viewAgent(agent, index, spot, at, reduced) : null;
  });
  const views = agents.filter((view): view is AgentView => view !== null);
  // With reduced motion a "walk" is only the crossfade of a move, which still asks for frames.
  const moving = views.some((view) => view.pose === "walk");
  return {
    layout: model.layout,
    agents: views,
    pending: pendingShown(model, at),
    fps: moving ? MOVE_FPS : reduced ? 0 : IDLE_FPS,
    nextChangeAt: nextChangeAt(model, at),
  };
}
