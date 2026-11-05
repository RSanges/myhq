import { z } from "zod";
import { strings } from "../ui/strings";

/** Longest quote kept in the text an agent reads, in characters. */
export const QUOTE_TEXT_MAX = 200;

const coordinate = z.number().min(-1_000_000).max(1_000_000);
const component = z.number().min(-1).max(1);
const fileId = z.number().int().positive();
/** A share of the width or the height of an image, from its left or top edge. */
const fraction = z.number().min(0).max(1);

/**
 * A point of a 3D part: the point in the frame of the part as its file defines
 * it (millimetres, Z up, see src/ui/model-load.ts) and the outward normal of
 * the face hit. `kind` is absent on the pins stored before images and videos
 * had pins of their own; they read as they did.
 */
const modelPointSchema = z.strictObject({
  fileId,
  kind: z.literal("model").optional(),
  x: coordinate,
  y: coordinate,
  z: coordinate,
  normal: z.tuple([component, component, component]),
});

/**
 * A point of an image: x from the left edge, y from the top edge, as shares
 * (0 to 1) of the image's own width and height, whatever size it was shown at.
 */
const imagePointSchema = z.strictObject({ fileId, kind: z.literal("image"), x: fraction, y: fraction });

/** A point of a video's frame at `t` seconds, x and y as on an image. */
const videoPointSchema = z.strictObject({
  fileId,
  kind: z.literal("video"),
  x: fraction,
  y: fraction,
  t: z.number().min(0).max(1_000_000),
});

/** The point of a file joined to the item that a remark is about: on a 3D part, an image or a video's frame. */
export const annotationPointSchema = z.union([imagePointSchema, videoPointSchema, modelPointSchema]);
export type AnnotationPoint = z.infer<typeof annotationPointSchema>;
export type ModelPoint = z.infer<typeof modelPointSchema>;
export type ImagePoint = z.infer<typeof imagePointSchema>;
export type VideoPoint = z.infer<typeof videoPointSchema>;

/**
 * A remark on a passage of an approval's body: the quoted text (as rendered),
 * the user's comment, and the offset of the quote in the rendered text, which
 * tells apart two passages that read the same. A remark on a point of a file
 * (a 3D part, an image, a video's frame) has no `position` but a `point`, and
 * its quote names the file and the point (« piece.3mf, point (12,4 ; -3,0 ;
 * 8,5) mm, face +Z », « cover.png, point à 62 % de la largeur et 18 % de la
 * hauteur », « clip-01.mp4 à 0:12, point à 40 % ; 70 % »).
 */
export const annotationSchema = z.strictObject({
  quote: z.string().trim().min(1).max(2_000),
  comment: z.string().trim().min(1).max(2_000),
  position: z.number().int().min(0).optional(),
  point: annotationPointSchema.optional(),
});
export type Annotation = z.infer<typeof annotationSchema>;

export const MAX_ANNOTATIONS = 30;
export const annotationsSchema = z.array(annotationSchema).max(MAX_ANNOTATIONS);

/** Reads the `annotations` column; an unreadable value counts as none. */
export function parseAnnotations(raw: string | null | undefined): Annotation[] {
  if (!raw) return [];
  try {
    const parsed = annotationsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** The quote as the agent reads it: spaces collapsed, cut at 200 characters. */
export function cutQuote(quote: string): string {
  const flat = quote.replace(/\s+/g, " ").trim();
  return flat.length > QUOTE_TEXT_MAX ? `${flat.slice(0, QUOTE_TEXT_MAX)}…` : flat;
}

/** A number of a point for the agent: fixed decimals, a dot, never "-0.0". */
const fixed = (value: number, digits: number) => {
  const text = value.toFixed(digits);
  return /^-0\.?0*$/.test(text) ? text.slice(1) : text;
};

/** A share of an image as a whole percentage: 0.623 is "62". */
export const percent = (share: number) => String(Math.round(share * 100));

/** A time in a video as a player shows it: 0:12, 4:05, 1:02:03. */
export function formatTimecode(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/**
 * The line under a remark on a point, for the agent: on a 3D part, the exact
 * point and normal in the part's frame; on an image, the point from its left
 * and top edges; on a video, the same with the time (to the hundredth of a
 * second, to extract the frame).
 */
export function pointText(point: AnnotationPoint): string {
  if (point.kind === "image") return strings.annotations.imagePointLine(percent(point.x), percent(point.y));
  if (point.kind === "video") {
    return strings.annotations.videoPointLine(formatTimecode(point.t), fixed(point.t, 2), percent(point.x), percent(point.y));
  }
  const [nx, ny, nz] = point.normal.map((n) => fixed(n, 2));
  return strings.annotations.pointLine(fixed(point.x, 1), fixed(point.y, 1), fixed(point.z, 1), `${nx}, ${ny}, ${nz}`);
}

/**
 * What the agent reads of a decision: the numbered annotations (a remark on a
 * point of a file followed by that point), then the general note. Without
 * annotations, the note alone, unchanged (null when there is none).
 */
export function decisionText(note: string | null, annotations: readonly Annotation[]): string | null {
  if (annotations.length === 0) return note;
  const lines = annotations.flatMap((a, index) => {
    const line = `${index + 1}. ${strings.annotations.about(cutQuote(a.quote), a.comment)}`;
    return a.point ? [line, `   ${pointText(a.point)}`] : [line];
  });
  if (note) lines.push("", strings.annotations.generalNote(note));
  return lines.join("\n");
}
