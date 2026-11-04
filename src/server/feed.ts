import path from "node:path";
import { parseAnnotations, type Annotation } from "./annotations";
import { parseDecisionHistory, type DecisionRecord } from "./decision-history";
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
import { NOTIFICATION_NOTE, readReceptionRoom } from "./home-settings";
import { isArmed, listFirings, nextRoutineFire, type FiringDto } from "./routines";
import { toPosix, type Home } from "./rooms";
import { isoSpriteUrl, isoStrideOf, receptionSpriteUrl, spriteUrl } from "./sprites";
import { RECEPTION_AGENT, RECEPTION_ROOM, resolveReceptionRoom } from "../ui/reception";

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
  /** Why the run was started (POST /api/runs `reason`, `approval`, `message`), null otherwise. */
  reason: string | null;
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
  /** Remarks on passages of the body that came with a revise or reject decision. */
  annotations: Annotation[];
  /** The decisions the item had before the last one, oldest first (it was sent back for a revision). */
  decisionHistory: DecisionRecord[];
  /** The task that executes the item once approved (`onApproval: "task"`) has run: the action happened. */
  actionDone: boolean;
  /**
   * An informational item (`notifyTypes`): nothing to decide or revise. It is
   * `unseen` then `seen`; the ones stored before that status existed were
   * born `approved`, with a note, and read the same way.
   */
  informational: boolean;
  decidedAt: string | null;
  createdAt: string;
};

/** An approval row, with whether its execution task is done (see `APPROVAL_SELECT`). */
export type ApprovalRowWithAction = ApprovalRow & { action_done?: number };

/** Selects approvals as `a`, with `action_done`; append a WHERE clause. */
export const APPROVAL_SELECT = `SELECT a.*, EXISTS(
  SELECT 1 FROM tasks t WHERE t.source = 'approval' AND t.ref_id = a.id AND t.status = 'done'
) AS action_done FROM approvals a`;

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
  reason: r.reason ?? null,
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

export const toApproval = (r: ApprovalRowWithAction): ApprovalDto => ({
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
  annotations: parseAnnotations(r.annotations),
  decisionHistory: parseDecisionHistory(r.decision_history),
  actionDone: r.action_done === 1,
  informational:
    r.status === "unseen" ||
    r.status === "seen" ||
    (r.status === "approved" && r.decision_note === NOTIFICATION_NOTE && r.decided_at === r.created_at),
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
      const row = db.prepare(`${APPROVAL_SELECT} WHERE a.id = ?`).get(id) as ApprovalRowWithAction | undefined;
      if (row) items.push({ seq, kind: "approval", data: toApproval(row) });
    }
  }
  return { items, cursor: changes.length > 0 ? changes[changes.length - 1]!.seq : since };
}

/** Onboarding runs listed in the state (the sheet of the receptionist). */
export const RECEPTION_RUNS = 8;

export type AgentState = "working" | "idle" | "failed";

export type StateDto = {
  cursor: number;
  rooms: {
    name: string;
    targetRepo: string;
    /** Hex colour of the room (room.json), or null for the neutral look. */
    color: string | null;
    agents: {
      id: string;
      name: string;
      model: string;
      role: string;
      allowedTools: string[];
      /** URL of the old top-down sheet, or null (no longer drawn). */
      sprite: string | null;
      /** URL of the iso character sheet of the floor, or null for a neutral person. */
      isoSprite: string | null;
      /** Voxels per walk frame the iso sheet declares (`iso.json` next to it), or null for the default. */
      isoStride: number | null;
      /** Armed state of the routines (the database value, or room.json's until changed). */
      armed: boolean;
      routines: { cron: string; task: string | null; nextAt: string | null }[];
      state: AgentState;
      lastRun: RunDto | null;
    }[];
  }[];
  invalidRooms: { room: string; error: string }[];
  /**
   * The reception: the floor that draws the onboarding agent as a receptionist
   * (null when the home has no room), its own character sheet when the home
   * sets one, and its latest runs, newest first.
   */
  reception: { room: string | null; sprite: string | null; runs: RunDto[] };
  scheduler: SchedulerInfo;
  firings: FiringDto[];
  /** `pending` waits for a decision, `unseen` (« À regarder ») for a look, `history` is the rest. */
  approvals: { pending: ApprovalDto[]; unseen: ApprovalDto[]; history: ApprovalDto[] };
  recent: { events: EventDto[]; messages: MessageDto[] };
};

export type SchedulerInfo = {
  /** HQ_SCHEDULER=on. */
  enabled: boolean;
  /** This process runs the routines (enabled, and the lock of the home taken). */
  running: boolean;
  timeZone: string;
};

/** Snapshot for the interface: load it once, then follow /api/events from `cursor`. */
export function getState(db: Db, home: Home, scheduler: SchedulerInfo, at: Date = new Date()): StateDto {
  const cursor = currentCursor(db);
  const lastRun = db.prepare("SELECT * FROM runs WHERE room = ? AND agent_id = ? ORDER BY id DESC LIMIT 1");
  return {
    cursor,
    rooms: home.rooms.map((room) => ({
      name: room.name,
      targetRepo: toPosix(path.relative(home.root, room.targetRepo)),
      color: room.color,
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
          sprite: spriteUrl(room.name, agent),
          isoSprite: isoSpriteUrl(room.name, agent),
          isoStride: isoStrideOf(agent),
          armed: isArmed(db, room.name, agent),
          routines: agent.routines.map((routine) => ({
            cron: routine.cron,
            task: routine.task,
            nextAt: nextRoutineFire(routine, at, scheduler.timeZone)?.toISOString() ?? null,
          })),
          state,
          lastRun: row ? toRun(row) : null,
        };
      }),
    })),
    invalidRooms: home.invalid.map((r) => ({ room: path.basename(r.dir), error: r.error })),
    reception: {
      room: resolveReceptionRoom(
        home.rooms.map((room) => room.name),
        readReceptionRoom(home.root),
      ),
      sprite: receptionSpriteUrl(home.root),
      runs: (
        db
          .prepare("SELECT * FROM runs WHERE room = ? AND agent_id = ? ORDER BY id DESC LIMIT ?")
          .all(RECEPTION_ROOM, RECEPTION_AGENT, RECEPTION_RUNS) as RunRow[]
      ).map(toRun),
    },
    scheduler,
    firings: listFirings(db, 50),
    approvals: {
      pending: (
        db.prepare(`${APPROVAL_SELECT} WHERE a.status = 'pending' ORDER BY a.id`).all() as ApprovalRowWithAction[]
      ).map(toApproval),
      unseen: (
        db.prepare(`${APPROVAL_SELECT} WHERE a.status = 'unseen' ORDER BY a.id`).all() as ApprovalRowWithAction[]
      ).map(toApproval),
      history: (
        db
          .prepare(`${APPROVAL_SELECT} WHERE a.status NOT IN ('pending', 'unseen') ORDER BY a.decided_at DESC, a.id DESC LIMIT 100`)
          .all() as ApprovalRowWithAction[]
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
