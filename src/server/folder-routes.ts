import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { app } from "./app";
import { attachmentMaxBytes, attachmentType } from "./attachments";
import { liveConfig, type HqConfig } from "./config";
import { errorResponse, HqError, readJsonRequest } from "./errors";
import { fileResponse } from "./file-response";
import {
  listRoomFolder,
  orderNameSchema,
  RECEIVED,
  openOrder,
  realRoomFolder,
  resolveRoomFile,
  roomFolder,
  RoomFolderError,
  roomFoldersRoot,
  saveReceived,
  type RoomFolderEntry,
} from "./room-folders";
import { idSchema, loadHome, type Room } from "./rooms";

// The answers of the room folder routes (src/app/api/rooms/[room]/folder),
// apart from the route files so that tests can call them: a route only awaits
// `connection()` first. The owner browses the folder of a room, downloads its
// files, opens orders and drops files into a `recu/` drawer. See docs/api.md.

/** At most this many files in one deposit. */
export const MAX_RECEIVED_FILES = 20;
/** Room for the multipart boundaries and headers on top of the files, in a deposit's Content-Length. */
const MULTIPART_OVERHEAD = 1024 * 1024;

const pathSchema = z.string().max(1_000);
const orderBodySchema = z.strictObject({
  client: z.string().trim().min(1).max(200),
  subject: z.string().trim().min(1).max(200),
});

export type FolderListing = {
  room: string;
  /** The directory listed, relative to the room folder, with "/" ("" for the room folder). */
  path: string;
  /** Its absolute path on the machine (« Copier le chemin »). */
  location: string;
  /** Whether the room takes orders (room.json `orders`). */
  orders: boolean;
  /** The file the address pointed at, relative to the room folder, when it was a file: its directory is listed. */
  file: string | null;
  entries: RoomFolderEntry[];
  /** The caps of a deposit into a `recu/` drawer. */
  deposit: { maxFiles: number; maxFileBytes: number };
};

/** A RoomFolderError is the owner's input refused: a 400 with its message. */
function folderError(error: unknown): unknown {
  return error instanceof RoomFolderError ? new HqError("FOLDER_PATH_INVALID", 400, error.message) : error;
}

/** The room of the home of that name (not archived), else ROOM_NOT_FOUND (404). */
function knownRoom(config: HqConfig, raw: string): Room {
  const name = idSchema.safeParse(raw);
  const room = name.success ? loadHome(config.home).rooms.find((each) => each.name === name.data) : undefined;
  if (!room) throw new HqError("ROOM_NOT_FOUND", 404, `No room "${raw}" in the home.`);
  return room;
}

const toPosix = (p: string) => p.split(path.sep).join("/");

/**
 * GET /api/rooms/<room>/folder?path=<relative>: the entries of a directory of
 * the room folder (`path` empty: the folder itself). The room folder and its
 * `recu/` are created on the first listing, so that the owner can drop files
 * before any run. A path that names a file lists its directory, with `file`.
 */
export function folderListingResponse(request: Request, rawRoom: string): Response {
  try {
    const { config } = app();
    const room = knownRoom(config, rawRoom);
    const raw = pathSchema.parse(new URL(request.url).searchParams.get("path") ?? "");
    const root = roomFoldersRoot(config.home);
    try {
      if (realRoomFolder(root, room.name) === null) fs.mkdirSync(path.join(roomFolder(root, room.name), RECEIVED), { recursive: true });
      const top = realRoomFolder(root, room.name)!;
      let dir = raw;
      let file: string | null = null;
      if (raw !== "" && raw !== ".") {
        let real: string | null = null;
        try {
          real = resolveRoomFile(root, room.name, raw);
        } catch (error) {
          if (!(error instanceof RoomFolderError)) throw error;
        }
        if (real !== null) {
          file = toPosix(path.relative(top, real));
          dir = path.posix.dirname(file) === "." ? "" : path.posix.dirname(file);
        }
      }
      const entries = listRoomFolder(root, room.name, dir);
      const base = dir === "" || dir === "." ? "" : toPosix(path.relative(top, fs.realpathSync(path.resolve(top, dir))));
      const body: FolderListing = {
        room: room.name,
        path: base,
        location: base === "" ? top : path.join(top, ...base.split("/")),
        orders: room.orders === true,
        file,
        entries,
        deposit: { maxFiles: MAX_RECEIVED_FILES, maxFileBytes: attachmentMaxBytes(process.env) },
      };
      return Response.json(body);
    } catch (error) {
      throw folderError(error);
    }
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * GET and HEAD /api/rooms/<room>/folder/file?path=<relative>: one file of the
 * room folder, with range requests. A file of a known attachment kind
 * (video, image, sound, PDF, 3D model) is served with its MIME type, inline
 * unless `download=1`; any other file only as a download
 * (application/octet-stream, attachment, a sandbox policy), so that the
 * browser never renders an SVG or an HTML page from the folder. Weak ETag:
 * the file may change.
 */
export function folderFileResponse(request: Request, rawRoom: string): Response {
  try {
    const { config } = app();
    const room = knownRoom(config, rawRoom);
    const params = new URL(request.url).searchParams;
    const raw = pathSchema.min(1).parse(params.get("path") ?? "");
    const root = roomFoldersRoot(config.home);
    let real: string;
    try {
      real = resolveRoomFile(root, room.name, raw);
    } catch (error) {
      if (error instanceof RoomFolderError) throw new HqError("FILE_NOT_FOUND", 404, error.message);
      throw error;
    }
    const stat = fs.statSync(real);
    const name = path.basename(real);
    const known = attachmentType(name);
    const response = fileResponse(request, {
      path: real,
      name,
      mime: known?.mime ?? "application/octet-stream",
      etag: `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`,
      immutable: false,
      download: known === null || params.get("download") === "1",
    });
    if (known === null) response.headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}

/** The room takes orders, else ORDERS_NOT_TAKEN (409). */
function assertTakesOrders(room: Room): void {
  if (room.orders !== true) {
    throw new HqError("ORDERS_NOT_TAKEN", 409, `Room "${room.name}" takes no orders (room.json "orders").`);
  }
}

/**
 * POST /api/rooms/<room>/folder/orders, JSON `{ client, subject }`: opens an
 * order (`<YYYY>-<MM>-<client>-<subject>`, the month in the home's time zone)
 * with its `recu/`. 201 when it was created, 200 when it was already there.
 */
export async function openOrderResponse(request: Request, rawRoom: string): Promise<Response> {
  try {
    const { config } = app();
    const room = knownRoom(config, rawRoom);
    const body = orderBodySchema.parse(await readJsonRequest(request));
    assertTakesOrders(room);
    const root = roomFoldersRoot(config.home);
    try {
      const { order, created } = openOrder(root, room.name, body.client, body.subject, new Date(), liveConfig(config).timeZone);
      return Response.json({ order, created, path: `${room.name}/${order}` }, { status: created ? 201 : 200 });
    } catch (error) {
      throw folderError(error);
    }
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * A request another site's page sent: the browser says so (`Sec-Fetch-Site`),
 * or its `Origin` is not this host. A plain form of another site can post a
 * multipart body without asking first, so a deposit checks it (403).
 */
function assertSameSite(request: Request): void {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") {
    throw new HqError("CROSS_SITE", 403, "A deposit is accepted from the pages of MyHQ only.");
  }
  const origin = request.headers.get("origin");
  if (origin !== null) {
    let host: string | null = null;
    try {
      host = new URL(origin).host;
    } catch {
      host = null;
    }
    if (host === null || host !== (request.headers.get("host") ?? new URL(request.url).host)) {
      throw new HqError("CROSS_SITE", 403, "A deposit is accepted from the pages of MyHQ only.");
    }
  }
}

/**
 * POST /api/rooms/<room>/folder/received, multipart: one or several `file`
 * parts (at most 20, each non empty and at most the attachment cap) and an
 * optional `order`. Each file is written into the `recu/` of the room, or of
 * that order, under a neutralised free name (saveReceived). Every file is
 * checked before any is written. A body without a readable Content-Length is
 * refused (411), one declared over the caps too (413), before it is read.
 * 201 `{ room, order, saved }`, the saved paths relative to the room folder.
 */
export async function receivedResponse(request: Request, rawRoom: string): Promise<Response> {
  try {
    assertSameSite(request);
    const { config } = app();
    const room = knownRoom(config, rawRoom);
    const type = request.headers.get("content-type") ?? "";
    if (!/^\s*multipart\/form-data\s*;/i.test(type)) {
      throw new HqError("UNSUPPORTED_MEDIA_TYPE", 415, "Send the files as multipart/form-data.");
    }
    const maxBytes = attachmentMaxBytes(process.env);
    // The size cap applies before the body is read: a deposit without a readable Content-Length is refused (browsers always send it).
    const length = request.headers.get("content-length")?.trim() ?? "";
    const declared = /^[0-9]+$/.test(length) ? Number(length) : NaN;
    if (!Number.isSafeInteger(declared)) {
      throw new HqError("LENGTH_REQUIRED", 411, "Send the deposit with its Content-Length, a number of bytes.");
    }
    if (declared > MAX_RECEIVED_FILES * maxBytes + MULTIPART_OVERHEAD) {
      throw new HqError("FILE_TOO_LARGE", 413, `A deposit holds at most ${MAX_RECEIVED_FILES} files of ${maxBytes} bytes each.`);
    }
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new HqError("INVALID_INPUT", 400, "The body is not a readable multipart form.");
    }
    const rawOrder = form.get("order");
    if (rawOrder !== null && typeof rawOrder !== "string") throw new HqError("INVALID_INPUT", 400, "order: a text field.");
    const order = rawOrder === null || rawOrder.trim() === "" ? null : orderNameSchema.parse(rawOrder.trim());
    if (order !== null) assertTakesOrders(room);
    const files = form.getAll("file");
    if (files.length === 0) throw new HqError("NO_FILE", 400, "Join at least one file (field \"file\").");
    if (files.length > MAX_RECEIVED_FILES) {
      throw new HqError("TOO_MANY_FILES", 400, `At most ${MAX_RECEIVED_FILES} files per deposit (${files.length} given).`);
    }
    const checked = files.map((file) => {
      if (typeof file === "string") throw new HqError("INVALID_INPUT", 400, "file: a file part, not a text field.");
      if (file.size === 0) throw new HqError("EMPTY_FILE", 400, `"${file.name}" is empty.`);
      if (file.size > maxBytes) throw new HqError("FILE_TOO_LARGE", 413, `"${file.name}" is over ${maxBytes} bytes.`);
      return file;
    });
    const root = roomFoldersRoot(config.home);
    const saved: string[] = [];
    try {
      for (const file of checked) saved.push(saveReceived(root, room.name, order, file.name, Buffer.from(await file.arrayBuffer())));
    } catch (error) {
      throw folderError(error);
    }
    return Response.json({ room: room.name, order, saved }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
