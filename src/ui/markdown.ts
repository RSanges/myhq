// A small Markdown parser for approval bodies and chat replies. It produces a
// tree that the React layer renders as elements, so no HTML string is ever
// injected. Supported: headings, paragraphs (line breaks kept), bullet, numbered
// and task lists with nesting, block quotes, fenced code, rules, GFM tables, and
// inline code, bold, italic, http(s) links and escapes. An image is shown as its
// alt text in brackets. Anything else stays plain text; nothing here throws.

export type Inline =
  | { type: "text"; text: string }
  | { type: "br" }
  | { type: "code"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] };

export type Align = "left" | "center" | "right" | null;

/** A list item: its blocks (a paragraph, then maybe nested lists), and its checkbox for a task. */
export type ListItem = { checked: boolean | null; blocks: Block[] };

export type Block =
  | { type: "heading"; level: number; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { type: "quote"; blocks: Block[] }
  | { type: "code"; text: string }
  | { type: "rule" }
  | { type: "table"; align: Align[]; header: Inline[][]; rows: Inline[][][] };

export function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

// Alternatives, in order: an escape, code, an image, bold italic, bold, italic, a link.
const INLINE = new RegExp(
  [
    /\\([\\`*_{}[\]()#+\-.!|>~<])/,
    /`([^`]+)`/,
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/,
    /\*\*\*(?=\S)(.+?)(?<=\S)\*\*\*/,
    /\*\*(?=\S)(.+?)(?<=\S)\*\*/,
    /\*([^*\s](?:[^*]*[^*\s])?)\*/,
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/,
  ]
    .map((alternative) => alternative.source)
    .join("|"),
  "g",
);

function pushText(out: Inline[], text: string): void {
  if (text === "") return;
  const last = out[out.length - 1];
  if (last?.type === "text") last.text += text;
  else out.push({ type: "text", text });
}

export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  const pattern = new RegExp(INLINE.source, "g");
  let from = 0;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    pushText(out, source.slice(from, match.index));
    from = match.index + match[0].length;
    if (match[1] !== undefined) {
      pushText(out, match[1]);
    } else if (match[2] !== undefined) {
      out.push({ type: "code", text: match[2] });
    } else if (match[4] !== undefined) {
      // An image is not rendered: its alt text stands in, in brackets.
      pushText(out, `[${match[3] === "" ? "image" : match[3]}]`);
    } else if (match[5] !== undefined) {
      out.push({ type: "strong", children: [{ type: "em", children: parseInline(match[5]) }] });
    } else if (match[6] !== undefined) {
      out.push({ type: "strong", children: parseInline(match[6]) });
    } else if (match[7] !== undefined) {
      out.push({ type: "em", children: parseInline(match[7]) });
    } else {
      const href = safeHref(match[9]!);
      if (href) out.push({ type: "link", href, children: parseInline(match[8]!) });
      else pushText(out, match[0]);
    }
  }
  pushText(out, source.slice(from));
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

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const MARKER = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const DELIMITER_CELL = /^:?-+:?$/;
/** Nesting (lists in quotes in lists...) is cut here: deeper content is plain paragraphs. */
const MAX_DEPTH = 12;

const indentOf = (line: string): number => /^\s*/.exec(line)![0].length;

/** The cells of a table row: edge pipes dropped, split on pipes that are not escaped. */
function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < row.length; i++) {
    if (row[i] === "\\" && row[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (row[i] === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += row[i];
    }
  }
  cells.push(cell.trim());
  return cells;
}

/** The alignment of each column when `line` is a table's delimiter row, else null. */
function delimiterRow(line: string): Align[] | null {
  if (!line.includes("|") || !line.includes("-")) return null;
  const cells = splitRow(line);
  if (!cells.every((cell) => DELIMITER_CELL.test(cell))) return null;
  return cells.map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    return left && right ? "center" : right ? "right" : left ? "left" : null;
  });
}

/** True when `lines[at]` is a table's header row: it has a pipe and a matching delimiter row follows. */
function startsTable(lines: string[], at: number): boolean {
  const line = lines[at]!;
  const next = lines[at + 1];
  if (next === undefined || !line.includes("|")) return false;
  const align = delimiterRow(next);
  return align !== null && align.length === splitRow(line).length;
}

type Marker = { indent: number; ordered: boolean; number: number; first: string };

function markerOf(line: string): Marker | null {
  if (RULE.test(line)) return null;
  const match = MARKER.exec(line);
  if (!match) return null;
  const token = match[2]!;
  const ordered = /\d/.test(token);
  return { indent: match[1]!.length, ordered, number: ordered ? Number.parseInt(token, 10) : 0, first: match[3]! };
}

function parseBlocks(lines: string[], depth: number): Block[] {
  const blocks: Block[] = [];
  const nested = depth < MAX_DEPTH;
  const startsBlock = (at: number): boolean => {
    const line = lines[at]!;
    return (
      FENCE.test(line) ||
      HEADING.test(line) ||
      RULE.test(line) ||
      (nested && (markerOf(line) !== null || QUOTE.test(line))) ||
      startsTable(lines, at)
    );
  };
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const marker = nested ? markerOf(line) : null;
    if (line.trim() === "") {
      i++;
    } else if (FENCE.test(line)) {
      const fence = FENCE.exec(line)![1]!;
      const closing = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`);
      const code: string[] = [];
      i++;
      while (i < lines.length && !closing.test(lines[i]!)) code.push(lines[i++]!);
      i++; // closing fence (or end of input)
      blocks.push({ type: "code", text: code.join("\n") });
    } else if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      i++;
    } else if (HEADING.test(line)) {
      const match = HEADING.exec(line)!;
      blocks.push({ type: "heading", level: match[1]!.length, children: parseInline(match[2]!) });
      i++;
    } else if (marker) {
      const items: ListItem[] = [];
      for (let current: Marker | null = marker; current && current.ordered === marker.ordered && current.indent <= marker.indent; ) {
        // The item: its first line, then the lines indented deeper than its marker (blank lines too, when more of them follow).
        const content = [current.first];
        const body: string[] = [];
        i++;
        while (i < lines.length) {
          const next = lines[i]!;
          if (next.trim() === "") {
            let ahead = i;
            while (ahead < lines.length && lines[ahead]!.trim() === "") ahead++;
            if (ahead < lines.length && indentOf(lines[ahead]!) > marker.indent) {
              body.push(...lines.slice(i, ahead));
              i = ahead;
              continue;
            }
            break;
          }
          if (indentOf(next) <= marker.indent) break;
          body.push(next);
          i++;
        }
        const strip = Math.min(...body.filter((l) => l.trim() !== "").map(indentOf), Infinity);
        content.push(...body.map((l) => (l.trim() === "" ? "" : l.slice(strip))));
        const task = /^\[([ xX])\](?:\s+|$)(.*)$/.exec(content[0]!);
        if (task) content[0] = task[2]!;
        items.push({ checked: task ? task[1] !== " " : null, blocks: parseBlocks(content, depth + 1) });
        // The list goes on at the next marker (a blank line may come first), of the same kind.
        let ahead = i;
        while (ahead < lines.length && lines[ahead]!.trim() === "") ahead++;
        current = ahead < lines.length ? markerOf(lines[ahead]!) : null;
        if (current && current.ordered === marker.ordered && current.indent <= marker.indent) i = ahead;
      }
      blocks.push({ type: "list", ordered: marker.ordered, start: marker.ordered ? marker.number : 1, items });
    } else if (nested && QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) quoted.push(QUOTE.exec(lines[i++]!)![1]!);
      blocks.push({ type: "quote", blocks: parseBlocks(quoted, depth + 1) });
    } else if (startsTable(lines, i)) {
      const header = splitRow(line);
      const align = delimiterRow(lines[i + 1]!)!;
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i]!.trim() !== "" && lines[i]!.includes("|") && !FENCE.test(lines[i]!) && !HEADING.test(lines[i]!) && !QUOTE.test(lines[i]!)) {
        const cells = splitRow(lines[i++]!);
        rows.push(header.map((_, column) => parseInline(cells[column] ?? "")));
      }
      blocks.push({ type: "table", align, header: header.map((cell) => parseInline(cell)), rows });
    } else {
      const paragraph: string[] = [];
      while (i < lines.length && lines[i]!.trim() !== "" && (paragraph.length === 0 || !startsBlock(i))) {
        paragraph.push(lines[i++]!);
      }
      blocks.push({ type: "paragraph", children: inlineLines(paragraph) });
    }
  }
  return blocks;
}

export function parseMarkdown(source: string): Block[] {
  return parseBlocks(source.replace(/\r\n?/g, "\n").replace(/^\t+/gm, (tabs) => "    ".repeat(tabs.length)).split("\n"), 0);
}
