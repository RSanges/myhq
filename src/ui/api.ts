import type { z } from "zod";
import type { Annotation } from "@/server/annotations";
import type { Answer } from "@/server/questions";
import { roadmapSchema, type Roadmap } from "@/server/roadmap-schema";
import {
  deletionCheckResponseSchema,
  roomDeletedResponseSchema,
  settingsResponseSchema,
  type DeletionCheckView,
  type SettingsView,
} from "@/server/settings-schema";
import { strings } from "./strings";
import {
  approvalResponseSchema,
  armResponseSchema,
  askResponseSchema,
  chatHistorySchema,
  chatReplySchema,
  clearedSchema,
  closeResponseSchema,
  deskActionResponseSchema,
  deskSchema,
  deskSeenSchema,
  dirListingSchema,
  discussionClearedSchema,
  errorBodySchema,
  folderListingSchema,
  itemAskResponseSchema,
  liveRoomSchema,
  liveRunSchema,
  orderOpenedSchema,
  proposalResponseSchema,
  queueSchema,
  receivedSchema,
  relaunchResponseSchema,
  reopenResponseSchema,
  routinesResponseSchema,
  runResponseSchema,
  stateSchema,
  subjectResponseSchema,
  subjectsResponseSchema,
  threadSchema,
  usageSchema,
  type AgentQuestion,
  type Approval,
  type ChatReply,
  type ChatTurn,
  type Desk,
  type DirListing,
  type FolderListing,
  type LiveRoom,
  type LiveRun,
  type Queue,
  type Run,
  type State,
  type Subject,
  type Thread,
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

export const fetchLiveRoom = (): Promise<LiveRoom> => request("/api/live", liveRoomSchema);

export const fetchLiveRun = (runId: number): Promise<LiveRun> => request(`/api/live/runs/${runId}`, liveRunSchema);

export const fetchSettings = async (): Promise<SettingsView> =>
  (await request("/api/settings", settingsResponseSchema)).settings;

/** Saves one group of the settings page and returns every setting as it is now. */
export async function saveSettingsGroup(group: "layout" | "limits" | "notifications" | "rooms", body: unknown): Promise<SettingsView> {
  return (await request(`/api/settings/${group}`, settingsResponseSchema, jsonInit("PUT", body))).settings;
}

/** A gesture on a room of the settings page; returns every setting as it is now. */
export async function roomGesture(room: string, gesture: "pause" | "resume" | "archive" | "restore"): Promise<SettingsView> {
  return (await request(`/api/rooms/${encodeURIComponent(room)}/${gesture}`, settingsResponseSchema, jsonInit("POST", {}))).settings;
}

/** Removes an agent from its room (room.json only); returns every setting as it is now. */
export async function removeRoomAgent(room: string, agent: string): Promise<SettingsView> {
  return (
    await request(`/api/rooms/${encodeURIComponent(room)}/agents/${encodeURIComponent(agent)}`, settingsResponseSchema, { method: "DELETE" })
  ).settings;
}

export const fetchDeletionCheck = async (room: string): Promise<DeletionCheckView> =>
  (await request(`/api/rooms/${encodeURIComponent(room)}/deletion`, deletionCheckResponseSchema)).check;

/** Deletes a room (its configuration moves to archives/rooms/); `confirm` is its name as typed. */
export const deleteRoom = (room: string, confirm: string) =>
  request(`/api/rooms/${encodeURIComponent(room)}`, roomDeletedResponseSchema, jsonInit("DELETE", { confirm }));

export const fetchUsage = (): Promise<Usage> => request("/api/usage", usageSchema);

export const fetchDesk = (): Promise<Desk> => request("/api/desk", deskSchema);

/** The page of a desk object was opened: what its unread sources counted is seen. */
export const markDeskSeen = (id: string) => request(`/api/desk/${encodeURIComponent(id)}/seen`, deskSeenSchema, { method: "POST" });

/** An action of a desk object: a new item (`add`, its text) or an item done (`done`, its id). */
/** `keepalive`: the request outlives the page (an action sent as the owner leaves). */
export const runDeskAction = (id: string, action: "add" | "done", body: { text: string } | { id: string }, keepalive = false) =>
  request(`/api/desk/${encodeURIComponent(id)}/actions/${action}`, deskActionResponseSchema, { ...jsonInit("POST", body), keepalive });

export const fetchQueue = (): Promise<Queue> => request("/api/queue", queueSchema);

/** Moves a pending task in the queue; returns the queue as it is now. */
export const moveQueued = (taskId: number, move: "first" | "up" | "down" | "auto"): Promise<Queue> =>
  request("/api/queue", queueSchema, jsonInit("POST", { taskId, move }));

/** What the actions of the Standard act on: a task, or a failed or interrupted run and its tasks. */
export type BlockedTarget = { kind: "task" | "run"; id: number };

/** « Relancer »: the tasks go back to pending and the agent is woken at once, or the answer says why it could not be. */
export const relaunchBlocked = (target: BlockedTarget) => request("/api/blocked/relaunch", relaunchResponseSchema, jsonInit("POST", target));

/** « Clore »: the tasks are done, closed by the owner. */
export const closeBlocked = (target: BlockedTarget) => request("/api/blocked/close", closeResponseSchema, jsonInit("POST", target));

/** « Rouvrir » a closure by the supervisor: the entry is back on the Standard as it was, handed to the owner. */
export const reopenClosure = (id: number) => request("/api/blocked/reopen", reopenResponseSchema, jsonInit("POST", { id }));

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

const agentUrl = (room: string, agent: string) => `/api/rooms/${encodeURIComponent(room)}/agents/${encodeURIComponent(agent)}`;
const askUrl = (room: string, agent: string) => `${agentUrl(room, agent)}/ask`;

/** The thread of an agent's sheet in a subject (null: the general one): the discussion, its runs and its items, oldest first, with the tabs. */
export const fetchThread = (room: string, agent: string, subject: number | null = null): Promise<Thread> =>
  request(`${agentUrl(room, agent)}/thread${subject === null ? "" : `?subject=${subject}`}`, threadSchema);

/** Asks an agent a question in a subject (null: the general one): it answers in the background, the discussion shows it. */
export async function askAgent(room: string, agent: string, question: string, subject: number | null = null): Promise<AgentQuestion> {
  const body = { question: question.trim(), ...(subject === null ? {} : { subject }) };
  return (await request(askUrl(room, agent), askResponseSchema, jsonInit("POST", body))).question;
}

/** The archived subjects of an agent, the latest archived first. */
export async function fetchArchivedSubjects(room: string, agent: string): Promise<Subject[]> {
  return (await request(`${agentUrl(room, agent)}/subjects?archived=1`, subjectsResponseSchema)).subjects;
}

/** Opens a new subject with an agent, without a title: the owner's first message in it gives one. */
export async function createSubject(room: string, agent: string): Promise<Subject> {
  return (await request(`${agentUrl(room, agent)}/subjects`, subjectResponseSchema, jsonInit("POST", {}))).subject;
}

/** Renames a subject, archives or reopens it. */
export async function updateSubject(
  room: string,
  agent: string,
  id: number,
  patch: { title?: string; status?: "open" | "archived" },
): Promise<Subject> {
  return (await request(`${agentUrl(room, agent)}/subjects/${id}`, subjectResponseSchema, jsonInit("PATCH", patch))).subject;
}

/**
 * « Lancer le tour » (`launch`) or « On en parle d'abord » (`dismiss`) on the run an answer proposes:
 * the question as it is now, and the run it started.
 */
export async function decideProposal(
  room: string,
  agent: string,
  questionId: number,
  action: "launch" | "dismiss",
): Promise<{ question: AgentQuestion; run: Run | null }> {
  return request(`${askUrl(room, agent)}/${questionId}/proposal`, proposalResponseSchema, jsonInit("POST", { action }));
}

/** « Nouvelle discussion »: the questions leave the sheet (their cost stays metered). */
export async function resetDiscussion(room: string, agent: string): Promise<void> {
  await request(askUrl(room, agent), discussionClearedSchema, { method: "DELETE" });
}

export async function startOnboarding(path: string): Promise<Run> {
  return (await request("/api/onboarding", runResponseSchema, jsonInit("POST", { path: path.trim() }))).run;
}

/** The sub-folders of a folder of the projects root (`path` is relative to the root, empty for the root). */
export const fetchDirs = (path: string): Promise<DirListing> =>
  request(`/api/fs/dirs?path=${encodeURIComponent(path)}`, dirListingSchema);

const folderUrl = (room: string) => `/api/rooms/${encodeURIComponent(room)}/folder`;

/** A directory of a room folder (`path` relative to it, empty for the folder itself); a path to a file lists its directory. */
export const fetchFolder = (room: string, path: string): Promise<FolderListing> =>
  request(`${folderUrl(room)}?path=${encodeURIComponent(path)}`, folderListingSchema);

/** « Nouvelle commande »: opens an order of a room that takes orders. */
export const openFolderOrder = (room: string, client: string, subject: string) =>
  request(`${folderUrl(room)}/orders`, orderOpenedSchema, jsonInit("POST", { client: client.trim(), subject: subject.trim() }));

/**
 * « Déposer des fichiers »: sends files into the `recu/` of a room or of one
 * of its orders. Through XMLHttpRequest, the one browser API that reports the
 * progress of an upload (`onProgress`, from 0 to 1). Fails with an ApiError as
 * the other calls do.
 */
export function uploadReceived(
  room: string,
  order: string | null,
  files: readonly File[],
  onProgress: (share: number) => void,
): Promise<z.output<typeof receivedSchema>> {
  const form = new FormData();
  for (const file of files) form.append("file", file, file.name);
  if (order !== null) form.append("order", order);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${folderUrl(room)}/received`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    xhr.onerror = () => reject(new ApiError("NETWORK", "Network error"));
    xhr.onload = () => {
      let body: unknown;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = undefined;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        const parsed = errorBodySchema.safeParse(body);
        reject(parsed.success ? new ApiError(parsed.data.error.code, parsed.data.error.message) : new ApiError("BAD_RESPONSE", `HTTP ${xhr.status}`));
        return;
      }
      const parsed = receivedSchema.safeParse(body);
      if (parsed.success) resolve(parsed.data);
      else reject(new ApiError("BAD_RESPONSE", parsed.error.message));
    };
    xhr.send(form);
  });
}

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
  | { decision: "rejected"; note?: string; annotations?: Annotation[] }
  | { decision: "revise"; note?: string; annotations?: Annotation[]; answers?: Answer[] };

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
