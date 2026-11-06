import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DEFAULT_FLOOR_LAYOUT, FLOOR_LAYOUTS, type FloorLayoutMode } from "../ui/floor-mode";

// `<home>/myhq.json`, read by the app and by the HQ MCP server (which must
// stay light: this module only needs the file system and zod).

export const DEFAULT_LANGUAGE = "en";

/** A BCP 47 language tag such as `fr` or `en`. */
export const languageTagSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "a BCP 47 language tag such as fr or en");

/** An approval type, in snake_case (an entry of `notifyTypes`). */
export const approvalTypeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, "an approval type in snake_case");

/**
 * `<home>/myhq.json`: settings of the home that are not secrets. Optional;
 * other keys are ignored, so that the file can grow.
 */
export const homeSettingsSchema = z.looseObject({
  /**
   * Language of the texts the agents write for this home (BCP 47 tag such as
   * `fr` or `en`). Read by the onboarding run; defaults to English.
   */
  language: languageTagSchema.default(DEFAULT_LANGUAGE),
  export: z
    .strictObject({
      /** Folder of the daily export, relative to the home or absolute. */
      dir: z.string().trim().min(1),
      /** Local hour (HQ_TIMEZONE) from which the previous day is exported. */
      hour: z.number().int().min(0).max(23).default(1),
    })
    .optional(),
  /**
   * Informational approval types: an item of one of them is stored already
   * approved (note « notification ») and sent to Telegram in full, without buttons.
   */
  /**
   * The floor that draws the reception desk and the receptionist (the
   * onboarding agent): the room named here when it exists, else the room
   * `assistant`, else the first room.
   */
  reception: z.strictObject({ room: z.string().trim().min(1) }).optional(),
  /** The onboarding agent's own settings. */
  onboarding: z
    .strictObject({
      /** Character sheet of the receptionist, relative to the home (the shipped one when absent). */
      sprite: z.string().trim().min(1).optional(),
    })
    .optional(),
  notifyTypes: z.array(approvalTypeSchema).default([]),
});

export type HomeSettings = z.infer<typeof homeSettingsSchema>;

/** The parsed myhq.json, or null when the file is absent. Throws when it is invalid. */
export function readHomeSettings(home: string): HomeSettings | null {
  const file = path.join(home, "myhq.json");
  if (!fs.existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  const parsed = homeSettingsSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`${file}: ${details}`);
  }
  return parsed.data;
}

/**
 * The informational approval types (`notifyTypes` in myhq.json), none when
 * the file or the key is absent. Never throws: an invalid file is logged and
 * every item keeps the pending flow.
 */
export function readNotifyTypes(home: string): string[] {
  try {
    return readHomeSettings(home)?.notifyTypes ?? [];
  } catch (error) {
    console.error(`[notify] ${(error as Error).message}`);
    return [];
  }
}

/** The `reception.room` of myhq.json, null when absent. Never throws: an invalid file is logged. */
export function readReceptionRoom(home: string): string | null {
  try {
    return readHomeSettings(home)?.reception?.room ?? null;
  } catch (error) {
    console.error(`[reception] ${(error as Error).message}`);
    return null;
  }
}

/** The receptionist's own character sheet (`onboarding.sprite`), as an absolute path, null when absent. Never throws. */
export function readReceptionSprite(home: string): string | null {
  try {
    const sprite = readHomeSettings(home)?.onboarding?.sprite;
    return sprite ? path.resolve(home, sprite) : null;
  } catch (error) {
    console.error(`[reception] ${(error as Error).message}`);
    return null;
  }
}

/** The `floor` block of myhq.json: how /room draws the home. */
export const floorSettingsSchema = z.strictObject({ layout: z.enum(FLOOR_LAYOUTS).default(DEFAULT_FLOOR_LAYOUT) });

/**
 * The `floor.layout` of myhq.json, the default when the file or the key is
 * absent. Read apart from the rest of the file (like the desk): an invalid
 * block falls back to the default with the reason, and never breaks the other
 * settings. Never throws.
 */
export function readFloorLayout(home: string): { layout: FloorLayoutMode; error: string | null } {
  const file = path.join(home, "myhq.json");
  let raw: unknown;
  try {
    if (!fs.existsSync(file)) return { layout: DEFAULT_FLOOR_LAYOUT, error: null };
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return { layout: DEFAULT_FLOOR_LAYOUT, error: `myhq.json is not valid JSON: ${(error as Error).message}` };
  }
  const block = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).floor : undefined;
  if (block === undefined) return { layout: DEFAULT_FLOOR_LAYOUT, error: null };
  const parsed = floorSettingsSchema.safeParse(block);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `floor.${issue.path.join(".")}: ${issue.message}`).join("; ");
    return { layout: DEFAULT_FLOOR_LAYOUT, error: `myhq.json: ${details}` };
  }
  return { layout: parsed.data.layout, error: null };
}

/** The decision note of an informational item (a type of `notifyTypes`), stored already approved. */
export const NOTIFICATION_NOTE = "notification";

/** The `projectsRoot` of myhq.json: the folder the room browser is limited to. */
export const projectsRootSchema = z.string().trim().min(1).max(1_000);

const reportedProjectsRootErrors = new Set<string>();

/**
 * The folder the room browser (`GET /api/fs/dirs`) is limited to, as an
 * absolute path: `projectsRoot` of myhq.json (relative to the home, or
 * absolute), else the parent folder of the home, where the repositories are
 * usually kept. Read apart from the rest of the file (like `floor`): an
 * invalid value falls back to the default, with the reason logged once, and
 * never breaks the other settings. Never throws.
 */
export function readProjectsRoot(home: string): string {
  const fallback = path.dirname(path.resolve(home));
  const file = path.join(home, "myhq.json");
  const report = (message: string) => {
    if (reportedProjectsRootErrors.has(message)) return;
    reportedProjectsRootErrors.add(message);
    console.error(`[fs] ${message}: the parent folder of the home applies`);
  };
  let raw: unknown;
  try {
    if (!fs.existsSync(file)) return fallback;
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    report(`myhq.json is not valid JSON: ${(error as Error).message}`);
    return fallback;
  }
  const value = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).projectsRoot : undefined;
  if (value === undefined) return fallback;
  const parsed = projectsRootSchema.safeParse(value);
  if (!parsed.success) {
    report("myhq.json: projectsRoot must be a non-empty string");
    return fallback;
  }
  return path.resolve(home, parsed.data);
}

/**
 * `portier` of myhq.json: the small model that reads a message before MyHQ wakes its recipient for it, and
 * says whether the message is worth a wake or can wait for the recipient's next run (see portier.ts).
 */
export const portierSettingSchema = z.strictObject({
  enabled: z.boolean(),
  /** The model alias given to `claude -p --model`. */
  model: z.string().trim().min(1).max(100).optional(),
});

export type PortierSetting = { enabled: boolean; model: string };

/** The portier when myhq.json says nothing: on, on Haiku. */
export const DEFAULT_PORTIER: PortierSetting = { enabled: true, model: "haiku" };

/**
 * The `portier` block of myhq.json over `fallback` (the default, or what a test configuration sets).
 * Read apart from the rest of the file, like `floor`: an invalid block keeps the fallback and gives the
 * reason. Never throws.
 */
export function readPortierSetting(
  home: string,
  fallback: PortierSetting = DEFAULT_PORTIER,
): { setting: PortierSetting; fromFile: boolean; error: string | null } {
  const file = path.join(home, "myhq.json");
  let raw: unknown;
  try {
    if (!fs.existsSync(file)) return { setting: fallback, fromFile: false, error: null };
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return { setting: fallback, fromFile: false, error: `myhq.json is not valid JSON: ${(error as Error).message}` };
  }
  const block = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).portier : undefined;
  if (block === undefined) return { setting: fallback, fromFile: false, error: null };
  const parsed = portierSettingSchema.safeParse(block);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `portier.${issue.path.join(".")}: ${issue.message}`).join("; ");
    return { setting: fallback, fromFile: false, error: `myhq.json: ${details}` };
  }
  return { setting: { enabled: parsed.data.enabled, model: parsed.data.model ?? fallback.model }, fromFile: true, error: null };
}
