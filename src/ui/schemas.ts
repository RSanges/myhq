import { z } from "zod";
import { annotationSchema } from "@/server/annotations";
import { decisionRecordSchema } from "@/server/decision-history";
import { DEFAULT_FLOOR_LAYOUT, FLOOR_LAYOUTS } from "./floor-mode";

// Shapes received from the HTTP API (docs/api.md), validated before use.

export const runStatusSchema = z.enum(["running", "done", "failed", "cancelled"]);
export const approvalStatusSchema = z.enum(["pending", "approved", "rejected", "revise", "unseen", "seen"]);

export const runSchema = z.object({
  id: z.number().int(),
  room: z.string(),
  agentId: z.string(),
  engine: z.string(),
  task: z.string(),
  status: runStatusSchema,
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationInputTokens: z.number(),
  cacheReadInputTokens: z.number(),
  costUsd: z.number(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  summary: z.string().nullable(),
  reason: z.string().nullable().optional(),
});

export const eventSchema = z.object({
  id: z.number().int(),
  runId: z.number().int(),
  room: z.string(),
  agentId: z.string(),
  type: z.enum(["start", "text", "tool_call", "tool_result", "end"]),
  data: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});

export const messageSchema = z.object({
  id: z.number().int(),
  room: z.string(),
  from: z.string(),
  to: z.string(),
  /** Room of the recipient when it is not `room` (an order to a shared room, or its answer). */
  toRoom: z.string().nullable().optional(),
  text: z.string(),
  runId: z.number().int().nullable(),
  createdAt: z.string(),
});

/** A file joined to an item by its agent (hq_submit `attachments`), served at `url`. */
export const approvalFileSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  mime: z.string(),
  kind: z.enum(["video", "image", "audio", "model", "pdf"]),
  size: z.number(),
  sha256: z.string(),
  caption: z.string().nullable(),
  url: z.string(),
});
export type ApprovalFile = z.infer<typeof approvalFileSchema>;

export const approvalSchema = z.object({
  id: z.number().int(),
  room: z.string(),
  agentId: z.string(),
  runId: z.number().int().nullable(),
  type: z.string(),
  title: z.string(),
  body: z.string(),
  payload: z.record(z.string(), z.unknown()),
  status: approvalStatusSchema,
  decisionNote: z.string().nullable(),
  annotations: z.array(annotationSchema).default([]),
  decisionHistory: z.array(decisionRecordSchema).default([]),
  actionDone: z.boolean().default(false),
  informational: z.boolean().default(false),
  /** The room that ordered it from a shared room: its pile and its colour. `room` stays the producing agent's. */
  forRoom: z.string().nullable().optional(),
  /** Absent from the items built before files existed (and in the tests that build items by hand). */
  files: z.array(approvalFileSchema).optional(),
  decidedAt: z.string().nullable(),
  createdAt: z.string(),
});

export const routineSchema = z.object({
  cron: z.string(),
  task: z.string().nullable(),
  nextAt: z.string().nullable(),
});

export const agentSchema = z.object({
  id: z.string(),
  name: z.string(),
  model: z.string(),
  role: z.string(),
  allowedTools: z.array(z.string()).default([]),
  /** URL of the agent's old top-down sheet, or null (no longer drawn). */
  sprite: z.string().nullable().default(null),
  /** URL of the agent's iso character sheet; null or absent: a neutral person. */
  isoSprite: z.string().nullable().optional(),
  /** Voxels per walk frame declared next to the iso sheet (`iso.json`); null or absent: the default of 3. */
  isoStride: z.number().int().positive().nullable().optional(),
  armed: z.boolean().default(false),
  routines: z.array(routineSchema).default([]),
  /** Shared resources its runs hold (room.json `resources`). */
  resources: z.array(z.string()).optional(),
  /** Its resources another run held while its work waited, when the state was read. */
  waitingFor: z.array(z.string()).optional(),
  lastRun: runSchema.nullable(),
});

export const firingSchema = z.object({
  id: z.number().int(),
  room: z.string(),
  agentId: z.string(),
  cron: z.string(),
  task: z.string().nullable(),
  scheduledAt: z.string(),
  outcome: z.enum(["started", "skipped_busy", "skipped_cap", "skipped_unarmed", "error"]),
  runId: z.number().int().nullable(),
  detail: z.string().nullable(),
  createdAt: z.string(),
});

export const schedulerSchema = z.object({ enabled: z.boolean(), running: z.boolean(), timeZone: z.string() });
const schedulerOff = { enabled: false, running: false, timeZone: "UTC" };

/** The floor that draws the receptionist (the onboarding agent), its own sheet, and its latest runs, newest first. */
export const receptionSchema = z.object({ room: z.string().nullable(), sprite: z.string().nullable(), runs: z.array(runSchema) });

/** How /room draws the home; an unknown layout (a newer server) falls back to the default. */
export const floorSchema = z.object({ layout: z.enum(FLOOR_LAYOUTS).catch(DEFAULT_FLOOR_LAYOUT) });

export const stateSchema = z.object({
  cursor: z.number().int(),
  rooms: z.array(z.object({ name: z.string(), color: z.string().nullable().default(null), agents: z.array(agentSchema) })),
  invalidRooms: z.array(z.object({ room: z.string(), error: z.string() })),
  reception: receptionSchema.default({ room: null, sprite: null, runs: [] }),
  floor: floorSchema.default({ layout: DEFAULT_FLOOR_LAYOUT }),
  scheduler: schedulerSchema.default(schedulerOff),
  firings: z.array(firingSchema).default([]),
  approvals: z.object({
    pending: z.array(approvalSchema),
    unseen: z.array(approvalSchema).default([]),
    history: z.array(approvalSchema),
  }),
  recent: z.object({ events: z.array(eventSchema), messages: z.array(messageSchema) }),
});

const totalsSchema = z.object({
  runs: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationInputTokens: z.number(),
  cacheReadInputTokens: z.number(),
  costUsd: z.number(),
});

const agentTotalsSchema = totalsSchema.extend({ room: z.string(), agentId: z.string() });
const chatTotalsSchema = z.object({
  turns: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationInputTokens: z.number(),
  cacheReadInputTokens: z.number(),
  costUsd: z.number(),
  toolCalls: z.number(),
});

export const usageSchema = z.object({
  today: totalsSchema,
  week: totalsSchema,
  cap: z.object({ maxRunsPerDay: z.number(), runsToday: z.number(), remaining: z.number() }),
  budget: z.object({ weeklyUsd: z.number(), spentUsd: z.number(), share: z.number() }).nullable().default(null),
  agents: z.object({ today: z.array(agentTotalsSchema), week: z.array(agentTotalsSchema) }).nullable().default(null),
  chat: z.object({ today: chatTotalsSchema, week: chatTotalsSchema }).nullable().default(null),
});

export const routinesResponseSchema = z.object({ scheduler: schedulerSchema, firings: z.array(firingSchema) });
export const armResponseSchema = z.object({ agent: z.object({ room: z.string(), id: z.string(), armed: z.boolean() }) });

export const errorBodySchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
export const runResponseSchema = z.object({ run: runSchema });
export const approvalResponseSchema = z.object({ approval: approvalSchema });
/** The answer to « Demander à Rom2 »: the chat's reply (or why it did not answer), and the item as it is now. */
export const itemAskResponseSchema = z.object({
  ok: z.boolean(),
  reply: z.string(),
  approval: approvalSchema,
});
/** An item of a selection list (a task list in a reply of the chat). */
const choiceSchema = z.object({ id: z.string().nullable(), label: z.string() });
export const chatMessageSchema = z.object({
  id: z.number().int(),
  role: z.enum(["user", "assistant", "bot"]),
  kind: z.string().nullable(),
  channel: z.enum(["telegram", "desk"]),
  to: z.object({ room: z.string(), agent: z.string() }).nullable(),
  text: z.string(),
  choices: z.array(choiceSchema).nullable().default(null),
  createdAt: z.string(),
});

export const chatTurnSchema = z.object({
  running: z.boolean(),
  queued: z.number().int(),
  pendingConfirmation: z.object({ summary: z.string() }).nullable(),
});

/** The `chat` message of the stream. */
export const chatEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message"), message: chatMessageSchema }),
  z.object({ type: z.literal("cleared") }),
  z.object({ type: z.literal("turn"), turn: chatTurnSchema }),
]);

export const chatHistorySchema = z.object({ messages: z.array(chatMessageSchema), turn: chatTurnSchema });

export const chatReplySchema = z.object({
  ok: z.boolean(),
  reply: z.string(),
  pendingConfirmation: z.object({ summary: z.string() }).optional(),
  choices: z.array(choiceSchema).optional(),
  messages: z.array(chatMessageSchema),
  dispatch: z.object({ run: runSchema }).optional(),
});

export const clearedSchema = z.object({ cleared: z.boolean() });

export const readySchema = z.object({ cursor: z.number().int() });

/** An object of the desk (GET /api/desk). */
export const deskObjectKindSchema = z.enum(["pile", "tray", "newspaper", "postits", "calendar", "phone"]);
const deskRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("approval"),
    id: z.number().int(),
    room: z.string(),
    agentId: z.string(),
    type: z.string(),
    status: z.string(),
    forRoom: z.string().nullable().optional(),
  }),
  z.object({ kind: z.literal("run"), id: z.number().int(), room: z.string(), agentId: z.string() }),
  z.object({ kind: z.literal("chat"), id: z.number().int(), role: z.string() }),
]);
export const deskItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  at: z.string().nullable(),
  end: z.string().nullable(),
  allDay: z.boolean(),
  href: z.string().nullable(),
  tone: z.enum(["neutral", "info", "warn", "alert", "muted"]).nullable(),
  color: z.string().nullable(),
  ref: deskRefSchema.nullable(),
});
export const deskObjectSchema = z.object({
  id: z.string(),
  object: deskObjectKindSchema,
  label: z.string(),
  source: z.string(),
  status: z.enum(["ok", "error"]),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  count: z.number().int(),
  items: z.array(deskItemSchema),
  slots: z.array(z.object({ start: z.string(), end: z.string(), label: z.string().nullable() })).nullable(),
  note: z.string().nullable(),
  spines: z.array(z.object({ approvalId: z.number().int(), room: z.string(), color: z.string().nullable() })).nullable(),
  updatedAt: z.string(),
});
export const deskSchema = z.object({ objects: z.array(deskObjectSchema), configError: z.string().nullable() });

/** The `desk` message of the stream: a count changed. */
export const deskEventSchema = z.object({
  objects: z.array(z.object({ id: z.string(), count: z.number().int(), status: z.enum(["ok", "error"]) })),
  at: z.string(),
});

export type DeskObject = z.infer<typeof deskObjectSchema>;
export type DeskItem = z.infer<typeof deskItemSchema>;
export type Desk = z.infer<typeof deskSchema>;
export type DeskSignal = { type: "counts"; counts: z.infer<typeof deskEventSchema> } | { type: "ready" };

export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatTurn = z.infer<typeof chatTurnSchema>;
export type ChatReply = z.infer<typeof chatReplySchema>;
/** What the chat listeners of `useHq` receive: an event of the stream, or the stream (re)opening. */
export type ChatSignal = z.infer<typeof chatEventSchema> | { type: "ready" };
export type Run = z.infer<typeof runSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type HqEvent = z.infer<typeof eventSchema>;
export type Message = z.infer<typeof messageSchema>;
export type Approval = z.infer<typeof approvalSchema>;
export type Agent = z.infer<typeof agentSchema>;
export type State = z.infer<typeof stateSchema>;
export type Usage = z.infer<typeof usageSchema>;
export type Reception = z.infer<typeof receptionSchema>;
export type Firing = z.infer<typeof firingSchema>;
export type Scheduler = z.infer<typeof schedulerSchema>;
export type Routine = z.infer<typeof routineSchema>;
