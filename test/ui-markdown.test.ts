import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInline, parseMarkdown, safeHref } from "../src/ui/markdown";

test("paragraphs keep their line breaks and blank lines separate blocks", () => {
  assert.deepEqual(parseMarkdown("one\ntwo\n\nthree"), [
    { type: "paragraph", children: [{ type: "text", text: "one" }, { type: "br" }, { type: "text", text: "two" }] },
    { type: "paragraph", children: [{ type: "text", text: "three" }] },
  ]);
});

test("headings, lists, quotes and rules", () => {
  const blocks = parseMarkdown("## Title\n- a\n- b\n1. x\n> quoted\n---");
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["heading", "list", "list", "quote", "rule"],
  );
  const lists = blocks.flatMap((b) => (b.type === "list" ? [b] : []));
  assert.deepEqual(
    lists.map((l) => l.ordered),
    [false, true],
  );
  assert.equal(lists[0]!.items.length, 2);
});

test("fenced code is kept verbatim, even unclosed", () => {
  assert.deepEqual(parseMarkdown("```\n**not bold**\n```"), [{ type: "code", text: "**not bold**" }]);
  assert.deepEqual(parseMarkdown("```\nopen"), [{ type: "code", text: "open" }]);
});

test("inline code, bold, italic and links", () => {
  assert.deepEqual(parseInline("a `b` **c** *d* [e](https://example.com)"), [
    { type: "text", text: "a " },
    { type: "code", text: "b" },
    { type: "text", text: " " },
    { type: "strong", children: [{ type: "text", text: "c" }] },
    { type: "text", text: " " },
    { type: "em", children: [{ type: "text", text: "d" }] },
    { type: "text", text: " " },
    { type: "link", href: "https://example.com/", children: [{ type: "text", text: "e" }] },
  ]);
});

test("links with other schemes stay plain text, and HTML is never interpreted", () => {
  assert.equal(safeHref("javascript:alert(1)"), null);
  const plain = parseInline("[x](javascript:alert(1))");
  assert.ok(plain.every((node) => node.type === "text"));
  assert.equal(plain.map((node) => (node.type === "text" ? node.text : "")).join(""), "[x](javascript:alert(1))");
  assert.deepEqual(parseMarkdown("<script>alert(1)</script>"), [
    { type: "paragraph", children: [{ type: "text", text: "<script>alert(1)</script>" }] },
  ]);
});
