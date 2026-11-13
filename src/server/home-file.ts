import fs from "node:fs";
import path from "node:path";
import { HqError } from "./errors";
import { readRawHomeFile } from "./runtime-settings";

// Writing the files of the home: myhq.json key by key, and any JSON file
// atomically (written beside it, then renamed over it), in 2-space JSON.
// Shared by the settings page (settings.ts) and the room gestures
// (room-manage.ts).

/** Replaces `file` with `text`: written beside it, then renamed over it. */
export function writeTextAtomic(file: string, text: string): void {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temp, text, "utf8");
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

/** Replaces `file` with `value` as 2-space JSON: written beside it, then renamed over it. */
export function writeJsonAtomic(file: string, value: unknown): void {
  writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** The keys of myhq.json, ready to be changed. Refuses a file that cannot be read back (it is never overwritten). */
export function readHomeFileForWrite(home: string): { file: string; data: Record<string, unknown>; text: string | null } {
  const file = path.join(home, "myhq.json");
  const { data, error } = readRawHomeFile(home);
  if (error) throw new HqError("SETTINGS_FILE_INVALID", 409, `${error}: fix or remove it, nothing was written.`);
  return { file, data: data ?? {}, text: data ? fs.readFileSync(file, "utf8") : null };
}

/**
 * Sets (or, with `undefined`, removes) top-level keys of myhq.json. The other
 * keys, their order and their values stay as they are; the file is not
 * touched when nothing changes.
 */
export function writeHomeKeys(home: string, changes: Record<string, unknown>): void {
  const { file, data, text } = readHomeFileForWrite(home);
  const next: Record<string, unknown> = { ...data };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  if (text !== null && JSON.stringify(data) === JSON.stringify(next)) return;
  fs.mkdirSync(home, { recursive: true });
  writeJsonAtomic(file, next);
}

