import type { z } from "zod";
import type { Annotation } from "@/server/annotations";
import type { Answer } from "@/server/questions";
import { roadmapSchema, type Roadmap } from "@/server/roadmap-schema";
import { settingsResponseSchema, type SettingsView } from "@/server/settings-schema";
import { strings } from "./strings";
import {
  approvalResponseSchema,
  armResponseSchema,
  chatHistorySchema,
  chatReplySchema,
  clearedSchema,
  closeResponseSchema,
  deskActionResponseSchema,
  deskSchema,
  deskSeenSchema,
  dirListingSchema,
  errorBodySchema,
  itemAskResponseSchema,
  relaunchResponseSchema,
  routinesResponseSchema,
  runResponseSchema,
  stateSchema,
  usageSchema,
  type Approval,
  type ChatReply,
  type ChatTurn,
  type Desk,
  type DirListing,
  type Run,
  type State,
  type Usage,
} from "./schemas";

/** An API failure with the stable `code` of docs/api.md, or NETWORK / BAD_RESPONSE. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** The text shown to the user: French, per code, never the English log message. */
  get display(): string {
    if (this.code === "NETWORK") return strings.errors.network;
    if (this.code === "BAD_RESPONSE") return strings.errors.badResponse;
    return strings.errors.byCode[this.code] ?? strings.errors.generic;
  }
}

export function errorText(error: unknown): string {
  return error instanceof ApiError ? error.display : strings.errors.generic;
}

async function request<S extends z.ZodType>(url: string, schema: S, init?: RequestInit): Promise<z.output<S>> {
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store", ...init });
  } catch {
    throw new ApiError("NETWORK", "Network error");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const parsed = errorBodySchema.safeParse(body);
    if (parsed.success) throw new ApiError(parsed.data.error.code, parsed.data.error.message);
    throw new ApiError("BAD_RESPONSE", `HTTP ${response.status}`);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError("BAD_RESPONSE", parsed.error.message);
  return parsed.data;
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const fetchState = (): Promise<State> => request("/api/state", stateSchema);

export const fetchRoadmap = (): Promise<Roadmap> => request("/api/roadmap", roadmapSchema);

export const fetchSettings = async (): Promise<SettingsView> =>
  (await request("/api/settings", settingsResponseSchema)).settings;

/** Saves one group of the settings page and returns every setting as it is now. */
export async function saveSettingsGroup(group: "layout" | "limits" | "notifications" | "rooms", body: unknown): Promise<SettingsView> {
  return (await request(`/api/settings/${group}`, settingsResponseSchema, jsonInit("PUT", body))).settings;
}

export const fetchUsage = (): Promise<Usage> => request("/api/usage", usageSchema);

export const fetchDesk = (): Promise<Desk> => request("/api/desk", deskSchema);

/** The page of a desk object was opened: what its unread sources counted is seen. */
export const markDeskSeen = (id: string) => request(`/api/desk/${encodeURIComponent(id)}/seen`, deskSeenSchema, { method: "POST" });

/** An action of a desk object: a new item (`add`, its text) or an item done (`done`, its id). */
/** `keepalive`: the request outlives the page (an action sent as the owner leaves). */
export const runDeskAction = (id: string, action: "add" | "done", body: { text: string } | { id: string }, keepalive = false) =>
  request(`/api/desk/${encodeURIComponent(id)}/actions/${action}`, deskActionResponseSchema, { ...jsonInit("POST", body), keepalive });

/** What the actions of the Standard act on: a task, or a failed or interrupted run and its tasks. */
export type BlockedTarget = { kind: "task" | "run"; id: number };

/** « Relancer »: the tasks go back to pending and the agent is woken at once, or the answer says why it could not be. */
export const relaunchBlocked = (target: BlockedTarget) => request("/api/blocked/relaunch", relaunchResponseSchema, jsonInit("POST", target));

/** « Clore »: the tasks are done, closed by the owner. */
export const closeBlocked = (target: BlockedTarget) => request("/api/blocked/close", closeResponseSchema, jsonInit("POST", target));

export const fetchRoutines = () => request("/api/routines", routinesResponseSchema);

export async function setArmed(room: string, agent: string, armed: boolean): Promise<boolean> {
  const url = `/api/rooms/${encodeURIComponent(room)}/agents/${encodeURIComponent(agent)}`;
  return (await request(url, armResponseSchema, jsonInit("PATCH", { armed }))).agent.armed;
}

export async function startRun(room: string, agent: string, task: string): Promise<Run> {
  const body: { room: string; agent: string; task?: string } = { room, agent };
  if (task.trim() !== "") body.task = task.trim();
  return (await request("/api/runs", runResponseSchema, jsonInit("POST", body))).run;
}

export async function startOnboarding(path: string): Promise<Run> {
  return (await request("/api/onboarding", runResponseSchema, jsonInit("POST", { path: path.trim() }))).run;
}

/** The sub-folders of a folder of the projects root (`path` is relative to the root, empty for the root). */
export const fetchDirs = (path: string): Promise<DirListing> =>
  request(`/api/fs/dirs?path=${encodeURIComponent(path)}`, dirListingSchema);

export const fetchChatHistory = () => request("/api/chat/history?limit=50", chatHistorySchema);

/** Whether a turn of the chat is in progress (the floor's owner types meanwhile), with the least of the history. */
export const fetchChatTurn = async (): Promise<ChatTurn> => (await request("/api/chat/history?limit=1", chatHistorySchema)).turn;

/** Says something to the chat, or, with `to`, gives a task to an agent. */
export const sendChat = (text: string, to?: { room: string; agent: string }): Promise<ChatReply> =>
  request("/api/chat", chatReplySchema, jsonInit("POST", { text, ...(to ? { to } : {}) }));

/** `/new`: the conversation starts over. */
export async function clearChat(): Promise<void> {
  await request("/api/chat/history", clearedSchema, { method: "DELETE" });
}

export type Decision =
  | { decision: "approved"; answers?: Answer[] }
  | { decision: "rejected" | "revise"; note?: string; annotations?: Annotation[] };

export async function decideApproval(id: number, decision: Decision): Promise<Approval> {
  return (await request(`/api/approvals/${id}`, approvalResponseSchema, jsonInit("PATCH", decision))).approval;
}

/** « Vu »: the item leaves « À regarder » and stays in the history. */
export async function markSeen(id: number): Promise<Approval> {
  return (await request(`/api/approvals/${id}/seen`, approvalResponseSchema, { method: "POST" })).approval;
}

/** « Demander à Rom2 »: the request goes to the chat with the item as context; the item is seen once the chat answered. */
export const askAboutItem = (id: number, text: string) =>
  request(`/api/approvals/${id}/ask`, itemAskResponseSchema, jsonInit("POST", { text }));
