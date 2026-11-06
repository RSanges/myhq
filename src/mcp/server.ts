/**
 * The HQ MCP server: the agents' only door to the office.
 *
 * Started over stdio by `claude -p` for one run (see the per-run MCP config
 * written by the runner). It reads its context from HQ_DB_PATH, HQ_RUN_ID,
 * HQ_AGENT_ID and HQ_ROOM, and writes directly to SQLite.
 */
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDb } from "../server/db";
import {
  hqBlocked,
  hqBlockedNote,
  hqItems,
  hqMemoryRead,
  hqMemoryWrite,
  hqMessage,
  hqPending,
  hqReadDecisions,
  hqRelaunch,
  hqRooms,
  hqRunExtend,
  hqRunStatus,
  hqRunStop,
  hqSubmit,
  hqSuggestAgent,
  hqTaskUpdate,
  inputs,
  readContext,
  toolErrorText,
} from "./tools";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** A tool's answer, or its error: a database error is an explicit error, never an empty result. */
function respond(run: () => unknown): ToolResult {
  try {
    return { content: [{ type: "text", text: JSON.stringify(run()) }] };
  } catch (error) {
    return { content: [{ type: "text", text: toolErrorText(error) }], isError: true };
  }
}

async function main(): Promise<void> {
  // This file is started by path (see hqMcpServerCommand). The frozen build carries its own copy of the
  // templates next to it; from the sources they are two levels up.
  const here = path.dirname(process.argv[1] ?? ".");
  const frozenTemplates = path.join(here, "templates", "roles");
  const templatesDir = fs.existsSync(frozenTemplates)
    ? frozenTemplates
    : path.resolve(here, "..", "..", "templates", "roles");
  const ctx = { ...readContext(process.env), templatesDir };
  const db = openDb(ctx.dbPath);
  const server = new McpServer({ name: "hq", version: "0.1.0" });

  server.registerTool(
    "hq_message",
    {
      description:
        "Send a message to another agent. It becomes a task handled at its next run (at once when the recipient wakes on messages). Without `room` it goes to your room; with `room`, to an agent of a shared room (an order, see hq_rooms) or to an agent of a room that ordered from yours (an answer).",
      inputSchema: inputs.hq_message,
    },
    async (args) => respond(() => hqMessage(db, ctx, args)),
  );
  server.registerTool(
    "hq_submit",
    {
      description:
        "Submit an item to the user's approval queue. This is the only way to get anything published: never publish yourself. A room_proposal payload is checked at once: on an error, fix it and submit again. A type the home declares informational is delivered to the user at once and stays on the desk under « À regarder » until they have seen it: it never waits for a decision, so it comes back with the status unseen and nothing to read back. An agent of a shared room delivers an order with `forRoom`, the room that ordered: the item shows in that room's pile, and the decisions still come back to you. A render to validate (video, image, sound, 3D part, PDF) goes in `attachments`, with paths relative to your working directory: the owner sees and plays it on the desk and on Telegram. The same item (type, title and body) still waiting or approved in the last 24 hours is not submitted twice: the answer gives its id with `duplicate: true`.",
      inputSchema: inputs.hq_submit,
    },
    async (args) => respond(() => hqSubmit(db, ctx, args)),
  );
  server.registerTool(
    "hq_task_update",
    {
      description: "Report the state of your current task (in_progress, done or blocked).",
      inputSchema: inputs.hq_task_update,
    },
    async (args) => respond(() => hqTaskUpdate(db, ctx, args)),
  );
  server.registerTool(
    "hq_read_decisions",
    {
      description:
        "Read the user's decisions (approved, rejected, revise) on your submissions that you have not seen yet. Each decision is given once: the run that reads it acts on it.",
      inputSchema: inputs.hq_read_decisions,
    },
    async () => respond(() => hqReadDecisions(db, ctx)),
  );
  server.registerTool(
    "hq_memory_read",
    {
      description: "Read a value of your role memory, kept between runs.",
      inputSchema: inputs.hq_memory_read,
    },
    async (args) => respond(() => hqMemoryRead(db, ctx, args)),
  );
  server.registerTool(
    "hq_memory_write",
    {
      description: "Write a value of your role memory, kept between runs.",
      inputSchema: inputs.hq_memory_write,
    },
    async (args) => respond(() => hqMemoryWrite(db, ctx, args)),
  );
  server.registerTool(
    "hq_pending",
    {
      description:
        "List the items waiting for the user's decision, in every room, oldest first: id, room, agent, type, title and submission time (no body). Read-only. An item already decided (approved, rejected, sent back) is no longer listed: an item missing from this list was decided, not lost; read your own decisions with hq_read_decisions.",
      inputSchema: inputs.hq_pending,
    },
    async () => respond(() => hqPending(db)),
  );
  server.registerTool(
    "hq_items",
    {
      description:
        "Read the state of items, whenever you need it (it never marks anything seen, unlike hq_read_decisions which gives a decision once). With `id`: the item's content (`body`, cut to `maxChars`: 20000 by default, 60000 at most, `bodyTruncated` says when it was cut), type, title, status (pending, approved, rejected, revise, seen), decision date and note, remarks (with their points), producing room and agent, forRoom and attached files (name and, when available, the path of MyHQ's read-only copy). Without `id`: the items of the last 30 days, newest first (at most 50), of your room, those you produced, those delivered for your room, and, for an agent of a shared room, those of the rooms that ordered from it; filter with `status` and `type`. To read what an item says, call this with its id. Before saying that an item is not approved or does not exist, check it here. An item out of your reach is refused, which does not tell you its status. Read-only.",
      inputSchema: inputs.hq_items,
    },
    async (args) => respond(() => hqItems(db, ctx, args)),
  );
  server.registerTool(
    "hq_rooms",
    {
      description:
        "List the shared rooms of the office (studios any room may order from with hq_message and `room`) and their agents. Read-only.",
      inputSchema: inputs.hq_rooms,
    },
    async () => respond(() => hqRooms(db, ctx)),
  );
  server.registerTool(
    "hq_suggest_agent",
    {
      description:
        "Use when you are given an order that neither you nor any agent of the office can do (check hq_rooms first): describe the need, and the receptionist proposes a new agent to the user, who decides. Nothing is created until the user approves. The same need is queued at most once a day. Then tell whoever ordered that nobody can do it yet.",
      inputSchema: inputs.hq_suggest_agent,
    },
    async (args) => respond(() => hqSuggestAgent(db, ctx, args)),
  );
  // The supervisor of the Standard's tools: refused, with a clear error, to any other agent.
  server.registerTool(
    "hq_blocked",
    {
      description:
        "Supervisor of the Standard only. Read the Standard: what is stuck at the agents of every room (yours excepted). Each entry: `target` (what hq_relaunch and hq_blocked_note take), room, agent, state (blocked, pending, failed, cancelled), since when, the reason MyHQ knows, the text of the task, its task ids, your last `note`, `handedOff` (handed to the owner) and `relaunched` (a supervisor already relaunched it: never again). Read-only.",
      inputSchema: inputs.hq_blocked,
    },
    async () => respond(() => hqBlocked(db, ctx)),
  );
  server.registerTool(
    "hq_relaunch",
    {
      description:
        "Supervisor of the Standard only. Relaunch an entry of the Standard, as the owner's « Relancer » does: its tasks go back to pending and MyHQ wakes the agent at once, under the same guards (agent lock, shared resources, daily cap). When a guard holds the agent now, nothing changes (`relaunched: false`, `waiting` says why): try again when it is over. `message` gives the agent what it was missing in the same run. An entry is relaunched once at most: a second time is refused, hand it to the owner.",
      inputSchema: inputs.hq_relaunch,
    },
    async (args) => respond(() => hqRelaunch(db, ctx, args)),
  );
  server.registerTool(
    "hq_blocked_note",
    {
      description:
        "Supervisor of the Standard only. Attach a sentence for the owner to an entry of the Standard, shown on its line: what you did, or why you cannot act and what you expect from the owner. `handOff: true` hands the entry to the owner (it comes first on the Standard, marked « remis au propriétaire », and you are no longer woken for it). It never approves, closes nor relaunches anything.",
      inputSchema: inputs.hq_blocked_note,
    },
    async (args) => respond(() => hqBlockedNote(db, ctx, args)),
  );
  server.registerTool(
    "hq_run_status",
    {
      description:
        "Supervisor of the Standard only. Check a run in progress (a « long run to check »): agent, room, task, minutes since its start, its deadlines and extensions, its cost so far against its budget (an estimate from its tokens while it runs), its 20 latest events with their time, the time of its last event, and MyHQ's hints: minutes without activity, events and tool calls of the last 10 minutes, identical tool calls repeated in a row (`trailingIdenticalCalls`) and the most repeated one. Read-only.",
      inputSchema: inputs.hq_run_status,
    },
    async (args) => respond(() => hqRunStatus(db, ctx, args)),
  );
  server.registerTool(
    "hq_run_extend",
    {
      description:
        "Supervisor of the Standard only. Let a long run that progresses go on for `minutes` more from now (10 to 60), never past its hard limit (HQ_RUN_HARD_LIMIT_MINUTES), which always interrupts it. Each extension is counted. You are woken again if it still runs at its new deadline.",
      inputSchema: inputs.hq_run_extend,
    },
    async (args) => respond(() => hqRunExtend(db, ctx, args)),
  );
  server.registerTool(
    "hq_run_stop",
    {
      description:
        "Supervisor of the Standard only. Interrupt a run that is clearly stuck, with the reason for the owner. It ends failed, as a run that timed out: its own task blocked, its mailbox tasks pending, and a line of the Standard gives your reason.",
      inputSchema: inputs.hq_run_stop,
    },
    async (args) => respond(() => hqRunStop(db, ctx, args)),
  );

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  // stdout belongs to the MCP protocol: errors go to stderr.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
