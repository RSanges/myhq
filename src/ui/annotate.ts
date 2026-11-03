// Helpers of the annotations on an approval's body. The body is rendered from
// Markdown, so a passage is identified in the *rendered text*: the text nodes of
// the rendered body, in order, with a "\n" after each block, each list item and
// each line break (the renderer emits them as text nodes of their own, so the
// model below and the DOM agree character for character).

import type { Annotation } from "@/server/annotations";
import type { Block, Inline } from "./markdown";

function inlineText(nodes: Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
        case "code":
          return node.text;
        case "br":
          return "\n";
        case "strong":
        case "em":
        case "link":
          return inlineText(node.children);
      }
    })
    .join("");
}

/** The text of a rendered body: what a selection can quote. */
export function plainText(blocks: Block[]): string {
  return blocks
    .map((block) => {
      switch (block.type) {
        case "heading":
        case "paragraph":
        case "quote":
          return `${inlineText(block.children)}\n`;
        case "list":
          return block.items.map((item) => `${inlineText(item)}\n`).join("");
        case "code":
          return `${block.text}\n`;
        case "rule":
          return "";
      }
    })
    .join("");
}

export type Span = { start: number; end: number };

/**
 * Where each quote sits in the text, or null when it is not there. A quote with
 * a `position` is found there, or at the occurrence nearest to it; a quote
 * without one takes its first occurrence that no other annotation has taken, so
 * that the same words quoted twice map to two different passages.
 */
export function locateQuotes(text: string, items: readonly Pick<Annotation, "quote" | "position">[]): (Span | null)[] {
  const result: (Span | null)[] = items.map(() => null);
  const taken = new Set<number>();
  const claim = (index: number, start: number) => {
    taken.add(start);
    result[index] = { start, end: start + items[index]!.quote.length };
  };
  items.forEach((item, index) => {
    if (item.position === undefined) return;
    if (text.startsWith(item.quote, item.position) && !taken.has(item.position)) {
      claim(index, item.position);
      return;
    }
    let best: number | null = null;
    for (let at = text.indexOf(item.quote); at !== -1; at = text.indexOf(item.quote, at + 1)) {
      if (taken.has(at)) continue;
      if (best === null || Math.abs(at - item.position) < Math.abs(best - item.position)) best = at;
    }
    if (best !== null) claim(index, best);
  });
  items.forEach((item, index) => {
    if (item.position !== undefined || result[index]) return;
    for (let at = text.indexOf(item.quote); at !== -1; at = text.indexOf(item.quote, at + 1)) {
      if (!taken.has(at)) {
        claim(index, at);
        return;
      }
    }
  });
  return result;
}

export type Mark = Span & { id: number; kind: "saved" | "draft" };

/** The marks to draw: sorted, and without overlap (a span that overlaps an earlier one is not drawn). */
export function drawableMarks(marks: readonly Mark[]): Mark[] {
  const sorted = [...marks].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Mark[] = [];
  let until = 0;
  for (const mark of sorted) {
    if (mark.end <= mark.start || mark.start < until) continue;
    out.push(mark);
    until = mark.end;
  }
  return out;
}

/** The part of `[from, to)` that each mark covers, as `[offset in the piece, length, mark]`. */
export function splitByMarks(from: number, to: number, marks: readonly Mark[]): { text: [number, number]; mark: Mark | null }[] {
  const pieces: { text: [number, number]; mark: Mark | null }[] = [];
  let cursor = from;
  for (const mark of marks) {
    if (mark.end <= cursor || mark.start >= to) continue;
    const start = Math.max(mark.start, cursor);
    const end = Math.min(mark.end, to);
    if (start > cursor) pieces.push({ text: [cursor - from, start - from], mark: null });
    pieces.push({ text: [start - from, end - from], mark });
    cursor = end;
  }
  if (cursor < to) pieces.push({ text: [cursor - from, to - from], mark: null });
  return pieces;
}

/** Inserts an annotation in document order (the order the agent reads them in). */
export function insertAnnotation(list: readonly Annotation[], added: Annotation): Annotation[] {
  const at = list.findIndex((a) => (a.position ?? Infinity) > (added.position ?? Infinity));
  return at === -1 ? [...list, added] : [...list.slice(0, at), added, ...list.slice(at)];
}

/**
 * The quote of a selection, from its offsets in the rendered text: trimmed, at
 * most `max` characters. Null when nothing but blanks is selected.
 */
export function quoteOf(text: string, start: number, end: number, max = 2_000): (Span & { quote: string }) | null {
  let from = start;
  let to = Math.min(end, start + max + 1_000);
  while (from < to && /\s/.test(text[from]!)) from++;
  to = Math.min(to, from + max);
  while (to > from && /\s/.test(text[to - 1]!)) to--;
  return to > from ? { start: from, end: to, quote: text.slice(from, to) } : null;
}

/** Offset in the rendered text of a DOM boundary point, ignoring what the annotation UI adds to the body. */
function offsetAt(root: Element, container: Node, offset: number): number {
  const pre = document.createRange();
  pre.setStart(root, 0);
  pre.setEnd(container, offset);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest("[data-ann-ui]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  let total = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node === container) total += offset;
    else if (pre.intersectsNode(node)) total += node.nodeValue?.length ?? 0;
  }
  return total;
}

/** The selection range as offsets in the rendered text of `root`. Browser only. */
export function rangeOffsets(root: Element, range: Range): Span {
  return { start: offsetAt(root, range.startContainer, range.startOffset), end: offsetAt(root, range.endContainer, range.endOffset) };
}
