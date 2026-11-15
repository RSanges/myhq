import type { FolderEntry } from "./schemas";
import { strings } from "./strings";

// The room folders page (/dossiers) as a model, pure: its address, the trail,
// the grouping of the entries into orders, drawers and the rest, where a
// deposit goes, the name MyHQ will give an order, sizes, and the checks made
// before a deposit is sent. Nothing here touches the DOM.

const t = strings.folders;

/** The page, and its query: `?salle=<room>&chemin=<path relative to the room folder>`. */
export const FOLDERS_PATH = "/dossiers";
export const ROOM_PARAM = "salle";
export const PATH_PARAM = "chemin";

/** The drawers, in the order of the server's closed list (src/server/room-folders.ts DRAWERS). */
export const DRAWER_NAMES = ["recu", "videos", "visuels", "sons", "social", "modeles-3d", "rendus", "impression", "devis", "documents"] as const;
const RECEIVED = "recu";

const ROOM_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const ORDER_NAME = /^[0-9]{4}-[0-9]{2}-[a-z0-9]+(-[a-z0-9]+)*$/;

export type FoldersAddress = { room: string | null; path: string };

const isDrawer = (name: string) => (DRAWER_NAMES as readonly string[]).includes(name);

/** Whether a name at the root of a room folder is an order (the server's rule: the order format, not a drawer). */
export const isOrderName = (name: string): boolean => ORDER_NAME.test(name) && !isDrawer(name);

/** A relative path as the page keeps it: "/" between segments, no empty or "." segment; "" for anything that climbs out or is absolute. */
export function cleanPath(raw: string): string {
  if (/^[a-zA-Z]:/.test(raw) || raw.startsWith("/") || raw.startsWith("\\")) return "";
  const segments = raw.split(/[\\/]+/).filter((segment) => segment !== "" && segment !== ".");
  return segments.includes("..") ? "" : segments.join("/");
}

/** The room and the place in its folder an address opens; a room that is not a room name opens none. */
export function addressFromParams(params: { get(name: string): string | null }): FoldersAddress {
  const room = params.get(ROOM_PARAM);
  const okRoom = room !== null && ROOM_NAME.test(room) ? room : null;
  return { room: okRoom, path: okRoom ? cleanPath(params.get(PATH_PARAM) ?? "") : "" };
}

/** The address of a place: `/dossiers?salle=<room>&chemin=<path>`, `chemin` left out at the room folder. */
export function foldersHref(address: FoldersAddress): string {
  const params = new URLSearchParams();
  if (address.room) params.set(ROOM_PARAM, address.room);
  if (address.room && address.path) params.set(PATH_PARAM, address.path);
  const text = params.toString();
  return text === "" ? FOLDERS_PATH : `${FOLDERS_PATH}?${text}`;
}

/** The page at the place MyHQ filed an item (`filedPath` is relative to the root: `<room>/<path>`); null for a path it cannot be. */
export function filedHref(filedPath: string): string | null {
  const [room, ...rest] = filedPath.split("/");
  if (!room || !ROOM_NAME.test(room)) return null;
  return foldersHref({ room, path: cleanPath(rest.join("/")) });
}

/** The French name of a drawer. */
export const drawerLabel = (name: string): string => t.drawers[name]?.label ?? name;

/** Whether the segment at `index` of a path stands where drawers stand: the root of the room folder or of an order. */
function atDrawerLevel(segments: readonly string[], index: number): boolean {
  return index === 0 || (index === 1 && isOrderName(segments[0]!));
}

export type Crumb = { label: string; path: string };

/** The trail from the room folder to the place listed, a drawer by its French name. */
export function folderCrumbs(roomLabel: string, path: string): Crumb[] {
  const crumbs: Crumb[] = [{ label: roomLabel, path: "" }];
  const segments = cleanPath(path).split("/").filter((segment) => segment !== "");
  segments.forEach((segment, index) => {
    const label = isDrawer(segment) && atDrawerLevel(segments, index) ? drawerLabel(segment) : segment;
    crumbs.push({ label, path: segments.slice(0, index + 1).join("/") });
  });
  return crumbs;
}

export type EntryGroups = { orders: FolderEntry[]; drawers: FolderEntry[]; folders: FolderEntry[]; files: FolderEntry[] };

/**
 * The entries of a directory, grouped: the orders, newest first (by name,
 * descending), the drawers in the order of the closed list, then the other
 * folders and the files, each in the order given (by name).
 */
export function groupEntries(entries: readonly FolderEntry[]): EntryGroups {
  const orders = entries.filter((entry) => entry.role === "order").sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  const drawers = entries
    .filter((entry) => entry.role === "drawer")
    .sort((a, b) => DRAWER_NAMES.indexOf(a.name as (typeof DRAWER_NAMES)[number]) - DRAWER_NAMES.indexOf(b.name as (typeof DRAWER_NAMES)[number]));
  const rest = entries.filter((entry) => entry.role === null);
  return { orders, drawers, folders: rest.filter((entry) => entry.type === "dir"), files: rest.filter((entry) => entry.type === "file") };
}

/** Where a deposit made in the directory `path` goes: the `recu/` of the room (order null) or of an order; null when `path` is no `recu` drawer. */
export function depositTarget(path: string): { order: string | null } | null {
  const segments = cleanPath(path).split("/");
  if (segments.length === 1 && segments[0] === RECEIVED) return { order: null };
  if (segments.length === 2 && segments[1] === RECEIVED && isOrderName(segments[0]!)) return { order: segments[0]! };
  return null;
}

/** What kind of drawer or folder a directory is, for its empty state. */
export function emptyText(path: string): string {
  if (path === "") return t.empty.room;
  if (depositTarget(path)) return t.empty.recu;
  const segments = path.split("/");
  const last = segments[segments.length - 1]!;
  return isDrawer(last) && atDrawerLevel(segments, segments.length - 1) ? t.empty.drawer : t.empty.folder;
}

/** The slug of the server (room-folders.ts rawSlug): lowercase ASCII, accents stripped, other runs one "-", 60 at most. */
function rawSlug(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
}

/**
 * The name MyHQ will give an order, as openOrder builds it:
 * `<YYYY>-<MM>-<client>-<subject>`, the month of `now` here (the server takes
 * the home's time zone, the same month but around midnight on the first).
 * Null while the client or the subject leaves nothing.
 */
export function orderPreview(client: string, subject: string, now: Date): string | null {
  const who = rawSlug(client);
  const what = rawSlug(subject);
  if (!who || !what) return null;
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${who}-${what}`;
}

const decimal = new Intl.NumberFormat(strings.locale, { maximumFractionDigits: 1 });

/** A size in bytes, as the owner reads it: « 512 o », « 1,5 Ko », « 12 Mo », « 1,2 Go ». */
export function formatSize(bytes: number): string {
  const units = [t.units.b, t.units.kb, t.units.mb, t.units.gb];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown = unit === 0 ? String(Math.round(value)) : decimal.format(value >= 100 ? Math.round(value) : value);
  return `${shown} ${units[unit]}`;
}

/** The address of a file of a room folder; `download`: asks for a download even of a media file. */
export function folderFileUrl(room: string, path: string, download = false): string {
  return `/api/rooms/${encodeURIComponent(room)}/folder/file?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`;
}

/** How a file is shown: in the page for a kind MyHQ knows, a download for anything else. */
export type PreviewKind = NonNullable<FolderEntry["kind"]> | "download";
export const previewKind = (entry: Pick<FolderEntry, "kind">): PreviewKind => entry.kind ?? "download";

/** What is wrong with a deposit before it is sent, in French, or null: the count, an empty file, one over the cap. */
export function depositProblem(
  files: readonly { name: string; size: number }[],
  caps: { maxFiles: number; maxFileBytes: number },
): string | null {
  if (files.length > caps.maxFiles) return t.deposit.tooMany(caps.maxFiles);
  const empty = files.find((file) => file.size === 0);
  if (empty) return t.deposit.emptyFile(empty.name);
  const large = files.find((file) => file.size > caps.maxFileBytes);
  if (large) return t.deposit.tooLarge(large.name, formatSize(caps.maxFileBytes));
  return null;
}
