import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { blockedTargetSchema } from "../server/blocked";
import { getConfig, type Env, type HqConfig } from "../server/config";
import { decisionText, parseAnnotations } from "../server/annotations";
import {
  AttachmentError,
  attachmentInputSchema,
  attachmentMaxBytes,
  attachmentPath,
  MAX_ATTACHMENTS,
  resolveAttachment,
  storeAttachments,
  type ResolvedAttachment,
} from "../server/attachments";
import { APPROVAL_STATUSES, now, type ApprovalRow, type Db } from "../server/db";
import { readNotifyTypes } from "../server/home-settings";
import { EXTEND_MAX_MINUTES, EXTEND_MIN_MINUTES, extendRun, requestStop, runStatus } from "../server/long-runs";
import { AGENT_PROPOSAL, NEED_SOURCE, needSchema, normalizeAgentProposal, queueAgentNeed, sameNeed } from "../server/agent-proposal";
import { MESSAGE_EXPECTS } from "../server/portier";
import { normalizeRoomProposal, ROOM_PROPOSAL } from "../server/proposal";
import { CHOICES_KEY, QUESTION_TYPE, questionsSchema, renderQuestionsBody } from "../server/questions";
import { idSchema, loadHome, type Home } from "../server/rooms";
import {
  isSupervisor,
  noteBlocked,
  OWNER_NOTE,
  recordRelays,
  requestRelaunch,
  supervisedEntries,
  writeMessage,
  type RelayMessage,
} from "../server/supervisor";
import { normalizeStatus, STATUS_MAX_CHARS } from "../ui/activity";
import { RECEPTION_AGENT, RECEPTION_ROOM } from "../ui/reception";

/** Context of the HQ MCP server, read from the environment of the run. */
export const contextSchema = z.object({
  HQ_DB_PATH: z.string().min(1),
  /** Left out only for a question to an agent (HQ_READ_ONLY), which is not a run. */
  HQ_RUN_ID: z.coerce.number().int().positive().optional(),
  /** "1": the server gives only its read tools (a question to an agent, see agent-questions.ts). */
  HQ_READ_ONLY: z.literal("1").optional(),
  HQ_AGENT_ID: z.string().min(1),
  HQ_ROOM: z.string().min(1),
  /** The agent's working directory (its worktree when it has one): where attachments are read from. */
  HQ_WORK_DIR: z.string().min(1).optional(),
  HQ_ATTACHMENT_MAX_MB: z.string().optional(),
  /** The app's daily cap and anti ping-pong window, for the reasons and guards of the Standard (hq_blocked, hq_relaunch). */
  HQ_MAX_RUNS_PER_DAY: z.string().optional(),
  HQ_MESSAGE_WAKE_MINUTES: z.string().optional(),
});

export type HqContext = {
  dbPath: string;
  /** The run; 0 in read-only mode, where no tool that uses it is given. */
  runId: number;
  /** Only the read tools are given (HQ_READ_ONLY). */
  readOnly?: boolean;
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
  /** HQ_MAX_RUNS_PER_DAY and HQ_MESSAGE_WAKE_MINUTES of the app, as given to the run. */
  appEnv?: Env;
};

/** MyHQ keeps its database at `<home>/data/hq.db`: the home is two levels up. */
function homeOf(dbPath: string): string | undefined {
  const dataDir = path.dirname(path.resolve(dbPath));
  return path.basename(dataDir) === "data" ? path.dirname(dataDir) : undefined;
}

export function readContext(env: Env): HqContext {
  const parsed = contextSchema
    .refine((value) => value.HQ_RUN_ID !== undefined || value.HQ_READ_ONLY === "1", {
      path: ["HQ_RUN_ID"],
      message: "required unless HQ_READ_ONLY is 1",
    })
    .safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`HQ MCP server: invalid or missing environment variables: ${missing}`);
  }
  return {
    dbPath: parsed.data.HQ_DB_PATH,
    runId: parsed.data.HQ_RUN_ID ?? 0,
    ...(parsed.data.HQ_READ_ONLY === "1" ? { readOnly: true } : {}),
    agentId: parsed.data.HQ_AGENT_ID,
    room: parsed.data.HQ_ROOM,
    home: homeOf(parsed.data.HQ_DB_PATH),
    ...(parsed.data.HQ_WORK_DIR ? { workDir: parsed.data.HQ_WORK_DIR } : {}),
    attachmentMaxBytes: attachmentMaxBytes({ HQ_ATTACHMENT_MAX_MB: parsed.data.HQ_ATTACHMENT_MAX_MB }),
    appEnv: { HQ_MAX_RUNS_PER_DAY: parsed.data.HQ_MAX_RUNS_PER_DAY, HQ_MESSAGE_WAKE_MINUTES: parsed.data.HQ_MESSAGE_WAKE_MINUTES },
  };
}

/** hq_items: the body of an item is cut to `maxChars` characters, 20000 unless asked, 60000 at most. */
export const ITEM_BODY_DEFAULT = 20_000;
export const ITEM_BODY_MAX = 60_000;

/** A target of the Standard, as hq_blocked gives it: `kind` and `id`. */
const targetShape = {
  kind: blockedTargetSchema.shape.kind.describe('"task" or "run": the `target.kind` of the entry in hq_blocked.'),
  id: blockedTargetSchema.shape.id.describe("The `target.id` of the entry in hq_blocked (a task id, or a run id)."),
};

/** The run a supervisor checks: the run number of its « long run to check » task. */
const runIdShape = z.number().int().positive().describe("The number of the run (#12 gives 12), as your task « Long run to check » names it.");

/** Input shapes of the eighteen tools (zod raw shapes, as the MCP SDK expects). */
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
    expects: z
      .enum(MESSAGE_EXPECTS)
      .optional()
      .describe(
        'What you expect from the recipient. "reply" or "action": it is woken at once. "none": it is not woken, the message waits in its mailbox for its next run; use it for an acknowledgement, a thanks, a status that asks nothing ("received", "still waiting for the clips"). Left out: a small model reads the message and decides, and a question mark wakes it at once.',
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
    onApprove: z
      .array(
        z.strictObject({
          to: z
            .string()
            .regex(/^(?:[a-z0-9][a-z0-9_-]{0,62}\/)?[a-z0-9][a-z0-9_-]{0,62}$/, '"room/agent", or "agent" for an agent of your room')
            .describe('The recipient, "room/agent" (or "agent" in your room), as for hq_message.'),
          text: z.string().trim().min(1).max(20_000).describe("The order to give it: MyHQ appends the item's title, body and files."),
        }),
      )
      .min(1)
      .max(10)
      .optional()
      .describe(
        "Messages MyHQ delivers itself, in your name, the moment the owner approves the item (for example the order to a studio to produce the approved script): each one gets the item's title, body and files appended and wakes its recipient. You are not woken to relay them. The recipients are checked now, as hq_message checks them.",
      ),
    questions: questionsSchema
      .optional()
      .describe(
        "Use it when the deliverable offers variants or options the owner has to choose between (two voices, three music seeds, a few titles): put the choices here, 2 to 6 concrete options per question, instead of a separate hq_ask. The owner sees the deliverable and the questions together, and approving needs every question answered. The answers come back to you with the decision. Not for a yes or no (that is the approval itself).",
      ),
  },
  hq_ask: {
    title: z.string().trim().min(1).max(300).describe("Short title shown in the approval queue: what you need decided."),
    context: z
      .string()
      .trim()
      .min(1)
      .max(20_000)
      .optional()
      .describe("Why you are asking, in Markdown: what you found, what depends on the answer."),
    questions: questionsSchema.describe(
      "The questions, as many as you need (at most 20), each with 2 to 6 concrete options. The owner answers all of them.",
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
  hq_status: {
    text: z
      .string()
      .max(STATUS_MAX_CHARS)
      .refine((value) => normalizeStatus(value) !== null, "a few words, not blank")
      .describe(
        `What you are doing right now, in a few words of the home's language, for the owner: ${STATUS_MAX_CHARS} characters at most, no technical detail (no file path, command or tool name). For example "rend le clip B, 2 sur 3".`,
      ),
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
    maxChars: z
      .number()
      .int()
      .min(1)
      .max(ITEM_BODY_MAX)
      .optional()
      .describe(`With id only: the most characters of the body to give (default ${ITEM_BODY_DEFAULT}, at most ${ITEM_BODY_MAX}); bodyTruncated tells when it was cut.`),
  },
  hq_rooms: {},
  hq_suggest_agent: {
    need: needSchema.describe(
      "What nobody in the office can do, in a few sentences: the work, the technologies involved, and the order that needs it.",
    ),
  },
  hq_blocked: {},
  hq_relaunch: {
    ...targetShape,
    message: z
      .string()
      .trim()
      .min(1)
      .max(5_000)
      .optional()
      .describe(
        "Optional: what the agent was missing (the proof, such as the number of the approved item, or the text it could not read), given to it as a message from you, in the same run as its relaunched tasks.",
      ),
  },
  hq_blocked_note: {
    ...targetShape,
    text: z
      .string()
      .trim()
      .min(1)
      .max(1_000)
      .describe("For the owner, in one or two sentences of the home's language: what you did, or why you cannot act and what you expect from the owner."),
    handOff: z
      .boolean()
      .optional()
      .describe("true: the entry is handed to the owner (shown first on the Standard, and you are no longer woken for it)."),
  },
  hq_run_status: { runId: runIdShape },
  hq_run_extend: {
    runId: runIdShape,
    minutes: z
      .number()
      .int()
      .min(EXTEND_MIN_MINUTES)
      .max(EXTEND_MAX_MINUTES)
      .describe(`How many more minutes the run may go on, from now (${EXTEND_MIN_MINUTES} to ${EXTEND_MAX_MINUTES}); never past its hard limit.`),
  },
  hq_run_stop: {
    runId: runIdShape,
    reason: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe("For the owner, in one sentence of the home's language: why the run is stuck (the facts of hq_run_status). Shown on the Standard."),
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
  assertMayWrite(db, ctx, room, parsed.to);
  return db
    .transaction(() => ({
      messageId: writeMessage(
        db,
        { room: ctx.room, agentId: ctx.agentId, runId: ctx.runId },
        { room, agentId: parsed.to },
        parsed.text,
        parsed.expects,
      ),
    }))
    .immediate();
}

/**
 * Whether this run's agent may write to `to` of `room`: within its room, to a
 * shared room, to an agent that ordered from its room, anywhere for the
 * supervisor. A tool error otherwise.
 */
function assertMayWrite(db: Db, ctx: HqContext, room: string, to: string): void {
  const elsewhere = room !== ctx.room;
  if (elsewhere) {
    const info = roomInfo(db, room);
    if (!info) throw new ToolError(`Unknown room "${room}".`);
    // The supervisor of the Standard writes to any agent of any room.
    if (info.shared !== 1 && !orderedFrom(db, ctx, room, to) && !isSupervisor(db, ctx.room, ctx.agentId)) {
      throw new ToolError(
        `Room "${room}" is not shared: you may write to a shared room (see hq_rooms), or answer an agent of a room that ordered from yours.`,
      );
    }
  }
  const target = db.prepare("SELECT id FROM agents WHERE room = ? AND id = ?").get(room, to);
  if (!target) throw new ToolError(`Unknown agent "${to}" in room "${room}".`);
  if (!elsewhere && to === ctx.agentId) throw new ToolError("An agent cannot write to itself.");
}

/** The messages of hq_submit `onApprove`, their recipients checked as hq_message checks them. */
function relayMessages(db: Db, ctx: HqContext, onApprove: Args<"hq_submit">["onApprove"]): RelayMessage[] {
  return (onApprove ?? []).map((message) => {
    const [first, second] = message.to.split("/");
    const room = second === undefined ? ctx.room : first!;
    const agent = second ?? first!;
    if (!idSchema.safeParse(agent).success) throw new ToolError(`onApprove: "${message.to}" is not "room/agent".`);
    try {
      assertMayWrite(db, ctx, room, agent);
    } catch (error) {
      throw new ToolError(`onApprove: ${(error as Error).message}`);
    }
    return { room, agent, text: message.text };
  });
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
  // The supervisor of the Standard submits nothing to approve: only a note to the owner, informational.
  const supervisor = isSupervisor(db, ctx.room, ctx.agentId);
  if (supervisor && parsed.type !== OWNER_NOTE) {
    throw new ToolError(
      `You are the supervisor of the Standard: you submit nothing to approve, only a note to the owner (type "${OWNER_NOTE}"). To tell the owner about an entry of the Standard, use hq_blocked_note.`,
    );
  }
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
  // The recipients of onApprove are checked now, so that the agent can fix them within the same run.
  const relays = relayMessages(db, ctx, parsed.onApprove);
  if (parsed.questions) {
    if (parsed.type === QUESTION_TYPE || parsed.type === ROOM_PROPOSAL || parsed.type === AGENT_PROPOSAL) {
      throw new ToolError(`questions are for an ordinary deliverable: not for type "${parsed.type}" (to only ask, use hq_ask).`);
    }
    payload = { ...(payload ?? {}), [CHOICES_KEY]: { questions: parsed.questions } };
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
  // sends it to Telegram as one message (cut, with a link, when long) and the
  // desk keeps it under « À regarder » until the user marks it seen. It never
  // waits for a decision, never triggers onApproval and never wakes an agent.
  // Its agent already knows it, so it counts as read by the agent.
  const informational =
    supervisor ||
    (parsed.type !== ROOM_PROPOSAL &&
      parsed.type !== AGENT_PROPOSAL &&
      ctx.home !== undefined &&
      readNotifyTypes(ctx.home).includes(parsed.type));
  if (informational && parsed.questions) {
    throw new ToolError("questions are for an item the owner decides: this type is informational, nothing is answered.");
  }
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
      // An informational item is never approved: its messages would never leave.
      if (!informational) recordRelays(db, id, relays);
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

/** What hq_ask answers: the id of the item that holds the questions, and what to do now. */
export type AskResult = { approvalId: number; status: ApprovalRow["status"]; duplicate?: true; note: string };

/**
 * Asks the owner questions. They become one item of the approval queue (type
 * `question`, pending): the questions in its payload, a readable text of them
 * in its body. The owner answers on the desk or on Telegram; the answers wake
 * the agent with a new task holding its questions and them (like a revision),
 * so the agent finishes its turn after asking and does not wait. The same
 * questions (title and text) still waiting, or answered in the last 24 hours,
 * are not asked twice. Not for the supervisor of the Standard, nor the
 * receptionist, whose wake-ups are their own.
 */
export function hqAsk(db: Db, ctx: HqContext, args: Args<"hq_ask">): AskResult {
  const parsed = z.object(inputs.hq_ask).parse(args);
  if (isSupervisor(db, ctx.room, ctx.agentId)) {
    throw new ToolError("You are the supervisor of the Standard: you do not ask questions, you leave a note with hq_blocked_note.");
  }
  if (ctx.room === RECEPTION_ROOM) {
    throw new ToolError("The receptionist does not ask questions: put what is missing in its proposal.");
  }
  const body = renderQuestionsBody(parsed.context, parsed.questions);
  const payload = { ...(parsed.context ? { context: parsed.context } : {}), questions: parsed.questions };
  const at = now();
  const stored = db
    .transaction((): { id: number; duplicate: ApprovalRow["status"] | null } => {
      const twin = sameItem(db, ctx, QUESTION_TYPE, parsed.title, body);
      if (twin) return { id: twin.id, duplicate: twin.status };
      const result = db
        .prepare(
          `INSERT INTO approvals (room, agent_id, run_id, type, title, body, payload, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .run(ctx.room, ctx.agentId, ctx.runId, QUESTION_TYPE, parsed.title, body, JSON.stringify(payload), at);
      return { id: Number(result.lastInsertRowid), duplicate: null };
    })
    .immediate();
  if (stored.duplicate !== null) {
    return {
      approvalId: stored.id,
      status: stored.duplicate,
      duplicate: true,
      note: `Questions #${stored.id} are these same questions, ${stored.duplicate}: nothing new was asked. Do not wait for them: finish your turn.`,
    };
  }
  return {
    approvalId: stored.id,
    status: "pending",
    note: "The owner will answer on the desk or on Telegram. Do not wait: finish your turn now. The answers come back to you as a new task, with your questions and each answer.",
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
  // The supervisor of the Standard checks the facts in every room.
  if (isSupervisor(db, ctx.room, ctx.agentId)) {
    const rooms = db.prepare("SELECT DISTINCT room FROM approvals UNION SELECT name FROM rooms").all() as { room: string }[];
    return [...new Set([ctx.room, ...rooms.map((row) => row.room)])];
  }
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
 * body (cut to `maxChars`), decision and remarks. Without: the recent items (30 days, newest first, at
 * most ITEMS_LIST_MAX) of the rooms the agent may read, optionally filtered by
 * status and type. An item outside those rooms is refused, with an error that
 * says it is out of reach, not that it does not exist.
 */
export function hqItems(db: Db, ctx: HqContext, args: Args<"hq_items">) {
  const parsed = z.object(inputs.hq_items).parse(args);
  if (parsed.id === undefined && parsed.maxChars !== undefined) {
    throw new ToolError("hq_items: maxChars applies to the body of one item; give its id.");
  }
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
    const files = db
      .prepare("SELECT id, name FROM approval_files WHERE approval_id = ? ORDER BY id")
      .all(row.id) as { id: number; name: string }[];
    const dataDir = path.dirname(path.resolve(ctx.dbPath));
    const limit = parsed.maxChars ?? ITEM_BODY_DEFAULT;
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
      body: row.body.slice(0, limit),
      bodyTruncated: row.body.length > limit,
      remarks: parseAnnotations(row.annotations).map((a) => ({
        quote: a.quote,
        comment: a.comment,
        ...(a.point ? { point: a.point } : {}),
      })),
      // `path` is MyHQ's frozen copy of the file (read it, never change it), given when it is on disk.
      files: files.map((file) => {
        const copy = attachmentPath(dataDir, row.id, file.id, file.name);
        return fs.existsSync(copy) ? { name: file.name, path: copy } : { name: file.name };
      }),
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

// --- The supervisor of the Standard ------------------------------------------------------

/** The supervisor's tools are refused, with a clear error, to any other agent. */
function assertSupervisor(db: Db, ctx: HqContext, tool: string): void {
  if (isSupervisor(db, ctx.room, ctx.agentId)) return;
  throw new ToolError(
    `${tool} is reserved for the supervisor of the Standard (an agent with "supervisor": true in its room.json), and you are not one. If you are stuck, say so with hq_task_update and status blocked, with a note.`,
  );
}

/** The home and the app's configuration as the run sees them: the database lives in `<home>/data`. */
function office(ctx: HqContext): { home: Home; config: HqConfig } {
  if (!ctx.home) throw new ToolError("The home of the office is not known in this run: the Standard cannot be read.");
  const config = getConfig({ ...ctx.appEnv, MYHQ_HOME: ctx.home });
  return { home: loadHome(ctx.home), config };
}

/** hq_blocked: the Standard, every entry but the supervisor's own. Read-only. */
export function hqBlocked(db: Db, ctx: HqContext) {
  assertSupervisor(db, ctx, "hq_blocked");
  const { home, config } = office(ctx);
  return { entries: supervisedEntries(db, home, config, { room: ctx.room, agentId: ctx.agentId }) };
}

/** hq_relaunch: « Relancer » for the supervisor, with the same guards, once per task. */
export function hqRelaunch(db: Db, ctx: HqContext, args: Args<"hq_relaunch">) {
  assertSupervisor(db, ctx, "hq_relaunch");
  const parsed = z.object(inputs.hq_relaunch).parse(args);
  const { home, config } = office(ctx);
  const result = requestRelaunch(
    db,
    config,
    home,
    { room: ctx.room, agentId: ctx.agentId, runId: ctx.runId },
    { kind: parsed.kind, id: parsed.id },
    parsed.message,
  );
  if (!result.relaunched) {
    return {
      ...result,
      note: "Nothing was changed and this does not count as a relaunch: relaunch it when what holds it back is over (you are woken again while the entry stays open), or hand it to the owner.",
    };
  }
  return {
    ...result,
    note: "The tasks are pending again and MyHQ wakes the agent now. Never relaunch this entry again: if it fails once more, MyHQ hands it to the owner.",
  };
}

/** hq_blocked_note: a sentence for the owner on an entry of the Standard, optionally handing it to the owner. */
export function hqBlockedNote(db: Db, ctx: HqContext, args: Args<"hq_blocked_note">) {
  assertSupervisor(db, ctx, "hq_blocked_note");
  const parsed = z.object(inputs.hq_blocked_note).parse(args);
  return noteBlocked(
    db,
    { room: ctx.room, agentId: ctx.agentId, runId: ctx.runId },
    { kind: parsed.kind, id: parsed.id },
    parsed.text,
    parsed.handOff ?? false,
  );
}

/** The runs folder of the home: the journals are `<home>/data/runs/<id>.jsonl`, next to the database. */
const runsDirOf = (ctx: HqContext) => path.join(path.dirname(path.resolve(ctx.dbPath)), "runs");

/** hq_run_status: a run as the supervisor checks it, with MyHQ's hints on its activity. Read-only. */
export function hqRunStatus(db: Db, ctx: HqContext, args: Args<"hq_run_status">) {
  assertSupervisor(db, ctx, "hq_run_status");
  const parsed = z.object(inputs.hq_run_status).parse(args);
  const { home } = office(ctx);
  return runStatus(db, home, runsDirOf(ctx), parsed.runId);
}

/** hq_run_extend: more time for a long run that progresses, never past its hard limit. */
export function hqRunExtend(db: Db, ctx: HqContext, args: Args<"hq_run_extend">) {
  assertSupervisor(db, ctx, "hq_run_extend");
  const parsed = z.object(inputs.hq_run_extend).parse(args);
  const result = extendRun(db, { room: ctx.room, agentId: ctx.agentId }, parsed.runId, parsed.minutes);
  return {
    ...result,
    note: result.cappedByHardLimit
      ? "Extended up to its hard limit only: MyHQ interrupts the run then, whatever happens."
      : "Extended: MyHQ wakes you again if it is still running at its new deadline.",
  };
}

/** hq_run_stop: interrupts a stuck run, with the reason the Standard shows. */
export function hqRunStop(db: Db, ctx: HqContext, args: Args<"hq_run_stop">) {
  assertSupervisor(db, ctx, "hq_run_stop");
  const parsed = z.object(inputs.hq_run_stop).parse(args);
  return {
    ...requestStop(db, { room: ctx.room, agentId: ctx.agentId }, parsed.runId, parsed.reason),
    note: "MyHQ interrupts the run now: it ends failed, its own task blocked and its mailbox tasks pending, and the Standard shows your reason.",
  };
}

/**
 * hq_status: what the agent says it is doing, stored with the time and its run
 * (`run_statuses`, migration 21). It writes nothing else: the floor reads it
 * from the tool call itself, which reaches the interface through the event
 * stream of the run, and the sheet lists the steps of the run.
 */
export function hqStatus(db: Db, ctx: HqContext, args: Args<"hq_status">) {
  const parsed = z.object(inputs.hq_status).parse(args);
  const text = normalizeStatus(parsed.text)!;
  const at = now();
  db.prepare("INSERT INTO run_statuses (run_id, room, agent_id, text, created_at) VALUES (?, ?, ?, ?, ?)").run(
    ctx.runId,
    ctx.room,
    ctx.agentId,
    text,
    at,
  );
  return { saved: true as const, text, at };
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
