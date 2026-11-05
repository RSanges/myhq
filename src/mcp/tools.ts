import path from "node:path";
import { z } from "zod";
import type { Env } from "../server/config";
import { decisionText, parseAnnotations } from "../server/annotations";
import {
  AttachmentError,
  attachmentInputSchema,
  attachmentMaxBytes,
  MAX_ATTACHMENTS,
  resolveAttachment,
  storeAttachments,
  type ResolvedAttachment,
} from "../server/attachments";
import { APPROVAL_STATUSES, now, type ApprovalRow, type Db } from "../server/db";
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
  /** The agent's working directory (its worktree when it has one): where attachments are read from. */
  HQ_WORK_DIR: z.string().min(1).optional(),
  HQ_ATTACHMENT_MAX_MB: z.string().optional(),
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
  /** Absolute working directory of the agent, which attachments are relative to; none: no attachments. */
  workDir?: string;
  /** Cap on one attached file, in bytes. */
  attachmentMaxBytes?: number;
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
    ...(parsed.data.HQ_WORK_DIR ? { workDir: parsed.data.HQ_WORK_DIR } : {}),
    attachmentMaxBytes: attachmentMaxBytes({ HQ_ATTACHMENT_MAX_MB: parsed.data.HQ_ATTACHMENT_MAX_MB }),
  };
}

/** Input shapes of the ten tools (zod raw shapes, as the MCP SDK expects). */
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
    attachments: z
      .array(attachmentInputSchema)
      .max(MAX_ATTACHMENTS)
      .optional()
      .describe(
        "Files to validate with the item (a render: video mp4/webm/mov, image png/jpg/webp/gif, sound wav/mp3/ogg/flac/m4a, 3D 3mf/stl/glb, pdf), each { path, caption? }. path is relative to your working directory and must stay inside it: copy a render made elsewhere (ComfyUI output...) into your directory first. MyHQ keeps a copy, so the owner validates exactly what you sent. An image named like a 3D file or a PDF (piece.png next to piece.3mf) is shown as its preview.",
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
  hq_items: {
    id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Number of the item to read (the approvalId of hq_submit, the number in a command). Without it: the list of recent items."),
    status: z
      .enum(APPROVAL_STATUSES)
      .optional()
      .describe("List only: keep the items in this status (pending, approved, rejected, revise, unseen, seen)."),
    type: z.string().min(1).max(63).optional().describe("List only: keep the items of this type."),
  },
  hq_rooms: {},
  hq_suggest_agent: {
    need: needSchema.describe(
      "What nobody in the office can do, in a few sentences: the work, the technologies involved, and the order that needs it.",
    ),
  },
} as const;

type Args<K extends keyof typeof inputs> = z.infer<z.ZodObject<(typeof inputs)[K]>>;

export class ToolError extends Error {}

/** A `better-sqlite3` error (`SqliteError`): it carries an SQLite result code such as SQLITE_BUSY. */
function sqliteCode(error: unknown): string | null {
  if (!(error instanceof Error) || error.name !== "SqliteError") return null;
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "string" ? code : "SQLITE_ERROR";
}

/**
 * The text of a failed tool call, given back to the agent as an error result.
 * A database error says so explicitly, and that nothing was read or written:
 * an agent once took a busy database for an empty queue and submitted its
 * item a second time.
 */
export function toolErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = sqliteCode(error);
  if (code === null) return `Error: ${message}`;
  if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")) {
    return `Error: the office database is busy (${code}: ${message}). Nothing was read or written: this is not an empty result. Call the same tool again in a moment; never conclude from this error that an item is missing, and do not submit anything a second time.`;
  }
  return `Error: office database error (${code}: ${message}). Nothing was read or written: this is not an empty result.`;
}

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
  return db
    .transaction(() => {
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
    })
    .immediate();
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

/** What hq_submit answers: the item's id and status; for a duplicate, the existing item and a note. */
export type SubmitResult = {
  approvalId: number;
  status: ApprovalRow["status"];
  files?: number;
  duplicate?: true;
  note?: string;
};

export function hqSubmit(db: Db, ctx: HqContext, args: Args<"hq_submit">): SubmitResult {
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
  // Checked before anything is written, so that the agent can fix its paths within the same run.
  const files: ResolvedAttachment[] = [];
  if (parsed.attachments && parsed.attachments.length > 0) {
    const workDir = ctx.workDir;
    if (!workDir) throw new ToolError("attachments are not available in this run.");
    const maxBytes = ctx.attachmentMaxBytes ?? attachmentMaxBytes({});
    try {
      for (const input of parsed.attachments) files.push(resolveAttachment(workDir, input, maxBytes));
    } catch (error) {
      if (error instanceof AttachmentError) throw new ToolError(error.message);
      throw error;
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
  const insert = db.prepare(
    `INSERT INTO approvals (room, agent_id, run_id, type, title, body, payload, status, decision_note,
         decided_at, seen_by_agent_at, for_room, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // The item and the copies of its files are one: a failed copy leaves neither.
  // Immediate: the check for a duplicate and the insert see the same queue.
  const stored = db
    .transaction((): { id: number; duplicate: ApprovalRow["status"] | null } => {
      // The receptionist's proposals are checked when they are approved (ROOM_EXISTS, AGENT_EXISTS).
      const proposal = parsed.type === ROOM_PROPOSAL || parsed.type === AGENT_PROPOSAL;
      const twin = proposal ? undefined : sameItem(db, ctx, parsed.type, parsed.title, body);
      if (twin) return { id: twin.id, duplicate: twin.status };
      const result = insert.run(
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
      const id = Number(result.lastInsertRowid);
      // MyHQ keeps its database in the data directory of the home.
      storeAttachments(db, path.dirname(path.resolve(ctx.dbPath)), id, files);
      return { id, duplicate: null };
    })
    .immediate();
  if (stored.duplicate !== null) {
    return {
      approvalId: stored.id,
      status: stored.duplicate,
      duplicate: true,
      note: `Item #${stored.id} is this same item (same type, title and body), ${stored.duplicate}: nothing new was submitted. Refer to #${stored.id}; read its decision with hq_read_decisions.`,
    };
  }
  const approvalId = stored.id;
  return {
    approvalId,
    ...(files.length > 0 ? { files: files.length } : {}),
    status: informational ? ("unseen" as const) : ("pending" as const),
  };
}

/** How long an approved item still counts as the same one for a submission of the same content. */
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * An item of this agent with the same type, title and body that is still
 * waiting (pending, or informational and unseen), or was approved in the last
 * 24 hours: submitting it again is a duplicate (a run that could not read its
 * decisions once submitted its script a second time). Body compared without
 * the blanks around it.
 */
function sameItem(db: Db, ctx: HqContext, type: string, title: string, body: string): Pick<ApprovalRow, "id" | "status"> | undefined {
  const since = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString();
  const rows = db
    .prepare(
      `SELECT id, status, body FROM approvals
       WHERE room = ? AND agent_id = ? AND type = ? AND title = ?
         AND (status IN ('pending', 'unseen') OR (status = 'approved' AND decided_at >= ?))
       ORDER BY id`,
    )
    .all(ctx.room, ctx.agentId, type, title, since) as Pick<ApprovalRow, "id" | "status" | "body">[];
  const twin = rows.find((row) => row.body.trim() === body.trim());
  return twin ? { id: twin.id, status: twin.status } : undefined;
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
  // Immediate: a deferred transaction that reads, then marks the rows seen, fails at once
  // (SQLITE_BUSY, whatever the busy timeout) when another process wrote in between.
  return db
    .transaction(() => {
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
    })
    .immediate();
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

/** How far back the list of hq_items looks, and how many items it gives at most. */
export const ITEMS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const ITEMS_LIST_MAX = 50;

/**
 * The rooms whose items an agent may read with hq_items: its own, and, for an
 * agent of a shared room, the rooms that ordered from it (a message that
 * became a task of its room carries `from_room`). An item belongs to a room
 * when it was produced there (`room`) or delivered for it (`for_room`).
 */
function readableRooms(db: Db, ctx: HqContext): string[] {
  const rooms = [ctx.room];
  if (roomInfo(db, ctx.room)?.shared !== 1) return rooms;
  const orderers = db
    .prepare("SELECT DISTINCT from_room FROM tasks WHERE room = ? AND source = 'message' AND from_room IS NOT NULL ORDER BY from_room")
    .all(ctx.room) as { from_room: string }[];
  for (const { from_room } of orderers) if (!rooms.includes(from_room)) rooms.push(from_room);
  return rooms;
}

const marks = (values: readonly unknown[]) => values.map(() => "?").join(", ");

/**
 * Reads the state of items, never marks anything seen (unlike
 * hq_read_decisions, which gives a decision once). With `id`: the item, its
 * decision and remarks. Without: the recent items (30 days, newest first, at
 * most ITEMS_LIST_MAX) of the rooms the agent may read, optionally filtered by
 * status and type. An item outside those rooms is refused, with an error that
 * says it is out of reach, not that it does not exist.
 */
export function hqItems(db: Db, ctx: HqContext, args: Args<"hq_items">) {
  const parsed = z.object(inputs.hq_items).parse(args);
  const rooms = readableRooms(db, ctx);
  const scope = `(room IN (${marks(rooms)}) OR for_room IN (${marks(rooms)}))`;
  if (parsed.id !== undefined) {
    if (parsed.status !== undefined || parsed.type !== undefined) {
      throw new ToolError("hq_items: status and type filter the list; do not combine them with id.");
    }
    const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(parsed.id) as ApprovalRow | undefined;
    if (!row) throw new ToolError(`No item #${parsed.id} exists.`);
    if (!rooms.includes(row.room) && !(row.for_room !== null && rooms.includes(row.for_room))) {
      throw new ToolError(
        `Item #${parsed.id} is outside what you may read: only the items of your room, those you produced, those delivered for your room and, for a shared room, those of the rooms that ordered from it. This does not tell you whether it is approved.`,
      );
    }
    const files = db.prepare("SELECT name FROM approval_files WHERE approval_id = ? ORDER BY id").all(row.id) as { name: string }[];
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      status: row.status,
      room: row.room,
      agent: row.agent_id,
      forRoom: row.for_room,
      submittedAt: row.created_at,
      decidedAt: row.decided_at,
      note: row.decision_note,
      remarks: parseAnnotations(row.annotations).map((a) => ({
        quote: a.quote,
        comment: a.comment,
        ...(a.point ? { point: a.point } : {}),
      })),
      files: files.map((file) => file.name),
    };
  }
  const since = new Date(Date.now() - ITEMS_WINDOW_MS).toISOString();
  const where = [scope, "MAX(created_at, COALESCE(decided_at, created_at)) >= ?"];
  const params: unknown[] = [...rooms, ...rooms, since];
  if (parsed.status !== undefined) {
    where.push("status = ?");
    params.push(parsed.status);
  }
  if (parsed.type !== undefined) {
    where.push("type = ?");
    params.push(parsed.type);
  }
  const rows = db
    .prepare(
      `SELECT id, room, agent_id, type, title, status, for_room, decided_at, created_at FROM approvals
       WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`,
    )
    .all(...params, ITEMS_LIST_MAX + 1) as Pick<
    ApprovalRow,
    "id" | "room" | "agent_id" | "type" | "title" | "status" | "for_room" | "decided_at" | "created_at"
  >[];
  return {
    items: rows.slice(0, ITEMS_LIST_MAX).map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      status: row.status,
      room: row.room,
      agent: row.agent_id,
      forRoom: row.for_room,
      submittedAt: row.created_at,
      decidedAt: row.decided_at,
    })),
    truncated: rows.length > ITEMS_LIST_MAX,
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
