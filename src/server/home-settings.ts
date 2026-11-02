import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

// `<home>/myhq.json`, read by the app and by the HQ MCP server (which must
// stay light: this module only needs the file system and zod).

export const DEFAULT_LANGUAGE = "en";

/**
 * `<home>/myhq.json`: settings of the home that are not secrets. Optional;
 * other keys are ignored, so that the file can grow.
 */
export const homeSettingsSchema = z.looseObject({
  /**
   * Language of the texts the agents write for this home (BCP 47 tag such as
   * `fr` or `en`). Read by the onboarding run; defaults to English.
   */
  language: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "a BCP 47 language tag such as fr or en")
    .default(DEFAULT_LANGUAGE),
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
  notifyTypes: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, "an approval type in snake_case")).default([]),
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

/** The decision note of an informational item (a type of `notifyTypes`), stored already approved. */
export const NOTIFICATION_NOTE = "notification";
