import fs from "node:fs";
import { Readable } from "node:stream";

/** A byte range of a file, both ends included. */
export type ByteRange = { start: number; end: number };

/**
 * Reads a `Range` header for a file of `size` bytes. Null: no usable range,
 * serve the whole file (no header, another unit, a malformed value).
 * "unsatisfiable": a range that starts past the end (416). Only the first
 * range of a list is served, which is what players ask for.
 */
export function parseRange(header: string | null, size: number): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=\s*(\d*)\s*-\s*(\d*)\s*(?:,.*)?$/i.exec(header.trim());
  if (!match) return null;
  const [, from, to] = match as unknown as [string, string, string];
  if (from === "" && to === "") return null;
  if (from === "") {
    // A suffix: the last N bytes.
    const length = Number(to);
    if (length === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(from);
  if (start >= size) return "unsatisfiable";
  if (to === "") return { start, end: size - 1 };
  const end = Number(to);
  if (end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

/** The policy of a file served as a download only: the browser renders nothing of it, runs no script of it. */
export const SANDBOX_POLICY = "default-src 'none'; sandbox";

/** Quotes a file name for Content-Disposition, ASCII fallback plus the UTF-8 form. */
function disposition(kind: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Serves a stored file: its MIME type, `Accept-Ranges`, and a 206 with
 * `Content-Range` for a range request (what Safari on iOS asks for before it
 * plays or seeks in a video). `etag` is the quoted ETag. `immutable`: the file
 * never changes (the copy of an item made at submission, its sha256 as ETag)
 * and may be cached; otherwise it is revalidated each time (a file of the
 * surveillance room, which the agent may write again). `fd`: a descriptor
 * the caller opened and checked; the file is then read from it, never
 * reopened by its path, and the descriptor is closed with the response.
 */
export function fileResponse(
  request: Request,
  file: { path: string; fd?: number; name: string; mime: string; etag: string; immutable: boolean; download: boolean },
): Response {
  const fd = file.fd;
  const size = fd === undefined ? fs.statSync(file.path).size : fs.fstatSync(fd).size;
  // A response without a body leaves the descriptor unused.
  const done = (response: Response) => {
    if (fd !== undefined) fs.closeSync(fd);
    return response;
  };
  const headers: Record<string, string> = {
    "Content-Type": file.mime,
    "Accept-Ranges": "bytes",
    "Cache-Control": file.immutable ? "private, max-age=31536000, immutable" : "private, no-cache",
    "Content-Disposition": disposition(file.download ? "attachment" : "inline", file.name),
    "X-Content-Type-Options": "nosniff",
    ETag: file.etag,
  };
  const head = request.method === "HEAD";
  if (request.headers.get("if-none-match") === headers.ETag) return done(new Response(null, { status: 304, headers }));
  const range = parseRange(request.headers.get("range"), size);
  if (range === "unsatisfiable") {
    return done(new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } }));
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  const length = size === 0 ? 0 : end - start + 1;
  const out: Record<string, string> = { ...headers, "Content-Length": String(length) };
  if (range) out["Content-Range"] = `bytes ${start}-${end}/${size}`;
  const status = range ? 206 : 200;
  if (head || length === 0) return done(new Response(null, { status, headers: out }));
  const source = fd === undefined ? fs.createReadStream(file.path, { start, end }) : fs.createReadStream(file.path, { fd, start, end });
  const stream = Readable.toWeb(source) as ReadableStream<Uint8Array>;
  return new Response(stream, { status, headers: out });
}
