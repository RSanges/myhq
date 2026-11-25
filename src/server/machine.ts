import { execFile, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { strings } from "../ui/strings";
import type { Env, HqConfig } from "./config";
import { now, type Db } from "./db";
import { readMachineSetting, type MachineSetting } from "./home-settings";
import type { Agent } from "./rooms";

// The machine: what a run of an agent with `needs` (room.json, in GB) takes
// from it, checked before the run starts, where the agent lock and the shared
// resources are (launchRun). The reading is portable: RAM from node:os, GPU
// memory from nvidia-smi when it exists (anything else is "unknown"), queried
// in the background so that nothing waits on it. The runs already started
// reserve what they still have to take, so that two runs released together
// never count the same free memory. While a run with needs goes on, the tick
// samples what the machine gave up since it started; the second highest peak
// of its last runs alone under the declaration in force raises the need of
// the agent (never lowers it). The home's veto command may say "wait" for a
// reason MyHQ cannot see. This module imports nothing that reads the runner:
// the runner calls it. See docs/architecture.md, "The queue and the machine".

export type MachineReading = {
  at: string;
  ramFreeGb: number;
  ramTotalGb: number;
  /** GPU memory of the first GPU nvidia-smi lists; null: unknown (no nvidia-smi, or it failed). */
  vramUsedGb: number | null;
  vramTotalGb: number | null;
};

/** How MyHQ reads the machine: injectable, so that no test runs the real nvidia-smi. */
export type MachineRead = () => MachineReading;

export type Needs = { ramGb: number | null; vramGb: number | null };

/** How long a reading is reused. */
export const MACHINE_CACHE_MS = 5_000;
/** nvidia-smi may not take longer than this: past it, the GPU is unknown. */
export const NVIDIA_SMI_TIMEOUT_MS = 2_000;
/** The last runs alone of an agent whose measured peaks count. */
export const PEAK_RUNS = 5;
/** How long an answer of the veto command holds: a `wait` is asked again after it, an `ok` is used once within it. */
export const VETO_FRESH_MS = 60_000;

const GIB = 1024 ** 3;
const round = (gb: number) => Math.round(gb * 100) / 100;

/**
 * The GPU memory of `nvidia-smi --query-gpu=memory.used,memory.total
 * --format=csv,noheader,nounits` (MiB), read strictly: the first line must be
 * two numbers, the used one not above the total. Anything else is unknown.
 */
export function parseNvidiaSmi(stdout: string): { usedGb: number; totalGb: number } | null {
  const line = stdout
    .split(/\r?\n/)
    .map((each) => each.trim())
    .find((each) => each.length > 0);
  const match = line ? /^(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)$/.exec(line) : null;
  if (!match) return null;
  const used = Number(match[1]);
  const total = Number(match[2]);
  if (!(total > 0) || used > total) return null;
  return { usedGb: round(used / 1024), totalGb: round(total / 1024) };
}

/** The real nvidia-smi query, in a child process that nothing waits on: its stdout, or null when it is absent, fails or times out. Never rejects. */
export function queryNvidiaSmi(): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        "nvidia-smi",
        ["--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"],
        { encoding: "utf8", timeout: NVIDIA_SMI_TIMEOUT_MS, windowsHide: true },
        (error, stdout) => resolve(error ? null : stdout),
      );
    } catch {
      resolve(null);
    }
  });
}

export type MachineProbes = {
  memory: () => { freeBytes: number; totalBytes: number };
  /** The stdout of nvidia-smi, null when there is none. */
  gpu: () => string | null;
};

/** One reading of the machine with these probes. Never throws: a probe that fails reads as unknown (GPU) or zero free (RAM). */
export function takeReading(probes: MachineProbes, at: Date = new Date()): MachineReading {
  let ram = { freeBytes: 0, totalBytes: 0 };
  try {
    ram = probes.memory();
  } catch {
    // Nothing free that MyHQ can see: a run with a RAM need waits.
  }
  let gpu: { usedGb: number; totalGb: number } | null = null;
  try {
    const stdout = probes.gpu();
    gpu = stdout === null ? null : parseNvidiaSmi(stdout);
  } catch {
    gpu = null;
  }
  return {
    at: at.toISOString(),
    ramFreeGb: round(ram.freeBytes / GIB),
    ramTotalGb: round(ram.totalBytes / GIB),
    vramUsedGb: gpu?.usedGb ?? null,
    vramTotalGb: gpu?.totalGb ?? null,
  };
}

type MachineState = {
  cached: { reading: MachineReading; at: number } | null;
  /** The latest answer of nvidia-smi (its stdout, null: none), and the query in progress. */
  gpu: { stdout: string | null; at: number } | null;
  gpuQuery: Promise<void> | null;
  vetoes: Set<string>;
  pending: Set<Promise<void>>;
  /** The direct starts that met the veto command being asked, per agent: tried again once it answered. */
  retries: Map<string, (() => void)[]>;
};
const globalForMachine = globalThis as unknown as { __myhqMachine?: MachineState };
function machineState(): MachineState {
  globalForMachine.__myhqMachine ??= { cached: null, gpu: null, gpuQuery: null, vetoes: new Set(), pending: new Set(), retries: new Map() };
  return globalForMachine.__myhqMachine;
}

/** Asks nvidia-smi again in the background when its latest answer is older than MACHINE_CACHE_MS and no query is going on. */
function refreshGpu(state: MachineState): void {
  if (state.gpuQuery || (state.gpu && Date.now() - state.gpu.at < MACHINE_CACHE_MS)) return;
  state.gpuQuery = queryNvidiaSmi()
    .then((stdout) => {
      state.gpu = { stdout, at: Date.now() };
    })
    .finally(() => {
      state.gpuQuery = null;
    });
}

/**
 * The real reading, reused for MACHINE_CACHE_MS. The RAM is read at once
 * (node:os), the GPU from the latest answer of nvidia-smi, queried again in
 * the background: no caller ever waits on a child process. Until its first
 * answer the GPU is unknown (and the reading is not kept). Never throws.
 */
export function readMachine(): MachineReading {
  const state = machineState();
  if (state.cached && Date.now() - state.cached.at < MACHINE_CACHE_MS) return state.cached.reading;
  refreshGpu(state);
  const reading = takeReading({ memory: () => ({ freeBytes: os.freemem(), totalBytes: os.totalmem() }), gpu: () => state.gpu?.stdout ?? null });
  if (state.gpu) state.cached = { reading, at: Date.now() };
  return reading;
}

// --- What a run needs -----------------------------------------------------------------

/** Whether the agent declares `needs`: only then is the machine looked at for its runs. */
export const declaresNeeds = (agent: Pick<Agent, "needs">): boolean =>
  Boolean(agent.needs && (agent.needs.ramGb !== null || agent.needs.vramGb !== null));

/** Whether the home's veto command is asked before a run of this agent: it declares `needs` or `resources`. */
export const asksVeto = (agent: Pick<Agent, "needs" | "resources">): boolean => declaresNeeds(agent) || agent.resources.length > 0;

/** What a run of the agent holds that others may wait for: its shared resources, and `ram` or `vram` for its needs. */
export function scarceOf(agent: Pick<Agent, "needs" | "resources">): string[] {
  return [
    ...agent.resources.map((resource) => `resource:${resource}`),
    ...(agent.needs?.ramGb != null ? ["ram"] : []),
    ...(agent.needs?.vramGb != null ? ["vram"] : []),
  ];
}

/**
 * The peaks of the last runs alone of an agent under the declaration in
 * force, newest first: only those measure the agent and nothing else, and a
 * declaration the owner changed starts the learning over.
 */
export function measuredPeaks(db: Db, room: string, agentId: string, declared: Needs, limit = PEAK_RUNS): { ramGb: number[]; vramGb: number[] } {
  const peaks = (kind: "ram" | "vram", need: number | null): number[] =>
    need === null
      ? []
      : (
          db
            .prepare(
              `SELECT ${kind}_peak_gb AS peak FROM run_machine WHERE room = ? AND agent_id = ? AND ended_at IS NOT NULL AND alone = 1
                 AND ${kind}_declared_gb = ? AND ${kind}_peak_gb IS NOT NULL ORDER BY run_id DESC LIMIT ?`,
            )
            .all(room, agentId, need, limit) as { peak: number }[]
        ).map((row) => row.peak);
  return { ramGb: peaks("ram", declared.ramGb), vramGb: peaks("vram", declared.vramGb) };
}

/** What the peaks teach: the second highest of them, so that a need is raised only when two runs measured it (one outlier never counts); null with fewer than two. */
export function learnedPeak(peaks: readonly number[]): number | null {
  const sorted = [...peaks].sort((a, b) => b - a);
  return sorted.length >= 2 ? sorted[1]! : null;
}

/** The most a run can be given on this machine (its total minus the margin), per kind; null when unknown. */
export function machineCeiling(reading: MachineReading, setting: MachineSetting): Needs {
  return {
    ramGb: reading.ramTotalGb > 0 ? round(reading.ramTotalGb - setting.keepFreeRamGb) : null,
    vramGb: reading.vramTotalGb !== null ? round(reading.vramTotalGb - setting.keepFreeVramGb) : null,
  };
}

/**
 * The need a run of the agent reserves: what it declares, raised to what its
 * peaks teach (learnedPeak) when that is higher. Only the runs alone under the
 * declaration in force count (measuredPeaks), and a peak above what the
 * machine can give at all (`ceiling`) is left out: it measured something else,
 * and would lock the agent out for good. Never lowered below the declaration.
 * A kind it does not declare stays null.
 */
export function effectiveNeeds(db: Db, room: string, agent: Pick<Agent, "id" | "needs">, ceiling?: Needs): Needs {
  const declared = agent.needs ?? { ramGb: null, vramGb: null };
  const peaks = measuredPeaks(db, room, agent.id, declared);
  const raise = (need: number | null, measured: number[], most: number | null | undefined) => {
    if (need === null) return null;
    const learned = learnedPeak(most === null || most === undefined ? measured : measured.filter((peak) => peak <= most));
    return round(Math.max(need, learned ?? need));
  };
  return { ramGb: raise(declared.ramGb, peaks.ramGb, ceiling?.ramGb), vramGb: raise(declared.vramGb, peaks.vramGb, ceiling?.vramGb) };
}

/**
 * How long a run in progress reserves what it still has to take. A
 * reservation keeps two runs released together from counting the same free
 * memory; past this, a run has loaded what it loads at its start, and the
 * memory it takes shows in what is free (its agent's reasoning between two
 * heavy steps takes little). Holding the whole need for the whole run (an hour
 * or more) kept the heavy agents from ever running side by side. The home's
 * veto command (virtual memory) and the margin stay the guard on a heavy step
 * that comes later.
 */
export const RESERVATION_WINDOW_MS = 10 * 60_000;

/**
 * What the runs in progress still have to take, per kind: the sum of the
 * needs of those started less than RESERVATION_WINDOW_MS ago minus what the
 * machine gave up since the earliest of them started, never negative. The
 * memory given up is credited once to all of them (one run's share is not
 * known), so that several runs going never under-count. A run that just
 * started has taken nothing yet and reserves its whole need; an older one
 * reserves nothing, what it takes is no longer free.
 */
export function reservations(db: Db, reading: MachineReading, at: Date = new Date()): { ramGb: number; vramGb: number } {
  const since = new Date(at.getTime() - RESERVATION_WINDOW_MS).toISOString();
  const rows = db
    .prepare(
      `SELECT m.ram_need_gb, m.vram_need_gb, m.ram_free_start_gb, m.vram_used_start_gb
       FROM run_machine m JOIN runs r ON r.id = m.run_id WHERE r.status = 'running' AND m.started_at > ? ORDER BY m.started_at, m.run_id`,
    )
    .all(since) as { ram_need_gb: number | null; vram_need_gb: number | null; ram_free_start_gb: number; vram_used_start_gb: number | null }[];
  const ram = rows.filter((row) => row.ram_need_gb !== null);
  const vram = rows.filter((row) => row.vram_need_gb !== null);
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const ramGiven = ram.length > 0 ? Math.max(0, ram[0]!.ram_free_start_gb - reading.ramFreeGb) : 0;
  const vramStart = vram[0]?.vram_used_start_gb ?? null;
  const vramGiven = reading.vramUsedGb !== null && vramStart !== null ? Math.max(0, reading.vramUsedGb - vramStart) : 0;
  return {
    ramGb: round(Math.max(0, sum(ram.map((row) => row.ram_need_gb!)) - ramGiven)),
    vramGb: round(Math.max(0, sum(vram.map((row) => row.vram_need_gb!)) - vramGiven)),
  };
}

/** Why the machine cannot take a run now, with the figures (GB). */
export type MachineShortfall =
  | { kind: "ram" | "vram"; needGb: number; keepGb: number; freeGb: number; reservedGb: number }
  /** A GPU need, and no GPU reading: the run waits (fail closed, see the docs). */
  | { kind: "vramUnknown"; needGb: number }
  /** A need the machine can never give: with its margin, above the machine's total. The task waits for the owner. */
  | { kind: "tooBig"; what: "ram" | "vram"; needGb: number; keepGb: number; totalGb: number };

/**
 * The gate of the machine: for each declared need, what is free now minus
 * what the runs in progress still have to take must be at least the need
 * plus the home's margin. Empty when the run fits, else every kind that falls
 * short; a need above the machine's total (tooBig) comes alone, since nothing
 * that frees can ever let it start.
 */
export function machineShortfalls(db: Db, need: Needs, reading: MachineReading, setting: MachineSetting): MachineShortfall[] {
  const tooBig: MachineShortfall[] = [];
  if (need.ramGb !== null && reading.ramTotalGb > 0 && need.ramGb + setting.keepFreeRamGb > reading.ramTotalGb) {
    tooBig.push({ kind: "tooBig", what: "ram", needGb: need.ramGb, keepGb: setting.keepFreeRamGb, totalGb: reading.ramTotalGb });
  }
  if (need.vramGb !== null && reading.vramTotalGb !== null && need.vramGb + setting.keepFreeVramGb > reading.vramTotalGb) {
    tooBig.push({ kind: "tooBig", what: "vram", needGb: need.vramGb, keepGb: setting.keepFreeVramGb, totalGb: reading.vramTotalGb });
  }
  if (tooBig.length > 0) return tooBig;
  const held = reservations(db, reading);
  const short: MachineShortfall[] = [];
  if (need.ramGb !== null && reading.ramFreeGb - held.ramGb < need.ramGb + setting.keepFreeRamGb) {
    short.push({ kind: "ram", needGb: need.ramGb, keepGb: setting.keepFreeRamGb, freeGb: reading.ramFreeGb, reservedGb: held.ramGb });
  }
  if (need.vramGb !== null) {
    if (reading.vramUsedGb === null || reading.vramTotalGb === null) {
      short.push({ kind: "vramUnknown", needGb: need.vramGb });
    } else {
      const free = round(reading.vramTotalGb - reading.vramUsedGb);
      if (free - held.vramGb < need.vramGb + setting.keepFreeVramGb) {
        short.push({ kind: "vram", needGb: need.vramGb, keepGb: setting.keepFreeVramGb, freeGb: free, reservedGb: held.vramGb });
      }
    }
  }
  return short;
}

/** What a task refused for these shortfalls keeps in the queue (no overtaking): only the kinds that fell short, nothing for a need that can never fit. */
export function shortfallHolds(shortfalls: readonly MachineShortfall[]): string[] {
  const holds = new Set<string>();
  for (const each of shortfalls) {
    if (each.kind === "ram") holds.add("ram");
    if (each.kind === "vram" || each.kind === "vramUnknown") holds.add("vram");
  }
  return [...holds];
}

/** The shortfall in one English sentence (the error of a refused start, the logs). */
export function shortfallText(shortfall: MachineShortfall): string {
  if (shortfall.kind === "vramUnknown") {
    return `it needs ${shortfall.needGb} GB of GPU memory and the GPU cannot be read (no nvidia-smi, or it failed)`;
  }
  if (shortfall.kind === "tooBig") {
    const what = shortfall.what === "ram" ? "RAM" : "GPU memory";
    return `it needs ${shortfall.needGb} GB of ${what} plus ${shortfall.keepGb} GB kept, more than the machine's ${shortfall.totalGb} GB: it can never start with this need`;
  }
  const what = shortfall.kind === "ram" ? "RAM" : "GPU memory";
  const left = round(shortfall.freeGb - shortfall.reservedGb);
  return `it needs ${shortfall.needGb} GB of ${what} free plus ${shortfall.keepGb} GB kept, and ${left} GB are left (${shortfall.freeGb} free, ${shortfall.reservedGb} reserved by the runs in progress)`;
}

// --- The home's veto command -------------------------------------------------------------

export type VetoRow = { verdict: "asking" | "ok" | "wait"; reason: string | null; error: string | null; at: string };

/** The latest answer of the veto command for an agent, null when it was never asked. */
export function readVeto(db: Db, room: string, agentId: string): VetoRow | null {
  return (
    (db.prepare("SELECT verdict, reason, error, at FROM machine_vetoes WHERE room = ? AND agent_id = ?").get(room, agentId) as VetoRow | undefined) ??
    null
  );
}

function writeVeto(db: Db, room: string, agentId: string, row: VetoRow): void {
  db.prepare(
    `INSERT INTO machine_vetoes (room, agent_id, verdict, reason, error, at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (room, agent_id) DO UPDATE SET verdict = excluded.verdict, reason = excluded.reason, error = excluded.error, at = excluded.at`,
  ).run(room, agentId, row.verdict, row.reason, row.error, row.at);
}

/** Whether an `ok` given at `at` was used: a run of the agent started since. An ok is used once, by the start it was asked for. */
function okUsed(db: Db, room: string, agentId: string, at: string): boolean {
  return db.prepare("SELECT 1 FROM runs WHERE room = ? AND agent_id = ? AND started_at >= ? LIMIT 1").get(room, agentId, at) !== undefined;
}

/** Whether a blocked task is MyHQ's note on a veto command that failed (the Standard says it as written). */
export function isVetoNote(db: Db, taskId: number): boolean {
  return db.prepare("SELECT 1 FROM machine_vetoes WHERE note_task_id = ?").get(taskId) !== undefined;
}

/**
 * Tells the owner, on the Standard, that the veto command failed for this
 * agent (it failed open: the run may start, but the command is not doing its
 * job): one blocked task of the agent with MyHQ's note, refreshed while it
 * keeps failing, done once the command answers again. A note the owner closed
 * stays closed until the command has worked again.
 */
function noteVeto(db: Db, room: string, agentId: string, error: string | null): void {
  const v = strings.deskModules.standard.vetoNote;
  const row = db.prepare("SELECT note_task_id FROM machine_vetoes WHERE room = ? AND agent_id = ?").get(room, agentId) as
    | { note_task_id: number | null }
    | undefined;
  const taskId = row?.note_task_id ?? null;
  const at = now();
  if (error === null) {
    if (taskId === null) return;
    db.prepare("UPDATE tasks SET status = 'done', note = ?, updated_at = ? WHERE id = ? AND status = 'blocked'").run(v.solved, at, taskId);
    db.prepare("UPDATE machine_vetoes SET note_task_id = NULL WHERE room = ? AND agent_id = ?").run(room, agentId);
    return;
  }
  const note = v.failed(error.replace(/\s+/g, " ").trim().slice(0, 500));
  if (taskId !== null) {
    db.prepare("UPDATE tasks SET note = ?, updated_at = ? WHERE id = ? AND status = 'blocked' AND note <> ?").run(note, at, taskId, note);
    return;
  }
  const text = `The home's veto command failed before a run of yours (${error.slice(0, 500)}), so MyHQ let the run start without it. This is for the owner to put right in myhq.json (machine.veto) or in the command itself: there is nothing for you to change, finish your turn.`;
  const id = Number(
    db
      .prepare("INSERT INTO tasks (room, agent_id, source, text, status, note, created_at, updated_at) VALUES (?, ?, 'manual', ?, 'blocked', ?, ?, ?)")
      .run(room, agentId, text, note, at, at).lastInsertRowid,
  );
  db.prepare("UPDATE machine_vetoes SET note_task_id = ? WHERE room = ? AND agent_id = ?").run(id, room, agentId);
}

/** What the veto command reads on stdin: the reading and the run about to start. */
export type VetoInput = {
  reading: MachineReading;
  run: { room: string; agent: string; needs: Needs; declaredNeeds: Needs; resources: string[] };
  now: string;
};

const vetoOutputSchema = z.union([
  z.looseObject({ wait: z.literal(false) }),
  z.looseObject({ wait: z.literal(true), reason: z.string().trim().min(1).max(500) }),
]);

export type VetoAnswer = { verdict: "ok" | "wait"; reason: string | null; error: string | null };

/**
 * Runs the veto command once, in the home, with the input on stdin. Exit 0
 * and `{ "wait": true, "reason": "..." }` is a wait; `{ "wait": false }` an
 * ok; anything else (a crash, a timeout, an unreadable answer) is an ok with
 * its error: it fails open. Never rejects.
 */
export function runVetoCommand(p: { home: string; command: readonly string[]; input: VetoInput; env: Env; timeoutMs: number }): Promise<VetoAnswer> {
  const open = (error: string): VetoAnswer => ({ verdict: "ok", reason: null, error });
  return new Promise((resolve) => {
    const [first, ...args] = p.command;
    const program = first!.includes("/") || first!.includes("\\") ? path.resolve(p.home, first!) : first!;
    let settled = false;
    // Set once the command started: the timeout of a command that could not start is never armed.
    const timer: { id?: ReturnType<typeof setTimeout> } = {};
    const done = (answer: VetoAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer.id);
      resolve(answer);
    };
    let stdout = "";
    let stderr = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(program, args, { cwd: p.home, env: p.env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      return done(open(`could not start "${first}": ${(error as Error).message}`));
    }
    timer.id = setTimeout(() => {
      child.kill();
      done(open(`no answer after ${Math.round(p.timeoutMs / 1000)} s`));
    }, p.timeoutMs);
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => (stdout = (stdout + chunk).slice(-10_000)));
    child.stderr!.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-2_000)));
    child.once("error", (error) => done(open(`could not start "${first}": ${error.message}`)));
    child.once("close", (code) => {
      const tail = stderr.trim() ? `: ${stderr.trim()}` : "";
      if (code !== 0) return done(open(`exited with code ${code}${tail}`));
      let raw: unknown;
      try {
        raw = JSON.parse(stdout.trim());
      } catch {
        return done(open(`stdout is not one JSON object: ${JSON.stringify(stdout.trim().slice(0, 200))}`));
      }
      const parsed = vetoOutputSchema.safeParse(raw);
      if (!parsed.success) return done(open(`stdout is not { "wait": false } or { "wait": true, "reason": "..." }`));
      done(parsed.data.wait ? { verdict: "wait", reason: parsed.data.reason, error: null } : { verdict: "ok", reason: null, error: null });
    });
    // A command that does not read its stdin closes it early: that is not an error.
    child.stdin!.on("error", () => undefined);
    child.stdin!.end(JSON.stringify(p.input));
  });
}

/** Resolves once every veto call in progress is stored (the tests wait for it). */
export async function vetoesIdle(): Promise<void> {
  const state = machineState();
  while (state.pending.size > 0) await Promise.allSettled([...state.pending]);
}

/**
 * What the gate asks of the veto command when it has to: where to run it,
 * what to do once it answered (wake the agents: the pending tasks it held
 * back), and, for a start with no pending task behind it (a routine, a run by
 * hand, the chat's run, a relaunch), `retry`: the same start again, tried once
 * the command answered, so that such a start is not lost.
 */
export type VetoAsk = { env: Env; rewake: () => void; retry?: () => void };

const vetoKey = (config: HqConfig, room: string, agentId: string) => `${config.dbPath}|${room}/${agentId}`;

function askVeto(config: HqConfig, db: Db, setting: MachineSetting, input: VetoInput, ask: VetoAsk): void {
  const state = machineState();
  const key = vetoKey(config, input.run.room, input.run.agent);
  state.vetoes.add(key);
  // After the transaction of the start (launchRun): the asking row must not be rolled back with it.
  const job = Promise.resolve()
    .then(async () => {
      writeVeto(db, input.run.room, input.run.agent, { verdict: "asking", reason: null, error: null, at: now() });
      const answer = await runVetoCommand({
        home: config.home,
        command: setting.veto!.command,
        input,
        env: { ...ask.env, MYHQ_HOME: config.home },
        timeoutMs: setting.veto!.timeoutMs,
      });
      if (answer.error) console.error(`[machine] the veto command failed for ${input.run.room}/${input.run.agent}, the run may start: ${answer.error}`);
      db.transaction(() => {
        writeVeto(db, input.run.room, input.run.agent, { ...answer, at: now() });
        noteVeto(db, input.run.room, input.run.agent, answer.error);
      }).immediate();
    })
    .catch((error: unknown) => console.error("[machine] the veto command could not be recorded", error))
    .finally(() => {
      state.vetoes.delete(key);
      state.pending.delete(job);
      // The direct starts that waited for this answer, each once: the first one uses an ok, the next ones ask again.
      const retries = state.retries.get(key) ?? [];
      state.retries.delete(key);
      for (const retry of retries) {
        try {
          retry();
        } catch (error) {
          console.error("[machine] a start tried again after the veto command failed", error);
        }
      }
      try {
        ask.rewake();
      } catch (error) {
        console.error("[machine] the wake-up after the veto command failed", error);
      }
    });
  state.pending.add(job);
}

// --- The gate -----------------------------------------------------------------------------

export type MachineCheck =
  /** The run may start; `need` and `reading` are what it reserves (null: an agent without needs; `reading` null: the machine was not looked at). */
  | { kind: "free"; need: Needs | null; reading: MachineReading | null }
  /** The memory falls short; `holds` is what the task keeps in the queue (shortfallHolds). */
  | { kind: "machine"; shortfall: MachineShortfall; holds: string[] }
  /** The home's veto command said wait (its reason), or is being asked (null); `deferred`: the start is tried again once it answers. */
  | { kind: "veto"; reason: string | null; deferred: boolean };

/** Whether the machine is looked at for a run of this agent: it declares `needs`, or the home has a veto command and the agent `needs` or `resources`. */
export function machineLooked(config: HqConfig, agent: Agent): boolean {
  if (declaresNeeds(agent)) return true;
  return asksVeto(agent) && readMachineSetting(config.home).setting.veto !== null;
}

/**
 * The machine's part of the gate of a run, the one place it is decided. An
 * agent without `needs` is not looked at, and without `needs` or `resources`
 * nor is the veto command asked: `free`, at no cost. With `ask` (the start
 * itself, launchRun) the gate acts: it uses a fresh `ok` of the veto command
 * once, and asks the command when it has no fresh answer (the run waits, the
 * answer wakes the agents again and tries `ask.retry` once). Without `ask`
 * (the queue, the Standard) it only reads what is known. `reading`, when
 * given, is the one taken by the caller (launchRun reads before its
 * transaction); otherwise `read` is called.
 */
export function machineCheck(p: {
  config: HqConfig;
  db: Db;
  room: string;
  agent: Agent;
  read?: MachineRead;
  reading?: MachineReading;
  ask?: VetoAsk;
}): MachineCheck {
  const { config, db, room, agent } = p;
  const needs = declaresNeeds(agent);
  const setting = needs || asksVeto(agent) ? readMachineSetting(config.home).setting : null;
  const veto = setting?.veto && asksVeto(agent) ? setting.veto : null;
  if (!needs && !veto) return { kind: "free", need: null, reading: null };
  const reading = p.reading ?? (p.read ?? readMachine)();
  const need = needs ? effectiveNeeds(db, room, agent, machineCeiling(reading, setting!)) : null;
  if (need) {
    const shortfalls = machineShortfalls(db, need, reading, setting!);
    if (shortfalls.length > 0) return { kind: "machine", shortfall: shortfalls[0]!, holds: shortfallHolds(shortfalls) };
  }
  if (veto) {
    const state = machineState();
    const key = vetoKey(config, room, agent.id);
    const row = readVeto(db, room, agent.id);
    const fresh = row !== null && Date.now() - Date.parse(row.at) < VETO_FRESH_MS;
    // The start waits for the answer; a direct one is tried again once it comes (askVeto).
    const defer = (): boolean => {
      if (!p.ask?.retry) return false;
      state.retries.set(key, [...(state.retries.get(key) ?? []), p.ask.retry]);
      return true;
    };
    // Asked by this process; for a reader (the queue, the Standard, the HQ MCP server as another process) an asking row still fresh too.
    const asking = state.vetoes.has(key) || (!p.ask && fresh && row.verdict === "asking");
    if (asking) return { kind: "veto", reason: null, deferred: defer() };
    if (fresh && row.verdict === "wait") return { kind: "veto", reason: row.reason, deferred: false };
    // Used once: the run that starts on it is newer than the answer, so the next start asks again.
    if (fresh && row.verdict === "ok" && !okUsed(db, room, agent.id, row.at)) return { kind: "free", need, reading };
    if (!p.ask) return row?.verdict === "wait" ? { kind: "veto", reason: row.reason, deferred: false } : { kind: "free", need, reading };
    askVeto(
      config,
      db,
      setting!,
      {
        reading,
        run: { room, agent: agent.id, needs: need ?? { ramGb: null, vramGb: null }, declaredNeeds: agent.needs ?? { ramGb: null, vramGb: null }, resources: agent.resources },
        now: now(),
      },
      p.ask,
    );
    return { kind: "veto", reason: null, deferred: defer() };
  }
  return { kind: "free", need, reading };
}

// --- Measured, then estimated ---------------------------------------------------------------

/**
 * Records, in the transaction of its start, what a run with needs reserves,
 * what it declares (the peaks count under that declaration only) and what the
 * machine had free.
 */
export function recordRunMachine(
  db: Db,
  runId: number,
  room: string,
  agentId: string,
  need: Needs,
  declared: Needs,
  reading: MachineReading,
  at: string,
): void {
  db.prepare(
    `INSERT INTO run_machine (run_id, room, agent_id, ram_need_gb, vram_need_gb, ram_declared_gb, vram_declared_gb, ram_free_start_gb, vram_used_start_gb, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(runId, room, agentId, need.ramGb, need.vramGb, declared.ramGb, declared.vramGb, reading.ramFreeGb, reading.vramUsedGb, at);
}

/**
 * Closes the machine records of the runs that ended without the normal path
 * (a crash, a forced stop, an exit with runs in progress): ended when their
 * run was closed (now if it has no end), not alone (what they measured is cut). Without it, an open record would make
 * every later run "not alone" and every tick read the machine. Returns how
 * many were closed. Never throws.
 */
export function closeStaleRunMachines(db: Db): number {
  try {
    return db
      .prepare(
        `UPDATE run_machine SET ended_at = COALESCE((SELECT r.ended_at FROM runs r WHERE r.id = run_machine.run_id), ?), alone = 0
         WHERE ended_at IS NULL AND run_id NOT IN (SELECT id FROM runs WHERE status = 'running')`,
      )
      .run(now()).changes;
  } catch (error) {
    console.error("[machine] closing the stale machine records failed", error);
    return 0;
  }
}

const SAMPLE = `UPDATE run_machine SET
    ram_peak_gb = MAX(ram_peak_gb, MAX(0, ram_free_start_gb - @ramFree)),
    vram_peak_gb = CASE WHEN @vramUsed IS NULL OR vram_used_start_gb IS NULL THEN vram_peak_gb
      ELSE MAX(COALESCE(vram_peak_gb, 0), MAX(0, @vramUsed - vram_used_start_gb)) END`;

/**
 * At each tick: for each run with needs in progress, the peak of what the
 * machine gave up since it started (RAM and GPU memory). Reads the machine
 * only when such a run goes on; the records of runs that ended without the
 * normal path are closed first (closeStaleRunMachines). Never throws.
 */
export function sampleMachine(db: Db, read: MachineRead = readMachine): void {
  try {
    closeStaleRunMachines(db);
    if (!db.prepare("SELECT 1 FROM run_machine WHERE ended_at IS NULL LIMIT 1").get()) return;
    const reading = read();
    db.prepare(`${SAMPLE} WHERE ended_at IS NULL AND run_id IN (SELECT id FROM runs WHERE status = 'running')`).run({
      ramFree: reading.ramFreeGb,
      vramUsed: reading.vramUsedGb,
    });
  } catch (error) {
    console.error("[machine] sampling the runs failed", error);
  }
}

/**
 * At the end of a run with needs: a last sample, then its end and whether it
 * was alone among the runs with needs (no other one overlapped it): only those
 * measure the agent. Does nothing for a run without needs. Never throws.
 */
export function closeRunMachine(db: Db, runId: number, read: MachineRead = readMachine): void {
  try {
    if (!db.prepare("SELECT 1 FROM run_machine WHERE run_id = ? AND ended_at IS NULL").get(runId)) return;
    const reading = read();
    const at = now();
    db.transaction(() => {
      db.prepare(`${SAMPLE} WHERE run_id = @runId`).run({ ramFree: reading.ramFreeGb, vramUsed: reading.vramUsedGb, runId });
      db.prepare(
        `UPDATE run_machine SET ended_at = @at, alone = NOT EXISTS (SELECT 1 FROM run_machine o WHERE o.run_id <> run_machine.run_id
           AND o.started_at <= @at AND (o.ended_at IS NULL OR o.ended_at >= run_machine.started_at))
         WHERE run_id = @runId`,
      ).run({ at, runId });
    }).immediate();
  } catch (error) {
    console.error(`[machine] closing the machine record of run #${runId} failed`, error);
  }
}

/** The median of a list of numbers, null when it is empty. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return round(sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2);
}

/** What the settings page shows of the machine: the reading, the margins, the veto command, and per agent with needs what it declares, measures and reserves. */
export type MachineView = {
  reading: MachineReading | null;
  keepFreeRamGb: number;
  keepFreeVramGb: number;
  source: "file" | "default";
  veto: { command: string; timeoutSeconds: number } | null;
  agents: {
    room: string;
    agent: string;
    name: string;
    kind: "ram" | "vram";
    declaredGb: number;
    effectiveGb: number;
    runs: number;
    medianGb: number | null;
    maxGb: number | null;
  }[];
  vetoes: (VetoRow & { room: string; agent: string })[];
};

/** The machine for the settings page. Reads the machine only when an agent of the home declares needs. Never throws for the reading. */
export function machineView(db: Db, config: HqConfig, agents: { room: string; agent: Agent }[], read: MachineRead = readMachine): MachineView & { error: string | null } {
  const { setting, fromFile, error } = readMachineSetting(config.home);
  const withNeeds = agents.filter(({ agent }) => declaresNeeds(agent));
  const reading = withNeeds.length > 0 ? read() : null;
  const ceiling = reading ? machineCeiling(reading, setting) : undefined;
  const rows: MachineView["agents"] = [];
  for (const { room, agent } of withNeeds) {
    const peaks = measuredPeaks(db, room, agent.id, agent.needs!);
    const effective = effectiveNeeds(db, room, agent, ceiling);
    for (const kind of ["ram", "vram"] as const) {
      const declared = kind === "ram" ? agent.needs!.ramGb : agent.needs!.vramGb;
      if (declared === null) continue;
      const measured = kind === "ram" ? peaks.ramGb : peaks.vramGb;
      rows.push({
        room,
        agent: agent.id,
        name: agent.name,
        kind,
        declaredGb: declared,
        effectiveGb: (kind === "ram" ? effective.ramGb : effective.vramGb) ?? declared,
        runs: measured.length,
        medianGb: median(measured),
        maxGb: measured.length > 0 ? round(Math.max(...measured)) : null,
      });
    }
  }
  const vetoes = db
    .prepare("SELECT room, agent_id AS agent, verdict, reason, error, at FROM machine_vetoes ORDER BY at DESC LIMIT 20")
    .all() as MachineView["vetoes"];
  return {
    reading,
    keepFreeRamGb: setting.keepFreeRamGb,
    keepFreeVramGb: setting.keepFreeVramGb,
    source: fromFile ? "file" : "default",
    veto: setting.veto ? { command: setting.veto.command.join(" "), timeoutSeconds: setting.veto.timeoutMs / 1000 } : null,
    agents: rows,
    vetoes,
    error,
  };
}
