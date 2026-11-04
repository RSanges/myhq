import path from "node:path";
import { z } from "zod";
import type { Env } from "../server/config";
import { decisionText, parseAnnotations } from "../server/annotations";
import { now, type ApprovalRow, type Db } from "../server/db";
import { readNotifyTypes } from "../server/home-settings";
import { AGENT_PROPOSAL, NEED_SOURCE, needSchema, normalizeAgentProposal, queueAgentNeed, sameNeed } from "../server/agent-proposal";
import { normalizeRoomProposal, ROOM_PROPOSAL } from "../server/proposal";
import { RECEPTION_AGENT, RECEPTION_ROOM } from "../ui/reception";

/** Context of the HQ MCP server, read from the environment of the run. */
export const contextSchema = z.object({
  HQ_DB_PATH: z.string().min(1),
  HQ_RUN_ID: z.coerce.number().int().positive(),
  HQ_AGENT_ID: z.string().min(1),
  HQ_ROOM: z.string().min(1),
});

export type HqContext = {
  dbPath: string;
  runId: number;
  agentId: string;
  room: string;
  /** MyHQ's role templates, to instantiate the roles of a room proposal. */
  templatesDir?: string;
  /** The home, to read `notifyTypes` from its myhq.json; none when unknown. */
  home?: string;
};

/** MyHQ keeps its database at `<home>/data/hq.db`: the home is two levels up. */
function homeOf(dbPath: string): string | undefined {
  const dataDir = path.dirname(path.resolve(dbPath));
  return path.basename(dataDir) === "data" ? path.dirname(dataDir) : undefined;
}

export function readContext(env: Env): HqContext {
  const parsed = contextSchema.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`HQ MCP server: invalid or missing environment variables: ${missing}`);
  }
  return {
    dbPath: parsed.data.HQ_DB_PATH,
    runId: parsed.data.HQ_RUN_ID,
    agentId: parsed.data.HQ_AGENT_ID,
    room: parsed.data.HQ_ROOM,
    home: homeOf(parsed.data.HQ_DB_PATH),
  };
}

/** Input shapes of the nine tools (zod raw shapes, as the MCP SDK expects). */
export const inputs = {
  hq_message: {
    to: z.string().min(1).describe("Id of the agent to write to."),
    text: z.string().min(1).max(20_000).describe("The message. It becomes a task for the recipient."),
    room: z
      .string()
      .min(1)
      .max(63)
      .optional()
      .describe(
        "Room of the recipient, when it is not yours: a shared room (see hq_rooms), or the room of an agent that ordered from your room. Default: your room.",
      ),
  },
  hq_submit: {
    type: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,62}$/)
      .describe("Kind of item, in snake_case, for example community_reply or pull_request."),
    title: z.string().trim().min(1).max(300).describe("Short title shown in the approval queue."),
    body: z.string().min(1).max(100_000).describe("The full content to approve, in Markdown."),
    payload: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Structured data needed to act on the item once approved (url, ids...)."),
    forRoom: z
      .string()
      .min(1)
      .max(63)
      .optional()
      .describe(
        "Only for an agent of a shared room: the room that ordered the deliverable. The item shows in that room's pile; the decisions still come back to you.",
      ),
  },
  hq_task_update: {
    status: z.enum(["in_progress", "done", "blocked"]).describe("State of your current task."),
    note: z.string().max(5_000).optional().describe("Short explanation, required in practice when blocked."),
  },
  hq_read_decisions: {},
  hq_memory_read: {
    key: z.string().min(1).max(200).describe("Key of the value to read."),
  },
  hq_memory_write: {
    key: z.string().min(1).max(200).describe("Key of the value to write."),
    value: z.string().max(100_000).describe("Value to store (text or JSON)."),
  },
  hq_pending: {},
  hq_rooms: {},
  hq_suggest_agent: {
    need: needSchema.describe(
      "What nobody in the office can do, in a few sentences: the work, the technologies involved, and the order that needs it.",
    ),
  },
} as const;

type Args<K extends keyof typeof inputs> = z.infer<z.ZodObject<(typeof inputs)[K]>>;

export class ToolError extends Error {}

/**
 * The rooms of the home as last synced (syncHome writes them all with the
 * same `synced_at`): a room removed from the home is no longer one of them.
 */
const CURRENT_ROOM = "synced_at = (SELECT MAX(synced_at) FROM rooms)";

function roomInfo(db: Db, name: string): { name: string; shared: number } | undefined {
  return db.prepare(`SELECT name, shared FROM rooms WHERE name = ? AND ${CURRENT_ROOM}`).get(name) as
    | { name: string; shared: number }
    | undefined;
}

/** Whether `agent` of `room` ordered from the room of `ctx`: one of its messages became a task there. */
function orderedFrom(db: Db, ctx: HqContext, room: string, agent: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM tasks WHERE room = ? AND source = 'message' AND from_room = ? AND from_agent = ? LIMIT 1")
      .get(ctx.room, room, agent) !== undefined
  );
}

/**
 * Sends a message, which becomes a task of the recipient. Within the room as
 * always; to another room only when that room is shared (an order to a
 * studio), or when the recipient is an agent that ordered from this room (a
 * studio answering its requester). The task keeps the sender's room and agent.
 */
export function hqMessage(db: Db, ctx: HqContext, args: Args<"hq_message">) {
  const parsed = z.object(inputs.hq_message).parse(args);
  const room = parsed.room ?? ctx.room;
  const elsewhere = room !== ctx.room;
  if (elsewhere) {
    const info = roomInfo(db, room);
    if (!info) throw new ToolError(`Unknown room "${room}".`);
    if (info.shared !== 1 && !orderedFrom(db, ctx, room, parsed.to)) {
      throw new ToolError(
        `Room "${room}" is not shared: you may write to a shared room (see hq_rooms), or answer an agent of a room that ordered from yours.`,
      );
    }
  }
  const target = db.prepare("SELECT id FROM agents WHERE room = ? AND id = ?").get(room, parsed.to);
  if (!target) throw new ToolError(`Unknown agent "${parsed.to}" in room "${room}".`);
  if (!elsewhere && parsed.to === ctx.agentId) throw new ToolError("An agent cannot write to itself.");
  const text = elsewhere
    ? `Message from ${ctx.agentId} of room "${ctx.room}" (answer with hq_message to "${ctx.agentId}", room "${ctx.room}"): ${parsed.text}`
    : `Message from ${ctx.agentId}: ${parsed.text}`;
  const at = now();
  return db.transaction(() => {
    const message = db
      .prepare(
        "INSERT INTO messages (room, from_agent, to_agent, to_room, text, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(ctx.room, ctx.agentId, parsed.to, elsewhere ? room : null, parsed.text, ctx.runId, at);
    const messageId = Number(message.lastInsertRowid);
    db.prepare(
      `INSERT INTO tasks (room, agent_id, source, ref_id, text, status, from_room, from_agent, created_at, updated_at)
       VALUES (?, ?, 'message', ?, ?, 'pending', ?, ?, ?, ?)`,
    ).run(room, parsed.to, messageId, text, ctx.room, ctx.agentId, at, at);
    return { messageId };
  })();
}

/** The shared rooms of the home and their agents: the studios any agent may order from. Read-only. */
export function hqRooms(db: Db, ctx: HqContext) {
  const rooms = db.prepare(`SELECT name FROM rooms WHERE shared = 1 AND ${CURRENT_ROOM} ORDER BY name`).all() as {
    name: string;
  }[];
  const agents = db.prepare("SELECT id, name FROM agents WHERE room = ? ORDER BY id");
  return {
    rooms: rooms.map((room) => ({
      room: room.name,
      yours: room.name === ctx.room,
      agents: (agents.all(room.name) as { id: string; name: string }[]).map((agent) => ({ id: agent.id, name: agent.name })),
    })),
  };
}

/** The repository a stored or submitted room proposal is about, as an absolute path, or null when unreadable. */
function proposalRepo(home: string | undefined, payload: unknown): string | null {
  const targetRepo = (payload as { room?: { targetRepo?: unknown } } | null)?.room?.targetRepo;
  return typeof targetRepo === "string" ? path.resolve(home ?? ".", targetRepo) : null;
}

/**
 * A rejection ends the matter: the receptionist never submits a new room
 * proposal for a repository whose latest room proposal the owner rejected,
 * unless the owner started this run by hand (`POST /api/onboarding`, the chat:
 * a run without a `reason`; a run woken by MyHQ has one).
 */
function assertNotRejected(db: Db, ctx: HqContext, payload: unknown): void {
  if (ctx.room !== RECEPTION_ROOM) return;
  const run = db.prepare("SELECT reason FROM runs WHERE id = ?").get(ctx.runId) as { reason: string | null } | undefined;
  if (!run || run.reason === null) return;
  const repo = proposalRepo(ctx.home, payload);
  if (repo === null) return;
  const earlier = db
    .prepare("SELECT status, payload FROM approvals WHERE type = ? ORDER BY id DESC")
    .all(ROOM_PROPOSAL) as { status: string; payload: string }[];
  for (const item of earlier) {
    let stored: unknown;
    try {
      stored = JSON.parse(item.payload);
    } catch {
      continue;
    }
    if (proposalRepo(ctx.home, stored) !== repo) continue;
    if (item.status === "rejected") {
      throw new ToolError(
        "The owner rejected your latest room proposal for this repository: it is closed, do not propose it again. Call hq_task_update with done.",
      );
    }
    return;
  }
}

export function hqSubmit(db: Db, ctx: HqContext, args: Args<"hq_submit">) {
  const parsed = z.object(inputs.hq_submit).parse(args);
  let { body, payload } = parsed;
  // A shared room delivers to the room that ordered: the item goes to that room's pile.
  let forRoom: string | null = null;
  if (parsed.forRoom !== undefined && parsed.forRoom !== ctx.room) {
    if (roomInfo(db, ctx.room)?.shared !== 1) {
      throw new ToolError(`forRoom is only for the agents of a shared room, and room "${ctx.room}" is not shared.`);
    }
    if (!roomInfo(db, parsed.forRoom)) throw new ToolError(`forRoom: unknown room "${parsed.forRoom}".`);
    forRoom = parsed.forRoom;
  }
  if (parsed.type === ROOM_PROPOSAL) {
    // Checked now, so that the agent can fix its payload within the same run.
    if (!ctx.templatesDir) throw new ToolError("room_proposal: the role templates are not available.");
    try {
      ({ body, payload } = normalizeRoomProposal(parsed.payload ?? {}, parsed.body, ctx.templatesDir));
    } catch (error) {
      throw new ToolError((error as Error).message);
    }
    assertNotRejected(db, ctx, payload);
  }
  if (parsed.type === AGENT_PROPOSAL) {
    // The receptionist's alone: a room agent asks for one with hq_suggest_agent.
    if (ctx.room !== RECEPTION_ROOM) {
      throw new ToolError("agent_proposal is the receptionist's: use hq_suggest_agent to ask for an agent nobody is.");
    }
    try {
      ({ body, payload } = normalizeAgentProposal(parsed.payload ?? {}, parsed.body));
    } catch (error) {
      throw new ToolError((error as Error).message);
    }
    const proposal = payload as { room: string; agent: { id: string } };
    if (!roomInfo(db, proposal.room)) throw new ToolError(`agent_proposal: unknown room "${proposal.room}".`);
    if (db.prepare("SELECT 1 FROM agents WHERE room = ? AND id = ?").get(proposal.room, proposal.agent.id)) {
      throw new ToolError(`agent_proposal: room "${proposal.room}" already has an agent "${proposal.agent.id}": pick another id.`);
    }
  }
  // An informational type (notifyTypes in myhq.json) is born 'unseen': the app
  // sends it to Telegram in full and the desk keeps it under « À regarder »
  // until the user marks it seen. It never waits for a decision, never
  // triggers onApproval and never wakes an agent. Its agent already knows it,
  // so it counts as read by the agent.
  const informational =
    parsed.type !== ROOM_PROPOSAL &&
    parsed.type !== AGENT_PROPOSAL &&
    ctx.home !== undefined &&
    readNotifyTypes(ctx.home).includes(parsed.type);
  const at = now();
  const result = db
    .prepare(
      `INSERT INTO approvals (room, agent_id, run_id, type, title, body, payload, status, decision_note,
         decided_at, seen_by_agent_at, for_room, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ctx.room,
      ctx.agentId,
      ctx.runId,
      parsed.type,
      parsed.title,
      body,
      JSON.stringify(payload ?? {}),
      informational ? "unseen" : "pending",
      null,
      null,
      informational ? at : null,
      forRoom,
      at,
    );
  return {
    approvalId: Number(result.lastInsertRowid),
    status: informational ? ("unseen" as const) : ("pending" as const),
  };
}

const SUGGESTION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * A room agent was given an order nobody in the office can do: the need
 * becomes a task of the receptionist (a need, with the asking room and
 * agent), which the app wakes to propose an agent for it (see
 * `wakeOnboarding`). At most one suggestion per need text (case and spacing
 * aside) in 24 hours, whatever became of it except a blocked one: a repeat is
 * answered without queueing anything. Nothing is created until the user
 * approves the proposal.
 */
export function hqSuggestAgent(db: Db, ctx: HqContext, args: Args<"hq_suggest_agent">) {
  const parsed = z.object(inputs.hq_suggest_agent).parse(args);
  if (ctx.room === RECEPTION_ROOM) throw new ToolError("The receptionist proposes agents itself: submit an agent_proposal.");
  const since = new Date(Date.now() - SUGGESTION_WINDOW_MS).toISOString();
  const recent = db
    .prepare(
      "SELECT id, text FROM tasks WHERE room = ? AND agent_id = ? AND source = ? AND status <> 'blocked' AND created_at >= ? ORDER BY id",
    )
    .all(RECEPTION_ROOM, RECEPTION_AGENT, NEED_SOURCE, since) as { id: number; text: string }[];
  const same = recent.find((task) => sameNeed(task.text, parsed.need));
  if (same) {
    return {
      queued: false as const,
      taskId: same.id,
      note: "The same need was already suggested in the last 24 hours: the receptionist has it, do not suggest it again.",
    };
  }
  const taskId = queueAgentNeed(db, {
    room: RECEPTION_ROOM,
    agent: RECEPTION_AGENT,
    need: parsed.need,
    fromRoom: ctx.room,
    fromAgent: ctx.agentId,
  });
  return {
    queued: true as const,
    taskId,
    note: "The receptionist will propose an agent to the user. Tell whoever ordered that nobody can do it yet, then go on with your other tasks.",
  };
}

export function hqTaskUpdate(db: Db, ctx: HqContext, args: Args<"hq_task_update">) {
  const parsed = z.object(inputs.hq_task_update).parse(args);
  const result = db
    .prepare(
      `UPDATE tasks SET status = ?, note = COALESCE(?, note), updated_at = ?
       WHERE run_id = ? AND room = ? AND agent_id = ? AND status IN ('pending', 'in_progress')`,
    )
    .run(parsed.status, parsed.note ?? null, now(), ctx.runId, ctx.room, ctx.agentId);
  return { updated: result.changes };
}

export function hqReadDecisions(db: Db, ctx: HqContext) {
  return db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT * FROM approvals WHERE room = ? AND agent_id = ?
         AND status NOT IN ('pending', 'unseen', 'seen') AND seen_by_agent_at IS NULL ORDER BY decided_at, id`,
      )
      .all(ctx.room, ctx.agentId) as ApprovalRow[];
    const markSeen = db.prepare("UPDATE approvals SET seen_by_agent_at = ? WHERE id = ?");
    const at = now();
    for (const row of rows) markSeen.run(at, row.id);
    return {
      decisions: rows.map((row) => ({
        approvalId: row.id,
        type: row.type,
        title: row.title,
        decision: row.status,
        note: decisionText(row.decision_note, parseAnnotations(row.annotations)),
        decidedAt: row.decided_at,
        payload: JSON.parse(row.payload) as unknown,
      })),
    };
  })();
}

/**
 * The items waiting for the user's decision, in every room, oldest first:
 * what an agent that writes a brief needs, without the bodies. Read-only.
 */
export function hqPending(db: Db) {
  const rows = db
    .prepare("SELECT id, room, agent_id, type, title, for_room, created_at FROM approvals WHERE status = 'pending' ORDER BY id")
    .all() as Pick<ApprovalRow, "id" | "room" | "agent_id" | "type" | "title" | "for_room" | "created_at">[];
  return {
    pending: rows.map((row) => ({
      id: row.id,
      room: row.room,
      agent: row.agent_id,
      /** The room that ordered it from a shared room, null otherwise. */
      forRoom: row.for_room,
      type: row.type,
      title: row.title,
      submittedAt: row.created_at,
    })),
  };
}

export function hqMemoryRead(db: Db, ctx: HqContext, args: Args<"hq_memory_read">) {
  const parsed = z.object(inputs.hq_memory_read).parse(args);
  const row = db
    .prepare("SELECT value, updated_at FROM memories WHERE room = ? AND agent_id = ? AND key = ?")
    .get(ctx.room, ctx.agentId, parsed.key) as { value: string; updated_at: string } | undefined;
  return { key: parsed.key, value: row?.value ?? null, updatedAt: row?.updated_at ?? null };
}

export function hqMemoryWrite(db: Db, ctx: HqContext, args: Args<"hq_memory_write">) {
  const parsed = z.object(inputs.hq_memory_write).parse(args);
  db.prepare(
    `INSERT INTO memories (room, agent_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (room, agent_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(ctx.room, ctx.agentId, parsed.key, parsed.value, now());
  return { key: parsed.key, saved: true };
}
