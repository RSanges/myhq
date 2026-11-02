import type { ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "./markdown";

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return node.text;
      case "br":
        return <br key={index} />;
      case "code":
        return (
          <code key={index} className="rounded bg-soft px-1 py-0.5 font-mono text-[0.85em]">
            {node.text}
          </code>
        );
      case "strong":
        return <strong key={index}>{renderInline(node.children)}</strong>;
      case "em":
        return <em key={index}>{renderInline(node.children)}</em>;
      case "link":
        return (
          <a
            key={index}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline underline-offset-2"
          >
            {renderInline(node.children)}
          </a>
        );
    }
  });
}

function renderBlock(block: Block, index: number): ReactNode {
  switch (block.type) {
    case "heading":
      return (
        <p key={index} className="font-semibold">
          {renderInline(block.children)}
        </p>
      );
    case "paragraph":
      return <p key={index}>{renderInline(block.children)}</p>;
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag key={index} className={`${block.ordered ? "list-decimal" : "list-disc"} space-y-1 pl-5`}>
          {block.items.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </Tag>
      );
    }
    case "quote":
      return (
        <blockquote key={index} className="border-l-2 border-line pl-3 text-muted">
          {renderInline(block.children)}
        </blockquote>
      );
    case "code":
      return (
        <pre key={index} className="overflow-x-auto rounded bg-soft p-3 font-mono text-xs">
          {block.text}
        </pre>
      );
    case "rule":
      return <hr key={index} className="border-line" />;
  }
}

/** Renders approval bodies: Markdown to React elements, never to an HTML string. */
export function Markdown({ source }: { source: string }) {
  return <div className="space-y-3 break-words text-sm leading-relaxed">{parseMarkdown(source).map(renderBlock)}</div>;
}
