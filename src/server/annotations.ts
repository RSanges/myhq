import { z } from "zod";
import { strings } from "../ui/strings";

/** Longest quote kept in the text an agent reads, in characters. */
export const QUOTE_TEXT_MAX = 200;

const coordinate = z.number().min(-1_000_000).max(1_000_000);
const component = z.number().min(-1).max(1);

/**
 * The point of a 3D part a remark is about: the file of the item it was placed
 * on, the point in the frame of the part as its file defines it (millimetres,
 * Z up, see src/ui/model-load.ts) and the outward normal of the face hit.
 */
export const annotationPointSchema = z.strictObject({
  fileId: z.number().int().positive(),
  x: coordinate,
  y: coordinate,
  z: coordinate,
  normal: z.tuple([component, component, component]),
});
export type AnnotationPoint = z.infer<typeof annotationPointSchema>;

/**
 * A remark on a passage of an approval's body: the quoted text (as rendered),
 * the user's comment, and the offset of the quote in the rendered text, which
 * tells apart two passages that read the same. A remark on a point of a 3D
 * part has no `position` but a `point`, and its quote names the file and the
 * point (« piece.3mf, point (12,4 ; -3,0 ; 8,5) mm, face +Z »).
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

/** The line under a remark on a 3D part: the exact point and normal, in the part's frame. */
export function pointText(point: AnnotationPoint): string {
  const [nx, ny, nz] = point.normal.map((n) => fixed(n, 2));
  return strings.annotations.pointLine(fixed(point.x, 1), fixed(point.y, 1), fixed(point.z, 1), `${nx}, ${ny}, ${nz}`);
}

/**
 * What the agent reads of a decision: the numbered annotations (a remark on a
 * 3D part followed by its point), then the general note. Without annotations,
 * the note alone, unchanged (null when there is none).
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
