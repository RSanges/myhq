import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { isInside } from "../server/config";

// The contract between MyHQ and the assistant's extensions, which live in the
// home (`assistant/commands/*.ts`). Documented in docs/home-layout.md.

/** A command shown in Telegram's command menu. */
export interface AssistantCommand {
  command: string;
  description: string;
}

/** What an extension receives with each message. */
export interface AssistantContext {
  /** The one chat the assistant serves. */
  chatId: string;
  /** Absolute path of the home directory. */
  home: string;
  /** The app's environment (`.env.local`), without the HQ_TELEGRAM_* variables. */
  env: NodeJS.ProcessEnv;
  /** Sends a message now (plain text, cut at 4000 characters). */
  reply(text: string): Promise<void>;
  log(message: string): void;
}

/**
 * The default export of an extension module. `handle` is asked about every
 * text message that is not a core command, in the order of `extensions` in
 * `assistant.json`: the first non-null answer is sent and nothing else runs.
 */
export interface AssistantExtension {
  name: string;
  commands: AssistantCommand[];
  handle(text: string, ctx: AssistantContext): Promise<string | null>;
}

const commandSchema = z.strictObject({
  command: z.string().regex(/^[a-z0-9_]{1,32}$/, "1 to 32 lowercase letters, digits or underscores"),
  description: z.string().trim().min(1).max(256),
});

const extensionSchema = z.looseObject({
  name: z.string().trim().min(1).max(64),
  commands: z.array(commandSchema),
  handle: z.custom<AssistantExtension["handle"]>((value) => typeof value === "function", "must be a function"),
});

export type LoadedExtension = { entry: string; extension: AssistantExtension };

/** Imports a module file by absolute path. */
export type ModuleImporter = (file: string, parentDir: string) => Promise<unknown>;

/**
 * TypeScript modules are imported through tsx's `tsImport`, which compiles
 * them on the fly without registering a loader for the whole process.
 */
export const tsImporter: ModuleImporter = async (file, parentDir) => {
  const { tsImport } = await import("tsx/esm/api");
  return tsImport(pathToFileURL(file).href, pathToFileURL(path.join(parentDir, path.sep)).href);
};

/** `export default` read from ESM, or from a module compiled as CommonJS. */
function defaultExport(mod: unknown): unknown {
  if (!mod || typeof mod !== "object" || !("default" in mod)) return undefined;
  const first = (mod as { default: unknown }).default;
  if (first && typeof first === "object" && !("handle" in first) && "default" in first) {
    return (first as { default: unknown }).default;
  }
  return first;
}

/**
 * Loads the extensions listed in `assistant.json`, in order. A module that is
 * missing, outside the home, fails to load or does not match the contract is
 * reported in `errors` and skipped: the bridge runs without it.
 */
export async function loadExtensions(
  home: string,
  entries: string[],
  importer: ModuleImporter = tsImporter,
): Promise<{ extensions: LoadedExtension[]; errors: string[] }> {
  const extensions: LoadedExtension[] = [];
  const errors: string[] = [];
  for (const entry of entries) {
    const file = path.resolve(home, entry);
    if (!isInside(home, file)) {
      errors.push(`${entry}: an extension must stay inside the home`);
      continue;
    }
    if (!fs.existsSync(file)) {
      errors.push(`${entry}: file not found`);
      continue;
    }
    let mod: unknown;
    try {
      mod = await importer(file, home);
    } catch (error) {
      errors.push(`${entry}: failed to load (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const parsed = extensionSchema.safeParse(defaultExport(mod));
    if (!parsed.success) {
      const details = parsed.error.issues
        .map((issue) => `${issue.path.length ? issue.path.join(".") : "default export"}: ${issue.message}`)
        .join("; ");
      errors.push(`${entry}: not an assistant extension (${details})`);
      continue;
    }
    const extension = parsed.data as unknown as AssistantExtension;
    if (extensions.some((loaded) => loaded.extension.name === extension.name)) {
      errors.push(`${entry}: another extension is already named "${extension.name}"`);
      continue;
    }
    extensions.push({ entry, extension });
  }
  return { extensions, errors };
}
