import { Fragment, useMemo, type ReactNode, type Ref } from "react";
import { drawableMarks, splitByMarks, type Mark } from "./annotate";
import { parseMarkdown, type Align, type Block, type Inline } from "./markdown";
import { strings } from "./strings";

/**
 * Where the render is in the text of the body. The text nodes are emitted in
 * document order, and the separators ("\n" after each block, table row and line
 * break, a tab between table cells) are text nodes of their own: see
 * annotate.ts, which relies on it. List markers and checkboxes are not text.
 * The look of every element is in the `prose` block of globals.css.
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

const separator = (cursor: Cursor, value = "\n"): ReactNode => text(value, cursor);

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
        return <code key={index}>{text(node.text, cursor)}</code>;
      case "strong":
        return <strong key={index}>{renderInline(node.children, cursor)}</strong>;
      case "em":
        return <em key={index}>{renderInline(node.children, cursor)}</em>;
      case "link":
        return (
          <a key={index} href={node.href} target="_blank" rel="noopener noreferrer">
            {renderInline(node.children, cursor)}
          </a>
        );
    }
  });
}

type HeadingTag = "h2" | "h3" | "h4" | "h5";

/** The cells of a table row: a tab after each one but the last, a "\n" after the last (inside the cell). */
function renderRow(cells: Inline[][], align: Align[], cursor: Cursor, head: boolean): ReactNode {
  const Cell = head ? "th" : "td";
  return (
    <tr>
      {cells.map((cell, column) => (
        <Cell key={column} data-align={align[column] ?? undefined} scope={head ? "col" : undefined}>
          {renderInline(cell, cursor)}
          {separator(cursor, column === cells.length - 1 ? "\n" : "\t")}
        </Cell>
      ))}
    </tr>
  );
}

function renderBlocks(blocks: Block[], cursor: Cursor): ReactNode[] {
  return blocks.map((block, index) => <Fragment key={index}>{renderBlock(block, cursor)}</Fragment>);
}

/** A block and its separator, in the same order as the text model (see `blockText` in annotate.ts). */
function renderBlock(block: Block, cursor: Cursor): ReactNode {
  switch (block.type) {
    case "heading": {
      // One level down, so that the title of the item stays the biggest: # is h2, and h4 to h6 stop at h5.
      const level = Math.min(block.level, 4);
      const Tag = `h${level + 1}` as HeadingTag;
      return (
        <>
          <Tag data-level={level}>{renderInline(block.children, cursor)}</Tag>
          {separator(cursor)}
        </>
      );
    }
    case "paragraph":
      return (
        <>
          <p>{renderInline(block.children, cursor)}</p>
          {separator(cursor)}
        </>
      );
    case "list": {
      const items = block.items.map((item, index) => (
        <li key={index} data-task={item.checked === null ? undefined : item.checked ? "done" : "todo"}>
          {item.checked !== null && <input
              type="checkbox"
              checked={item.checked}
              disabled
              readOnly
              aria-label={item.checked ? strings.markdown.taskDone : strings.markdown.taskTodo}
            />}
          {renderBlocks(item.blocks, cursor)}
        </li>
      ));
      return block.ordered ? <ol start={block.start !== 1 ? block.start : undefined}>{items}</ol> : <ul>{items}</ul>;
    }
    case "quote":
      return <blockquote>{renderBlocks(block.blocks, cursor)}</blockquote>;
    case "code":
      return (
        <>
          <pre>
            <code>{text(block.text, cursor)}</code>
          </pre>
          {separator(cursor)}
        </>
      );
    case "rule":
      return <hr />;
    case "table":
      return (
        <div className="table-wrap" role="region" aria-label={strings.markdown.tableLabel} tabIndex={0}>
          <table>
            <thead>{renderRow(block.header, block.align, cursor, true)}</thead>
            <tbody>
              {block.rows.map((row, index) => (
                <Fragment key={index}>{renderRow(row, block.align, cursor, false)}</Fragment>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/**
 * Renders approval bodies and chat replies: Markdown to React elements, never to
 * an HTML string. `marks` highlight passages (offsets in the rendered text, see
 * annotate.ts); `afterBlock` may add an element after a top-level block, given
 * the span of text the block covers.
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
    <div ref={ref} className="prose">
      {blocks.flatMap((block, index) => {
        const start = cursor.pos;
        const element = renderBlock(block, cursor);
        const nodes: ReactNode[] = [<Fragment key={index}>{element}</Fragment>];
        const extra = afterBlock?.({ start, end: cursor.pos });
        if (extra) nodes.push(<Fragment key={`after-${index}`}>{extra}</Fragment>);
        return nodes;
      })}
    </div>
  );
}
