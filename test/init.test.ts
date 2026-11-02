import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseEnv, renderEnv } from "../scripts/init";

const script = path.join(process.cwd(), "scripts", "init.ts");

/** Runs `npm run init` on a copy of the repository files it needs, answers piped on stdin. */
function init(root: string, answers: string) {
  const result = spawnSync(process.execPath, ["--import", "tsx", script, "--root", root], {
    input: answers,
    encoding: "utf8",
    env: { ...process.env, HQ_CLAUDE_BIN: "myhq-test-no-such-claude" },
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("init in non-interactive mode creates the home, writes .env.local and the database, and can run again", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-root-"));
  fs.copyFileSync(path.join(process.cwd(), ".env.example"), path.join(root, ".env.example"));

  const first = init(root, "my-home\nbot-token\n123456\n5\n4343\nEurope/Paris\n");
  assert.match(first, /Home créé/);
  assert.match(first, /CLI claude introuvable \(« myhq-test-no-such-claude »\)/);
  assert.match(first, /pm2 start ecosystem\.config\.cjs/);
  const home = path.join(root, "my-home");
  assert.ok(fs.existsSync(path.join(home, "rooms")));
  assert.ok(fs.existsSync(path.join(home, "data", "hq.db")));
  let env = parseEnv(fs.readFileSync(path.join(root, ".env.local"), "utf8"));
  assert.equal(env.get("MYHQ_HOME"), "my-home");
  assert.equal(env.get("HQ_TELEGRAM_BOT_TOKEN"), "bot-token");
  assert.equal(env.get("HQ_TELEGRAM_CHAT_ID"), "123456");
  assert.equal(env.get("HQ_MAX_RUNS_PER_DAY"), "5");
  assert.equal(env.get("HQ_PORT"), "4343");
  assert.equal(env.get("HQ_TIMEZONE"), "Europe/Paris");
  assert.equal(env.get("HQ_SCHEDULER"), "off");
  // Comments of .env.example are kept.
  assert.match(fs.readFileSync(path.join(root, ".env.local"), "utf8"), /^# MyHQ configuration/);

  // A value set by hand, then a run with no answers at all: everything is kept.
  fs.appendFileSync(path.join(root, ".env.local"), "HQ_EXT_SOMETHING=kept\n");
  fs.writeFileSync(path.join(home, "rooms", "marker.txt"), "x");
  const second = init(root, "");
  assert.match(second, /Home existant, conservé tel quel/);
  env = parseEnv(fs.readFileSync(path.join(root, ".env.local"), "utf8"));
  assert.equal(env.get("MYHQ_HOME"), "my-home");
  assert.equal(env.get("HQ_TELEGRAM_BOT_TOKEN"), "bot-token");
  assert.equal(env.get("HQ_PORT"), "4343");
  assert.equal(env.get("HQ_EXT_SOMETHING"), "kept");
  assert.ok(fs.existsSync(path.join(home, "rooms", "marker.txt")));
  assert.ok(fs.existsSync(path.join(root, ".env.local.bak")));

  // "-" clears the token; invalid answers keep the previous values.
  const third = init(root, "\n-\nmany\n99999999\nMars/Olympus\n");
  assert.match(third, /« many » n'est pas valable/);
  env = parseEnv(fs.readFileSync(path.join(root, ".env.local"), "utf8"));
  assert.equal(env.get("HQ_TELEGRAM_BOT_TOKEN"), "");
  assert.equal(env.get("HQ_MAX_RUNS_PER_DAY"), "5");
  assert.equal(env.get("HQ_PORT"), "4343");
  assert.equal(env.get("HQ_TIMEZONE"), "Europe/Paris");
});

test("renderEnv replaces the example's values and keeps unknown keys at the end", () => {
  const out = renderEnv("# comment\nA=1\n\nB=2\n", new Map([["B", "3"], ["C", "4"]]));
  assert.equal(out, "# comment\nA=1\n\nB=3\n\n# Kept from the previous .env.local\nC=4\n");
});
