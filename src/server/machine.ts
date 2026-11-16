import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Env, HqConfig } from "./config";
import { now, type Db } from "./db";
import { readMachineSetting, type MachineSetting } from "./home-settings";
import type { Agent } from "./rooms";

// The machine: what a run of an agent with `needs` (room.json, in GB) takes
// from it, checked before the run starts, where the agent lock and the shared
// resources are (launchRun). The reading is portable: RAM from node:os, GPU
// memory from nvidia-smi when it exists (anything else is "unknown"). The
// runs already started reserve what they still have to take, so that two
// runs released together never count the same free memory. While a run with
// needs goes on, the tick samples what the machine gave up since it started;
// the peak of its last runs alone raises the need of the agent (never lowers
// it). The home's veto command may say "wait" for a reason MyHQ cannot see.
// This module imports nothing that reads the runner: the runner calls it.
// See docs/architecture.md, "The queue and the machine".

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

/** The real nvidia-smi query, its stdout, or null when it is absent, fails or times out. Never throws. */
export function queryNvidiaSmi(): string | null {
  try {
    const result = spawnSync("nvidia-smi", ["--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"], {
      encoding: "utf8",
      timeout: NVIDIA_SMI_TIMEOUT_MS,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) return null;
    return result.stdout;
  } catch {
    return null;
  }
}

export type MachineProbes = {
  memory: () => { freeBytes: number; totalBytes: number };
  /** The stdout of nvidia-smi, null when there is none. */
  gpu: () => string | null;
};

const REAL_PROBES: MachineProbes = {
  memory: () => ({ freeBytes: os.freemem(), totalBytes: os.totalmem() }),
  gpu: queryNvidiaSmi,
};

/** One reading of the machine with these probes. Never throws: a probe that fails reads as unknown (GPU) or zero free (RAM). */
export function takeReading(probes: MachineProbes = REAL_PROBES, at: Date = new Date()): MachineReading {
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

const globalForMachine = globalThis as unknown as {
  __myhqMachine?: { cached: { reading: MachineReading; at: number } | null; vetoes: Set<string>; pending: Set<Promise<void>> };
};
function machineState() {
  globalForMachine.__myhqMachine ??= { cached: null, vetoes: new Set(), pending: new Set() };
  return globalForMachine.__myhqMachine;
}

/** The real reading, reused for MACHINE_CACHE_MS. Never throws. */
export function readMachine(): MachineReading {
  const state = machineState();
  if (state.cached && Date.now() - state.cached.at < MACHINE_CACHE_MS) return state.cached.reading;
  const reading = takeReading();
  state.cached = { reading, at: Date.now() };
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

/** The peaks of the last runs alone of an agent, newest first (only those measure the agent and nothing else). */
export function measuredPeaks(db: Db, room: string, agentId: string, limit = PEAK_RUNS): { ramGb: number[]; vramGb: number[] } {
  const rows = db
    .prepare(
      `SELECT ram_peak_gb, vram_peak_gb FROM run_machine WHERE room = ? AND agent_id = ? AND ended_at IS NOT NULL AND alone = 1
       ORDER BY run_id DESC LIMIT ?`,
    )
    .all(room, agentId, limit) as { ram_peak_gb: number; vram_peak_gb: number | null }[];
  return {
    ramGb: rows.map((row) => row.ram_peak_gb),
    vramGb: rows.map((row) => row.vram_peak_gb).filter((value): value is number => value !== null),
  };
}

/**
 * The need a run of the agent reserves: what it declares, raised to the
 * measured max of its last runs alone when that is higher. Never lowered: the
 * owner lowers the declaration himself. A kind it does not declare stays null.
 */
export function effectiveNeeds(db: Db, room: string, agent: Pick<Agent, "id" | "needs">): Needs {
  const declared = agent.needs ?? { ramGb: null, vramGb: null };
  const peaks = measuredPeaks(db, room, agent.id);
  const raise = (need: number | null, measured: number[]) => (need === null ? null : round(Math.max(need, ...measured)));
  return { ramGb: raise(declared.ramGb, peaks.ramGb), vramGb: raise(declared.vramGb, peaks.vramGb) };
}

/**
 * What the runs in progress still have to take: for each one with needs, its
 * need minus what the machine gave up since it started, never negative. A run
 * that just started has taken nothing yet and reserves its whole need.
 */
export function reservations(db: Db, reading: MachineReading): { ramGb: number; vramGb: number } {
  const rows = db
    .prepare(
      `SELECT m.ram_need_gb, m.vram_need_gb, m.ram_free_start_gb, m.vram_used_start_gb
       FROM run_machine m JOIN runs r ON r.id = m.run_id WHERE r.status = 'running'`,
    )
    .all() as { ram_need_gb: number | null; vram_need_gb: number | null; ram_free_start_gb: number; vram_used_start_gb: number | null }[];
  let ramGb = 0;
  let vramGb = 0;
  for (const row of rows) {
    if (row.ram_need_gb !== null) ramGb += Math.max(0, row.ram_need_gb - Math.max(0, row.ram_free_start_gb - reading.ramFreeGb));
    if (row.vram_need_gb !== null) {
      const given = reading.vramUsedGb !== null && row.vram_used_start_gb !== null ? Math.max(0, reading.vramUsedGb - row.vram_used_start_gb) : 0;
      vramGb += Math.max(0, row.vram_need_gb - given);
    }
  }
  return { ramGb: round(ramGb), vramGb: round(vramGb) };
}

/** Why the machine cannot take a run now, with the figures (GB). */
export type MachineShortfall =
  | { kind: "ram" | "vram"; needGb: number; keepGb: number; freeGb: number; reservedGb: number }
  /** A GPU need, and no GPU reading: the run waits (fail closed, see the docs). */
  | { kind: "vramUnknown"; needGb: number };

/**
 * The gate of the machine: for each declared need, what is free now minus
 * what the runs in progress still have to take must be at least the need
 * plus the home's margin. Null when the run fits.
 */
export function machineShortfall(db: Db, need: Needs, reading: MachineReading, setting: MachineSetting): MachineShortfall | null {
  const held = reservations(db, reading);
  if (need.ramGb !== null && reading.ramFreeGb - held.ramGb < need.ramGb + setting.keepFreeRamGb) {
    return { kind: "ram", needGb: need.ramGb, keepGb: setting.keepFreeRamGb, freeGb: reading.ramFreeGb, reservedGb: held.ramGb };
  }
  if (need.vramGb !== null) {
    if (reading.vramUsedGb === null || reading.vramTotalGb === null) return { kind: "vramUnknown", needGb: need.vramGb };
    const free = round(reading.vramTotalGb - reading.vramUsedGb);
    if (free - held.vramGb < need.vramGb + setting.keepFreeVramGb) {
      return { kind: "vram", needGb: need.vramGb, keepGb: setting.keepFreeVramGb, freeGb: free, reservedGb: held.vramGb };
    }
  }
  return null;
}

/** The shortfall in one English sentence (the error of a refused start, the logs). */
export function shortfallText(shortfall: MachineShortfall): string {
  if (shortfall.kind === "vramUnknown") {
    return `it needs ${shortfall.needGb} GB of GPU memory and the GPU cannot be read (no nvidia-smi, or it failed)`;
  }
  const what = shortfall.kind === "ram" ? "RAM" : "GPU memory";
  const left = round(shortfall.freeGb - shortfall.reservedGb);
  return `it needs ${shortfall.needGb} GB of ${what} free plus ${shortfall.keepGb} GB kept, and ${left} GB are left (${shortfall.freeGb} free, ${shortfall.reservedGb} reserved by the runs in progress)`;
}

// --- The home's veto command -------------------------------------------------------------

export type VetoRow = { verdict: "asking" | "ok" | "wait"; reason: string | null; error: string | null; at: string };

/** The latest answer of the veto command for an agent, null when it was never asked (or its ok was used). */
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

/** What the gate asks of the veto command when it has to: where to run it, and what to do once it answered. */
export type VetoAsk = { env: Env; rewake: () => void };

function askVeto(config: HqConfig, db: Db, setting: MachineSetting, input: VetoInput, ask: VetoAsk): void {
  const state = machineState();
  const key = `${config.dbPath}|${input.run.room}/${input.run.agent}`;
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
      writeVeto(db, input.run.room, input.run.agent, { ...answer, at: now() });
    })
    .catch((error: unknown) => console.error("[machine] the veto command could not be recorded", error))
    .finally(() => {
      state.vetoes.delete(key);
      state.pending.delete(job);
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
  /** The run may start; `need` and `reading` are what it reserves (null: an agent without needs). */
  | { kind: "free"; need: Needs | null; reading: MachineReading | null }
  | { kind: "machine"; shortfall: MachineShortfall }
  /** The home's veto command said wait (its reason), or is being asked (null). */
  | { kind: "veto"; reason: string | null };

/**
 * The machine's part of the gate of a run, the one place it is decided. An
 * agent without `needs` is not looked at, and without `needs` or `resources`
 * nor is the veto command asked: `free`, at no cost. With `ask` (the start
 * itself, launchRun) the gate acts: it uses a fresh `ok` of the veto command
 * once, and asks the command when it has no fresh answer (the run waits, and
 * the answer wakes the agents again). Without `ask` (the queue, the
 * Standard) it only reads what is known.
 */
export function machineCheck(p: { config: HqConfig; db: Db; room: string; agent: Agent; read?: MachineRead; ask?: VetoAsk }): MachineCheck {
  const { config, db, room, agent } = p;
  const needs = declaresNeeds(agent);
  const setting = needs || asksVeto(agent) ? readMachineSetting(config.home).setting : null;
  const veto = setting?.veto && asksVeto(agent) ? setting.veto : null;
  if (!needs && !veto) return { kind: "free", need: null, reading: null };
  const reading = (p.read ?? readMachine)();
  const need = needs ? effectiveNeeds(db, room, agent) : null;
  if (need) {
    const shortfall = machineShortfall(db, need, reading, setting!);
    if (shortfall) return { kind: "machine", shortfall };
  }
  if (veto) {
    const row = readVeto(db, room, agent.id);
    const fresh = row !== null && Date.now() - Date.parse(row.at) < VETO_FRESH_MS;
    // Asked by this process, or by the app as another process (the HQ MCP server) reads it.
    const asking = machineState().vetoes.has(`${config.dbPath}|${room}/${agent.id}`) || (fresh && row.verdict === "asking");
    if (asking) return { kind: "veto", reason: null };
    if (fresh && row.verdict === "wait") return { kind: "veto", reason: row.reason };
    if (fresh && row.verdict === "ok") {
      // Used once: the next run asks again.
      if (p.ask) db.prepare("DELETE FROM machine_vetoes WHERE room = ? AND agent_id = ?").run(room, agent.id);
      return { kind: "free", need, reading };
    }
    if (!p.ask) return row?.verdict === "wait" ? { kind: "veto", reason: row.reason } : { kind: "free", need, reading };
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
    return { kind: "veto", reason: null };
  }
  return { kind: "free", need, reading };
}

// --- Measured, then estimated ---------------------------------------------------------------

/** Records, in the transaction of its start, what a run with needs reserves and what the machine had free. */
export function recordRunMachine(db: Db, runId: number, room: string, agentId: string, need: Needs, reading: MachineReading, at: string): void {
  db.prepare(
    `INSERT INTO run_machine (run_id, room, agent_id, ram_need_gb, vram_need_gb, ram_free_start_gb, vram_used_start_gb, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(runId, room, agentId, need.ramGb, need.vramGb, reading.ramFreeGb, reading.vramUsedGb, at);
}

const SAMPLE = `UPDATE run_machine SET
    ram_peak_gb = MAX(ram_peak_gb, MAX(0, ram_free_start_gb - @ramFree)),
    vram_peak_gb = CASE WHEN @vramUsed IS NULL OR vram_used_start_gb IS NULL THEN vram_peak_gb
      ELSE MAX(COALESCE(vram_peak_gb, 0), MAX(0, @vramUsed - vram_used_start_gb)) END`;

/**
 * At each tick: for each run with needs in progress, the peak of what the
 * machine gave up since it started (RAM and GPU memory). Reads the machine
 * only when such a run goes on. Never throws.
 */
export function sampleMachine(db: Db, read: MachineRead = readMachine): void {
  try {
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
  const rows: MachineView["agents"] = [];
  for (const { room, agent } of withNeeds) {
    const peaks = measuredPeaks(db, room, agent.id);
    const effective = effectiveNeeds(db, room, agent);
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
    reading: withNeeds.length > 0 ? read() : null,
    keepFreeRamGb: setting.keepFreeRamGb,
    keepFreeVramGb: setting.keepFreeVramGb,
    source: fromFile ? "file" : "default",
    veto: setting.veto ? { command: setting.veto.command.join(" "), timeoutSeconds: setting.veto.timeoutMs / 1000 } : null,
    agents: rows,
    vetoes,
    error,
  };
}
