import fs from "node:fs";
import path from "node:path";
import { getConfig } from "./config";
import { HqError, errorResponse } from "./errors";
import { roadmapSchema, type Roadmap } from "./roadmap-schema";

export * from "./roadmap-schema";

/** Where the roadmap lives, relative to the home. Configurable later. */
export const ROADMAP_RELATIVE_PATH = "docs/roadmap.json";

const DEBOUNCE_MS = 150;
const RETRY_MS = 5_000;

export type RoadmapResult = { ok: true; roadmap: Roadmap } | { ok: false; reason: string };

export const roadmapPath = (home: string): string => path.join(home, ...ROADMAP_RELATIVE_PATH.split("/"));

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Reads and validates the roadmap file; the reason says why it is not usable. */
export function loadRoadmap(home: string): RoadmapResult {
  let raw: string;
  try {
    raw = fs.readFileSync(roadmapPath(home), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      reason:
        code === "ENOENT"
          ? `${ROADMAP_RELATIVE_PATH} does not exist in the home.`
          : `${ROADMAP_RELATIVE_PATH} cannot be read: ${messageOf(error)}`,
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (error) {
    return { ok: false, reason: `${ROADMAP_RELATIVE_PATH} is not valid JSON: ${messageOf(error)}` };
  }
  const parsed = roadmapSchema.safeParse(json);
  if (!parsed.success) {
    const details = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, reason: `${ROADMAP_RELATIVE_PATH} is invalid: ${details}` };
  }
  return { ok: true, roadmap: parsed.data };
}

/** The validated roadmap, or null (with the reason logged) when absent or invalid. */
export function readRoadmap(home: string, warn: (message: string) => void = console.warn): Roadmap | null {
  const result = loadRoadmap(home);
  if (result.ok) return result.roadmap;
  warn(`[myhq] roadmap unavailable: ${result.reason}`);
  return null;
}

/** Response of GET /api/roadmap: the document, or 404 with the reason. */
export function roadmapResponse(home: string): Response {
  const result = loadRoadmap(home);
  if (result.ok) return Response.json(result.roadmap);
  console.warn(`[myhq] roadmap unavailable: ${result.reason}`);
  return errorResponse(new HqError("ROADMAP_NOT_FOUND", 404, result.reason));
}

/** The route handler: reads the home from the environment. */
export function handleGetRoadmap(): Response {
  return roadmapResponse(getConfig().home);
}

/**
 * Calls `onChange` (debounced) whenever the roadmap file is created, edited,
 * replaced or removed. Watches the directory rather than the file, because
 * editors save by replacing the file and a watch on the file itself is lost
 * with it (notably on Windows). If the directory does not exist yet, it is
 * looked for again every few seconds. Returns a function that stops watching.
 */
export function watchRoadmap(home: string, onChange: () => void, debounceMs = DEBOUNCE_MS): () => void {
  const file = roadmapPath(home);
  const dir = path.dirname(file);
  const name = path.basename(file);
  let watcher: fs.FSWatcher | null = null;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let retried = false;

  const trigger = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (!stopped) onChange();
    }, debounceMs);
  };

  const scheduleRetry = () => {
    if (stopped) return;
    retried = true;
    retry = setTimeout(start, RETRY_MS);
    retry.unref();
  };

  function start() {
    if (stopped) return;
    try {
      watcher = fs.watch(dir, (_event, filename) => {
        // filename can be missing on some platforms: treat it as a change.
        if (filename === null || filename === undefined || filename.toString() === name) trigger();
      });
    } catch {
      scheduleRetry();
      return;
    }
    watcher.on("error", () => {
      // The directory was removed or renamed: the file went with it. Tell
      // the listeners, then look for the directory again.
      watcher?.close();
      watcher = null;
      trigger();
      scheduleRetry();
    });
    // The directory appeared after we started looking: the file may already be there.
    if (retried) trigger();
  }

  start();
  return () => {
    stopped = true;
    clearTimeout(debounce);
    clearTimeout(retry);
    watcher?.close();
    watcher = null;
  };
}

type Listener = () => void;
type Hub = { listeners: Set<Listener>; stop: () => void };

// Shared across module instances (instrumentation, route bundles, dev reloads).
const globalForHub = globalThis as unknown as { __myhqRoadmapHubs?: Map<string, Hub> };

/**
 * Subscribes to roadmap changes of a home. One watcher per home is shared by
 * all subscribers; it starts with the first one and stops with the last.
 * Returns the unsubscribe function.
 */
export function subscribeRoadmap(home: string, listener: Listener): () => void {
  const hubs = (globalForHub.__myhqRoadmapHubs ??= new Map());
  let hub = hubs.get(home);
  if (!hub) {
    const listeners = new Set<Listener>();
    hub = {
      listeners,
      stop: watchRoadmap(home, () => {
        for (const each of [...listeners]) {
          try {
            each();
          } catch {
            // A closed stream must not stop the others.
          }
        }
      }),
    };
    hubs.set(home, hub);
  }
  const current = hub;
  current.listeners.add(listener);
  return () => {
    current.listeners.delete(listener);
    if (current.listeners.size === 0 && hubs.get(home) === current) {
      current.stop();
      hubs.delete(home);
    }
  };
}
