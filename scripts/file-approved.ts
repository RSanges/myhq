/**
 * `npm run file-approved`: catches up the room folders. Lists the approved
 * items that MyHQ would file and has not (`filed_path` empty, with files or a
 * drawer: the conditions of `fileApproval`), with the drawer each would go to.
 * By default it only prints that list and changes nothing; `--apply` files
 * each one (the code of an approval) and prints where it went; `--only 12,15`
 * restricts to those ids. The home is MYHQ_HOME, from the environment or
 * `.env.local`.
 */
import { getConfig, type HqConfig } from "../src/server/config";
import { getDbAt, type Db } from "../src/server/db";
import { fileApproval, pendingFilings } from "../src/server/room-folders";
import { strings } from "../src/ui/strings";

const t = strings.fileApproved;

export type FileApprovedOptions = { apply: boolean; only: number[] | null };

/** The options of the command line, null when they are not valid. */
export function parseArgs(args: string[]): FileApprovedOptions | null {
  let apply = false;
  let only: number[] | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--apply") apply = true;
    else if (args[i] === "--only") {
      const value = args[++i] ?? "";
      if (!/^\d+(,\d+)*$/.test(value)) return null;
      only = value.split(",").map(Number);
    } else return null;
  }
  return { apply, only };
}

/**
 * Prints the items to file (all, or those of `only`), and files them when
 * `apply`. Returns how many could not be filed (0 for a dry run).
 */
export function fileApproved(db: Db, config: HqConfig, options: FileApprovedOptions, log: (line: string) => void = console.log): number {
  const all = pendingFilings(db);
  const pending = options.only ? all.filter((item) => options.only!.includes(item.id)) : all;
  if (options.only) {
    const missing = options.only.filter((id) => !pending.some((item) => item.id === id));
    if (missing.length > 0) log(t.unknownIds(missing));
  }
  if (pending.length === 0) {
    log(t.none);
    return 0;
  }
  log(options.apply ? t.applyTitle(pending.length) : t.dryRunTitle(pending.length));
  if (!options.apply) {
    for (const item of pending) log(t.line(item));
    return 0;
  }
  let failed = 0;
  for (const item of pending) {
    const filed = fileApproval(db, config, item.id);
    if (filed === null) {
      failed++;
      log(t.notFiled(item.id));
    } else log(t.filed(item.id, filed));
  }
  log(t.summary(pending.length - failed, failed));
  return failed;
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    console.error(t.usage);
    process.exit(2);
  }
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // No .env.local: the environment alone.
  }
  const config = getConfig();
  process.exit(fileApproved(getDbAt(config.dbPath), config, options) > 0 ? 1 : 0);
}
