// A minimal Markdown parser for approval bodies. It produces a small tree that
// the React layer renders as elements, so no HTML string is ever injected.
// Supported: headings, paragraphs (line breaks kept), bullet and numbered lists,
// block quotes, fenced code, rules, and inline code, bold, italic and http(s) links.

export type Inline =
  | { type: "text"; text: string }
  | { type: "br" }
  | { type: "code"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] };

export type Block =
  | { type: "heading"; level: number; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "list"; ordered: boolean; items: Inline[][] }
  | { type: "quote"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "rule" };

export function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|\[([^\]]+)\]\(([^)\s]+)\)/;

export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let rest = source;
  while (rest.length > 0) {
    const match = INLINE.exec(rest);
    if (!match) {
      out.push({ type: "text", text: rest });
      break;
    }
    if (match.index > 0) out.push({ type: "text", text: rest.slice(0, match.index) });
    if (match[1] !== undefined) {
      out.push({ type: "code", text: match[1] });
    } else if (match[2] !== undefined) {
      out.push({ type: "strong", children: parseInline(match[2]) });
    } else if (match[3] !== undefined) {
      out.push({ type: "em", children: parseInline(match[3]) });
    } else {
      const href = safeHref(match[5]!);
      if (href) out.push({ type: "link", href, children: parseInline(match[4]!) });
      else out.push({ type: "text", text: match[0] });
    }
    rest = rest.slice(match.index + match[0].length);
  }
  return out;
}

/** Inline content of several lines, joined with line breaks. */
function inlineLines(lines: string[]): Inline[] {
  const out: Inline[] = [];
  lines.forEach((line, index) => {
    if (index > 0) out.push({ type: "br" });
    out.push(...parseInline(line));
  });
  return out;
}

const FENCE = /^```/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  const startsBlock = (line: string): boolean =>
    FENCE.test(line) ||
    HEADING.test(line) ||
    BULLET.test(line) ||
    NUMBERED.test(line) ||
    QUOTE.test(line) ||
    RULE.test(line);

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
    } else if (FENCE.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i]!)) code.push(lines[i++]!);
      i++; // closing fence (or end of input)
      blocks.push({ type: "code", text: code.join("\n") });
    } else if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      i++;
    } else if (HEADING.test(line)) {
      const match = HEADING.exec(line)!;
      blocks.push({ type: "heading", level: match[1]!.length, children: parseInline(match[2]!) });
      i++;
    } else if (BULLET.test(line) || NUMBERED.test(line)) {
      const ordered = !BULLET.test(line);
      const pattern = ordered ? NUMBERED : BULLET;
      const items: Inline[][] = [];
      while (i < lines.length && pattern.test(lines[i]!)) {
        items.push(parseInline(pattern.exec(lines[i]!)![1]!));
        i++;
      }
      blocks.push({ type: "list", ordered, items });
    } else if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) quoted.push(QUOTE.exec(lines[i++]!)![1]!);
      blocks.push({ type: "quote", children: inlineLines(quoted) });
    } else {
      const paragraph: string[] = [];
      while (i < lines.length && lines[i]!.trim() !== "" && (paragraph.length === 0 || !startsBlock(lines[i]!))) {
        paragraph.push(lines[i++]!);
      }
      blocks.push({ type: "paragraph", children: inlineLines(paragraph) });
    }
  }
  return blocks;
}
