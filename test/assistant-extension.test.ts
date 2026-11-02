import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadExtensions, type AssistantContext } from "../src/assistant/extension";

const fixtures = path.join(import.meta.dirname, "fixtures", "extensions");

function homeWith(files: string[]): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-ext-"));
  const dir = path.join(home, "assistant", "commands");
  fs.mkdirSync(dir, { recursive: true });
  for (const file of files) fs.copyFileSync(path.join(fixtures, file), path.join(dir, file));
  return home;
}

const ctx = (env = {} as unknown as NodeJS.ProcessEnv): AssistantContext => ({
  chatId: "42",
  home: "/h",
  env,
  reply: async () => undefined,
  log: () => undefined,
});

test("loads a TypeScript extension from the home with tsImport", async () => {
  const home = homeWith(["echo.ts"]);
  const { extensions, errors } = await loadExtensions(home, ["assistant/commands/echo.ts"]);
  assert.deepEqual(errors, []);
  assert.equal(extensions.length, 1);
  const { extension } = extensions[0]!;
  assert.equal(extension.name, "echo");
  assert.deepEqual(extension.commands, [{ command: "echo", description: "Repeats the text" }]);
  assert.equal(await extension.handle("/echo hi", ctx({ ECHO_SECRET: "s" } as unknown as NodeJS.ProcessEnv)), "echo: hi (s, telegram hidden)");
  assert.equal(await extension.handle("something else", ctx()), null);
});

test("reports missing, outside and invalid modules without stopping the others", async () => {
  const home = homeWith(["echo.ts", "not-an-extension.ts"]);
  const outside = path.join(fixtures, "echo.ts");
  const { extensions, errors } = await loadExtensions(home, [
    "assistant/commands/missing.ts",
    path.relative(home, outside),
    "assistant/commands/not-an-extension.ts",
    "assistant/commands/echo.ts",
    "assistant/commands/echo.ts",
  ]);
  assert.deepEqual(
    extensions.map((e) => e.extension.name),
    ["echo"],
  );
  assert.equal(errors.length, 4);
  assert.match(errors[0]!, /missing\.ts: file not found/);
  assert.match(errors[1]!, /must stay inside the home/);
  assert.match(errors[2]!, /not an assistant extension \(commands\.0\.command: .*handle: must be a function/);
  assert.match(errors[3]!, /already named "echo"/);
});

test("a module that fails to import is reported", async () => {
  const home = homeWith([]);
  fs.writeFileSync(path.join(home, "assistant", "commands", "syntax.ts"), "export default {{{;");
  const { extensions, errors } = await loadExtensions(home, ["assistant/commands/syntax.ts"]);
  assert.equal(extensions.length, 0);
  assert.match(errors[0]!, /syntax\.ts: failed to load/);
});
