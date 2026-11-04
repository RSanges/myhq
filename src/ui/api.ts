import type { z } from "zod";
import type { Annotation } from "@/server/annotations";
import { roadmapSchema, type Roadmap } from "@/server/roadmap-schema";
import { strings } from "./strings";
import {
  approvalResponseSchema,
  armResponseSchema,
  chatHistorySchema,
  chatReplySchema,
  clearedSchema,
  errorBodySchema,
  itemAskResponseSchema,
  routinesResponseSchema,
  runResponseSchema,
  stateSchema,
  usageSchema,
  type Approval,
  type ChatReply,
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

export const fetchUsage = (): Promise<Usage> => request("/api/usage", usageSchema);

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

export const fetchChatHistory = () => request("/api/chat/history?limit=50", chatHistorySchema);

/** Says something to the chat, or, with `to`, gives a task to an agent. */
export const sendChat = (text: string, to?: { room: string; agent: string }): Promise<ChatReply> =>
  request("/api/chat", chatReplySchema, jsonInit("POST", { text, ...(to ? { to } : {}) }));

/** `/new`: the conversation starts over. */
export async function clearChat(): Promise<void> {
  await request("/api/chat/history", clearedSchema, { method: "DELETE" });
}

export type Decision =
  | { decision: "approved" }
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
