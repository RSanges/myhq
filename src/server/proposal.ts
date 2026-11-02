import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { isInside, type HqConfig } from "./config";
import type { Db } from "./db";
import { HqError } from "./errors";
import { idSchema, loadHome, loadRoom, roomFileSchema, syncHome, type Room, type RoomFile } from "./rooms";
import { instantiateRole, readRoleTemplate, roleValuesSchema, templateNameSchema } from "./templates";
import { ensureWorktree, worktreeBranch } from "./worktree";

/**
 * The room proposal submitted by the onboarding agent (type `room_proposal`):
 * checked and completed when it is submitted (by the HQ MCP server), applied
 * when it is approved. Kept apart from the runner so that the MCP server
 * stays light.
 */
export const ROOM_PROPOSAL = "room_proposal";

/** What the onboarding agent submits. */
const submittedSchema = z.strictObject({
  room: z.looseObject({
    name: idSchema,
    targetRepo: z.string().min(1),
    agents: z.array(z.looseObject({ id: idSchema })).min(1),
  }),
  roles: z.record(
    idSchema,
    z.strictObject({
      template: templateNameSchema,
      values: roleValuesSchema,
      notes: z.string().trim().max(20_000).optional(),
    }),
  ),
  claudeMd: z.string().trim().min(1).max(20_000),
});

/** What is stored once MyHQ has normalized it, and written on approval. */
export const proposalSchema = z.strictObject({
  room: roomFileSchema,
  roles: z.record(idSchema, z.strictObject({ template: templateNameSchema, content: z.string().min(1) })),
  claudeMd: z.string().min(1),
});
export type RoomProposal = z.infer<typeof proposalSchema>;

function issues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "(payload)"}: ${issue.message}`)
    .join("; ");
}

/** Shown in a fenced block of the approval body: a fence inside would close it. */
const fenced = (lang: string, text: string) => `\`\`\`${lang}\n${text.replace(/^```/gm, "'''")}\n\`\`\``;

/**
 * Validates a submitted room proposal and instantiates its roles from the
 * templates: role paths become `roles/<id>.md`, routines are disarmed. The
 * body gets the full room.json, every role and the CLAUDE.md block, so that
 * the user approves exactly what will be written. Throws an explicit Error
 * the agent can act on.
 */
export function normalizeRoomProposal(
  payload: unknown,
  body: string,
  templatesDir: string,
): { payload: RoomProposal; body: string } {
  const parsed = submittedSchema.safeParse(payload);
  if (!parsed.success) throw new Error(`invalid room_proposal payload: ${issues(parsed.error)}`);
  const { room, roles, claudeMd } = parsed.data;

  const ids = room.agents.map((a) => a.id);
  const missing = ids.filter((id) => !roles[id]);
  const extra = Object.keys(roles).filter((id) => !ids.includes(id));
  if (missing.length > 0) throw new Error(`invalid room_proposal payload: no role for agent(s) ${missing.join(", ")}`);
  if (extra.length > 0) throw new Error(`invalid room_proposal payload: roles without an agent: ${extra.join(", ")}`);

  const file = roomFileSchema.safeParse({
    ...room,
    agents: room.agents.map((agent) => ({ ...agent, role: `roles/${agent.id}.md`, armed: false })),
  });
  if (!file.success) throw new Error(`invalid room_proposal payload: room.${issues(file.error)}`);

  const content: RoomProposal["roles"] = {};
  for (const id of ids) {
    const role = roles[id]!;
    let text: string;
    try {
      text = instantiateRole(readRoleTemplate(templatesDir, role.template), role.values);
    } catch (error) {
      throw new Error(`invalid room_proposal payload: roles.${id}: ${(error as Error).message}`);
    }
    if (role.notes) text = `${text.trimEnd()}\n\n## Project notes\n\n${role.notes}\n`;
    content[id] = { template: role.template, content: text };
  }

  const normalized: RoomProposal = { room: file.data, roles: content, claudeMd };
  const sections = [
    body.trim(),
    "## room.json",
    fenced("json", JSON.stringify(normalized.room, null, 2)),
    "## Roles",
    ...ids.flatMap((id) => [`### ${id} (${content[id]!.template})`, fenced("markdown", content[id]!.content.trim())]),
    "## CLAUDE.md block",
    fenced("markdown", claudeMd),
  ];
  return { payload: normalized, body: sections.join("\n\n") };
}

/** Paths of room.json that must stay inside the home (loadRoom checks them again after writing). */
function checkPaths(home: string, room: RoomFile): void {
  for (const agent of room.agents) {
    for (const [field, value] of [
      ["workingDirectory", agent.workingDirectory],
      ["worktree", agent.worktree],
    ] as const) {
      if (value && !isInside(home, path.resolve(home, value))) {
        throw new HqError("PROPOSAL_INVALID", 422, `${field} of "${agent.id}" must stay inside the home.`);
      }
    }
  }
}

/**
 * Applies an approved room proposal: writes `rooms/<name>/room.json` and the
 * roles, never over an existing room, creates the worktrees, then syncs the
 * home (the room is live without a restart). Throws ROOM_EXISTS,
 * PROPOSAL_INVALID or WORKTREE_FAILED and leaves no room behind.
 */
export function applyRoomProposal(config: HqConfig, db: Db, payload: unknown): Room {
  const parsed = proposalSchema.safeParse(payload);
  if (!parsed.success) throw new HqError("PROPOSAL_INVALID", 422, `Invalid room proposal: ${issues(parsed.error)}`);
  const { room, roles } = parsed.data;
  const roomsDir = path.join(config.home, "rooms");
  const dir = path.join(roomsDir, room.name);
  const exists = () =>
    new HqError("ROOM_EXISTS", 409, `Room "${room.name}" already exists in ${roomsDir}; nothing was written.`);
  if (fs.existsSync(dir)) throw exists();
  checkPaths(config.home, room);
  const target = path.resolve(config.home, room.targetRepo);
  if (!fs.existsSync(target)) {
    throw new HqError("PROPOSAL_INVALID", 422, `The target repository ${target} does not exist.`);
  }

  fs.mkdirSync(roomsDir, { recursive: true });
  try {
    fs.mkdirSync(dir); // not recursive: fails when the room exists
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw exists();
    throw error;
  }

  let loaded: Room;
  try {
    fs.mkdirSync(path.join(dir, "roles"));
    for (const agent of room.agents) {
      fs.writeFileSync(path.join(dir, "roles", `${agent.id}.md`), roles[agent.id]!.content, "utf8");
    }
    fs.writeFileSync(path.join(dir, "room.json"), `${JSON.stringify(room, null, 2)}\n`, "utf8");
    try {
      loaded = loadRoom(config.home, dir);
    } catch (error) {
      throw new HqError("PROPOSAL_INVALID", 422, (error as Error).message);
    }
    for (const agent of loaded.agents) {
      if (!agent.worktree) continue;
      try {
        ensureWorktree({ repo: loaded.targetRepo, dir: agent.worktree, branch: worktreeBranch(agent.id) });
      } catch (error) {
        throw new HqError("WORKTREE_FAILED", 422, `Worktree of "${agent.id}": ${(error as Error).message}`);
      }
    }
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  syncHome(db, loadHome(config.home));
  return loaded;
}
