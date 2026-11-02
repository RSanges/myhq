import path from "node:path";
import type {
  ApprovalRow,
  ApprovalStatus,
  ChangeRow,
  Db,
  EventRow,
  EventType,
  MessageRow,
  RunRow,
  RunStatus,
} from "./db";
import { toPosix, type Home } from "./rooms";

// Shapes returned by the API (documented in docs/api.md).

export type RunDto = {
  id: number;
  room: string;
  agentId: string;
  engine: string;
  task: string;
  status: RunStatus;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUsd: number;
  startedAt: string;
  endedAt: string | null;
  summary: string | null;
};

export type EventDto = {
  id: number;
  runId: number;
  room: string;
  agentId: string;
  type: EventType;
  data: Record<string, unknown>;
  createdAt: string;
};

export type MessageDto = {
  id: number;
  room: string;
  from: string;
  to: string;
  text: string;
  runId: number | null;
  createdAt: string;
};

export type ApprovalDto = {
  id: number;
  room: string;
  agentId: string;
  runId: number | null;
  type: string;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  status: ApprovalStatus;
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
};

export const toRun = (r: RunRow): RunDto => ({
  id: r.id,
  room: r.room,
  agentId: r.agent_id,
  engine: r.engine,
  task: r.task,
  status: r.status,
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  cacheCreationInputTokens: r.cache_creation_input_tokens,
  cacheReadInputTokens: r.cache_read_input_tokens,
  costUsd: r.cost_usd,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  summary: r.summary,
});

export const toEvent = (r: EventRow): EventDto => ({
  id: r.id,
  runId: r.run_id,
  room: r.room,
  agentId: r.agent_id,
  type: r.type,
  data: JSON.parse(r.data) as Record<string, unknown>,
  createdAt: r.created_at,
});

export const toMessage = (r: MessageRow): MessageDto => ({
  id: r.id,
  room: r.room,
  from: r.from_agent,
  to: r.to_agent,
  text: r.text,
  runId: r.run_id,
  createdAt: r.created_at,
});

export const toApproval = (r: ApprovalRow): ApprovalDto => ({
  id: r.id,
  room: r.room,
  agentId: r.agent_id,
  runId: r.run_id,
  type: r.type,
  title: r.title,
  body: r.body,
  payload: JSON.parse(r.payload) as Record<string, unknown>,
  status: r.status,
  decisionNote: r.decision_note,
  decidedAt: r.decided_at,
  createdAt: r.created_at,
});

export type FeedItem =
  | { seq: number; kind: "run"; data: RunDto }
  | { seq: number; kind: "event"; data: EventDto }
  | { seq: number; kind: "message"; data: MessageDto }
  | { seq: number; kind: "approval"; data: ApprovalDto };

export function currentCursor(db: Db): number {
  return (db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM changes").get() as { seq: number }).seq;
}

/**
 * Changes after `since` (at most `limit`), each with the current state of its
 * entity, and the cursor to ask from next time.
 */
export function changesSince(db: Db, since: number, limit = 500): { items: FeedItem[]; cursor: number } {
  const changes = db
    .prepare("SELECT seq, entity, entity_id FROM changes WHERE seq > ? ORDER BY seq LIMIT ?")
    .all(since, limit) as ChangeRow[];
  const items: FeedItem[] = [];
  for (const change of changes) {
    const { seq, entity, entity_id: id } = change;
    if (entity === "run") {
      const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
      if (row) items.push({ seq, kind: "run", data: toRun(row) });
    } else if (entity === "event") {
      const row = db.prepare("SELECT * FROM events WHERE id = ?").get(id) as EventRow | undefined;
      if (row) items.push({ seq, kind: "event", data: toEvent(row) });
    } else if (entity === "message") {
      const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | undefined;
      if (row) items.push({ seq, kind: "message", data: toMessage(row) });
    } else {
      const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
      if (row) items.push({ seq, kind: "approval", data: toApproval(row) });
    }
  }
  return { items, cursor: changes.length > 0 ? changes[changes.length - 1]!.seq : since };
}

export type AgentState = "working" | "idle" | "failed";

export type StateDto = {
  cursor: number;
  rooms: {
    name: string;
    targetRepo: string;
    agents: {
      id: string;
      name: string;
      model: string;
      role: string;
      allowedTools: string[];
      cron: string | null;
      state: AgentState;
      lastRun: RunDto | null;
    }[];
  }[];
  invalidRooms: { room: string; error: string }[];
  approvals: { pending: ApprovalDto[]; history: ApprovalDto[] };
  recent: { events: EventDto[]; messages: MessageDto[] };
};

/** Snapshot for the interface: load it once, then follow /api/events from `cursor`. */
export function getState(db: Db, home: Home): StateDto {
  const cursor = currentCursor(db);
  const lastRun = db.prepare("SELECT * FROM runs WHERE room = ? AND agent_id = ? ORDER BY id DESC LIMIT 1");
  return {
    cursor,
    rooms: home.rooms.map((room) => ({
      name: room.name,
      targetRepo: toPosix(path.relative(home.root, room.targetRepo)),
      agents: room.agents.map((agent) => {
        const row = lastRun.get(room.name, agent.id) as RunRow | undefined;
        const state: AgentState =
          row?.status === "running" ? "working" : row?.status === "failed" ? "failed" : "idle";
        return {
          id: agent.id,
          name: agent.name,
          model: agent.model,
          role: toPosix(path.relative(home.root, agent.rolePath)),
          allowedTools: agent.allowedTools,
          cron: agent.routines[0]?.cron ?? null,
          state,
          lastRun: row ? toRun(row) : null,
        };
      }),
    })),
    invalidRooms: home.invalid.map((r) => ({ room: path.basename(r.dir), error: r.error })),
    approvals: {
      pending: (db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY id").all() as ApprovalRow[]).map(
        toApproval,
      ),
      history: (
        db
          .prepare("SELECT * FROM approvals WHERE status <> 'pending' ORDER BY decided_at DESC, id DESC LIMIT 100")
          .all() as ApprovalRow[]
      ).map(toApproval),
    },
    recent: {
      events: (db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT 200").all() as EventRow[])
        .reverse()
        .map(toEvent),
      messages: (db.prepare("SELECT * FROM messages ORDER BY id DESC LIMIT 100").all() as MessageRow[])
        .reverse()
        .map(toMessage),
    },
  };
}
