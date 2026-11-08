import { z } from "zod";
import { DEFAULT_FLOOR_LAYOUT, type FloorLayoutMode } from "./floor-mode";
import { RECEPTION_AGENT, RECEPTION_ROOM } from "./reception";
import type { Agent, AgentRoutines, Approval, Firing, HqEvent, Message, Reception, Run, Scheduler, State, Usage } from "./schemas";
import { strings } from "./strings";

// Pure state of the page: a snapshot from /api/state, then upserts from the SSE
// stream (every message is "upsert this entity by id", see docs/api.md).

export const MAX_EVENTS = 300;
export const MAX_MESSAGES = 150;
export const MAX_HISTORY = 100;
/** Onboarding runs kept for the sheet of the receptionist. */
export const MAX_RECEPTION_RUNS = 8;

export type Model = {
  loaded: boolean;
  cursor: number;
  rooms: State["rooms"];
  invalidRooms: State["invalidRooms"];
  /** The floor of the receptionist, its own sheet, and the latest onboarding runs, newest first. */
  reception: Reception;
  /** How /room draws the home (myhq.json `floor.layout`). */
  floorLayout: FloorLayoutMode;
  /** The person seated in the user's own office of the single floor (myhq.json `floor.owner`), or null. */
  floorOwner: State["floor"]["owner"];
  latestRuns: Record<string, Run>;
  approvals: Record<number, Approval>;
  events: HqEvent[];
  messages: Message[];
  usage: Usage | null;
  scheduler: Scheduler;
  /** Routine firings, newest first. */
  firings: Firing[];
};

export type Action =
  | { type: "state"; state: State }
  | { type: "usage"; usage: Usage }
  | { type: "run"; run: Run }
  | { type: "event"; event: HqEvent }
  | { type: "message"; message: Message }
  | { type: "approval"; approval: Approval }
  | { type: "routines"; scheduler: Scheduler; firings: Firing[]; agents?: AgentRoutines[] }
  | { type: "armed"; room: string; agentId: string; armed: boolean };

export const initialModel: Model = {
  loaded: false,
  cursor: 0,
  rooms: [],
  invalidRooms: [],
  reception: { room: null, sprite: null, runs: [] },
  floorLayout: DEFAULT_FLOOR_LAYOUT,
  floorOwner: null,
  latestRuns: {},
  approvals: {},
  events: [],
  messages: [],
  usage: null,
  scheduler: { enabled: false, running: false, timeZone: "UTC" },
  firings: [],
};

export const agentKey = (room: string, agentId: string): string => `${room}/${agentId}`;

/** Replaces the item with the same id or inserts it in id order, keeping the `max` newest. */
export function upsertById<T extends { id: number }>(list: T[], item: T, max: number): T[] {
  const index = list.findIndex((existing) => existing.id === item.id);
  if (index >= 0) {
    const next = list.slice();
    next[index] = item;
    return next;
  }
  const next = [...list, item].sort((a, b) => a.id - b.id);
  return next.length > max ? next.slice(next.length - max) : next;
}

function indexApprovals(lists: Approval[][]): Record<number, Approval> {
  const out: Record<number, Approval> = {};
  for (const list of lists) for (const approval of list) out[approval.id] = approval;
  return out;
}

export function reducer(model: Model, action: Action): Model {
  switch (action.type) {
    case "state": {
      const { state } = action;
      const latestRuns: Record<string, Run> = {};
      for (const room of state.rooms) {
        for (const agent of room.agents) {
          if (agent.lastRun) latestRuns[agentKey(room.name, agent.id)] = agent.lastRun;
        }
      }
      return {
        ...model,
        loaded: true,
        cursor: state.cursor,
        rooms: state.rooms,
        invalidRooms: state.invalidRooms,
        reception: state.reception,
        floorLayout: state.floor.layout,
        floorOwner: state.floor.owner,
        latestRuns,
        approvals: indexApprovals([state.approvals.pending, state.approvals.unseen, state.approvals.history]),
        events: state.recent.events,
        messages: state.recent.messages,
        scheduler: state.scheduler,
        firings: state.firings,
      };
    }
    case "routines": {
      // The routines of each agent as of now: their next fire moves on once one has come, `armed` may have
      // changed from Telegram. An agent the refresh does not list keeps what it had.
      const fresh = new Map((action.agents ?? []).map((entry) => [agentKey(entry.room, entry.agentId), entry]));
      const rooms =
        fresh.size === 0
          ? model.rooms
          : model.rooms.map((room) => ({
              ...room,
              agents: room.agents.map((agent) => {
                const entry = fresh.get(agentKey(room.name, agent.id));
                return entry ? { ...agent, armed: entry.armed, routines: entry.routines } : agent;
              }),
            }));
      return { ...model, rooms, scheduler: action.scheduler, firings: action.firings };
    }
    case "armed":
      return {
        ...model,
        rooms: model.rooms.map((room) =>
          room.name !== action.room
            ? room
            : {
                ...room,
                agents: room.agents.map((agent) =>
                  agent.id === action.agentId ? { ...agent, armed: action.armed } : agent,
                ),
              },
        ),
      };
    case "usage":
      return { ...model, usage: action.usage };
    case "run": {
      const key = agentKey(action.run.room, action.run.agentId);
      const current = model.latestRuns[key];
      if (current && current.id > action.run.id) return model;
      const next = { ...model, latestRuns: { ...model.latestRuns, [key]: action.run } };
      if (action.run.room !== RECEPTION_ROOM || action.run.agentId !== RECEPTION_AGENT) return next;
      const runs = upsertById(model.reception.runs.slice().reverse(), action.run, MAX_RECEPTION_RUNS).reverse();
      return { ...next, reception: { ...model.reception, runs } };
    }
    case "event":
      return { ...model, events: upsertById(model.events, action.event, MAX_EVENTS) };
    case "message":
      return { ...model, messages: upsertById(model.messages, action.message, MAX_MESSAGES) };
    case "approval":
      return { ...model, approvals: { ...model.approvals, [action.approval.id]: action.approval } };
  }
}

export type AgentState = "working" | "idle" | "failed";

/** Computed from the latest run, like the server does. */
export function agentState(lastRun: Run | null | undefined): AgentState {
  if (lastRun?.status === "running") return "working";
  if (lastRun?.status === "failed") return "failed";
  return "idle";
}

export type TeamAgent = Agent & { room: string; key: string; state: AgentState; color: string | null };

export function selectAgents(model: Model): TeamAgent[] {
  const agents = model.rooms.flatMap((room) =>
    room.agents.map((agent) => {
      const key = agentKey(room.name, agent.id);
      const lastRun = model.latestRuns[key] ?? null;
      return { ...agent, lastRun, room: room.name, key, state: agentState(lastRun), color: room.color };
    }),
  );
  return agents.map((agent) => (agent.waitingFor?.length ? { ...agent, waitingFor: resourceWait(agent, agents) } : agent));
}

/**
 * The shared resources an agent waits for (« en attente du GPU »): the ones
 * the state said another run held, as long as an agent holding one of them is
 * still working. Nothing while the agent works itself.
 */
export function resourceWait(agent: TeamAgent, agents: readonly TeamAgent[]): string[] {
  if (agent.state === "working") return [];
  return (agent.waitingFor ?? []).filter((resource) =>
    agents.some((other) => other.key !== agent.key && other.state === "working" && (other.resources ?? []).includes(resource)),
  );
}

/** Pending items, oldest first. */
export function selectPending(model: Model): Approval[] {
  return Object.values(model.approvals)
    .filter((approval) => approval.status === "pending")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
}

/** Informational items waiting for a look (« À regarder »), oldest first. */
export function selectUnseen(model: Model): Approval[] {
  return Object.values(model.approvals)
    .filter((approval) => approval.status === "unseen")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
}

/** Handled items, most recently handled first. */
export function selectHistory(model: Model): Approval[] {
  return Object.values(model.approvals)
    .filter((approval) => approval.status !== "pending" && approval.status !== "unseen")
    .sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? "") || b.id - a.id)
    .slice(0, MAX_HISTORY);
}

export type FeedEntry =
  | { key: string; at: string; room: string; kind: "event"; event: HqEvent }
  | { key: string; at: string; room: string; kind: "message"; message: Message };

/** Events and messages merged, newest first, optionally limited to one agent (`room/agent`). */
export function buildFeed(events: HqEvent[], messages: Message[], filter: string | null): FeedEntry[] {
  const entries: FeedEntry[] = [];
  for (const event of events) {
    if (filter !== null && agentKey(event.room, event.agentId) !== filter) continue;
    entries.push({ key: `event:${event.id}`, at: event.createdAt, room: event.room, kind: "event", event });
  }
  for (const message of messages) {
    if (
      filter !== null &&
      agentKey(message.room, message.from) !== filter &&
      agentKey(message.toRoom ?? message.room, message.to) !== filter
    ) {
      continue;
    }
    entries.push({ key: `message:${message.id}`, at: message.createdAt, room: message.room, kind: "message", message });
  }
  return entries.sort((a, b) => b.at.localeCompare(a.at) || b.key.localeCompare(a.key));
}

// What an event says, without any wording (the wording lives in strings.ts).

const textData = z.object({ text: z.string() });
const startData = z.object({ model: z.string().nullable().optional(), reason: z.string().optional() });
const toolCallData = z.object({ name: z.string(), input: z.unknown().optional() });
const toolResultData = z.object({ isError: z.boolean().optional(), content: z.string().optional() });
const endData = z.object({
  status: z.enum(["done", "failed"]).optional(),
  summary: z.string().optional(),
  costUsd: z.number().optional(),
});

export type EventView =
  | { kind: "start"; model: string | null; reason: string | null }
  | { kind: "text"; text: string }
  | { kind: "tool_call"; name: string; input: string }
  | { kind: "tool_result"; isError: boolean; content: string }
  | { kind: "end"; status: "done" | "failed" | null; summary: string; costUsd: number | null }
  | { kind: "unknown"; type: string };

function compactJson(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

export function viewEvent(event: HqEvent): EventView {
  const unknown: EventView = { kind: "unknown", type: event.type };
  switch (event.type) {
    case "start": {
      const parsed = startData.safeParse(event.data);
      return parsed.success
        ? { kind: "start", model: parsed.data.model ?? null, reason: parsed.data.reason ?? null }
        : unknown;
    }
    case "text": {
      const parsed = textData.safeParse(event.data);
      return parsed.success ? { kind: "text", text: parsed.data.text } : unknown;
    }
    case "tool_call": {
      const parsed = toolCallData.safeParse(event.data);
      return parsed.success
        ? { kind: "tool_call", name: parsed.data.name, input: compactJson(parsed.data.input) }
        : unknown;
    }
    case "tool_result": {
      const parsed = toolResultData.safeParse(event.data);
      return parsed.success
        ? { kind: "tool_result", isError: parsed.data.isError ?? false, content: parsed.data.content ?? "" }
        : unknown;
    }
    case "end": {
      const parsed = endData.safeParse(event.data);
      return parsed.success
        ? {
            kind: "end",
            status: parsed.data.status ?? null,
            summary: parsed.data.summary ?? "",
            costUsd: parsed.data.costUsd ?? null,
          }
        : unknown;
    }
  }
}

/** The `url` of an approval payload, only when it is a plain http(s) link. */
export function payloadUrl(payload: Record<string, unknown>): string | null {
  const raw = payload.url;
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** File name of a role path like `rooms/demo/roles/scout.md`. */
export function roleFileName(role: string): string {
  return role.split("/").pop() ?? role;
}

/** The tab title: the items to validate and the items to look at are counted apart. */
export function pendingTitle(base: string, pending: number, unseen = 0): string {
  const counts = [pending > 0 ? `(${pending})` : null, unseen > 0 ? `(${strings.app.watchCount(unseen)})` : null];
  return [...counts.filter((count) => count !== null), base].join(" ");
}

/** The label of an item type: the French one when the type is known, else the type with spaces. */
export function typeLabel(type: string): string {
  return strings.desk.typeLabels[type] ?? type.replace(/_/g, " ");
}

/** Item types whose payload may carry a local branch to push (a dev agent never pushes). */
export const BRANCH_TYPES = ["pull_request", "blog_post"] as const;

const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;
const SHA = /^[0-9a-f]{7,40}$/i;

/** A text made safe inside double quotes in sh, PowerShell and cmd: one line, no quote, no expansion. */
function shellText(text: string, max: number): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/["`$\%!]/g, "'")
    .trim()
    .slice(0, max);
}

export type BranchHandover = { branch: string; sha: string | null; commands: string };

/**
 * The branch of an approved pull request or blog post: the agent committed it
 * in its worktree and never pushes, so the user pushes it and opens the pull
 * request himself, from the target repository.
 */
export function branchHandover(approval: Pick<Approval, "type" | "title" | "payload">): BranchHandover | null {
  if (!(BRANCH_TYPES as readonly string[]).includes(approval.type)) return null;
  const { branch, sha, title, summary } = approval.payload;
  if (typeof branch !== "string" || !BRANCH.test(branch)) return null;
  const prTitle = shellText(typeof title === "string" && title.trim() ? title : approval.title, 200);
  const body = shellText(typeof summary === "string" && summary.trim() ? summary : prTitle, 2000);
  return {
    branch,
    sha: typeof sha === "string" && SHA.test(sha) ? sha : null,
    commands: [
      `git push -u origin ${branch}`,
      `gh pr create --head ${branch} --title "${prTitle}" --body "${body}"`,
    ].join("\n"),
  };
}

/**
 * The title shown for an item on the desk. A room proposal shows the UI string
 * for its room, so that an English title from an older proposal still reads
 * fine; every other item shows the title its agent gave it.
 */
export function approvalTitle(approval: Pick<Approval, "type" | "title" | "payload">): string {
  if (approval.type !== "room_proposal") return approval.title;
  const { room } = approval.payload;
  const name = room && typeof room === "object" && "name" in room && typeof room.name === "string" ? room.name.trim() : "";
  return name ? strings.desk.roomProposalTitle(name) : approval.title;
}

/**
 * The "HQ agents" block of an approved room proposal, for the project's
 * CLAUDE.md: MyHQ never writes it in the target repository, the user adds it.
 */
export function claudeMdHandover(approval: Pick<Approval, "type" | "payload">): { text: string; targetRepo: string } | null {
  if (approval.type !== "room_proposal") return null;
  const { claudeMd, room } = approval.payload;
  if (typeof claudeMd !== "string" || claudeMd.trim() === "") return null;
  const targetRepo =
    room && typeof room === "object" && "targetRepo" in room && typeof room.targetRepo === "string" ? room.targetRepo : "";
  return { text: claudeMd, targetRepo };
}
