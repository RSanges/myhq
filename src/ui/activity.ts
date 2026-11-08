import { strings } from "./strings";

// What an agent at work is doing, in a few words (docs/architecture.md, "The
// activity bubble"). The agent says it itself with the HQ tool `hq_status`
// (60 characters at most); when it has said nothing for a while, its last tool
// says it instead, translated here without any model (`toolActivity`). The
// floor shows it in a bubble over its head (30 characters), its chip and its
// sheet in full. Pure: the MCP server checks a status with the same function
// as the interface (`normalizeStatus`), so both agree on what is one.

/** The HQ tool an agent calls to say what it is doing. */
export const HQ_STATUS_TOOL = "mcp__hq__hq_status";
/** The longest status `hq_status` takes. */
export const STATUS_MAX_CHARS = 60;
/** The characters of a status the bubble over the head shows. */
export const BUBBLE_CHARS = 30;
/** How long the latest status wins over the agent's tools; after that its last tool says what it does. */
export const ANNOUNCE_MS = 2 * 60_000;

/**
 * A status as `hq_status` stores it: one line, its spaces collapsed. Null for
 * one that is not a string, blank, or longer than STATUS_MAX_CHARS as given
 * (the limit of the tool's input, so that the server and the interface agree).
 */
export function normalizeStatus(text: unknown): string | null {
  if (typeof text !== "string" || text.length > STATUS_MAX_CHARS) return null;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat === "" ? null : flat;
}

/** The text of the bubble: cut at BUBBLE_CHARS, with « … ». */
export function bubbleText(text: string, max: number = BUBBLE_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** The name of a file from a path of either system. */
function fileName(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parts = value.trim().split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

/** A shell command in a few words: what kind of work it does, never the command itself. */
function commandActivity(command: string): string {
  const a = strings.room.activity;
  const text = command.toLowerCase();
  if (/\b(ffmpeg|ffprobe|melt)\b/.test(text)) return a.editsVideo;
  if (/\bremotion\b/.test(text)) return a.rendersVideo;
  if (/\bblender\b/.test(text)) return a.models3d;
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|lint|typecheck|check)\b|\b(pytest|vitest|jest|tsc|eslint)\b/.test(text)) return a.checks;
  if (/\bgit\b/.test(text)) return a.code;
  if (/\b(python3?|py|node|tsx|ts-node|npx|deno|bun|curl|wget|pwsh|powershell|bash|sh)\b/.test(text)) return a.script;
  return a.command;
}

/**
 * The last tool of an agent in a few words, for when it has not said what it
 * does: `lit notes.md`, `cherche dans les fichiers`, `monte la vidéo`... Null
 * for `hq_status` itself (its text says it) and for a tool it cannot word.
 */
export function toolActivity(name: string, input: Record<string, unknown> = {}): string | null {
  const a = strings.room.activity;
  const file = fileName(input.file_path ?? input.notebook_path ?? input.path);
  switch (name) {
    case "Read":
      return file ? a.reads(file) : a.readsFiles;
    case "Grep":
    case "Glob":
    case "LS":
      return a.searchesFiles;
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return file ? a.writes(file) : a.writesFiles;
    case "WebSearch":
      return a.searchesWeb;
    case "WebFetch":
      return a.readsWeb;
    case "Bash":
    case "PowerShell":
      return commandActivity(typeof input.command === "string" ? input.command : "");
    case "TodoWrite":
      return a.plans;
    case "Task":
    case "Agent":
      return a.delegates;
    case HQ_STATUS_TOOL:
      return null;
    case "mcp__hq__hq_submit":
      return a.submits;
    case "mcp__hq__hq_message":
      return typeof input.to === "string" && input.to !== "" ? a.writesTo(input.to) : a.writesToSomeone;
    case "mcp__hq__hq_ask":
      return a.asks;
    case "mcp__hq__hq_memory_read":
      return a.remembers;
    case "mcp__hq__hq_memory_write":
      return a.notes;
    case "mcp__hq__hq_items":
    case "mcp__hq__hq_pending":
    case "mcp__hq__hq_read_decisions":
      return a.readsItems;
    case "mcp__hq__hq_task_update":
      return a.reports;
    case "mcp__hq__hq_rooms":
      return a.rooms;
  }
  // The tool of another MCP server: the name of the server says enough (« utilise courrier »).
  const server = /^mcp__([^_]+(?:_[^_]+)*)__/.exec(name)?.[1];
  return server && server !== "hq" ? a.uses(server) : null;
}

/** When the agent last said what it does (hq_status), and what its last tool says, in epoch milliseconds. */
export type Activity = {
  announced: { text: string; at: number } | null;
  lastTool: { text: string; at: number } | null;
};

/**
 * What an agent at work is doing at `at`: its latest status while it is less
 * than ANNOUNCE_MS old, then its last tool. A status stays as long as no tool
 * came after it: an older tool would say less than it.
 */
export function currentActivity(activity: Activity, at: number): string | null {
  const { announced, lastTool } = activity;
  if (announced && (at - announced.at < ANNOUNCE_MS || !lastTool || lastTool.at <= announced.at)) return announced.text;
  return lastTool?.text ?? null;
}
