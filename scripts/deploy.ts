/**
 * `npm run deploy`: puts the code of this repository in service under pm2.
 *
 *   1. `npm run build` (skipped with --skip-build);
 *   2. waits until no run is in progress (as `npm run wait-idle`, --timeout
 *      seconds, 1800 by default; the restart itself waits for the runs that
 *      are still going, up to HQ_SHUTDOWN_GRACE_SECONDS);
 *   3. `pm2 restart <app>` (or `pm2 start` of the ecosystem file when pm2 does
 *      not know the app yet);
 *   4. checks that the process that listens on the port is the one pm2 follows.
 *      A process that holds the port without being followed is an orphan of an
 *      earlier stop that never ended: it is stopped, but only when its command
 *      line is the `next start` of this very repository, and the app is
 *      started again. Any other process on the port is left alone, and the
 *      deployment fails;
 *   5. prints the pid, the state in pm2 and the HTTP answer of the app.
 *
 * Options: --app (name in pm2, the first app of the ecosystem file by default),
 * --port (HQ_PORT from the environment or `.env.local`, 4242 otherwise),
 * --ecosystem (default ecosystem.config.cjs), --skip-build, --timeout.
 * pm2 must be installed and on the PATH. Works on Windows, macOS and Linux.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { strings } from "../src/ui/strings";
import { option, port as defaultPort, waitIdle } from "./wait-idle";

const t = strings.deploy;
const ROOT = path.resolve(__dirname, "..");
const WIN = process.platform === "win32";

export type Pm2App = { name: string; pid: number; status: string };

/** The apps of `pm2 jlist` (the JSON array, which pm2 may precede with a warning line). */
export function parsePm2List(text: string): Pm2App[] {
  const start = text.search(/\[\s*[{\]]/);
  if (start < 0) return [];
  const list = JSON.parse(text.slice(start)) as { name?: unknown; pid?: unknown; pm2_env?: { status?: unknown } }[];
  return list.map((app) => ({
    name: String(app.name),
    pid: typeof app.pid === "number" ? app.pid : 0,
    status: String(app.pm2_env?.status ?? "unknown"),
  }));
}

/** The pid that listens on `port` in the output of `netstat -ano` (Windows, whatever the language), or null. */
export function parseNetstat(text: string, port: number): number | null {
  for (const line of text.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 4 || !/^tcp/i.test(columns[0]!)) continue;
    const local = columns[1]!;
    const foreign = columns[2]!;
    // A listening socket has no peer: 0.0.0.0:0, [::]:0 or *:0.
    if (!local.endsWith(`:${port}`) || !/^(0\.0\.0\.0|\[::\]|\*):0$/.test(foreign)) continue;
    const pid = Number(columns[columns.length - 1]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

/** The pid that listens on `port` in the output of `ss -ltnp`, or null. */
export function parseSs(text: string, port: number): number | null {
  for (const line of text.split(/\r?\n/)) {
    if (!new RegExp(`:${port}\\s`).test(line)) continue;
    const match = /pid=(\d+)/.exec(line);
    if (match) return Number(match[1]);
  }
  return null;
}

function normalizePath(value: string): string {
  const posix = value.replace(/\\/g, "/");
  return WIN ? posix.toLowerCase() : posix;
}

/** Whether a command line is the `next start` of the repository at `root` (the way ecosystem.config.cjs starts it). */
export function isNextStartOf(command: string, root: string): boolean {
  const line = normalizePath(command).replace(/"/g, "");
  return line.includes(`${normalizePath(root)}/node_modules/next/dist/bin/next`) && /\sstart(\s|$)/.test(line);
}

function run(command: string, args: string[], options: { inherit?: boolean } = {}): { ok: boolean; stdout: string; stderr: string } {
  // On Windows, npm and pm2 are .cmd files: they need a shell, so arguments with spaces are quoted by hand.
  const quote = (arg: string) => (WIN && /[\s&|<>^"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg);
  const result = spawnSync(WIN ? [command, ...args].map(quote).join(" ") : command, WIN ? [] : args, {
    cwd: ROOT,
    encoding: "utf8",
    shell: WIN,
    windowsHide: true,
    stdio: options.inherit ? "inherit" : "pipe",
    maxBuffer: 32 * 1024 * 1024,
  });
  return { ok: !result.error && result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? result.error?.message ?? "" };
}

function pm2List(): Pm2App[] {
  const result = run("pm2", ["jlist"]);
  if (!result.ok) throw new Error(t.pm2Failed(result.stderr.trim() || "pm2 jlist"));
  return parsePm2List(result.stdout);
}

/** The pid that listens on the port, or null when nobody does. Throws when no tool can tell. */
function portHolder(port: number): number | null {
  if (WIN) {
    const netstat = run("netstat", ["-ano", "-p", "TCP"]);
    if (!netstat.ok) throw new Error(t.cannotFindHolder);
    return parseNetstat(netstat.stdout, port);
  }
  const lsof = run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  if (lsof.ok) {
    const pid = Number(lsof.stdout.trim().split(/\s+/)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }
  const ss = run("ss", ["-ltnpH"]);
  if (ss.ok) return parseSs(ss.stdout, port);
  if (lsof.stdout === "" && lsof.stderr === "" && !ss.stdout) return null;
  throw new Error(t.cannotFindHolder);
}

/** The command line of a process, or an empty string when it cannot be read. */
function commandLine(pid: number): string {
  if (WIN) {
    const result = run("powershell", [
      "-NoProfile",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
    ]);
    return result.ok ? result.stdout.trim() : "";
  }
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim();
  } catch {
    const result = run("ps", ["-o", "args=", "-p", String(pid)]);
    return result.ok ? result.stdout.trim() : "";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function httpAnswer(url: string): Promise<{ ok: boolean; text: string }> {
  try {
    const response = await fetch(`${url}/api/runs/active`, { signal: AbortSignal.timeout(5_000) });
    return { ok: response.ok, text: `${response.status} ${(await response.text()).slice(0, 200)}` };
  } catch {
    return { ok: false, text: t.noAnswer };
  }
}

type Outcome = { kind: "ok"; app: Pm2App; http: string } | { kind: "orphan"; pid: number } | { kind: "failed"; message: string };

/**
 * Waits for the app to listen on `port` with the pid pm2 follows. A different
 * pid that stays on the port for `orphanAfterMs` is an orphan.
 */
async function verify(name: string, port: number, url: string, orphanAfterMs: number, timeoutMs: number): Promise<Outcome> {
  const deadline = Date.now() + timeoutMs;
  let foreignSince = 0;
  let foreignPid = 0;
  while (Date.now() < deadline) {
    const holder = portHolder(port);
    const app = pm2List().find((each) => each.name === name);
    if (holder !== null && app && app.pid === holder && app.status === "online") {
      const answer = await httpAnswer(url);
      if (answer.ok) return { kind: "ok", app, http: answer.text };
    } else if (holder !== null && (!app || app.pid !== holder)) {
      if (foreignPid !== holder) {
        foreignPid = holder;
        foreignSince = Date.now();
      } else if (Date.now() - foreignSince >= orphanAfterMs) {
        return { kind: "orphan", pid: holder };
      }
    } else {
      foreignPid = 0;
    }
    await sleep(1_000);
  }
  const holder = portHolder(port);
  return { kind: "failed", message: holder === null ? t.noHolder(port) : t.foreign(holder, commandLine(holder)) };
}

async function stopProcess(pid: number, port: number): Promise<void> {
  try {
    process.kill(pid, WIN ? "SIGKILL" : "SIGTERM");
  } catch {
    // Already gone.
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    if (portHolder(port) !== pid) return;
    if (attempt === 10 && !WIN) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await sleep(500);
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const timeoutS = Number(option(args, "--timeout") ?? "1800");
  if (!Number.isFinite(timeoutS) || timeoutS < 0) {
    console.error(t.usage);
    return 2;
  }
  const ecosystem = path.resolve(ROOT, option(args, "--ecosystem") ?? "ecosystem.config.cjs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- a CommonJS file read by pm2
  const declared = (require(ecosystem) as { apps: { name: string }[] }).apps[0]?.name ?? "myhq";
  const name = option(args, "--app") ?? declared;
  const port = Number(option(args, "--port") ?? defaultPort(ROOT));
  const url = `http://127.0.0.1:${port}`;
  const skipBuild = args.includes("--skip-build");
  const total = skipBuild ? 3 : 4;
  let n = 0;
  const step = (label: string) => console.log(t.step(++n, total, label));

  if (!skipBuild) {
    step(t.building);
    if (!run("npm", ["run", "build"], { inherit: true }).ok) {
      console.error(t.buildFailed);
      return 1;
    }
  }

  step(t.waiting);
  await waitIdle({ url, timeoutMs: timeoutS * 1000, pollMs: 5_000 });

  const restart = (announce: boolean) => {
    const known = pm2List().some((app) => app.name === name);
    if (announce) step(t.restarting(name, known));
    const result = known ? run("pm2", ["restart", name]) : run("pm2", ["start", ecosystem]);
    if (!result.ok) throw new Error(t.pm2Failed((result.stderr || result.stdout).trim()));
  };
  restart(true);

  step(t.verifying(port));
  // The restart waits for the old process (up to the grace of a stop), so the new one is quick to listen.
  let outcome = await verify(name, port, url, 8_000, 90_000);
  if (outcome.kind === "orphan") {
    const command = commandLine(outcome.pid);
    if (!isNextStartOf(command, ROOT)) {
      console.error(t.foreign(outcome.pid, command));
      return 1;
    }
    console.log(t.orphan(outcome.pid, command));
    await stopProcess(outcome.pid, port);
    console.log(t.orphanKilled(outcome.pid));
    restart(false);
    outcome = await verify(name, port, url, Infinity, 90_000);
  }
  if (outcome.kind === "ok") {
    console.log(t.done(outcome.app.pid, outcome.app.status, outcome.http));
    return 0;
  }
  console.error(outcome.kind === "failed" ? outcome.message : t.foreign(outcome.pid, commandLine(outcome.pid)));
  return 1;
}

if (require.main === module) {
  // exitCode, not process.exit: leaving while a fetch is closing trips a libuv assertion on Windows.
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error((error as Error).message);
      process.exitCode = 1;
    },
  );
}
