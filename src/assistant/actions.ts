import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { strings } from "../ui/strings";
import type { ChatConfig } from "./home-config";
import { REJECTED_DIR } from "./requests";

/**
 * Actions the chat may ask the core to take on the HQ, by writing a file in
 * the directory of `chat.requests` (whitelisted by `chat.requests.actions`).
 * The core executes them with the code of the buttons and of the commands.
 */
export const CHAT_ACTIONS = ["approve", "reject", "revise", "run", "arm", "disarm", "propose_agent"] as const;
export type ChatActionName = (typeof CHAT_ACTIONS)[number];

const DECISIONS: readonly ChatActionName[] = ["approve", "reject", "revise"];

const actionFileSchema = z
  .strictObject({
    action: z.enum(CHAT_ACTIONS),
    /** The approval, for approve, reject and revise (`approvalId` is accepted too). */
    id: z.number().int().positive().optional(),
    approvalId: z.number().int().positive().optional(),
    /** The agent, for run, arm and disarm; the room may be left out when the agent's id is unique. */
    room: z.string().min(1).optional(),
    agent: z.string().min(1).optional(),
    /** Required to reject or to ask for a revision. */
    note: z.string().trim().min(1).max(5_000).optional(),
    /** The task of a run. */
    task: z.string().trim().min(1).max(20_000).optional(),
    /** propose_agent: what no agent covers (the room, optional, is where the need comes from). */
    need: z.string().trim().min(1).max(2_000).optional(),
  })
  .superRefine((file, ctx) => {
    if (file.id !== undefined && file.approvalId !== undefined && file.id !== file.approvalId) {
      ctx.addIssue({ code: "custom", message: "id and approvalId differ", path: ["approvalId"] });
    }
    if (DECISIONS.includes(file.action)) {
      if ((file.id ?? file.approvalId) === undefined) {
        ctx.addIssue({ code: "custom", message: `${file.action} needs the item's id`, path: ["id"] });
      }
      if (file.action !== "approve" && !file.note) {
        ctx.addIssue({ code: "custom", message: `${file.action} needs a note`, path: ["note"] });
      }
    } else if (file.action === "propose_agent") {
      if (!file.need) ctx.addIssue({ code: "custom", message: "propose_agent needs a need", path: ["need"] });
    } else if (!file.agent) {
      ctx.addIssue({ code: "custom", message: `${file.action} needs an agent`, path: ["agent"] });
    }
  });

export type ChatAction = {
  action: ChatActionName;
  approvalId?: number;
  room?: string;
  agent?: string;
  note?: string;
  task?: string;
  need?: string;
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `name`, or `base (2).ext`... so that a rejected file never overwrites another. */
function freeName(dir: string, name: string): string {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let n = 2; fs.existsSync(path.join(dir, candidate)); n++) candidate = `${base} (${n})${ext}`;
  return candidate;
}

function moveAside(dir: string, name: string, log: (message: string) => void): void {
  try {
    const rejected = path.join(dir, REJECTED_DIR);
    fs.mkdirSync(rejected, { recursive: true });
    fs.renameSync(path.join(dir, name), path.join(rejected, freeName(rejected, name)));
  } catch (error) {
    log(`chat action ${name} not moved to ${REJECTED_DIR}/: ${describe(error)}`);
  }
}

/**
 * Takes the action files of `dir` (the `*.json` files holding an `action`
 * key), in name order: each valid one whose action is whitelisted is
 * returned and deleted; the others are moved to `<dir>/rejected/`, with a
 * French line for the reply. Files without an `action` key (requests to the
 * agents) are left for `processChatRequests`. Never throws.
 */
export function takeChatActions(
  dir: string,
  allowed: readonly ChatActionName[],
  log: (message: string) => void,
): { actions: ChatAction[]; refused: string[] } {
  const t = strings.assistant.actions;
  const actions: ChatAction[] = [];
  const refused: string[] = [];
  let names: string[];
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return { actions, refused };
  }
  for (const name of names) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    } catch {
      continue; // Not JSON: processChatRequests rejects it.
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("action" in raw)) continue;
    const parsed = actionFileSchema.safeParse(raw);
    if (!parsed.success) {
      const why = parsed.error.issues
        .map((issue) => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`)
        .join("; ");
      log(`chat action ${name} rejected: ${why}`);
      moveAside(dir, name, log);
      refused.push(t.invalid);
      continue;
    }
    const file = parsed.data;
    if (!allowed.includes(file.action)) {
      log(`chat action ${name} rejected: "${file.action}" is not in chat.requests.actions`);
      moveAside(dir, name, log);
      refused.push(t.notAllowed(file.action));
      continue;
    }
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch (error) {
      log(`chat action ${name} taken but not deleted: ${describe(error)}`);
    }
    actions.push({
      action: file.action,
      ...((file.id ?? file.approvalId) !== undefined ? { approvalId: file.id ?? file.approvalId } : {}),
      ...(file.room ? { room: file.room } : {}),
      ...(file.agent ? { agent: file.agent } : {}),
      ...(file.note ? { note: file.note } : {}),
      ...(file.task ? { task: file.task } : {}),
      ...(file.need ? { need: file.need } : {}),
    });
  }
  return { actions, refused };
}

/** Built-in tools whose results come from the web: never trusted. */
export const WEB_TOOLS = ["WebFetch", "WebSearch"] as const;

function matches(pattern: string, tool: string): boolean {
  return pattern.endsWith("*") ? tool.startsWith(pattern.slice(0, -1)) : tool === pattern;
}

/**
 * Whether a tool the turn called may have brought in text written by a third
 * party (a mail, a web page): the web tools, the tools matching
 * `chat.untrustedTools`, and every tool of an MCP server of the chat that is
 * not marked `"untrusted": false` (an unknown server counts as untrusted).
 */
export function isUntrustedTool(tool: string, chat: Pick<ChatConfig, "mcpServers" | "trustedServers" | "untrustedTools">): boolean {
  if ((WEB_TOOLS as readonly string[]).includes(tool)) return true;
  if (chat.untrustedTools.some((pattern) => matches(pattern, tool))) return true;
  if (!tool.startsWith("mcp__")) return false;
  const server = Object.keys(chat.mcpServers).find((name) => tool.startsWith(`mcp__${name}__`));
  return server === undefined || !chat.trustedServers.includes(server);
}

/** One French phrase for an action, as the confirmation question and the results name it. */
export function describeAction(action: ChatAction): string {
  const t = strings.assistant.actions.describe;
  const who = action.room ? `${action.room} / ${action.agent}` : (action.agent ?? "");
  switch (action.action) {
    case "approve":
      return t.approve(action.approvalId!);
    case "reject":
      return t.reject(action.approvalId!, action.note ?? "");
    case "revise":
      return t.revise(action.approvalId!, action.note ?? "");
    case "run":
      return t.run(who, action.task ?? null);
    case "arm":
      return t.arm(who);
    case "disarm":
      return t.disarm(who);
    case "propose_agent":
      return strings.agentProposal.describe(action.need ?? "", action.room ?? null);
  }
}

/** The user's answer to a confirmation: yes, no, or something else. */
export function confirmationAnswer(text: string): "yes" | "no" | null {
  const word = text
    .trim()
    .toLowerCase()
    .replace(/[\s.!?…]+$/u, "")
    .replace(/\s+/g, " ");
  if ((strings.assistant.actions.yes as readonly string[]).includes(word)) return "yes";
  if ((strings.assistant.actions.no as readonly string[]).includes(word)) return "no";
  return null;
}
