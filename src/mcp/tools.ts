import path from "node:path";
import { z } from "zod";
import type { Env } from "../server/config";
import { decisionText, parseAnnotations } from "../server/annotations";
import { now, type ApprovalRow, type Db } from "../server/db";
import { readNotifyTypes } from "../server/home-settings";
import { normalizeRoomProposal, ROOM_PROPOSAL } from "../server/proposal";

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

/** Input shapes of the seven tools (zod raw shapes, as the MCP SDK expects). */
export const inputs = {
  hq_message: {
    to: z.string().min(1).describe("Id of the agent of this room to write to."),
    text: z.string().min(1).max(20_000).describe("The message. It becomes a task for the recipient."),
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
} as const;

type Args<K extends keyof typeof inputs> = z.infer<z.ZodObject<(typeof inputs)[K]>>;

export class ToolError extends Error {}

export function hqMessage(db: Db, ctx: HqContext, args: Args<"hq_message">) {
  const parsed = z.object(inputs.hq_message).parse(args);
  const target = db
    .prepare("SELECT id FROM agents WHERE room = ? AND id = ?")
    .get(ctx.room, parsed.to);
  if (!target) throw new ToolError(`Unknown agent "${parsed.to}" in room "${ctx.room}".`);
  if (parsed.to === ctx.agentId) throw new ToolError("An agent cannot write to itself.");
  const at = now();
  return db.transaction(() => {
    const message = db
      .prepare(
        "INSERT INTO messages (room, from_agent, to_agent, text, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(ctx.room, ctx.agentId, parsed.to, parsed.text, ctx.runId, at);
    const messageId = Number(message.lastInsertRowid);
    db.prepare(
      `INSERT INTO tasks (room, agent_id, source, ref_id, text, status, created_at, updated_at)
       VALUES (?, ?, 'message', ?, ?, 'pending', ?, ?)`,
    ).run(ctx.room, parsed.to, messageId, `Message from ${ctx.agentId}: ${parsed.text}`, at, at);
    return { messageId };
  })();
}

export function hqSubmit(db: Db, ctx: HqContext, args: Args<"hq_submit">) {
  const parsed = z.object(inputs.hq_submit).parse(args);
  let { body, payload } = parsed;
  if (parsed.type === ROOM_PROPOSAL) {
    // Checked now, so that the agent can fix its payload within the same run.
    if (!ctx.templatesDir) throw new ToolError("room_proposal: the role templates are not available.");
    try {
      ({ body, payload } = normalizeRoomProposal(parsed.payload ?? {}, parsed.body, ctx.templatesDir));
    } catch (error) {
      throw new ToolError((error as Error).message);
    }
  }
  // An informational type (notifyTypes in myhq.json) is born 'unseen': the app
  // sends it to Telegram in full and the desk keeps it under « À regarder »
  // until the user marks it seen. It never waits for a decision, never
  // triggers onApproval and never wakes an agent. Its agent already knows it,
  // so it counts as read by the agent.
  const informational =
    parsed.type !== ROOM_PROPOSAL && ctx.home !== undefined && readNotifyTypes(ctx.home).includes(parsed.type);
  const at = now();
  const result = db
    .prepare(
      `INSERT INTO approvals (room, agent_id, run_id, type, title, body, payload, status, decision_note,
         decided_at, seen_by_agent_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      at,
    );
  return {
    approvalId: Number(result.lastInsertRowid),
    status: informational ? ("unseen" as const) : ("pending" as const),
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
    .prepare("SELECT id, room, agent_id, type, title, created_at FROM approvals WHERE status = 'pending' ORDER BY id")
    .all() as Pick<ApprovalRow, "id" | "room" | "agent_id" | "type" | "title" | "created_at">[];
  return {
    pending: rows.map((row) => ({
      id: row.id,
      room: row.room,
      agent: row.agent_id,
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
