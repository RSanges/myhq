import { z } from "zod";
import { strings } from "../ui/strings";

/** Longest quote kept in the text an agent reads, in characters. */
export const QUOTE_TEXT_MAX = 200;

/**
 * A remark on a passage of an approval's body: the quoted text (as rendered),
 * the user's comment, and the offset of the quote in the rendered text, which
 * tells apart two passages that read the same.
 */
export const annotationSchema = z.strictObject({
  quote: z.string().trim().min(1).max(2_000),
  comment: z.string().trim().min(1).max(2_000),
  position: z.number().int().min(0).optional(),
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

/**
 * What the agent reads of a decision: the numbered annotations, then the
 * general note. Without annotations, the note alone, unchanged (null when
 * there is none).
 */
export function decisionText(note: string | null, annotations: readonly Annotation[]): string | null {
  if (annotations.length === 0) return note;
  const lines = annotations.map(
    (a, index) => `${index + 1}. ${strings.annotations.about(cutQuote(a.quote), a.comment)}`,
  );
  if (note) lines.push("", strings.annotations.generalNote(note));
  return lines.join("\n");
}
