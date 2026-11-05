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
  hqItems,
  hqMemoryRead,
  hqMemoryWrite,
  hqMessage,
  hqPending,
  hqReadDecisions,
  hqRooms,
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
        "Read the state of items, whenever you need it (it never marks anything seen, unlike hq_read_decisions which gives a decision once). With `id`: the item's type, title, status (pending, approved, rejected, revise, seen), decision date and note, remarks (with their points), producing room and agent, forRoom and attached file names. Without `id`: the items of the last 30 days, newest first (at most 50), of your room, those you produced, those delivered for your room, and, for an agent of a shared room, those of the rooms that ordered from it; filter with `status` and `type`. Before saying that an item is not approved or does not exist, check it here. An item out of your reach is refused, which does not tell you its status. Read-only.",
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

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  // stdout belongs to the MCP protocol: errors go to stderr.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
