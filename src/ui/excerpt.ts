import { parseMarkdown, type Block, type Inline } from "./markdown";

// The one-line excerpt of a folded item on the desk: the first meaningful line
// of its Markdown body, with the Markdown stripped, cut around 120 characters.
// It reads the same tree the body is rendered from, so what the line shows is
// what the unfolded item shows. Pure: no DOM, nothing here throws.

export const EXCERPT_LENGTH = 120;

/** The text of inline nodes, up to the first line break. */
function inlineLine(nodes: readonly Inline[]): string {
  let text = "";
  for (const node of nodes) {
    if (node.type === "br") break;
    text += node.type === "text" || node.type === "code" ? node.text : inlineLine(node.children);
  }
  return text;
}

const clean = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Whether a line only says again what `skip` (the item's title) says: same words, whatever the case or the closing punctuation. */
function sameAs(line: string, skip: string): boolean {
  const normal = (text: string) => clean(text).replace(/[\s.:!?]+$/u, "").toLowerCase();
  return skip !== "" && normal(line) === normal(skip);
}

/** The first non-empty line of a block that is not `skip`, null for a block that holds none (a rule, an empty list). */
function blockLine(block: Block, skip: string): string | null {
  switch (block.type) {
    case "heading":
    case "paragraph": {
      const line = clean(inlineLine(block.children));
      return line !== "" && !sameAs(line, skip) ? line : null;
    }
    case "code":
      return block.text.split("\n").map(clean).find((line) => line !== "") ?? null;
    case "rule":
      return null;
    case "quote":
      return firstLine(block.blocks, skip);
    case "list":
      for (const item of block.items) {
        const line = firstLine(item.blocks, skip);
        if (line) return line;
      }
      return null;
    case "table": {
      const cells = block.header.map((cell) => clean(inlineLine(cell))).filter((cell) => cell !== "");
      return cells.length > 0 ? cells.join(" · ") : null;
    }
  }
}

function firstLine(blocks: readonly Block[], skip: string): string | null {
  for (const block of blocks) {
    const line = blockLine(block, skip);
    if (line) return line;
  }
  return null;
}

/** `text` cut at `max` characters on a word boundary when one is close enough, then "...". */
export function cutLine(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const space = head.lastIndexOf(" ");
  return `${(space >= max * 0.6 ? head.slice(0, space) : head).trimEnd()}...`;
}

/**
 * The first meaningful line of a Markdown body, stripped of its Markdown and
 * cut around `max` characters. A line that only repeats `title` (a body that
 * opens with its own title as a heading) is passed over, since the folded line
 * shows the title already. Empty when the body has no line left.
 */
export function excerpt(body: string, title = "", max: number = EXCERPT_LENGTH): string {
  return cutLine(firstLine(parseMarkdown(body), title) ?? "", max);
}
