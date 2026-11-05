/**
 * `npm run wait-idle`: waits until the app in service has no run in progress,
 * so that a deployment (`npm run build`, then `pm2 restart myhq`) cuts none.
 * It polls `GET /api/runs/active` every few seconds and exits 0 once nothing
 * runs (or when the app does not answer: then nothing runs in it either), 1
 * when runs are still going at the end of `--timeout` (seconds, default 1800,
 * the default run timeout). The port is HQ_PORT, from the environment or
 * `.env.local`, 4242 otherwise; `--url` overrides it. A run may still start
 * after it returns: the restart itself waits for it (HQ_SHUTDOWN_GRACE_SECONDS).
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { strings } from "../src/ui/strings";

const t = strings.waitIdle;

const activeSchema = z.object({
  running: z.number().int().min(0),
  runs: z.array(z.object({ id: z.number(), room: z.string(), agentId: z.string() })),
});

export type WaitIdleOptions = {
  url: string;
  timeoutMs: number;
  pollMs: number;
  fetch?: typeof fetch;
  log?: (line: string) => void;
};

/** Polls the app until no run is in progress; true when idle, false at the timeout. */
export async function waitIdle(options: WaitIdleOptions): Promise<boolean> {
  const get = options.fetch ?? fetch;
  const log = options.log ?? console.log;
  const deadline = Date.now() + options.timeoutMs;
  let last = "";
  for (;;) {
    let active: z.infer<typeof activeSchema>;
    try {
      const response = await get(`${options.url}/api/runs/active`);
      active = activeSchema.parse(await response.json());
    } catch {
      log(t.unreachable(options.url));
      return true;
    }
    if (active.running === 0) {
      log(t.idle);
      return true;
    }
    const line = t.running(active.runs.map((run) => `#${run.id} ${run.room}/${run.agentId}`).join(", "));
    if (line !== last) log(line);
    last = line;
    if (Date.now() >= deadline) {
      log(t.timeout);
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(options.pollMs, Math.max(1, deadline - Date.now()))));
  }
}

/** HQ_PORT from the environment or `.env.local` (as ecosystem.config.cjs reads it), 4242 otherwise. */
export function port(root: string): string {
  let value = process.env.HQ_PORT;
  try {
    const line = fs
      .readFileSync(path.join(root, ".env.local"), "utf8")
      .split(/\r?\n/)
      .find((l) => /^\s*HQ_PORT\s*=/.test(l));
    value ??= line?.split("=")[1]?.trim();
  } catch {
    // No .env.local: the default port.
  }
  return /^\d{2,5}$/.test(value ?? "") ? value! : "4242";
}

export function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const timeoutS = Number(option(args, "--timeout") ?? "1800");
  if (!Number.isFinite(timeoutS) || timeoutS < 0) {
    console.error(t.usage);
    process.exit(2);
  }
  const url = (option(args, "--url") ?? `http://127.0.0.1:${port(path.resolve(__dirname, ".."))}`).replace(/\/+$/, "");
  void waitIdle({ url, timeoutMs: timeoutS * 1000, pollMs: 5_000 }).then((idle) => process.exit(idle ? 0 : 1));
}
