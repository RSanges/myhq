// What the desk draws of the files joined to an item: the order, the previews
// of the 3D parts and PDFs, and the quote of a remark made at a given time.

import { strings } from "./strings";
import type { ApprovalFile } from "./schemas";

/** A time in a video or a sound, as a player shows it: 0:12, 4:05, 1:02:03. */
export function formatTimecode(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** The quote of a remark on a video or a sound at `seconds`: « clip-01.mp4 à 0:12 ». */
export function timedQuote(name: string, seconds: number): string {
  return strings.attachments.atTime(name, formatTimecode(seconds));
}

const stem = (name: string) => name.replace(/\.[^.]*$/, "").toLowerCase();

/** A file to show, with the image that previews it (a 3D part or a PDF only). */
export type FileEntry = { file: ApprovalFile; preview: ApprovalFile | null };

/**
 * The files in the order the agent gave, each 3D part or PDF with its preview
 * image: an image of the same name (piece.png for piece.3mf), which is then
 * not shown again on its own.
 */
export function fileEntries(files: readonly ApprovalFile[]): FileEntry[] {
  const previews = new Map<ApprovalFile, ApprovalFile>();
  for (const file of files) {
    if (file.kind !== "model" && file.kind !== "pdf") continue;
    const image = files.find((other) => other.kind === "image" && stem(other.name) === stem(file.name));
    if (image) previews.set(file, image);
  }
  const used = new Set(previews.values());
  return files.filter((file) => !used.has(file)).map((file) => ({ file, preview: previews.get(file) ?? null }));
}
