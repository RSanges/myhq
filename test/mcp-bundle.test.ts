import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildMcpBundle } from "../scripts/build-mcp";
import { mcpBundleEntry } from "../src/mcp/bundle";
import { hqMcpServerCommand } from "../src/server/claude-engine";

/** A scratch copy of the repository (sources and templates; node_modules is linked), to build in. */
function scratchRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-bundle-"));
  fs.cpSync(path.join(process.cwd(), "src"), path.join(root, "src"), { recursive: true });
  fs.cpSync(path.join(process.cwd(), "templates"), path.join(root, "templates"), { recursive: true });
  fs.symlinkSync(path.join(process.cwd(), "node_modules"), path.join(root, "node_modules"), "junction");
  return root;
}

async function listTools(command: { command: string; args: string[] }, dir: string): Promise<string[]> {
  const transport = new StdioClientTransport({
    command: command.command,
    args: command.args,
    env: {
      ...(process.env as Record<string, string>),
      HQ_DB_PATH: path.join(dir, "data", "hq.db"),
      HQ_RUN_ID: "1",
      HQ_AGENT_ID: "scout",
      HQ_ROOM: "demo",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "myhq-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    return (await client.listTools()).tools.map((tool) => tool.name).sort();
  } finally {
    await client.close();
  }
}

test("without a frozen build the sources are used, with one warning per process", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-nobundle-"));
  const warnings: string[] = [];
  const first = hqMcpServerCommand(root, (message) => warnings.push(message));
  hqMcpServerCommand(root, (message) => warnings.push(message));
  assert.ok(first.args.some((arg) => arg.endsWith(path.join("src", "mcp", "server.ts"))));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /no frozen HQ MCP server/);
  assert.match(warnings[0]!, /npm run build/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("the build freezes the server: it runs from build/mcp and ignores later changes to the sources", async () => {
  const root = scratchRepo();
  try {
    const dir = await buildMcpBundle(root);
    assert.equal(path.join(dir, "server.mjs"), mcpBundleEntry(root));
    assert.ok(fs.existsSync(path.join(dir, "templates", "roles", "dev.md")));
    assert.ok(!fs.existsSync(`${dir}.tmp`));

    const warnings: string[] = [];
    const command = hqMcpServerCommand(root, (message) => warnings.push(message));
    assert.deepEqual(command.args, [mcpBundleEntry(root)]);
    assert.deepEqual(warnings, []);

    const expected = [
      "hq_memory_read",
      "hq_memory_write",
      "hq_message",
      "hq_pending",
      "hq_read_decisions",
      "hq_rooms",
      "hq_submit",
      "hq_suggest_agent",
      "hq_task_update",
    ];
    assert.deepEqual(await listTools(command, root), expected);

    // Uncommitted work in the sources, as an agent editing the folder would leave it: the frozen copy is unaffected.
    fs.appendFileSync(path.join(root, "src", "mcp", "tools.ts"), '\nthrow new Error("work in progress");\n');
    assert.deepEqual(await listTools(command, root), expected);

    // A second build replaces the first one and leaves no staging folder.
    await buildMcpBundle(root);
    assert.ok(fs.existsSync(mcpBundleEntry(root)));
    assert.ok(!fs.existsSync(`${path.dirname(mcpBundleEntry(root))}.tmp`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a build that fails leaves the previous frozen copy in place", async () => {
  const root = scratchRepo();
  try {
    await buildMcpBundle(root);
    fs.writeFileSync(path.join(root, "src", "mcp", "server.ts"), "this is not ( valid typescript");
    await assert.rejects(buildMcpBundle(root));
    assert.ok(fs.existsSync(mcpBundleEntry(root)));
    assert.ok(!fs.existsSync(`${path.dirname(mcpBundleEntry(root))}.tmp`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
