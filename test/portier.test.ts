import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { hqMessage, type HqContext } from "../src/mcp/tools";
import { listBlocked } from "../src/server/blocked";
import type { HqConfig } from "../src/server/config";
import { getDbAt, type Db, type RunRow, type TaskRow } from "../src/server/db";
import type { Engine, RunEvent, RunInput } from "../src/server/engine";
import {
  parseVerdict,
  portierArgs,
  portierIdle,
  portierPrompt,
  recentVerdicts,
  roleSummary,
  ruleFor,
  type PortierAnswer,
  type PortierCall,
  type PortierCallInput,
} from "../src/server/portier";
import { loadHome, syncHome } from "../src/server/rooms";
import { wakeAgents } from "../src/server/runner";
import { buildSettingsView } from "../src/server/settings";
import { makeHome, waitForRun } from "./helpers";

// The portier: a message that needs no wake (an acknowledgement) waits for its
// recipient's next run; the sender's `expects` and a question mark decide
// without the model; any failure wakes the agent. The model call is a fake:
// no CLI runs in these tests.

const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const done: RunEvent = { type: "end", status: "done", reason: "success", summary: "ok", usage, costUsd: 0 };

/** Room "demo": Social and Motion write to each other; Silent opted out of the portier. The portier is on. */
function office(overrides: Partial<HqConfig> = {}): { config: HqConfig; db: Db } {
  const base = { model: "haiku", allowedTools: ["mcp__hq__*"] };
  const config = makeHome(
    { portier: { enabled: true, model: "haiku" }, ...overrides },
    {
      name: "demo",
      targetRepo: "../demo-project",
      agents: [
        { id: "social", name: "Social", role: "roles/scout.md", ...base },
        { id: "motion", name: "Motion", role: "roles/motion.md", ...base },
        { id: "silent", name: "Silent", role: "roles/scout.md", ...base, portier: false },
      ],
    },
  );
  fs.writeFileSync(
    path.join(config.home, "rooms", "demo", "roles", "motion.md"),
    "# Motion\n\nYou make the motion design of the videos, in Remotion, from the approved scripts.\n\n## Method\n\nRead the script.\n",
  );
  const db = getDbAt(config.dbPath);
  syncHome(db, loadHome(config.home));
  return { config, db };
}

function engine(seen: RunInput[] = []): Engine {
  return {
    name: "claude",
    async *run(input) {
      seen.push(input);
      yield done;
    },
  };
}

/** A fake model call that answers `text` (or fails), and records what it was asked. */
function fakeCall(answer: string | Error, calls: PortierCallInput[] = []): PortierCall {
  return async (input) => {
    calls.push(input);
    if (answer instanceof Error) throw answer;
    const result: PortierAnswer = {
      text: answer,
      costUsd: 0.0004,
      inputTokens: 420,
      outputTokens: 30,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      durationMs: 1800,
    };
    return result;
  };
}

/** The context of a finished run of `agent`, to send messages from. */
function ctxOf(config: HqConfig, db: Db, agent: string): HqContext {
  const runId = Number(
    db
      .prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at, ended_at) VALUES ('demo', ?, 'claude', 't', 'done', ?, ?)")
      .run(agent, new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() - 30_000).toISOString()).lastInsertRowid,
  );
  return { dbPath: config.dbPath, runId, agentId: agent, room: "demo", home: config.home, appEnv: {} };
}

const runsOf = (db: Db, agent: string) => db.prepare("SELECT * FROM runs WHERE agent_id = ? ORDER BY id").all(agent) as RunRow[];
const pendingOf = (db: Db, agent: string) =>
  db.prepare("SELECT * FROM tasks WHERE agent_id = ? AND status = 'pending' ORDER BY id").all(agent) as TaskRow[];
const verdicts = (db: Db) => db.prepare("SELECT * FROM portier_verdicts ORDER BY id").all() as Record<string, unknown>[];

test("portier: an acknowledgement judged skip waits in the mailbox, costs one stored verdict, and is not stuck on the Standard", async () => {
  const { config, db } = office();
  const calls: PortierCallInput[] = [];
  const deps = { config, engine: engine(), portier: fakeCall('{"verdict":"skip","reason":"Accusé de réception, rien à faire."}', calls) };
  hqMessage(db, ctxOf(config, db, "social"), { to: "motion", text: "Bien reçu, j'attends les clips du Vidéaste." });

  assert.deepEqual(wakeAgents(config, db, deps), [], "nothing wakes while the portier reads");
  await portierIdle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.model, "haiku");
  assert.match(calls[0]!.prompt, /Recipient: Motion \(demo\/motion\)\./);
  assert.match(calls[0]!.prompt, /Its role: You make the motion design of the videos/);
  assert.match(calls[0]!.prompt, /1\. From social: Bien reçu, j'attends les clips du Vidéaste\./);

  assert.equal(runsOf(db, "motion").length, 0, "Motion is not woken");
  assert.equal(pendingOf(db, "motion").length, 1, "the message waits for its next run");
  const [row] = verdicts(db);
  assert.equal(row!.verdict, "skip");
  assert.equal(row!.reason, "Accusé de réception, rien à faire.");
  assert.equal(row!.cost_usd, 0.0004);
  assert.equal(row!.input_tokens, 420);
  assert.equal(row!.error, null);

  // The next wake-ups read the verdict: no second call, still no run.
  assert.deepEqual(wakeAgents(config, db, deps), []);
  await portierIdle();
  assert.equal(calls.length, 1);

  // Waiting by design is not stuck, even long after.
  db.prepare("UPDATE tasks SET created_at = ? WHERE agent_id = 'motion'").run(new Date(Date.now() - 60 * 60_000).toISOString());
  assert.equal(listBlocked(db, loadHome(config.home), config).length, 0);
});

test("portier: a wake verdict wakes the recipient once it is stored, and its run takes the message", async () => {
  const { config, db } = office();
  const seen: RunInput[] = [];
  const deps = { config, engine: engine(seen), portier: fakeCall('{"verdict":"wake","reason":"Les clips sont livrés."}') };
  hqMessage(db, ctxOf(config, db, "social"), { to: "motion", text: "Les clips sont dans renders/clips, tu peux monter." });
  assert.deepEqual(wakeAgents(config, db, deps), []);
  await portierIdle();
  const [run] = runsOf(db, "motion");
  assert.ok(run, "woken by the verdict");
  assert.equal(run.reason, "message");
  await waitForRun(db, run.id);
  assert.match(seen.at(-1)!.prompt, /Les clips sont dans renders\/clips/);
  assert.equal(verdicts(db)[0]!.verdict, "wake");
});

test("portier: expects none never wakes, expects reply or action and a question mark wake at once, all without a call", async () => {
  const { config, db } = office();
  const calls: PortierCallInput[] = [];
  const deps = { config, engine: engine(), portier: fakeCall('{"verdict":"skip","reason":"x"}', calls) };
  const social = ctxOf(config, db, "social");

  hqMessage(db, social, { to: "motion", text: "Merci, bien reçu.", expects: "none" });
  assert.deepEqual(wakeAgents(config, db, deps), []);
  await portierIdle();
  assert.equal(calls.length, 0);
  assert.equal(runsOf(db, "motion").length, 0);
  assert.equal(listBlocked(db, loadHome(config.home), config, new Date(Date.now() + 60 * 60_000)).length, 0, "it waits by design");

  hqMessage(db, social, { to: "motion", text: "Le script #39 est approuvé, lance le montage.", expects: "action" });
  const [action] = wakeAgents(config, db, deps);
  assert.equal(action?.agent_id, "motion", "woken at once");
  await waitForRun(db, action.id);
  assert.equal(pendingOf(db, "motion").length, 0, "its run took both messages");

  const motion = ctxOf(config, db, "motion");
  hqMessage(db, motion, { to: "social", text: "Tu préfères le hook A ou le B ?" });
  const [question] = wakeAgents(config, db, deps);
  assert.equal(question?.agent_id, "social", "a question mark wakes without the portier");
  await waitForRun(db, question.id);
  assert.equal(calls.length, 0, "the model was never called");

  const stored = db.prepare("SELECT expects FROM message_wake ORDER BY task_id").all() as { expects: string | null }[];
  assert.deepEqual(stored.map((row) => row.expects), ["none", "action"]);
  assert.throws(() => hqMessage(db, social, { to: "motion", text: "x", expects: "later" as never }));
});

test("portier: it fails open: a call that fails, or an answer it cannot read, wakes the agent and is stored with its error", async () => {
  for (const answer of [new Error("could not start \"claude\": ENOENT"), "Je pense qu'il faut peut-être voir."]) {
    const { config, db } = office();
    const deps = { config, engine: engine(), portier: fakeCall(answer) };
    hqMessage(db, ctxOf(config, db, "social"), { to: "motion", text: "Les sous-titres sont prêts." });
    assert.deepEqual(wakeAgents(config, db, deps), []);
    await portierIdle();
    const [run] = runsOf(db, "motion");
    assert.ok(run, "woken by prudence");
    await waitForRun(db, run.id);
    const [row] = verdicts(db);
    assert.equal(row!.verdict, "wake");
    assert.ok(typeof row!.error === "string" && row!.error.length > 0);
  }
});

test("portier: off in myhq.json, or portier false on the agent: a message wakes at once, as before", async () => {
  const { config, db } = office();
  const calls: PortierCallInput[] = [];
  const deps = { config, engine: engine(), portier: fakeCall('{"verdict":"skip","reason":"x"}', calls) };
  hqMessage(db, ctxOf(config, db, "social"), { to: "silent", text: "Pour info, c'est livré." });
  const [optedOut] = wakeAgents(config, db, deps);
  assert.equal(optedOut?.agent_id, "silent");
  await waitForRun(db, optedOut.id);

  fs.writeFileSync(path.join(config.home, "myhq.json"), JSON.stringify({ portier: { enabled: false } }));
  hqMessage(db, ctxOf(config, db, "social"), { to: "motion", text: "Pour info, c'est livré." });
  const [off] = wakeAgents(config, db, deps);
  assert.equal(off?.agent_id, "motion");
  await waitForRun(db, off.id);
  assert.equal(calls.length, 0);
});

test("portier: the messages of an agent it has not read go in one call; a model of myhq.json is used", async () => {
  const { config, db } = office();
  fs.writeFileSync(path.join(config.home, "myhq.json"), JSON.stringify({ portier: { enabled: true, model: "sonnet" } }));
  const calls: PortierCallInput[] = [];
  const deps = { config, engine: engine(), portier: fakeCall('{"verdict":"skip","reason":"Deux accusés de réception."}', calls) };
  const social = ctxOf(config, db, "social");
  hqMessage(db, social, { to: "motion", text: "Bien reçu." });
  hqMessage(db, social, { to: "motion", text: "Toujours en attente des clips." });
  wakeAgents(config, db, deps);
  wakeAgents(config, db, deps);
  await portierIdle();
  assert.equal(calls.length, 1, "one call for both, and no second call while it reads");
  assert.equal(calls[0]!.model, "sonnet");
  assert.match(calls[0]!.prompt, /1\. From social: Bien reçu\.\n2\. From social: Toujours en attente des clips\./);
  assert.deepEqual(JSON.parse(String(verdicts(db)[0]!.task_ids)).length, 2);
});

test("portier: the call has no tool, no MCP server and low effort; the verdict is read leniently; rules and role summary", () => {
  const args = portierArgs({ model: "haiku", system: "S", prompt: "P" });
  assert.deepEqual(args.slice(0, 2), ["-p", "P"]);
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args[args.indexOf("--effort") + 1], "low");
  assert.equal(args[args.indexOf("--output-format") + 1], "json");
  assert.equal(args[args.indexOf("--system-prompt") + 1], "S");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.ok(!args.includes("--mcp-config"));

  assert.deepEqual(parseVerdict('Sure: {"verdict":"skip","reason":"Accusé."}'), { verdict: "skip", reason: "Accusé." });
  assert.deepEqual(parseVerdict("WAKE: une commande"), { verdict: "wake", reason: "une commande" });
  assert.equal(parseVerdict("je ne sais pas"), null);

  assert.equal(ruleFor(null, "Bien reçu."), null);
  assert.equal(ruleFor(null, "On publie quand ?"), "wake");
  assert.equal(ruleFor("none", "Tu as vu ?"), "skip", "the sender's word wins over the question mark");
  assert.equal(ruleFor("reply", "Voici le texte."), "wake");

  const { config } = office();
  assert.equal(roleSummary(path.join(config.home, "rooms", "demo", "roles", "motion.md")), "You make the motion design of the videos, in Remotion, from the approved scripts.");
  assert.match(
    portierPrompt({ agentName: "A", room: "r", agentId: "a", role: "", messages: [{ from: "b", text: "x" }], language: "fr" }),
    /Its role is not known\.[\s\S]*When in doubt, wake\.[\s\S]*tag "fr"/,
  );
});

test("portier: /reglages shows the setting and the latest verdicts, with what they cost over 7 days", async () => {
  const { config, db } = office();
  const deps = { config, engine: engine(), portier: fakeCall('{"verdict":"skip","reason":"Accusé de réception."}') };
  hqMessage(db, ctxOf(config, db, "social"), { to: "motion", text: "Bien reçu, merci." });
  wakeAgents(config, db, deps);
  await portierIdle();
  const view = buildSettingsView(config, db, {});
  assert.deepEqual([view.portier.enabled, view.portier.model, view.portier.source], [true, "haiku", "default"]);
  assert.deepEqual(view.portier.week, { calls: 1, skips: 1, costUsd: 0.0004 });
  const [first] = view.portier.verdicts;
  assert.equal(first?.verdict, "skip");
  assert.equal(first?.from, "social");
  assert.match(first?.excerpt ?? "", /Bien reçu, merci\./);
  assert.equal(recentVerdicts(db).verdicts.length, 1);

  fs.writeFileSync(path.join(config.home, "myhq.json"), JSON.stringify({ portier: { enabled: "yes" } }));
  const invalid = buildSettingsView(config, db, {});
  assert.equal(invalid.portier.enabled, true, "an invalid block keeps the default");
  assert.ok(invalid.errors.some((line) => /portier\.enabled/.test(line)));
});
