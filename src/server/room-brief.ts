import fs from "node:fs";
import { z } from "zod";
import { strings } from "../ui/strings";
import type { HqConfig } from "./config";
import { replaceDashes } from "./dashes";
import type { ApprovalRow } from "./db";
import { HqError } from "./errors";
import { writeTextAtomic } from "./home-file";
import { loadHome, type RoomFile } from "./rooms";

// The room brief (room.json `brief`, docs/home-layout.md "The room brief"):
// the draft MyHQ proposes when a room is created, and the new text its keeper
// proposes (type `room_brief`), written only on approval. Loading and joining
// a brief to a run live in rooms.ts and runner.ts. Kept apart from the runner
// so that the MCP server stays light.

/** Where the draft goes when the room declares no brief: next to room.json. */
export const BRIEF_DRAFT_FILE = "brief.md";

/**
 * The brief draft of a room: generic headings to fill in, with what MyHQ
 * knows without a model (the room's name, its repository, its agents).
 */
export function briefDraft(room: Pick<RoomFile, "name" | "targetRepo"> & { label?: string; agents: { id: string; name: string }[] }): string {
  return strings.roomBrief.draft({
    title: room.label ?? room.name,
    name: room.name,
    targetRepo: room.targetRepo,
    agents: room.agents.map((agent) => `${agent.id} (${agent.name})`),
  });
}

/** The item by which the keeper of a room's brief proposes its new text. */
export const ROOM_BRIEF = "room_brief";

/** Its payload: the whole new text of the brief and what changed. */
export const roomBriefSchema = z.strictObject({
  text: z.string().trim().min(1).max(100_000),
  summary: z.string().trim().min(1).max(2_000),
});

function issues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.length ? issue.path.join(".") : "(payload)"}: ${issue.message}`).join("; ");
}

/** Shown in a fenced block of the approval body: a fence inside would close it. */
const fenced = (text: string) => `\`\`\`markdown\n${text.replace(/^```/gm, "'''")}\n\`\`\``;

/**
 * Validates a submitted room_brief (the keeper is checked by hq_submit): the
 * stored text ends with a newline and has no em or en dash, and the body gets
 * the summary and the whole text, so that the owner approves exactly what
 * will be written. Throws an explicit Error the agent can act on.
 */
export function normalizeRoomBrief(payload: unknown, body: string): { payload: z.infer<typeof roomBriefSchema>; body: string } {
  const parsed = roomBriefSchema.safeParse(payload);
  if (!parsed.success) throw new Error(`invalid room_brief payload: ${issues(parsed.error)}`);
  const normalized = { text: `${replaceDashes(parsed.data.text)}\n`, summary: replaceDashes(parsed.data.summary) };
  const t = strings.roomBrief.body;
  return {
    payload: normalized,
    body: [body.trim(), `## ${t.summary}`, normalized.summary, `## ${t.text}`, fenced(normalized.text.trimEnd())].join("\n\n"),
  };
}

/**
 * Applies an approved room_brief: the old brief is copied beside it
 * (`<file>.<YYYYMMDD-HHMMSS>.bak`, UTC), then the new text replaces it
 * atomically. Throws ROOM_BRIEF_INVALID, and writes nothing, when the room is
 * gone or invalid, has no brief any more, its submitter no longer keeps it,
 * or the payload is invalid.
 */
export function applyRoomBrief(config: HqConfig, row: Pick<ApprovalRow, "room" | "agent_id" | "payload">): void {
  const invalid = (message: string) => new HqError("ROOM_BRIEF_INVALID", 422, `${message}; nothing was written.`);
  const parsed = roomBriefSchema.safeParse(JSON.parse(row.payload));
  if (!parsed.success) throw invalid(`Invalid room brief: ${issues(parsed.error)}`);
  const room = loadHome(config.home).rooms.find((each) => each.name === row.room);
  if (!room) throw invalid(`No valid room "${row.room}" in the home`);
  if (!room.brief) throw invalid(`Room "${row.room}" declares no brief any more`);
  if (room.brief.keeper !== row.agent_id) throw invalid(`"${row.agent_id}" no longer keeps the brief of room "${row.room}"`);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  if (fs.existsSync(room.brief.file)) fs.copyFileSync(room.brief.file, `${room.brief.file}.${stamp}.bak`, fs.constants.COPYFILE_EXCL);
  writeTextAtomic(room.brief.file, parsed.data.text.endsWith("\n") ? parsed.data.text : `${parsed.data.text}\n`);
}
