import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { closeServers } from "../src/server/exit";

test("closeServers frees the port and cuts the open event streams", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(": hello\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${port}/`);
  const reader = response.body!.getReader();
  await reader.read();
  const ended = reader.read();

  assert.ok((await closeServers()) >= 1);
  assert.equal(server.listening, false);
  await assert.rejects(ended).catch(() => undefined);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
});

test("exitProcess ends a process whose thread pool is blocked, which process.exit does not", async () => {
  const exitUrl = pathToFileURL(path.resolve(__dirname, "../src/server/exit.ts")).href;
  // One call of the pool that lasts minutes: Node's own exit waits for it.
  const script = `
    const { exitProcess } = await import(${JSON.stringify(exitUrl)});
    process.on("exit", (code) => console.log("exit listener " + code));
    (await import("node:crypto")).pbkdf2("a", "b", 400_000_000, 64, "sha512", () => {});
    setTimeout(() => exitProcess(0), 300);
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: path.resolve(__dirname, "..") });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk));
  const started = Date.now();
  const ended = await Promise.race([
    new Promise<boolean>((resolve) => child.on("exit", () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20_000)),
  ]);
  if (!ended) child.kill("SIGKILL");
  assert.equal(ended, true, "the process must end although the pool is busy");
  assert.ok(Date.now() - started < 20_000);
  assert.match(output, /exit listener 0/, "the exit listeners (lock, runs) still run");
});
