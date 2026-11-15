import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AGENT_PROPOSAL } from "./agent-proposal";
import { AttachmentError, attachmentPath, attachmentType, resolveInside, type AttachmentKind } from "./attachments";
import { isInside, liveConfig, type HqConfig } from "./config";
import type { ApprovalRow, Db } from "./db";
import { NOTIFICATION_NOTE, readHomeSettings } from "./home-settings";
import { ROOM_PROPOSAL } from "./proposal";
import { QUESTION_TYPE } from "./questions";
import { dayKey, wallTime } from "./time";

/**
 * The room folders: "one room, one folder". Everything a room receives and
 * produces lives under `<root>/<room>/`, sorted into drawers by content; a
 * room with orders (room.json `orders`) has one folder per order at the root
 * of its folder, each with its own drawers. MyHQ files an approved delivery
 * itself (fileApproval); agents never write there, they read.
 */

/**
 * The drawers, a closed list. On-disk names follow the interface language,
 * French for now: `recu` holds what a client or a third party sent.
 */
export const DRAWERS = ["recu", "videos", "visuels", "sons", "social", "modeles-3d", "rendus", "impression", "devis", "documents"] as const;
export type Drawer = (typeof DRAWERS)[number];
export const drawerSchema = z.enum(DRAWERS);

/** The drawer of what a room or an order received, created with the folder. */
export const RECEIVED: Drawer = "recu";

/** The name of an order: `<YYYY>-<MM>-<client>-<subject>`, lowercase ASCII. */
export const orderNameSchema = z.string().regex(/^[0-9]{4}-[0-9]{2}-[a-z0-9]+(-[a-z0-9]+)*$/, "an order name such as 2026-11-acme-sign");

export class RoomFolderError extends Error {}

/** The drawer of a kind of file, when the item names none: by priority, model first, images then a client's piece last. */
const KIND_PRIORITY: readonly [AttachmentKind, Drawer][] = [
  ["model", "modeles-3d"],
  ["video", "videos"],
  ["audio", "sons"],
  ["pdf", "documents"],
  ["image", "visuels"],
  ["file", "documents"],
];

/**
 * The drawer of an item that names none, by what its files are: a 3D model,
 * else a video, else a sound, else a PDF, else images, else a client's piece
 * or a data file (documents). A preview image put first never decides. Null without a file of a known kind.
 */
export function defaultDrawer(fileNames: readonly string[]): Drawer | null {
  const kinds = new Set(fileNames.map((name) => attachmentType(name)?.kind));
  return KIND_PRIORITY.find(([kind]) => kinds.has(kind))?.[1] ?? null;
}

const SLUG_MAX = 60;

/** Lowercase ASCII, accents stripped, every other run of characters one `-`, trimmed, 60 at most; "" when nothing is left. */
function rawSlug(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
}

/** The slug of a title, `sans-titre` when nothing is left of it. */
export function slug(text: string): string {
  return rawSlug(text) || "sans-titre";
}

/** The absolute root of the room folders: `folders.dir` of myhq.json (relative to the home, or absolute), else `<home>/folders`. Throws when myhq.json is invalid. */
export function roomFoldersRoot(home: string): string {
  return path.resolve(home, readHomeSettings(home)?.folders?.dir ?? "folders");
}

/**
 * The folder of a room; a name that is not a room id (one that would climb
 * out, say), or that Windows reserves for a device (`con`, `nul`, `com1`...),
 * is a RoomFolderError.
 */
export function roomFolder(root: string, room: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(room)) throw new RoomFolderError(`"${room}" is not a room name.`);
  if (WINDOWS_DEVICE.test(room)) throw new RoomFolderError(`"${room}" is a name Windows reserves: a room of that name gets no folder.`);
  return path.join(root, room);
}

/**
 * The real path of a room folder, null when it does not exist. A folder that
 * leads out of the real root (a link) is a RoomFolderError: nothing is ever
 * read or given out of the root.
 */
export function realRoomFolder(root: string, room: string): string | null {
  let real: string;
  try {
    real = fs.realpathSync(roomFolder(root, room));
  } catch (error) {
    if (error instanceof RoomFolderError) throw error;
    return null;
  }
  const realRoot = fs.realpathSync(root);
  if (!isInside(realRoot, real) || real === realRoot) {
    throw new RoomFolderError(`The folder of room "${room}" leads out of the room folders.`);
  }
  return real;
}

/**
 * Makes the folder of a room, then each directory of `parts` under it, one
 * level at a time, and checks each once made: its real path must be inside
 * the real root, else a RoomFolderError, so that nothing is ever created or
 * moved through a folder that leads out of the root (a link). Returns the
 * real path of the last one.
 */
function ensureInRoot(root: string, room: string, ...parts: string[]): string {
  let dir = roomFolder(root, room);
  fs.mkdirSync(dir, { recursive: true });
  let real = realRoomFolder(root, room)!;
  const realRoot = fs.realpathSync(root);
  for (const part of parts) {
    dir = path.join(dir, part);
    fs.mkdirSync(dir, { recursive: true });
    real = fs.realpathSync(dir);
    if (!isInside(realRoot, real)) throw new RoomFolderError(`The folder "${toPosix(path.relative(root, dir))}" leads out of the room folders.`);
  }
  return real;
}

/**
 * Whether room `orderer` ordered from room `from`: a message of one of its
 * agents became a task of `from`, at any time. Only then may an agent of
 * `from` read the folder of `orderer` on the revise or approval task of an
 * item delivered for it, list its orders, and be told them.
 */
export function roomOrderedFrom(db: Db, orderer: string, from: string): boolean {
  return db.prepare("SELECT 1 FROM tasks WHERE room = ? AND source = 'message' AND from_room = ? LIMIT 1").get(from, orderer) !== undefined;
}

/** Whether a name at the root of a room folder is an order: the order format, and not a drawer. */
export function isOrderName(name: string): boolean {
  return orderNameSchema.safeParse(name).success && !(DRAWERS as readonly string[]).includes(name);
}

/** The orders of a room, newest first (by name, descending); none when the room has no folder yet. */
export function listOrders(root: string, room: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(roomFolder(root, room), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && isOrderName(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
}

/**
 * Opens an order of a room: `<YYYY>-<MM>-<slug(client)>-<slug(subject)>`, the
 * month of `now` in `timeZone`, created with its `recu/`. An order of that
 * name already there is returned with `created: false`. Both slugs must be
 * non empty.
 */
export function openOrder(
  root: string,
  room: string,
  client: string,
  subject: string,
  now: Date,
  timeZone: string,
): { order: string; created: boolean } {
  const who = rawSlug(client);
  const what = rawSlug(subject);
  if (!who) throw new RoomFolderError(`client "${client}" leaves nothing for the name of the order: use letters or digits.`);
  if (!what) throw new RoomFolderError(`subject "${subject}" leaves nothing for the name of the order: use letters or digits.`);
  const { year, month } = wallTime(now, timeZone);
  const order = `${year}-${String(month).padStart(2, "0")}-${who}-${what}`;
  const created = !fs.existsSync(path.join(roomFolder(root, room), order));
  // The room folder is checked before the order is created through it, the order before its recu.
  ensureInRoot(root, room, order, RECEIVED);
  return { order, created };
}

const toPosix = (p: string) => p.split(path.sep).join("/");

/** A path given inside a room folder, checked as attachments are: relative, no "..", its real path inside the folder. */
function resolveInRoom(root: string, room: string, relPath: string): string {
  const dir = realRoomFolder(root, room);
  if (dir === null) throw new RoomFolderError(`Room "${room}" has no folder.`);
  try {
    return resolveInside(dir, relPath, "path").real;
  } catch (error) {
    if (error instanceof AttachmentError) {
      throw new RoomFolderError(`"${relPath}" is not a path inside the folder of room "${room}".`);
    }
    throw error;
  }
}

export type RoomFolderEntry = {
  name: string;
  /** Relative to the room folder, with "/". */
  path: string;
  type: "dir" | "file";
  size: number;
  modifiedAt: string;
  /** A drawer (at the root of the room folder or of an order), an order (at the root), or nothing. */
  role: "drawer" | "order" | null;
  /** The kind of a file of an accepted extension, null otherwise. */
  kind: AttachmentKind | null;
};

/**
 * The entries of a directory of a room folder (`relPath` empty: the folder
 * itself), directories first then by name. Hidden entries (leading dot) are
 * skipped. A path out of the folder, or that is no directory, is a
 * RoomFolderError; a room without a folder yet lists nothing.
 */
export function listRoomFolder(root: string, room: string, relPath: string): RoomFolderEntry[] {
  const top = relPath === "" || relPath === ".";
  let dir: string;
  let base: string;
  if (top) {
    const real = realRoomFolder(root, room);
    if (real === null) return [];
    dir = real;
    base = "";
  } else {
    dir = resolveInRoom(root, room, relPath);
    if (!fs.statSync(dir).isDirectory()) throw new RoomFolderError(`"${relPath}" is not a directory of room "${room}".`);
    base = toPosix(path.relative(realRoomFolder(root, room)!, dir));
  }
  // Drawers sit at the root of the room folder and at the root of each order.
  const drawerLevel = top || (!base.includes("/") && isOrderName(base));
  const entries: RoomFolderEntry[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(path.join(dir, entry.name));
    } catch {
      continue;
    }
    const isDir = stat.isDirectory();
    if (!isDir && !stat.isFile()) continue;
    let role: RoomFolderEntry["role"] = null;
    if (isDir && drawerLevel && (DRAWERS as readonly string[]).includes(entry.name)) role = "drawer";
    else if (isDir && top && isOrderName(entry.name)) role = "order";
    entries.push({
      name: entry.name,
      path: base ? `${base}/${entry.name}` : entry.name,
      type: isDir ? "dir" : "file",
      size: isDir ? 0 : stat.size,
      modifiedAt: stat.mtime.toISOString(),
      role,
      kind: isDir ? null : (attachmentType(entry.name)?.kind ?? null),
    });
  }
  return entries.sort((a, b) => (a.type === b.type ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.type === "dir" ? -1 : 1));
}

/** The real path of a file inside a room folder; a RoomFolderError for anything else. */
export function resolveRoomFile(root: string, room: string, relPath: string): string {
  const real = resolveInRoom(root, room, relPath);
  if (!fs.statSync(real).isFile()) throw new RoomFolderError(`"${relPath}" is not a file of room "${room}".`);
  return real;
}

/**
 * A file name safe to write: the base name only, without control characters,
 * separators nor the characters Windows reserves (`C:x.png` would write an
 * alternate stream there), never hidden, never only dots, no trailing dots or
 * spaces (Windows drops them), a Windows device name (`con`, `nul`, `com1`...,
 * tested on the part before the first dot: `nul.tar.gz` is one) prefixed with
 * `_`; `fichier` when nothing is left.
 */
function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "");
  if (!cleaned) return "fichier";
  const stem = cleaned.split(".")[0]!.replace(/ +$/, "");
  return WINDOWS_DEVICE.test(stem) ? `_${cleaned}` : cleaned;
}

/** The names Windows reserves for devices, whatever their extensions, the superscript COM and LPT included. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i;

/** The codes of a hard link that cannot be made: another volume, or a file system without hard links. */
const NO_HARD_LINK: ReadonlySet<string> = new Set(["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EMLINK"]);

/**
 * Moves a file or a directory to `target`, which must be free: the target is
 * reserved atomically, so that a name taken after it was chosen makes the
 * move fail (EEXIST) and is never replaced (`renameSync` would replace a
 * file). A file: hard link to the target, then unlink of the source; when no
 * hard link can be made (another volume, a file system without them), copy
 * with COPYFILE_EXCL, then unlink; when the source cannot be unlinked, the
 * target is removed again and the error thrown. A directory: the target is reserved by a
 * non recursive mkdir (fails when taken), then the directory is renamed onto
 * that empty reservation. POSIX does it atomically and refuses (ENOTEMPTY)
 * if anything was put in the reservation meanwhile. Windows never renames
 * onto an existing directory: there the empty reservation is removed (rmdir
 * fails if anything was put in it) and the rename done again, which on
 * Windows fails rather than replace whatever would appear in between.
 */
export function moveExclusive(source: string, target: string): void {
  if (!fs.lstatSync(source).isDirectory()) {
    try {
      fs.linkSync(source, target);
    } catch (error) {
      if (!NO_HARD_LINK.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    }
    try {
      fs.unlinkSync(source);
    } catch (error) {
      // The source stays (a file held open, say): the target just made goes, so a failed move leaves nothing behind.
      try {
        fs.unlinkSync(target);
      } catch {
        // Best effort.
      }
      throw error;
    }
    return;
  }
  fs.mkdirSync(target);
  try {
    fs.renameSync(source, target);
  } catch (error) {
    try {
      fs.rmdirSync(target);
    } catch {
      throw error;
    }
    fs.renameSync(source, target);
  }
}

/** `stem-2.ext`, `stem-3.ext`...: the n-th candidate of a name (n 1 is the name itself). */
function numbered(name: string, n: number): string {
  if (n === 1) return name;
  const ext = path.extname(name);
  return `${name.slice(0, name.length - ext.length)}-${n}${ext}`;
}

/** The first free name in `dir` among `name`, `name-2`, `name-3`... */
function freeName(dir: string, name: string): string {
  for (let n = 1; ; n++) {
    const candidate = numbered(name, n);
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
}

/**
 * Writes a file a room received into the `recu/` of the room, or of one of
 * its orders (which must exist), under a safe free name. Returns its path
 * relative to the room folder, with "/".
 */
export function saveReceived(root: string, room: string, order: string | null, fileName: string, data: Buffer): string {
  const roomDir = roomFolder(root, room);
  const parts: string[] = [RECEIVED];
  if (order !== null) {
    if (!isOrderName(order)) throw new RoomFolderError(`"${order}" is not an order name.`);
    if (!fs.existsSync(path.join(roomDir, order))) throw new RoomFolderError(`Room "${room}" has no order "${order}".`);
    parts.unshift(order);
  }
  // Nothing is created through a room folder, an order or a drawer that leads out of the root, and the file must stay in the drawer.
  const real = ensureInRoot(root, room, ...parts);
  const dir = path.join(roomDir, ...parts);
  const name = freeName(real, safeFileName(fileName));
  if (path.dirname(path.join(real, name)) !== real) throw new RoomFolderError(`"${fileName}" is not a file name.`);
  fs.writeFileSync(path.join(real, name), data, { flag: "wx" });
  return toPosix(path.relative(roomDir, path.join(dir, name)));
}

/** The first suffix under which every name of `names` is free in `dir` (`name`, then `name-2`...). */
function freeStem(dir: string, stem: string, exts: readonly string[]): string {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? stem : `${stem}-${n}`;
    if (exts.every((ext) => !fs.existsSync(path.join(dir, `${candidate}${ext}`)))) return candidate;
  }
}

/** The types that are never filed: they hold no delivery. */
const NEVER_FILED: readonly string[] = [QUESTION_TYPE, ROOM_PROPOSAL, AGENT_PROPOSAL];

/**
 * What an approved item, not filed yet, would file: its files, the drawer it
 * named (or null) and the drawer it goes to. Null for an item that is never
 * filed (an informational one, a type that holds no delivery, no file and no
 * drawer). Throws on a drawer that is not one.
 */
function filingPlan(db: Db, row: ApprovalRow): { files: { id: number; name: string }[]; named: Drawer | null; drawer: Drawer } | null {
  if (NEVER_FILED.includes(row.type)) return null;
  if (row.decision_note === NOTIFICATION_NOTE && row.decided_at === row.created_at) return null;
  const files = db.prepare("SELECT id, name FROM approval_files WHERE approval_id = ? ORDER BY id").all(row.id) as {
    id: number;
    name: string;
  }[];
  const named = row.drawer !== null ? drawerSchema.parse(row.drawer) : null;
  const drawer = named ?? defaultDrawer(files.map((file) => file.name));
  return drawer === null ? null : { files, named, drawer };
}

/** An approved item that fileApproval would file and has not yet. */
export type PendingFiling = {
  id: number;
  /** The room whose folder it goes to (`for_room`, else the room of the item). */
  room: string;
  type: string;
  title: string;
  fileCount: number;
  order: string | null;
  drawer: Drawer;
  /** The drawer it goes to, relative to the root, with "/". */
  folder: string;
};

/**
 * The approved items that fileApproval would file and that are not yet
 * (`filed_path` empty), by id: the same conditions, so filing each of them
 * does something. Reads only; an item whose drawer is invalid is left out.
 */
export function pendingFilings(db: Db): PendingFiling[] {
  const rows = db
    .prepare("SELECT * FROM approvals WHERE status = 'approved' AND (filed_path IS NULL OR filed_path = '') ORDER BY id")
    .all() as ApprovalRow[];
  const pending: PendingFiling[] = [];
  for (const row of rows) {
    let plan: ReturnType<typeof filingPlan>;
    try {
      plan = filingPlan(db, row);
    } catch {
      continue;
    }
    if (plan === null) continue;
    const room = row.for_room ?? row.room;
    pending.push({
      id: row.id,
      room,
      type: row.type,
      title: row.title,
      fileCount: plan.files.length,
      order: row.order_name,
      drawer: plan.drawer,
      folder: [room, ...(row.order_name ? [row.order_name] : []), plan.drawer].join("/"),
    });
  }
  return pending;
}

/**
 * Files one approved item into its room folder, and records where in
 * `approvals.filed_path` (relative to the root, with "/"). Destination:
 * `<root>/<for_room ?? room>[/<order>]/<drawer>/`, the item's drawer or the
 * default one of its files; name `<YYYY-MM-DD>-<slug(title)>`, the approval
 * day in the home's time zone. One file or none: flat (`<name><ext>`, and
 * `<name>.md` for the body); more: a folder `<name>/` holding the files and
 * `<name>.md`. The body is written only when the item named its drawer. The
 * files are copied from the frozen copies, and nothing is ever overwritten.
 *
 * Only an approved item that is not informational, of a type that holds a
 * delivery, with files or a drawer, is filed. Idempotent: an item already
 * filed returns its path. Never throws: an error is logged, what was written
 * is removed, `filed_path` stays NULL and null is returned.
 */
export function fileApproval(db: Db, config: HqConfig, id: number): string | null {
  const created: string[] = [];
  try {
    const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
    if (!row || row.status !== "approved") return null;
    if (row.filed_path) return row.filed_path;
    const plan = filingPlan(db, row);
    if (plan === null) return null;
    const { files, named, drawer } = plan;
    const root = roomFoldersRoot(config.home);
    const room = row.for_room ?? row.room;
    // Nothing is created through a room folder, an order or a drawer that leads out of the root.
    const parts = [...(row.order_name ? [orderNameSchema.parse(row.order_name)] : []), drawer];
    ensureInRoot(root, room, ...parts);
    const dir = path.join(roomFolder(root, room), ...parts);
    const name = `${dayKey(new Date(row.decided_at ?? Date.now()), liveConfig(config).timeZone)}-${slug(row.title)}`;
    const copy = (fileId: number, fileName: string, target: string) => {
      fs.copyFileSync(attachmentPath(config.dataDir, id, fileId, fileName), target, fs.constants.COPYFILE_EXCL);
      created.push(target);
    };
    const writeBody = (target: string) => {
      fs.writeFileSync(target, row.body.endsWith("\n") ? row.body : `${row.body}\n`, { flag: "wx" });
      created.push(target);
    };
    let filed: string;
    if (files.length <= 1) {
      const file = files[0];
      const ext = file ? (attachmentType(file.name)?.ext ?? "") : null;
      const stem = freeStem(dir, name, [...(ext !== null ? [ext] : []), ...(named ? [".md"] : [])]);
      if (file && ext !== null) copy(file.id, file.name, path.join(dir, `${stem}${ext}`));
      if (named) writeBody(path.join(dir, `${stem}.md`));
      filed = path.join(dir, file ? `${stem}${ext}` : `${stem}.md`);
    } else {
      const folder = path.join(dir, freeName(dir, name));
      fs.mkdirSync(folder);
      created.push(folder);
      const taken = new Set<string>();
      const body = `${path.basename(folder)}.md`;
      if (named) taken.add(body.toLowerCase());
      for (const file of files) {
        let target = safeFileName(file.name);
        for (let n = 2; taken.has(target.toLowerCase()); n++) target = numbered(safeFileName(file.name), n);
        taken.add(target.toLowerCase());
        copy(file.id, file.name, path.join(folder, target));
      }
      if (named) writeBody(path.join(folder, body));
      filed = folder;
    }
    const relative = toPosix(path.relative(root, filed));
    if (db.prepare("UPDATE approvals SET filed_path = ? WHERE id = ? AND filed_path IS NULL").run(relative, id).changes === 0) {
      // Another process filed the item meanwhile: what was just written goes, its filing stands.
      for (const target of created.reverse()) fs.rmSync(target, { recursive: true, force: true });
      const current = db.prepare("SELECT filed_path FROM approvals WHERE id = ?").get(id) as { filed_path: string | null } | undefined;
      return current?.filed_path || null;
    }
    return relative;
  } catch (error) {
    for (const target of created.reverse()) fs.rmSync(target, { recursive: true, force: true });
    console.error(`[room-folders] filing approval #${id} failed`, error);
    return null;
  }
}

/** A filed entry received outside any order, ready to move into one. */
export type ReceivedEntry = { id: number; filedPath: string };

/** Whether MyHQ delivered the onApprove messages of an item and one of them went to an agent of `room` (a message without a room is for the submitter's). */
function relayedTo(db: Db, id: number, itemRoom: string, room: string): boolean {
  const stored = db.prepare("SELECT messages FROM approval_relays WHERE approval_id = ? AND delivered_at IS NOT NULL").get(id) as
    | { messages: string }
    | undefined;
  if (!stored) return false;
  let messages: unknown;
  try {
    messages = JSON.parse(stored.messages);
  } catch {
    return false;
  }
  if (!Array.isArray(messages)) return false;
  const agentOf = db.prepare("SELECT 1 FROM agents WHERE room = ? AND id = ?");
  return messages.some((message: { room?: unknown; agent?: unknown } | null) => {
    if (typeof message?.agent !== "string") return false;
    const to = typeof message.room === "string" ? message.room : itemRoom;
    return to === room && agentOf.get(room, message.agent) !== undefined;
  });
}

/**
 * Checks that every id is an item an agent of `room` may pull into one of
 * its orders: approved, filed in a `recu` drawer outside any order (drawer
 * `recu`, `filed_path` set and on disk, no order), and its room's: the item's
 * `room` or `for_room` is `room`, or MyHQ relayed it to an agent of `room`
 * (hq_submit onApprove, delivered). All are checked before anything moves:
 * the first that does not qualify is a RoomFolderError naming it, the same
 * whatever the cause, so that nothing of another room can be probed with it.
 */
export function receivedEntries(db: Db, root: string, room: string, ids: readonly number[]): ReceivedEntry[] {
  const select = db.prepare("SELECT room, for_room, status, drawer, order_name, filed_path FROM approvals WHERE id = ?");
  return [...new Set(ids)].map((id) => {
    const refused = () => new RoomFolderError(`received: item #${id} cannot be pulled into an order of your room: nothing was moved.`);
    const row = select.get(id) as Pick<ApprovalRow, "room" | "for_room" | "status" | "drawer" | "order_name" | "filed_path"> | undefined;
    if (!row || row.status !== "approved" || row.drawer !== RECEIVED || !row.filed_path || row.order_name !== null) throw refused();
    if (row.room !== room && row.for_room !== room && !relayedTo(db, id, row.room, room)) throw refused();
    if (!fs.existsSync(path.join(root, row.filed_path))) throw refused();
    return { id, filedPath: row.filed_path };
  });
}

/**
 * Moves checked received entries (see receivedEntries) and checked names
 * (see receivedNames) into the `recu/` of an order of `room`: a filed file
 * with its `.md` twin, a body alone, a folder, or an entry given by its name,
 * each under a free name, never overwriting (moveExclusive). The order is
 * checked inside the root before anything moves. Records each item's new
 * `filed_path` and `order_name` (`for_room` is left alone) in one
 * transaction. All or nothing: when a move fails, the moves already done are
 * undone in reverse order and the transaction rolls back, so the disk and the
 * database still agree. Returns the new paths, relative to the root.
 */
export function moveIntoOrder(
  db: Db,
  root: string,
  room: string,
  order: string,
  entries: readonly ReceivedEntry[],
  names: readonly string[],
): { received: ReceivedEntry[]; files: string[] } {
  const parts = [orderNameSchema.parse(order), RECEIVED];
  ensureInRoot(root, room, ...parts);
  const target = path.join(roomFolder(root, room), ...parts);
  const record = db.prepare("UPDATE approvals SET filed_path = ?, order_name = ? WHERE id = ?");
  const done: { from: string; to: string }[] = [];
  const move = (from: string, to: string) => {
    moveExclusive(from, to);
    done.push({ from, to });
  };
  const jobs = [
    ...entries.map((entry) => ({ id: entry.id as number | null, source: path.join(root, entry.filedPath) })),
    ...names.map((source) => ({ id: null as number | null, source })),
  ];
  try {
    return db
      .transaction(() => {
        const received: ReceivedEntry[] = [];
        const files: string[] = [];
        for (const { id, source } of jobs) {
          let moved: string;
          if (id === null || fs.statSync(source).isDirectory()) {
            moved = path.join(target, freeName(target, path.basename(source)));
            move(source, moved);
          } else {
            const ext = path.extname(source);
            const stem = path.basename(source, ext);
            const twin = ext.toLowerCase() === ".md" ? null : path.join(path.dirname(source), `${stem}.md`);
            const withTwin = twin !== null && fs.existsSync(twin);
            const free = freeStem(target, stem, withTwin ? [ext, ".md"] : [ext]);
            moved = path.join(target, `${free}${ext}`);
            move(source, moved);
            if (withTwin) move(twin, path.join(target, `${free}.md`));
          }
          const relative = toPosix(path.relative(root, moved));
          if (id === null) {
            files.push(relative);
          } else {
            record.run(relative, order, id);
            received.push({ id, filedPath: relative });
          }
        }
        return { received, files };
      })
      .immediate();
  } catch (error) {
    for (const { from, to } of done.reverse()) {
      try {
        moveExclusive(to, from);
      } catch (undo) {
        console.error(`[room-folders] could not move ${to} back to ${from}`, undo);
      }
    }
    throw error;
  }
}

/**
 * Checks names of entries (files or folders) sitting directly in the `recu/`
 * of a room, outside any order: plain names (no separator, no ".."), existing,
 * their real path directly in that `recu/`, and none of them an item MyHQ
 * filed (that one moves by its id, with its `.md` twin). All are checked
 * before anything moves: the first that does not qualify is a RoomFolderError
 * naming it. Returns their real paths.
 */
export function receivedNames(db: Db, root: string, room: string, names: readonly string[]): string[] {
  const dir = path.join(roomFolder(root, room), RECEIVED);
  const unique = [...new Set(names)];
  // The items MyHQ filed loose in this drawer: an entry that is one of them, or its .md twin, moves by its id.
  const prefix = `${room}/${RECEIVED}/`;
  const filed = (
    db.prepare("SELECT id, filed_path FROM approvals WHERE substr(filed_path, 1, ?) = ?").all(prefix.length, prefix) as {
      id: number;
      filed_path: string;
    }[]
  ).map((row) => ({ id: row.id, name: row.filed_path.slice(prefix.length) }));
  const stem = (name: string) => name.slice(0, name.length - path.extname(name).length);
  const nativeReal = (p: string) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return null;
    }
  };
  return unique.map((name) => {
    const refuse = (why: string) =>
      new RoomFolderError(`receivedFiles: "${name}" ${why}: nothing was moved. Give the names of entries of your room's ${RECEIVED}/ folder.`);
    if (!name || /[\\/:]/.test(name) || /^\.+$/.test(name)) throw refuse("is not a plain name");
    let real: string;
    let realDir: string;
    try {
      realDir = fs.realpathSync(dir);
      real = fs.realpathSync(path.join(dir, name));
    } catch {
      throw refuse(`is not in your room's ${RECEIVED}/ folder`);
    }
    if (path.dirname(real) !== realDir || !isInside(fs.realpathSync(root), real)) throw refuse("leads out of that folder");
    // Compared without case (a case variant is the same entry on a case-insensitive disk), and by real path.
    const isNote = path.extname(name).toLowerCase() === ".md";
    const given = nativeReal(path.join(dir, name));
    const item = filed.find(
      (each) =>
        each.name.toLowerCase() === name.toLowerCase() ||
        (isNote && stem(each.name).toLowerCase() === stem(name).toLowerCase()) ||
        (given !== null && [each.name, `${stem(each.name)}.md`].some((entry) => nativeReal(path.join(dir, entry)) === given)),
    );
    if (item) throw refuse(`is item #${item.id}, filed by MyHQ: give its id in received instead`);
    return real;
  });
}

/** Why a file of the drop folder was not filed: the caller says it in the user's language. */
export type DroppedFileProblem = "not_in_drop" | "not_a_file" | "leads_out" | "no_such_order";

export class DroppedFileError extends RoomFolderError {
  constructor(
    message: string,
    readonly code: DroppedFileProblem,
    /** The orders of the room, for `no_such_order`. */
    readonly orders: string[] = [],
  ) {
    super(message);
  }
}

/**
 * Files a file of the assistant's drop folder (what the owner sent to the bot)
 * into the `recu/` of a room, or of one of its orders (which must exist), on an
 * act of the owner: it is MOVED there, under a safe free name, never
 * overwriting. Its companion note (`<name without extension>.md`, next to it),
 * when there is one, moves with it under the same free stem. `fileName` is a
 * plain name: its real path must be a regular file directly in the real drop
 * folder (a link is refused, a hard link too: a file with more than one link);
 * a note with more than one link stays where it is, the file moves alone.
 * Checked like saveReceived: nothing is created through a room folder that
 * leads out of the root. Returns the new path of the file, relative to the
 * root, with "/".
 */
export function moveDroppedIntoReceived(root: string, dropDir: string, room: string, order: string | null, fileName: string): string {
  const roomDir = roomFolder(root, room);
  if (order !== null && !isOrderName(order)) throw new RoomFolderError(`"${order}" is not an order name.`);
  const notInDrop = () => new DroppedFileError(`"${fileName}" is not in the drop folder.`, "not_in_drop");
  if (!fileName || /[\\/:]/.test(fileName) || /^\.+$/.test(fileName)) throw notInDrop();
  let realDrop: string;
  let source: string;
  try {
    realDrop = fs.realpathSync(dropDir);
    source = fs.realpathSync(path.join(dropDir, fileName));
  } catch {
    throw notInDrop();
  }
  if (path.dirname(source) !== realDrop || fs.lstatSync(path.join(realDrop, fileName)).isSymbolicLink()) {
    throw new DroppedFileError(`"${fileName}" leads out of the drop folder.`, "leads_out");
  }
  if (!fs.statSync(source).isFile()) throw new DroppedFileError(`"${fileName}" is not a file.`, "not_a_file");
  // A hard link shares its content with a file elsewhere: refused like a link.
  if (fs.lstatSync(source).nlink > 1) throw new DroppedFileError(`"${fileName}" leads out of the drop folder.`, "leads_out");
  // Nothing is created through a room folder that leads out of the root.
  realRoomFolder(root, room);
  if (order !== null && !fs.existsSync(path.join(roomDir, order))) {
    throw new DroppedFileError(`Room "${room}" has no order "${order}".`, "no_such_order", listOrders(root, room));
  }
  const parts = [...(order !== null ? [order] : []), RECEIVED];
  const realDrawer = ensureInRoot(root, room, ...parts);
  const drawer = path.join(roomDir, ...parts);
  const name = safeFileName(fileName);
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  const noteName = `${fileName.slice(0, fileName.length - path.extname(fileName).length)}.md`;
  const note = path.join(realDrop, noteName);
  const noteStat = ext.toLowerCase() !== ".md" && fs.existsSync(note) ? fs.lstatSync(note) : null;
  const withNote = noteStat !== null && noteStat.isFile() && noteStat.nlink === 1;
  const free = freeStem(realDrawer, stem, withNote ? [ext, ".md"] : [ext]);
  moveExclusive(source, path.join(realDrawer, `${free}${ext}`));
  if (withNote) moveExclusive(note, path.join(realDrawer, `${free}.md`));
  return toPosix(path.relative(root, path.join(drawer, `${free}${ext}`)));
}
