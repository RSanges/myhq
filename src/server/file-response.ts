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

/** Quotes a file name for Content-Disposition, ASCII fallback plus the UTF-8 form. */
function disposition(kind: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Serves a stored file: its MIME type, `Accept-Ranges`, and a 206 with
 * `Content-Range` for a range request (what Safari on iOS asks for before it
 * plays or seeks in a video). The file is the copy made at submission, which
 * never changes: its sha256 is the ETag and the copy can be cached.
 */
export function fileResponse(
  request: Request,
  file: { path: string; name: string; mime: string; sha256: string; download: boolean },
): Response {
  const size = fs.statSync(file.path).size;
  const headers: Record<string, string> = {
    "Content-Type": file.mime,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=31536000, immutable",
    "Content-Disposition": disposition(file.download ? "attachment" : "inline", file.name),
    "X-Content-Type-Options": "nosniff",
    ETag: `"${file.sha256}"`,
  };
  const head = request.method === "HEAD";
  if (request.headers.get("if-none-match") === headers.ETag) return new Response(null, { status: 304, headers });
  const range = parseRange(request.headers.get("range"), size);
  if (range === "unsatisfiable") {
    return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  const length = size === 0 ? 0 : end - start + 1;
  const out: Record<string, string> = { ...headers, "Content-Length": String(length) };
  if (range) out["Content-Range"] = `bytes ${start}-${end}/${size}`;
  const status = range ? 206 : 200;
  if (head || length === 0) return new Response(null, { status, headers: out });
  const stream = Readable.toWeb(fs.createReadStream(file.path, { start, end })) as ReadableStream<Uint8Array>;
  return new Response(stream, { status, headers: out });
}
