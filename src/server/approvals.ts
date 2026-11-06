import { z } from "zod";
import { strings } from "../ui/strings";
import { annotationsSchema, decisionText, parseAnnotations, type Annotation } from "./annotations";
import { getConfig, type HqConfig } from "./config";
import { now, type ApprovalRow, type ApprovalStatus, type Db } from "./db";
import { HqError } from "./errors";
import { parseDecisionHistory, type DecisionRecord } from "./decision-history";
import { APPROVAL_SELECT, toApproval, type ApprovalDto, type ApprovalRowWithAction } from "./feed";
import { AGENT_PROPOSAL, applyAgentProposal } from "./agent-proposal";
import { applyRoomProposal, ROOM_PROPOSAL } from "./proposal";
import { startApprovalCommand } from "./approval-command";
import { loadHome, type Agent } from "./rooms";
import { agentEnv, wakeAgents, type RunnerDeps } from "./runner";
import { deliverRelays, hasRelays } from "./supervisor";

export const decisionSchema = z
  .strictObject({
    decision: z.enum(["approved", "rejected", "revise"]),
    note: z.string().trim().max(5_000).optional(),
    /** Remarks on passages of the body, for `revise` and `rejected` only. */
    annotations: annotationsSchema.optional(),
  })
  .superRefine((d, ctx) => {
    const annotated = (d.annotations?.length ?? 0) > 0;
    if (d.decision === "approved" && annotated) {
      ctx.addIssue({ code: "custom", message: "annotations only go with a rejection or a revision", path: ["annotations"] });
    }
    // A revision may rest on its annotations alone; a rejection always has a reason.
    const needsNote = d.decision === "rejected" || (d.decision === "revise" && !annotated);
    if (needsNote && !d.note) {
      ctx.addIssue({ code: "custom", message: "a note is required to reject or to ask for a revision", path: ["note"] });
    }
  });
export type Decision = z.infer<typeof decisionSchema>;

/**
 * The task sent back to the agent. Without annotations, the user's note alone;
 * with them, the numbered remarks then the general note (see decisionText).
 */
export function revisionTaskText(
  id: number,
  title: string,
  type: string,
  note: string | null,
  annotations: readonly Annotation[],
): string {
  const head = `Revise your submission #${id} "${title}" (${type}).`;
  if (annotations.length === 0) return `${head} User's note: ${note}`;
  return `${head} User's remarks:
${decisionText(note, annotations)}`;
}

/** The agent of an item in the home, null when the home no longer has it. */
function agentOf(config: HqConfig, row: ApprovalRow): Agent | null {
  return (
    loadHome(config.home)
      .rooms.find((room) => room.name === row.room)
      ?.agents.find((a) => a.id === row.agent_id) ?? null
  );
}

/**
 * Decides a pending approval. `revise` sends the item back to its agent as a
 * new task carrying the user's note. It is also the one decision an item
 * that was already decided accepts: an approved or rejected item can still be
 * sent back (its previous decision goes to `decision_history`), and an item
 * already in `revise` only when the new note or remarks differ from the ones
 * it has. Any other decision on a decided item is `APPROVAL_ALREADY_DECIDED`.
 * A revision wakes the agent at once (`wakeAgents`, reason `revise`) unless it
 * has `onRevise: "queue"`; the wake-up needs `config`, the callers of the app
 * always give it. A `room_proposal` or an `agent_proposal` is the onboarding
 * agent's (the receptionist), which is no room agent: a revision gives it the
 * same task and relaunches it on the proposal's repository or need (see
 * `wakeOnboarding`). A rejection ends the matter, for these items as for any
 * other: no task, no wake-up.
 *
 * Approving a `room_proposal` writes the room in the home first (see
 * proposal.ts), approving an `agent_proposal` adds the agent to its room (see
 * agent-proposal.ts): when that fails, the item stays pending and the error
 * is thrown. Approving an item of an agent with `onApproval: "task"` gives that
 * agent a task to execute it, and wakes it (`wakeAgents`; with `"queue"` the
 * task waits for its next run): the agent acts, through its own tools. With
 * `onApproval: "command"`, MyHQ runs the agent's `approvalCommand` instead,
 * without a model turn, and falls back to the task when it fails (see
 * approval-command.ts). An item submitted with `onApprove` has its messages
 * delivered by MyHQ on approval (`deliverRelays`, expects `action`), and its
 * agent gets no task for it (a command still runs). No other type is acted
 * on: the item keeps its payload, and publishing or pushing stays the user's.
 */
export function decideApproval(
  db: Db,
  id: number,
  decision: Decision,
  config?: HqConfig,
  deps: RunnerDeps = {},
): ApprovalDto {
  let taskFor: HqConfig | null = null;
  let queueTaskFor: HqConfig | null = null;
  let relayFor: HqConfig | null = null;
  let command: { config: HqConfig; agent: Agent; row: ApprovalRow } | null = null;
  let wakeFor: HqConfig | null = decision.decision === "revise" ? (config ?? null) : null;
  if (decision.decision === "approved") {
    const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
    if (row?.status === "pending" && row.type === ROOM_PROPOSAL) {
      applyRoomProposal(config ?? getConfig(), db, JSON.parse(row.payload) as unknown);
    }
    if (row?.status === "pending" && row.type === AGENT_PROPOSAL) {
      applyAgentProposal(config ?? getConfig(), db, JSON.parse(row.payload) as unknown);
    }
    if (row?.status === "pending") {
      const cfg = config ?? getConfig();
      const agent = agentOf(cfg, row);
      const wanted = agent?.onApproval ?? null;
      // MyHQ delivers the item's messages itself: the agent is not woken to relay them.
      if (hasRelays(db, id)) relayFor = wakeFor = cfg;
      if (wanted === "command" && agent) command = { config: cfg, agent, row };
      else if (relayFor) {
        // No task: the relay is the execution.
      } else if (wanted === "task") taskFor = wakeFor = cfg;
      else if (wanted === "queue") queueTaskFor = cfg;
    }
  }
  const approval = db
    .transaction(() => {
      const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
      if (!row) throw new HqError("APPROVAL_NOT_FOUND", 404, `No approval #${id}.`);
      const at = now();
      const note = decision.note || null;
      const annotations = decision.annotations ?? [];
      let history = parseDecisionHistory(row.decision_history);
      if (isWatchStatus(row.status)) {
        throw new HqError("APPROVAL_NOT_DECIDABLE", 409, `Approval #${id} is informational: mark it seen, there is nothing to decide.`);
      }
      if (row.status !== "pending") {
        if (decision.decision !== "revise") {
          throw new HqError("APPROVAL_ALREADY_DECIDED", 409, `Approval #${id} is already ${row.status}.`);
        }
        const current: DecisionRecord = {
          decision: row.status,
          note: row.decision_note,
          annotations: parseAnnotations(row.annotations),
          decidedAt: row.decided_at,
        };
        if (row.status === "revise" && current.note === note && JSON.stringify(current.annotations) === JSON.stringify(annotations)) {
          throw new HqError(
            "APPROVAL_ALREADY_DECIDED",
            409,
            `Approval #${id} is already sent back for a revision: add a new note or remark.`,
          );
        }
        history = [...history, current];
      }
      // The agent reads the new decision whether or not it read the previous one.
      db.prepare(
        `UPDATE approvals SET status = ?, decision_note = ?, annotations = ?, decided_at = ?,
           decision_history = ?, seen_by_agent_at = NULL WHERE id = ?`,
      ).run(decision.decision, note, JSON.stringify(annotations), at, JSON.stringify(history), id);
      if (decision.decision === "revise") {
        db.prepare(
          `INSERT INTO tasks (room, agent_id, source, ref_id, text, status, created_at, updated_at)
           VALUES (?, ?, 'revise', ?, ?, 'pending', ?, ?)`,
        ).run(
          row.room,
          row.agent_id,
          id,
          revisionTaskText(id, row.title, row.type, note, annotations),
          at,
          at,
        );
      }
      if (decision.decision === "approved" && (taskFor || queueTaskFor)) {
        db.prepare(
          `INSERT INTO tasks (room, agent_id, source, ref_id, text, status, created_at, updated_at)
           VALUES (?, ?, 'approval', ?, ?, 'pending', ?, ?)`,
        ).run(row.room, row.agent_id, id, strings.tasks.executeApproved(id, row.title), at, at);
      }
      if (decision.decision === "approved" && relayFor) deliverRelays(db, row);
      return toApproval(db.prepare(`${APPROVAL_SELECT} WHERE a.id = ?`).get(id) as ApprovalRowWithAction);
    })
    .immediate();
  if (command) {
    const { config: cfg, agent, row } = command;
    startApprovalCommand({
      config: cfg,
      db,
      row,
      agent,
      note: decision.note || null,
      env: agentEnv(process.env, {}),
      wake: () => {
        try {
          wakeAgents(cfg, db, deps);
        } catch (error) {
          console.error(`[approvals] wake after the command of #${id} failed`, error);
        }
      },
    });
  }
  if (wakeFor) {
    // The decision stands whatever happens next: a busy agent or the daily
    // cap leave the task waiting for the agent's next run.
    try {
      wakeAgents(wakeFor, db, deps);
    } catch (error) {
      console.error(`[approvals] wake after approval #${id} failed`, error);
    }
  }
  return approval;
}

/** Whether an item is informational (`unseen` or `seen`): it waits for a look, never for a decision. */
export function isWatchStatus(status: ApprovalStatus): status is "unseen" | "seen" {
  return status === "unseen" || status === "seen";
}

/**
 * « Vu »: an informational item (`notifyTypes`, status `unseen`) leaves the
 * desk's « À regarder » section and stays in the history. Idempotent, since
 * the desk and the Telegram button may both press it: a `seen` item is
 * returned as is. Any other item is not concerned (`APPROVAL_NOT_WATCHABLE`).
 * Nothing wakes: no task is written, and the agent never reads it back.
 */
export function markApprovalSeen(db: Db, id: number): ApprovalDto {
  return db
    .transaction(() => {
      const row = db.prepare("SELECT status FROM approvals WHERE id = ?").get(id) as { status: ApprovalStatus } | undefined;
      if (!row) throw new HqError("APPROVAL_NOT_FOUND", 404, `No approval #${id}.`);
      if (row.status === "unseen") {
        db.prepare("UPDATE approvals SET status = 'seen', decided_at = ? WHERE id = ?").run(now(), id);
      } else if (row.status !== "seen") {
        throw new HqError("APPROVAL_NOT_WATCHABLE", 409, `Approval #${id} is not an informational item to look at.`);
      }
      return toApproval(db.prepare(`${APPROVAL_SELECT} WHERE a.id = ?`).get(id) as ApprovalRowWithAction);
    })
    .immediate();
}
