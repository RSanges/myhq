// What the desk draws of the files joined to an item: the order, the previews
// of the 3D parts and PDFs, the quote of a remark made at a given time, and the
// point of a remark on a 3D part, an image or a video's frame (where a click
// falls in the picture, its quote, when its pin shows). Nothing here loads
// three.js.

import { formatTimecode, percent, type AnnotationPoint, type ImagePoint, type ModelPoint, type VideoPoint } from "@/server/annotations";
import { strings } from "./strings";
import type { ApprovalFile } from "./schemas";

export { formatTimecode };

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
export function roundPoint(fileId: number, point: Vec, normal: Vec): ModelPoint {
  const length = Math.hypot(normal.x, normal.y, normal.z) || 1;
  const n = (value: number) => Math.max(-1, Math.min(1, round(value / length, 0.01)));
  return {
    fileId,
    kind: "model",
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

/**
 * The quote of a remark on a point: on a part « piece.3mf, point (12,4 ; -3,0 ;
 * 8,5) mm, face +Z », on an image « cover.png, point à 62 % de la largeur et
 * 18 % de la hauteur », on a video « clip-01.mp4 à 0:12, point à 40 % ; 70 % ».
 */
export function pointQuote(name: string, point: AnnotationPoint): string {
  if (point.kind === "image") return strings.attachments.atImagePoint(name, percent(point.x), percent(point.y));
  if (point.kind === "video") return strings.attachments.atVideoPoint(name, formatTimecode(point.t), percent(point.x), percent(point.y));
  return strings.attachments.atPoint(name, [point.x, point.y, point.z].map(formatMm).join(" ; "), faceLabel(point.normal));
}

type Size = { width: number; height: number };
export type Box = Size & { left: number; top: number };

/**
 * Where a picture of `natural` size is drawn in a box of `box` size when it is
 * fitted whole and centred (`object-fit: contain`, what a video does): the
 * bands beside or above it are empty. Before the picture is known, the box.
 */
export function containBox(box: Size, natural: Size | null): Box {
  if (!natural || natural.width <= 0 || natural.height <= 0 || box.width <= 0 || box.height <= 0) {
    return { left: 0, top: 0, width: Math.max(0, box.width), height: Math.max(0, box.height) };
  }
  const scale = Math.min(box.width / natural.width, box.height / natural.height);
  const width = natural.width * scale;
  const height = natural.height * scale;
  return { left: (box.width - width) / 2, top: (box.height - height) / 2, width, height };
}

/** A share of the picture, kept to the thousandth (a tenth of a percent). */
const share = (value: number) => round(Math.max(0, Math.min(1, value)), 0.001);

/**
 * Where a click at (`x`, `y`) falls in a picture drawn at `drawn` (both in the
 * same pixels, the page's): from its left and top edges, as shares of its width
 * and height, so the same spot of the picture gives the same point at any size
 * it is shown. Null outside the picture (a band of a video, the border).
 */
export function pointInPicture(x: number, y: number, drawn: Box): { x: number; y: number } | null {
  if (drawn.width <= 0 || drawn.height <= 0) return null;
  const across = (x - drawn.left) / drawn.width;
  const down = (y - drawn.top) / drawn.height;
  if (across < 0 || across > 1 || down < 0 || down > 1) return null;
  return { x: share(across), y: share(down) };
}

export function imagePoint(fileId: number, at: { x: number; y: number }): ImagePoint {
  return { fileId, kind: "image", x: share(at.x), y: share(at.y) };
}

/** A point of a video's frame at `seconds`, the time kept to the millisecond. */
export function videoPoint(fileId: number, at: { x: number; y: number }, seconds: number): VideoPoint {
  return { fileId, kind: "video", x: share(at.x), y: share(at.y), t: round(Math.max(0, seconds), 0.001) };
}

/** How near the playback must be to a pin's time for the pin to show, in seconds. */
export const PIN_TIME_WINDOW = 0.5;

/** Whether the pin of a video remark at `t` shows when the video is at `current`. */
export function pinShownAt(t: number, current: number): boolean {
  return Math.abs(current - t) < PIN_TIME_WINDOW;
}

/** The overall dimensions of a part, X by Y by Z: « 42,0 × 18,5 × 12,0 mm ». */
export function dimensionsText(size: Vec): string {
  return strings.attachments.dimensions([size.x, size.y, size.z].map(formatMm).join(" × "));
}

/** The frame of the 3D viewer, shared by its placeholder (attachments.tsx) and the viewer (model-viewer.tsx). */
export const MODEL_FRAME_CLASS =
  "relative aspect-[4/3] max-h-[70vh] w-full overflow-hidden rounded-md border border-line bg-soft sm:aspect-[16/10]";
