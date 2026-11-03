import { Fragment, useMemo, type ReactNode, type Ref } from "react";
import { drawableMarks, splitByMarks, type Mark } from "./annotate";
import { parseMarkdown, type Block, type Inline } from "./markdown";

/**
 * Where the render is in the text of the body. The text nodes are emitted in
 * document order, and the separators ("\n" after each block, list item and line
 * break) are text nodes of their own: see annotate.ts, which relies on it.
 */
type Cursor = { pos: number; marks: Mark[]; onMark?: (mark: Mark) => void };

const MARK_CLASS: Record<Mark["kind"], string> = {
  saved: "cursor-pointer rounded-sm bg-warn/25 text-foreground underline decoration-warn decoration-dotted underline-offset-2 [box-decoration-break:clone]",
  draft: "rounded-sm bg-accent-soft text-foreground [box-decoration-break:clone]",
};

function text(value: string, cursor: Cursor): ReactNode {
  const from = cursor.pos;
  cursor.pos += value.length;
  if (cursor.marks.length === 0) return value;
  const pieces = splitByMarks(from, cursor.pos, cursor.marks);
  if (pieces.length === 1 && pieces[0]!.mark === null) return value;
  return pieces.map((piece, index) => {
    const part = value.slice(piece.text[0], piece.text[1]);
    const mark = piece.mark;
    if (!mark) return part;
    return (
      <mark
        key={index}
        data-ann={mark.id}
        data-ann-kind={mark.kind}
        className={MARK_CLASS[mark.kind]}
        onClick={mark.kind === "saved" ? () => cursor.onMark?.(mark) : undefined}
      >
        {part}
      </mark>
    );
  });
}

const separator = (cursor: Cursor): ReactNode => text("\n", cursor);

function renderInline(nodes: Inline[], cursor: Cursor): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return <Fragment key={index}>{text(node.text, cursor)}</Fragment>;
      case "br":
        return (
          <Fragment key={index}>
            {separator(cursor)}
            <br />
          </Fragment>
        );
      case "code":
        return (
          <code key={index} className="rounded bg-soft px-1 py-0.5 font-mono text-[0.85em]">
            {text(node.text, cursor)}
          </code>
        );
      case "strong":
        return <strong key={index}>{renderInline(node.children, cursor)}</strong>;
      case "em":
        return <em key={index}>{renderInline(node.children, cursor)}</em>;
      case "link":
        return (
          <a
            key={index}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline underline-offset-2"
          >
            {renderInline(node.children, cursor)}
          </a>
        );
    }
  });
}

function renderBlock(block: Block, index: number, cursor: Cursor): ReactNode {
  switch (block.type) {
    case "heading":
      return (
        <p key={index} className="font-semibold">
          {renderInline(block.children, cursor)}
        </p>
      );
    case "paragraph":
      return <p key={index}>{renderInline(block.children, cursor)}</p>;
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag key={index} className={`${block.ordered ? "list-decimal" : "list-disc"} space-y-1 pl-5`}>
          {block.items.map((item, i) => (
            <Fragment key={i}>
              <li>{renderInline(item, cursor)}</li>
              {separator(cursor)}
            </Fragment>
          ))}
        </Tag>
      );
    }
    case "quote":
      return (
        <blockquote key={index} className="border-l-2 border-line pl-3 text-muted">
          {renderInline(block.children, cursor)}
        </blockquote>
      );
    case "code":
      return (
        <pre key={index} className="overflow-x-auto rounded bg-soft p-3 font-mono text-xs">
          {text(block.text, cursor)}
        </pre>
      );
    case "rule":
      return <hr key={index} className="border-line" />;
  }
}

/**
 * Renders approval bodies: Markdown to React elements, never to an HTML string.
 * `marks` highlight passages (offsets in the rendered text, see annotate.ts);
 * `afterBlock` may add an element after a top-level block, given the span of
 * text the block covers.
 */
export function Markdown({
  source,
  marks,
  onMark,
  afterBlock,
  ref,
}: {
  source: string;
  marks?: readonly Mark[];
  onMark?: (mark: Mark) => void;
  afterBlock?: (span: { start: number; end: number }) => ReactNode;
  ref?: Ref<HTMLDivElement>;
}) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  const cursor: Cursor = { pos: 0, marks: marks ? drawableMarks(marks) : [], onMark };
  return (
    <div ref={ref} className="space-y-3 break-words text-sm leading-relaxed">
      {blocks.flatMap((block, index) => {
        const start = cursor.pos;
        const element = renderBlock(block, index, cursor);
        // Every block but a rule and a list (which ends each item with one) is followed by a separator.
        const end = cursor.pos + (block.type === "rule" || block.type === "list" ? 0 : 1);
        const nodes: ReactNode[] = [element];
        if (block.type !== "rule" && block.type !== "list") nodes.push(<Fragment key={`sep-${index}`}>{separator(cursor)}</Fragment>);
        const extra = afterBlock?.({ start, end });
        if (extra) nodes.push(<Fragment key={`after-${index}`}>{extra}</Fragment>);
        return nodes;
      })}
    </div>
  );
}
