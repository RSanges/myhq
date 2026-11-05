// What the desk draws of the files joined to an item: the order, the previews
// of the 3D parts and PDFs, the quote of a remark made at a given time, and the
// quote of a remark on a point of a 3D part. Nothing here loads three.js.

import type { AnnotationPoint } from "@/server/annotations";
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

/** The 3D formats the desk's viewer reads, from the extension of a file. */
export type ModelFormat = "3mf" | "stl" | "glb";

export function modelFormat(name: string): ModelFormat | null {
  const ext = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase();
  return ext === "3mf" || ext === "stl" || ext === "glb" ? ext : null;
}

/** A length in millimetres as the desk writes it: to the tenth, with a decimal comma, never "-0,0". */
export function formatMm(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return (rounded === 0 ? 0 : rounded).toFixed(1).replace(".", ",");
}

type Vec = { x: number; y: number; z: number };

const round = (value: number, step: number) => {
  const rounded = Math.round(value / step) * step;
  return rounded === 0 ? 0 : Number(rounded.toFixed(6));
};

/**
 * A point hit on a part, as a remark stores it: in the part's frame, the
 * coordinates to the tenth of a millimetre, the normal made unit then rounded
 * to the hundredth.
 */
export function roundPoint(fileId: number, point: Vec, normal: Vec): AnnotationPoint {
  const length = Math.hypot(normal.x, normal.y, normal.z) || 1;
  const n = (value: number) => Math.max(-1, Math.min(1, round(value / length, 0.01)));
  return {
    fileId,
    x: round(point.x, 0.1),
    y: round(point.y, 0.1),
    z: round(point.z, 0.1),
    normal: [n(normal.x), n(normal.y), n(normal.z)],
  };
}

/** The face of a normal: « face +Z » when it is along an axis (within 5 degrees), else the normal itself. */
export function faceLabel(normal: readonly [number, number, number]): string {
  const axes = ["X", "Y", "Z"] as const;
  const length = Math.hypot(...normal) || 1;
  const along = normal.findIndex((value) => Math.abs(value / length) >= Math.cos((5 * Math.PI) / 180));
  if (along !== -1) return strings.attachments.face(`${normal[along]! > 0 ? "+" : "-"}${axes[along]}`);
  const two = (value: number) => {
    const rounded = Math.round((value / length) * 100) / 100;
    return (rounded === 0 ? 0 : rounded).toFixed(2).replace(".", ",");
  };
  return strings.attachments.tiltedFace(normal.map(two).join(" ; "));
}

/** The quote of a remark on a point of a part: « piece.3mf, point (12,4 ; -3,0 ; 8,5) mm, face +Z ». */
export function pointQuote(name: string, point: AnnotationPoint): string {
  return strings.attachments.atPoint(name, [point.x, point.y, point.z].map(formatMm).join(" ; "), faceLabel(point.normal));
}

/** The overall dimensions of a part, X by Y by Z: « 42,0 × 18,5 × 12,0 mm ». */
export function dimensionsText(size: Vec): string {
  return strings.attachments.dimensions([size.x, size.y, size.z].map(formatMm).join(" × "));
}

/** The frame of the 3D viewer, shared by its placeholder (attachments.tsx) and the viewer (model-viewer.tsx). */
export const MODEL_FRAME_CLASS =
  "relative aspect-[4/3] max-h-[70vh] w-full overflow-hidden rounded-md border border-line bg-soft sm:aspect-[16/10]";
