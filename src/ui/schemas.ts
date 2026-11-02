import { z } from "zod";

// Shapes received from the HTTP API (docs/api.md), validated before use.

export const runStatusSchema = z.enum(["running", "done", "failed", "cancelled"]);
export const approvalStatusSchema = z.enum(["pending", "approved", "rejected", "revise"]);

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
  text: z.string(),
  runId: z.number().int().nullable(),
  createdAt: z.string(),
});

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
  decidedAt: z.string().nullable(),
  createdAt: z.string(),
});

export const agentSchema = z.object({
  id: z.string(),
  name: z.string(),
  model: z.string(),
  role: z.string(),
  lastRun: runSchema.nullable(),
});

export const stateSchema = z.object({
  cursor: z.number().int(),
  rooms: z.array(z.object({ name: z.string(), agents: z.array(agentSchema) })),
  invalidRooms: z.array(z.object({ room: z.string(), error: z.string() })),
  approvals: z.object({ pending: z.array(approvalSchema), history: z.array(approvalSchema) }),
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

export const usageSchema = z.object({
  today: totalsSchema,
  week: totalsSchema,
  cap: z.object({ maxRunsPerDay: z.number(), runsToday: z.number(), remaining: z.number() }),
});

export const errorBodySchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
export const runResponseSchema = z.object({ run: runSchema });
export const approvalResponseSchema = z.object({ approval: approvalSchema });
export const readySchema = z.object({ cursor: z.number().int() });

export type Run = z.infer<typeof runSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type HqEvent = z.infer<typeof eventSchema>;
export type Message = z.infer<typeof messageSchema>;
export type Approval = z.infer<typeof approvalSchema>;
export type Agent = z.infer<typeof agentSchema>;
export type State = z.infer<typeof stateSchema>;
export type Usage = z.infer<typeof usageSchema>;
