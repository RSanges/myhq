import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { POST as actionRoute } from "../src/app/api/desk/[id]/actions/[action]/route";
import {
  actionSpec,
  commandSourceSchema,
  deskResponse,
  readDeskConfig,
  type DeskDto,
} from "../src/server/desk";
import { DeskCommands, parseActionOutput, type ActionSpec, type CommandSpec } from "../src/server/desk-command";
import { eventStreamResponse } from "../src/server/event-stream";
import { makeHome } from "./helpers";

// The actions of a command source (myhq.json `desk`, `actions`): the config,
// the runner (values on standard input, cache dropped, one at a time), the
// route and the `desk` event.

const saved = process.env.MYHQ_HOME;
afterEach(() => {
  if (saved === undefined) delete process.env.MYHQ_HOME;
  else process.env.MYHQ_HOME = saved;
});

/** A home with a list kept in todo.json and the command that reads and changes it. */
function writeTodo(home: string): void {
  fs.writeFileSync(path.join(home, "todo.json"), JSON.stringify(["Appeler le garage"]));
  fs.writeFileSync(
    path.join(home, "todo-cmd.mjs"),
    `import fs from "node:fs";
const mode = process.argv[2];
const file = "todo.json";
const list = () => JSON.parse(fs.readFileSync(file, "utf8"));
if (mode === "list") {
  const items = list().map((title, index) => ({ id: "t" + (index + 1), title }));
  console.log(JSON.stringify({ count: items.length, items }));
} else if (mode === "crash") {
  process.exit(4);
} else if (mode === "slow") {
  setTimeout(() => console.log(JSON.stringify({ ok: true })), 5000);
} else if (mode === "garbage") {
  console.log("fait");
} else {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (raw += chunk));
  process.stdin.on("end", () => {
    const input = JSON.parse(raw);
    fs.appendFileSync("calls.txt", process.argv.length + ":" + raw + "\\n");
    if (mode === "add") {
      fs.writeFileSync(file, JSON.stringify([...list(), input.text]));
      console.log(JSON.stringify({ ok: true, message: "Ajouté." }));
    } else if (mode === "done") {
      const index = Number(String(input.id).slice(1)) - 1;
      if (!(index >= 0 && index < list().length)) {
        console.log(JSON.stringify({ ok: false, message: "Ce post-it n'existe plus." }));
        process.exit(1);
      }
      fs.writeFileSync(file, JSON.stringify(list().filter((_, i) => i !== index)));
      console.log(JSON.stringify({ ok: true }));
    }
  });
}
`,
  );
}

const todoOf = (home: string): string[] => JSON.parse(fs.readFileSync(path.join(home, "todo.json"), "utf8")) as string[];

const SOURCE = {
  command: "node todo-cmd.mjs list",
  cacheSeconds: 600,
  actions: { add: { command: "node todo-cmd.mjs add" }, done: { command: "node todo-cmd.mjs done" } },
};

function writeSettings(home: string, source: unknown = SOURCE): void {
  fs.writeFileSync(
    path.join(home, "myhq.json"),
    JSON.stringify({ desk: { objects: [{ id: "postits", object: "postits", label: "Post-it", source }] } }),
  );
}

const post = (id: string, action: string, body: unknown) =>
  actionRoute(
    new Request(`http://127.0.0.1/api/desk/${id}/actions/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id, action }) },
  );

const errorOf = async (response: Response) => ((await response.json()) as { error: { code: string; message: string } }).error;

const dataSpec = (home: string): CommandSpec => ({ command: "node todo-cmd.mjs list", cwd: home, timeoutMs: 5_000, cacheMs: 600_000 });
const actionOf = (home: string, mode: string, timeoutMs = 5_000): ActionSpec => ({ command: `node todo-cmd.mjs ${mode}`, cwd: home, timeoutMs });

// --- The block ----------------------------------------------------------------------------

test("desk config: actions are optional commands with a timeout, nothing else", () => {
  const { home } = makeHome();
  writeSettings(home);
  const { desk, error } = readDeskConfig(home);
  assert.equal(error, null);
  const source = commandSourceSchema.parse(desk.objects[0]!.source);
  assert.deepEqual(source.actions, {
    add: { command: "node todo-cmd.mjs add", timeoutSeconds: 10 },
    done: { command: "node todo-cmd.mjs done", timeoutSeconds: 10 },
  });
  assert.equal(commandSourceSchema.parse({ command: "x" }).actions, undefined);

  for (const actions of [{ remove: { command: "x" } }, { add: {} }, { add: { command: "x", shell: true } }, { add: { command: "x", timeoutSeconds: 600 } }]) {
    writeSettings(home, { command: "x", actions });
    assert.match(readDeskConfig(home).error ?? "", /desk\.objects\.0\.source/, JSON.stringify(actions));
  }
  assert.deepEqual(actionSpec(home, commandSourceSchema.parse({ command: "x", actions: { add: { command: "y", cwd: "../out" } } }), "add"), {
    error: 'cwd "../out" is outside the home',
  });
  assert.deepEqual(actionSpec(home, commandSourceSchema.parse({ command: "x" }), "done"), { error: 'the object has no "done" action' });
});

test("action output: ok, or not ok with a message", () => {
  assert.deepEqual(parseActionOutput('{"ok":true}'), { ok: true, output: { ok: true } });
  assert.ok(parseActionOutput(`﻿${JSON.stringify({ ok: false, message: "Non." })}`).ok);
  assert.equal(parseActionOutput('{"ok":false}').ok, false, "a refusal says why");
  assert.equal(parseActionOutput("fait").ok, false);
  assert.equal(parseActionOutput('{"ok":"yes"}').ok, false);
});

// --- The runner ---------------------------------------------------------------------------

test("act: the values reach the command as JSON on its standard input, never in its command line", async () => {
  const { home } = makeHome();
  writeTodo(home);
  const commands = new DeskCommands({ env: { PATH: process.env.PATH } });
  const hostile = `a "quote" & $(echo x) ; \`id\` %PATH% 'b' é 📅 \\ done`;
  const result = await commands.act(actionOf(home, "add"), { text: hostile }, dataSpec(home));
  assert.deepEqual(result, { ok: true, message: "Ajouté." });
  assert.deepEqual(todoOf(home), ["Appeler le garage", hostile], "the text arrived untouched");
  const calls = fs.readFileSync(path.join(home, "calls.txt"), "utf8").trim().split("\n");
  assert.equal(calls[0], `3:${JSON.stringify({ text: hostile })}`, "argv is node, the script and the mode: the text is not in it");
});

test("act: the data of the object is read again after an action, a failed one included", async () => {
  const { home } = makeHome();
  writeTodo(home);
  const commands = new DeskCommands({ env: { PATH: process.env.PATH } });
  const first = await commands.get(dataSpec(home));
  assert.ok(first.ok && first.output.count === 1);
  assert.equal(await commands.get(dataSpec(home)), first, "cached");
  await commands.act(actionOf(home, "add"), { text: "Réserver le train" }, dataSpec(home));
  const second = await commands.get(dataSpec(home));
  assert.ok(second.ok && second.output.count === 2, "the cache was dropped by the action");
  const refused = await commands.act(actionOf(home, "done"), { id: "t9" }, dataSpec(home));
  assert.notEqual(await commands.get(dataSpec(home)), second, "dropped after a refusal too");
  assert.deepEqual(refused, { ok: false, code: "ACTION_FAILED", message: "Ce post-it n'existe plus." });
});

test("act: a run of the data command that started before the action does not fill the cache", async () => {
  const { home } = makeHome();
  writeTodo(home);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let runs = 0;
  const commands = new DeskCommands({
    env: {},
    run: async () => {
      runs += 1;
      const stale = JSON.stringify({ count: 1, items: [{ title: "avant" }] });
      if (runs === 1) await gate;
      return { code: 0, stdout: runs === 1 ? stale : JSON.stringify({ count: 2, items: [{ title: "après" }, { title: "après 2" }] }), stderr: "", timedOut: false };
    },
  });
  const slow = commands.get(dataSpec(home));
  commands.invalidate(dataSpec(home));
  release();
  await slow;
  const fresh = await commands.get(dataSpec(home));
  assert.ok(fresh.ok && fresh.output.count === 2, "the stale answer was not kept");
  assert.equal(runs, 2);
});

test("act: failures are values: a refusal with its words, a crash, garbage, a timeout", async () => {
  const { home } = makeHome();
  writeTodo(home);
  const logs: string[] = [];
  const commands = new DeskCommands({ env: { PATH: process.env.PATH }, log: (message) => logs.push(message) });
  assert.deepEqual(await commands.act(actionOf(home, "crash"), {}, dataSpec(home)), { ok: false, code: "ACTION_INVALID_OUTPUT", message: "exited with code 4" });
  const garbage = await commands.act(actionOf(home, "garbage"), {}, dataSpec(home));
  assert.ok(!garbage.ok && garbage.code === "ACTION_INVALID_OUTPUT");
  const started = Date.now();
  const slow = await commands.act(actionOf(home, "slow", 600), {}, dataSpec(home));
  assert.ok(!slow.ok && slow.code === "ACTION_TIMEOUT");
  assert.ok(Date.now() - started < 3_000, "does not wait for the command");
  assert.equal(logs.length, 3);
});

test("act: two actions at once run one after the other", async () => {
  const { home } = makeHome();
  writeTodo(home);
  const commands = new DeskCommands({ env: { PATH: process.env.PATH } });
  const all = await Promise.all(["un", "deux", "trois", "quatre"].map((text) => commands.act(actionOf(home, "add"), { text }, dataSpec(home))));
  assert.ok(all.every((each) => each.ok));
  assert.deepEqual(todoOf(home), ["Appeler le garage", "un", "deux", "trois", "quatre"], "no write was lost");
});

// --- The route ----------------------------------------------------------------------------

test("GET /api/desk lists the actions of an object; POST /api/desk/<id>/actions/<action> adds and ticks off", async () => {
  const config = makeHome();
  process.env.MYHQ_HOME = config.home;
  writeTodo(config.home);
  writeSettings(config.home);
  const read = async () => ((await (await deskResponse()).json()) as DeskDto).objects[0]!;
  const before = await read();
  assert.deepEqual((before as unknown as { actions: string[] }).actions, ["add", "done"]);
  assert.equal(before.count, 1);

  const added = await post("postits", "add", { text: "  Réserver le train  " });
  assert.equal(added.status, 200);
  assert.deepEqual(await added.json(), { ok: true, message: "Ajouté." });
  assert.deepEqual(todoOf(config.home), ["Appeler le garage", "Réserver le train"], "the text is trimmed");
  const after = await read();
  assert.equal(after.count, 2, "the cached data (600 s) was dropped by the action");

  const ticked = await post("postits", "done", { id: "t1" });
  assert.equal(ticked.status, 200);
  assert.deepEqual(await ticked.json(), { ok: true });
  assert.deepEqual((await read()).items.map((item) => item.title), ["Réserver le train"]);
});

test("POST /api/desk/<id>/actions/<action>: invalid bodies, unknown object, unknown action, a refusal, a crash", async () => {
  const config = makeHome();
  process.env.MYHQ_HOME = config.home;
  writeTodo(config.home);
  writeSettings(config.home);
  for (const [action, body] of [
    ["add", {}],
    ["add", { text: "   " }],
    ["add", { text: "x".repeat(301) }],
    ["add", { text: "deux\nlignes" }],
    ["add", { text: "ok", extra: 1 }],
    ["add", { id: "t1" }],
    ["done", { text: "x" }],
    ["done", { id: "" }],
    ["add", "not json"],
  ] as const) {
    const response = await post("postits", action, body);
    assert.equal(response.status, 400, JSON.stringify([action, body]));
    assert.ok(["INVALID_INPUT", "INVALID_JSON"].includes((await errorOf(response)).code));
  }
  assert.deepEqual(todoOf(config.home), ["Appeler le garage"], "nothing was run");

  const unknown = await post("agenda", "add", { text: "x" });
  assert.equal(unknown.status, 404);
  assert.equal((await errorOf(unknown)).code, "DESK_OBJECT_NOT_FOUND");
  const noAction = await post("postits", "remove", { id: "t1" });
  assert.equal(noAction.status, 404);
  assert.equal((await errorOf(noAction)).code, "DESK_ACTION_NOT_FOUND");

  const refused = await post("postits", "done", { id: "t9" });
  assert.equal(refused.status, 422);
  assert.deepEqual(await errorOf(refused), { code: "ACTION_FAILED", message: "Ce post-it n'existe plus." });

  writeSettings(config.home, { command: "node todo-cmd.mjs list", actions: { add: { command: "node todo-cmd.mjs crash" } } });
  const crashed = await post("postits", "add", { text: "x" });
  assert.equal(crashed.status, 502);
  assert.equal((await errorOf(crashed)).code, "ACTION_INVALID_OUTPUT");
  const missing = await post("postits", "done", { id: "t1" });
  assert.equal(missing.status, 404, "an object that declares only add has no done");
  writeSettings(config.home, { command: "node todo-cmd.mjs list", actions: { add: { command: "node todo-cmd.mjs slow", timeoutSeconds: 1 } } });
  const slow = await post("postits", "add", { text: "x" });
  assert.equal(slow.status, 504);
  assert.equal((await errorOf(slow)).code, "ACTION_TIMEOUT");
});

test("an object without actions, or a core object, offers none", async () => {
  const config = makeHome();
  process.env.MYHQ_HOME = config.home;
  writeTodo(config.home);
  writeSettings(config.home, { command: "node todo-cmd.mjs list" });
  assert.deepEqual(((await (await deskResponse()).json()) as { objects: { actions: string[] }[] }).objects[0]!.actions, []);
  assert.equal((await post("postits", "add", { text: "x" })).status, 404);
  fs.writeFileSync(
    path.join(config.home, "myhq.json"),
    JSON.stringify({ desk: { objects: [{ id: "signer", object: "pile", label: "À signer", source: "approvals" }] } }),
  );
  assert.deepEqual(((await (await deskResponse()).json()) as { objects: { actions: string[] }[] }).objects[0]!.actions, []);
  assert.equal((await post("signer", "add", { text: "x" })).status, 404);
});

// --- The `desk` event -------------------------------------------------------------------

test("an action sends the `desk` event at once, without waiting for the next poll", async () => {
  const config = makeHome();
  process.env.MYHQ_HOME = config.home;
  writeTodo(config.home);
  writeSettings(config.home);
  const controller = new AbortController();
  const response = eventStreamResponse(new Request("http://127.0.0.1/api/events", { signal: controller.signal }));
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  const read = async (until: RegExp, ms: number) => {
    const deadline = Date.now() + ms;
    while (!until.test(text)) {
      if (Date.now() > deadline) throw new Error(`no ${until} in ${text}`);
      pending ??= reader.read();
      const chunk = await Promise.race([pending, new Promise<null>((resolve) => setTimeout(() => resolve(null), 100))]);
      if (chunk) {
        pending = null;
        if (!chunk.done) text += decoder.decode(chunk.value);
      }
    }
  };
  try {
    await read(/event: ready/, 3_000);
    // The first reading of the counts is the baseline (the poll is every 3 s).
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal((await post("postits", "add", { text: "Réserver le train" })).status, 200);
    await read(/event: desk/, 1_800);
  } finally {
    controller.abort();
  }
  const frame = text.split("\n\n").find((each) => each.startsWith("event: desk"))!;
  const data = JSON.parse(frame.split("\ndata: ")[1]!) as { objects: { id: string; count: number }[] };
  assert.deepEqual(data.objects.find((object) => object.id === "postits"), { id: "postits", count: 2, status: "ok" });
});
