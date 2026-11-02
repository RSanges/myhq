/** A slash command as typed in Telegram: `/name@BotName arguments`. */
export type ParsedCommand = { name: string; args: string };

/** Parses `/name[@bot] [args]`. Returns null for anything that is not a command. */
export function parseCommand(text: string): ParsedCommand | null {
  const match = /^\/([A-Za-z0-9_]{1,32})(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  return { name: match[1]!.toLowerCase(), args: (match[2] ?? "").trim() };
}

export type CoreCommandName =
  | "start"
  | "new"
  | "pending"
  | "approve"
  | "reject"
  | "revise"
  | "run"
  | "status"
  | "arm"
  | "disarm"
  | "salle";
export const CORE_COMMANDS: readonly CoreCommandName[] = [
  "start",
  "new",
  "pending",
  "approve",
  "reject",
  "revise",
  "run",
  "status",
  "arm",
  "disarm",
  "salle",
];

export function isCoreCommand(name: string): name is CoreCommandName {
  return (CORE_COMMANDS as readonly string[]).includes(name);
}

/** `/approve 12` (an optional `#` is accepted). */
export function parseApproveArgs(args: string): { id: number } | null {
  const match = /^#?(\d{1,9})$/.exec(args);
  return match ? { id: Number(match[1]) } : null;
}

/** `/reject 12 reason` and `/revise 12 comment`: the note is required. */
export function parseNoteArgs(args: string): { id: number; note: string } | null {
  const match = /^#?(\d{1,9})\s+([\s\S]+)$/.exec(args);
  if (!match) return null;
  const note = match[2]!.trim();
  return note ? { id: Number(match[1]), note } : null;
}

/** `/run room/agent [task]`. */
export function parseRunArgs(args: string): { room: string; agent: string; task?: string } | null {
  const match = /^([a-z0-9][a-z0-9_-]{0,62})\/([a-z0-9][a-z0-9_-]{0,62})(?:\s+([\s\S]+))?$/.exec(args);
  if (!match) return null;
  const task = match[3]?.trim();
  return { room: match[1]!, agent: match[2]!, ...(task ? { task } : {}) };
}

/** `/arm room/agent` and `/disarm room/agent`. */
export function parseAgentArgs(args: string): { room: string; agent: string } | null {
  const parsed = parseRunArgs(args);
  return parsed && parsed.task === undefined ? { room: parsed.room, agent: parsed.agent } : null;
}
