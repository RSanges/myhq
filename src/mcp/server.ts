/**
 * The HQ MCP server: the agents' only door to the office.
 *
 * Started over stdio by `claude -p` for one run (see the per-run MCP config
 * written by the runner). It reads its context from HQ_DB_PATH, HQ_RUN_ID,
 * HQ_AGENT_ID and HQ_ROOM, and writes directly to SQLite.
 */
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDb } from "../server/db";
import {
  hqMemoryRead,
  hqMemoryWrite,
  hqMessage,
  hqPending,
  hqReadDecisions,
  hqSubmit,
  hqTaskUpdate,
  inputs,
  readContext,
} from "./tools";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function respond(run: () => unknown): ToolResult {
  try {
    return { content: [{ type: "text", text: JSON.stringify(run()) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}

async function main(): Promise<void> {
  // This file is started by path (see hqMcpServerCommand): the templates are two levels up.
  const templatesDir = path.resolve(path.dirname(process.argv[1] ?? "."), "..", "..", "templates", "roles");
  const ctx = { ...readContext(process.env), templatesDir };
  const db = openDb(ctx.dbPath);
  const server = new McpServer({ name: "hq", version: "0.1.0" });

  server.registerTool(
    "hq_message",
    {
      description:
        "Send a message to another agent of your room. It becomes a task handled at its next run (at once when the recipient wakes on messages).",
      inputSchema: inputs.hq_message,
    },
    async (args) => respond(() => hqMessage(db, ctx, args)),
  );
  server.registerTool(
    "hq_submit",
    {
      description:
        "Submit an item to the user's approval queue. This is the only way to get anything published: never publish yourself. A room_proposal payload is checked at once: on an error, fix it and submit again. A type the home declares informational is delivered to the user at once and stays on the desk under « À regarder » until they have seen it: it never waits for a decision, so it comes back with the status unseen and nothing to read back.",
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
        "Read the user's decisions (approved, rejected, revise) on your submissions that you have not seen yet.",
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
        "List the items waiting for the user's decision, in every room, oldest first: id, room, agent, type, title and submission time (no body). Read-only.",
      inputSchema: inputs.hq_pending,
    },
    async () => respond(() => hqPending(db)),
  );

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  // stdout belongs to the MCP protocol: errors go to stderr.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
