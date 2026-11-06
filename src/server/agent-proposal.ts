import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { strings } from "../ui/strings";
import { isInside, type HqConfig } from "./config";
import { replaceDashes } from "./dashes";
import { now, type Db, type TaskSource } from "./db";
import { HqError } from "./errors";
import { agentSchema, idSchema, loadHome, loadRoom, roomFileSchema, syncHome, type Room } from "./rooms";
import { ensureWorktree, worktreeBranch } from "./worktree";

/**
 * The agent proposal submitted by the receptionist (type `agent_proposal`):
 * one agent for one room of the home, answering a need no agent covers.
 * Checked when it is submitted (by the HQ MCP server), applied when it is
 * approved: `rooms/<room>/roles/<id>.md` is written and the agent appended to
 * that room's `room.json`, its routines disarmed. Kept apart from the runner
 * so that the MCP server stays light.
 */
export const AGENT_PROPOSAL = "agent_proposal";

/**
 * The agent as stored: the fields of room.json without `role` (MyHQ writes it), never armed, and never an
 * `approvalCommand` (what MyHQ runs on an approval is the owner's to write in room.json).
 */
export const proposedAgentSchema = agentSchema.omit({ role: true, armed: true, approvalCommand: true }).extend({ armed: z.literal(false) });

/** What is stored once MyHQ has normalized it, and applied on approval. */
export const agentProposalSchema = z.strictObject({
  /** The room that gets the agent. */
  room: idSchema,
  agent: proposedAgentSchema,
  /** The whole role prompt, in the language of the home. */
  rolePrompt: z.string().min(1).max(40_000),
  /** Why this agent, with these tools, this model and this budget. */
  reason: z.string().min(1).max(5_000),
  /** The need it answers, as it was asked. */
  need: z.string().min(1).max(2_000),
  /** Who asked: the owner, or an agent of a room. */
  requestedBy: z.string().min(1).max(300),
});
export type AgentProposal = z.infer<typeof agentProposalSchema>;

/** What the receptionist submits: the same, with an agent read loosely (role and armed are MyHQ's). */
const submittedSchema = agentProposalSchema.extend({
  agent: z.looseObject({ id: idSchema }),
  rolePrompt: z.string().trim().min(1).max(40_000),
  reason: z.string().trim().min(1).max(5_000),
  need: z.string().trim().min(1).max(2_000),
  requestedBy: z.string().trim().min(1).max(300),
});

function issues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "(payload)"}: ${issue.message}`)
    .join("; ");
}

/** Shown in a fenced block of the approval body: a fence inside would close it. */
const fenced = (lang: string, text: string) => `\`\`\`${lang}\n${text.replace(/^```/gm, "'''")}\n\`\`\``;

/** The heading MyHQ puts after the receptionist's own text: what comes before it is the agent's. */
export const agentProposalSummaryHeading = () => `## ${strings.agentProposal.body.summary}`;

/** The readable summary of the body: room, agent, model, budget, tools, schedule, who asked, why. */
function summaryLines(p: AgentProposal): string[] {
  const t = strings.agentProposal.body;
  const a = p.agent;
  const cron = a.cron === undefined ? null : typeof a.cron === "string" ? [a.cron] : a.cron.map((r) => r.cron);
  return [
    `- ${t.room} : ${p.room}`,
    `- ${t.agent} : ${a.id} (${a.name}), ${t.model} ${a.model}${a.maxBudgetUsd !== undefined ? `, ${t.budget(a.maxBudgetUsd)}` : ""}`,
    `- ${t.tools} : ${a.allowedTools.length > 0 ? a.allowedTools.map((tool) => `\`${tool}\``).join(", ") : t.none}`,
    ...(a.disallowedTools?.length ? [`- ${t.denied} : ${a.disallowedTools.map((tool) => `\`${tool}\``).join(", ")}`] : []),
    ...(a.worktree ? [`- ${t.worktree} : \`${a.worktree}\``] : []),
    `- ${t.schedule} : ${cron ? `${cron.map((c) => `\`${c}\``).join(", ")} (${t.disarmed})` : t.none}`,
    `- ${t.requestedBy} : ${p.requestedBy}`,
    `- ${t.need} : ${p.need}`,
    `- ${t.reason} : ${p.reason}`,
  ];
}

/**
 * Validates a submitted agent proposal: the agent against the agent schema of
 * room.json (`role` is MyHQ's, `armed` forced to false), a role prompt with no
 * placeholder left. The body gets a readable summary, the role prompt and the
 * room.json entry, so that the user approves exactly what will be written.
 * Throws an explicit Error the receptionist can act on. Whether the room
 * exists and the id is free is checked by the caller (it knows the home).
 */
export function normalizeAgentProposal(payload: unknown, body: string): { payload: AgentProposal; body: string } {
  const parsed = submittedSchema.safeParse(payload);
  if (!parsed.success) throw new Error(`invalid agent_proposal payload: ${issues(parsed.error)}`);
  const { room, agent, rolePrompt, reason, need, requestedBy } = parsed.data;
  const rest: Record<string, unknown> = { ...agent };
  delete rest.role;
  const file = proposedAgentSchema.safeParse({ ...rest, armed: false });
  if (!file.success) throw new Error(`invalid agent_proposal payload: agent.${issues(file.error)}`);
  const left = [...new Set(rolePrompt.match(/\{\{\w+\}\}/g) ?? [])];
  if (left.length > 0) throw new Error(`invalid agent_proposal payload: rolePrompt still has placeholder(s): ${left.join(", ")}`);

  // MyHQ never writes em or en dashes, in the home either.
  const normalized: AgentProposal = {
    room,
    agent: file.data,
    rolePrompt: `${replaceDashes(rolePrompt)}\n`,
    reason: replaceDashes(reason),
    need: replaceDashes(need),
    requestedBy: replaceDashes(requestedBy),
  };
  const t = strings.agentProposal.body;
  const sections = [
    replaceDashes(body.trim()),
    agentProposalSummaryHeading(),
    ...summaryLines(normalized),
    `## ${t.rolePrompt(`roles/${normalized.agent.id}.md`)}`,
    fenced("markdown", normalized.rolePrompt.trim()),
    `## ${t.entry}`,
    fenced("json", JSON.stringify({ ...normalized.agent, role: `roles/${normalized.agent.id}.md` }, null, 2)),
  ];
  return { payload: normalized, body: sections.join("\n\n") };
}

/**
 * Applies an approved agent proposal: writes `rooms/<room>/roles/<id>.md`,
 * appends the agent to `room.json` (its routines disarmed), creates its
 * worktree when it has one, then syncs the home (the agent is live without a
 * restart). Throws ROOM_NOT_FOUND (no such room in the home), AGENT_EXISTS
 * (the id or its role file is taken), AGENT_PROPOSAL_INVALID (the payload,
 * or the room it would give, is invalid) or WORKTREE_FAILED, and then leaves
 * the room exactly as it was.
 */
export function applyAgentProposal(config: HqConfig, db: Db, payload: unknown): Room {
  const parsed = agentProposalSchema.safeParse(payload);
  if (!parsed.success) throw new HqError("AGENT_PROPOSAL_INVALID", 422, `Invalid agent proposal: ${issues(parsed.error)}`);
  const { room: name, agent, rolePrompt } = parsed.data;
  const dir = path.join(config.home, "rooms", name);
  const file = path.join(dir, "room.json");
  const home = loadHome(config.home);
  if (!home.rooms.some((r) => r.name === name)) {
    throw new HqError("ROOM_NOT_FOUND", 422, `No valid room "${name}" in the home; nothing was written.`);
  }
  const original = fs.readFileSync(file, "utf8");
  const current = roomFileSchema.parse(JSON.parse(original));
  const rolePath = path.join(dir, "roles", `${agent.id}.md`);
  if (current.agents.some((a) => a.id === agent.id) || fs.existsSync(rolePath)) {
    throw new HqError("AGENT_EXISTS", 409, `Room "${name}" already has an agent "${agent.id}" (or its role file); nothing was written.`);
  }
  for (const [field, value] of [
    ["workingDirectory", agent.workingDirectory],
    ["worktree", agent.worktree],
  ] as const) {
    if (value && !isInside(config.home, path.resolve(config.home, value))) {
      throw new HqError("AGENT_PROPOSAL_INVALID", 422, `${field} of "${agent.id}" must stay inside the home.`);
    }
  }
  const next = roomFileSchema.safeParse({ ...current, agents: [...current.agents, { ...agent, role: `roles/${agent.id}.md` }] });
  if (!next.success) throw new HqError("AGENT_PROPOSAL_INVALID", 422, `The room would be invalid: ${issues(next.error)}`);

  let loaded: Room;
  try {
    fs.mkdirSync(path.dirname(rolePath), { recursive: true });
    fs.writeFileSync(rolePath, rolePrompt, { encoding: "utf8", flag: "wx" });
    fs.writeFileSync(file, `${JSON.stringify(next.data, null, 2)}\n`, "utf8");
    try {
      loaded = loadRoom(config.home, dir);
    } catch (error) {
      throw new HqError("AGENT_PROPOSAL_INVALID", 422, (error as Error).message);
    }
    const added = loaded.agents.find((a) => a.id === agent.id)!;
    if (added.worktree) {
      try {
        ensureWorktree({ repo: loaded.targetRepo, dir: added.worktree, branch: worktreeBranch(added.id) });
      } catch (error) {
        throw new HqError("WORKTREE_FAILED", 422, `Worktree of "${added.id}": ${(error as Error).message}`);
      }
    }
  } catch (error) {
    fs.writeFileSync(file, original, "utf8");
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") fs.rmSync(rolePath, { force: true });
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new HqError("AGENT_EXISTS", 409, `The role file of "${agent.id}" already exists; nothing was written.`);
    }
    throw error;
  }
  syncHome(db, loadHome(config.home));
  return loaded;
}

// --- Needs ------------------------------------------------------------------

/**
 * A need reaches the receptionist as a message: a task of source `message`
 * for `_hq/onboarding`, which no agent can write to with `hq_message` (`_hq`
 * is no room of the home), so every such task is a need.
 */
export const NEED_SOURCE: TaskSource = "message";

/** A need no agent covers, as the owner or an agent words it. */
export const needSchema = z.string().trim().min(1).max(2_000);

/** Two needs are the same when they read the same, case and spacing aside. */
export function sameNeed(a: string, b: string): boolean {
  const norm = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Gives the receptionist (`_hq/onboarding`) a pending need (`NEED_SOURCE`):
 * its text is the need, `from_room` the room it comes from (or the room the
 * owner suggests), `from_agent` the agent that asked (null for the owner).
 * The run that answers it is started by the caller or by `wakeOnboarding`.
 */
export function queueAgentNeed(
  db: Db,
  p: { room: string; agent: string; need: string; fromRoom: string | null; fromAgent: string | null },
): number {
  const at = now();
  return Number(
    db
      .prepare(
        `INSERT INTO tasks (room, agent_id, source, text, status, from_room, from_agent, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      )
      .run(p.room, p.agent, NEED_SOURCE, needSchema.parse(p.need), p.fromRoom, p.fromAgent, at, at).lastInsertRowid,
  );
}
