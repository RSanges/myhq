/**
 * `npm run init`: prepares this machine for MyHQ. Creates the home directory
 * or points to an existing one, checks the `claude` CLI, writes `.env.local`
 * from `.env.example` with the answers to a few questions, and creates the
 * database. Safe to run again: an existing home is left as it is, the
 * previous `.env.local` is kept as `.env.local.bak` and its other values are
 * carried over, and the database migrations are idempotent.
 *
 * Answers are read line by line from stdin, so they can be piped
 * (`printf '...' | npm run init`); a missing answer keeps the default.
 * `--root <dir>` works on another copy of the repository (used by the tests).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { openDb } from "../src/server/db";
import { isValidTimeZone, systemTimeZone } from "../src/server/time";
import { strings } from "../src/ui/strings";

const t = strings.init;

type Env = Map<string, string>;

/** `KEY=value` lines of a dotenv file (comments and blank lines skipped). */
export function parseEnv(text: string): Env {
  const env: Env = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=(.*)$/.exec(line);
    if (match) env.set(match[1]!, match[2]!.trim());
  }
  return env;
}

/**
 * `.env.example` with its values replaced by `values` (comments kept), then
 * the keys of `values` the example does not know, so that nothing set by
 * hand is lost.
 */
export function renderEnv(example: string, values: Env): string {
  const seen = new Set<string>();
  const lines = example.split(/\r?\n/).map((line) => {
    const match = /^(\s*)([A-Z0-9_]+)\s*=.*$/.exec(line);
    if (!match || !values.has(match[2]!)) return line;
    seen.add(match[2]!);
    return `${match[1]}${match[2]}=${values.get(match[2]!)}`;
  });
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  const extra = [...values].filter(([key]) => !seen.has(key));
  if (extra.length > 0) lines.push("", t.keptTitle, ...extra.map(([key, value]) => `${key}=${value}`));
  return `${lines.join("\n").trimEnd()}\n`;
}

function run(bin: string, args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync(bin, args, { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  return { ok: !result.error && result.status === 0, stdout: (result.stdout ?? "").trim() };
}

/** Prints whether the CLI is installed and signed in; never fails the init. */
function checkClaude(bin: string, say: (line: string) => void): void {
  const version = run(bin, ["--version"]);
  if (!version.ok) {
    say(t.claudeMissing(bin));
    return;
  }
  say(t.claudeFound(version.stdout));
  const status = run(bin, ["auth", "status", "--json"]);
  try {
    const parsed = JSON.parse(status.stdout) as { loggedIn?: boolean; authMethod?: string };
    say(parsed.loggedIn ? t.claudeSignedIn(parsed.authMethod ?? "?") : t.claudeSignedOut);
  } catch {
    say(t.claudeUnknown);
  }
}

async function main(): Promise<void> {
  const rootFlag = process.argv.indexOf("--root");
  const root = path.resolve(rootFlag >= 0 ? process.argv[rootFlag + 1]! : path.join(__dirname, ".."));
  const say = (line: string) => process.stdout.write(`${line}\n`);

  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
  let ended = false;
  const ask = async (question: string, current: string): Promise<string> => {
    process.stdout.write(t.ask(question, current));
    if (ended) {
      process.stdout.write("\n");
      return current;
    }
    const next = await lines.next();
    if (next.done) {
      ended = true;
      process.stdout.write("\n");
      return current;
    }
    const answer = next.value.trim();
    if (!process.stdin.isTTY) process.stdout.write("\n");
    return answer === "" ? current : answer;
  };

  say(t.title);
  const envFile = path.join(root, ".env.local");
  const example = fs.readFileSync(path.join(root, ".env.example"), "utf8");
  const previous = fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, "utf8")) : new Map<string, string>();
  const values: Env = new Map(previous);
  const current = (key: string, fallback: string) => previous.get(key) || parseEnv(example).get(key) || fallback;

  // 1. The home.
  const homeSetting = await ask(t.home, current("MYHQ_HOME", "./home"));
  const home = path.resolve(root, homeSetting);
  values.set("MYHQ_HOME", homeSetting);
  if (fs.existsSync(home)) {
    say(t.homeExisting(home));
  } else {
    fs.mkdirSync(path.join(home, "rooms"), { recursive: true });
    fs.mkdirSync(path.join(home, "data"), { recursive: true });
    fs.writeFileSync(path.join(home, ".gitignore"), "data/\n");
    say(t.homeCreated(home));
  }

  // 2. The Claude Code CLI.
  checkClaude(process.env.HQ_CLAUDE_BIN?.trim() || current("HQ_CLAUDE_BIN", "claude"), say);

  // 3. Questions.
  const oldToken = previous.get("HQ_TELEGRAM_BOT_TOKEN") ?? "";
  const token = await ask(t.token, oldToken ? t.tokenKept : "");
  const newToken = token === t.tokenKept ? oldToken : token === "-" ? "" : token;
  values.set("HQ_TELEGRAM_BOT_TOKEN", newToken);
  if (newToken) {
    values.set("HQ_TELEGRAM_CHAT_ID", await ask(t.chatId, current("HQ_TELEGRAM_CHAT_ID", "")));
  }

  const capDefault = current("HQ_MAX_RUNS_PER_DAY", "12");
  const cap = await ask(t.cap, capDefault);
  const capOk = /^\d{1,4}$/.test(cap);
  if (!capOk) say(t.invalid(cap, capDefault));
  values.set("HQ_MAX_RUNS_PER_DAY", capOk ? cap : capDefault);

  const portDefault = current("HQ_PORT", "4242");
  const port = await ask(t.port, portDefault);
  const portOk = /^\d{2,5}$/.test(port) && Number(port) > 0 && Number(port) < 65_536;
  if (!portOk) say(t.invalid(port, portDefault));
  values.set("HQ_PORT", portOk ? port : portDefault);

  const zoneDefault = current("HQ_TIMEZONE", systemTimeZone());
  const zone = await ask(t.timeZone, zoneDefault);
  if (!isValidTimeZone(zone)) say(t.invalid(zone, zoneDefault));
  values.set("HQ_TIMEZONE", isValidTimeZone(zone) ? zone : zoneDefault);

  // 4. .env.local, the previous one kept aside.
  if (fs.existsSync(envFile)) {
    fs.copyFileSync(envFile, `${envFile}.bak`);
    say(t.envBackup(`${envFile}.bak`));
  }
  fs.writeFileSync(envFile, renderEnv(example, values));
  say(t.envWritten(envFile));

  // 5. The database (migrations are idempotent).
  const dbFile = path.join(home, "data", "hq.db");
  openDb(dbFile).close();
  say(t.dbReady(dbFile));

  say(t.next(values.get("HQ_PORT")!));
  process.exit(0);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
