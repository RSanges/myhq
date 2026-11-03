import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import { drawableMarks, insertAnnotation, locateQuotes, plainText, quoteOf, splitByMarks } from "../src/ui/annotate";
import { parseMarkdown } from "../src/ui/markdown";
import { Markdown } from "../src/ui/markdown-view";

const BODY = [
  "## Title",
  "",
  "First line\nsecond line with **bold** and `code`.",
  "",
  "- one item",
  "- another item",
  "",
  "> a quoted line",
  "",
  "---",
  "",
  "```",
  "raw block",
  "```",
  "",
  "Last paragraph with [a link](https://example.com/) inside.",
].join("\n");

/** The text content of rendered HTML: tags removed, entities decoded. */
function textContent(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

test("the rendered text model matches the text of the rendered body, with or without highlights", () => {
  const model = plainText(parseMarkdown(BODY));
  assert.equal(textContent(renderToStaticMarkup(createElement(Markdown, { source: BODY }))), model);
  const marks = [
    { id: 0, kind: "saved" as const, start: model.indexOf("bold"), end: model.indexOf("bold") + 4 },
    { id: 1, kind: "saved" as const, start: model.indexOf("another"), end: model.indexOf("raw") + 3 },
  ];
  const html = renderToStaticMarkup(createElement(Markdown, { source: BODY, marks }));
  assert.equal(textContent(html), model);
  assert.equal(html.match(/<mark /g)?.length, 6, "the second mark spans several blocks and is split in pieces");
  assert.match(html, /<mark [^>]*data-ann="0"[^>]*>bold<\/mark>/);
});

test("quotes are slices of the rendered text, with separators where lines and blocks break", () => {
  const model = plainText(parseMarkdown(BODY));
  assert.ok(model.startsWith("Title\nFirst line\nsecond line with bold and code.\none item\nanother item\n"));
  assert.ok(model.includes("a quoted line\nraw block\nLast paragraph with a link inside.\n"), "a rule adds nothing");
});

test("a quote that appears twice maps to two passages, by position or in order", () => {
  const text = "red apple, green apple, red apple";
  const first = text.indexOf("red apple");
  const second = text.lastIndexOf("red apple");
  // With positions: each one lands where it was made.
  assert.deepEqual(
    locateQuotes(text, [
      { quote: "red apple", position: second },
      { quote: "red apple", position: first },
    ]),
    [
      { start: second, end: second + 9 },
      { start: first, end: first + 9 },
    ],
  );
  // Without positions: the first free occurrence each, in order.
  assert.deepEqual(
    locateQuotes(text, [{ quote: "red apple" }, { quote: "red apple" }, { quote: "red apple" }]),
    [{ start: first, end: first + 9 }, { start: second, end: second + 9 }, null],
  );
  // A position that no longer holds falls back to the nearest free occurrence; a quote that is gone is not located.
  assert.deepEqual(locateQuotes(text, [{ quote: "red apple", position: second - 2 }])[0], { start: second, end: second + 9 });
  assert.equal(locateQuotes(text, [{ quote: "blue pear", position: 3 }])[0], null);
  // A positioned quote is not stolen by an unpositioned one.
  assert.deepEqual(
    locateQuotes(text, [{ quote: "red apple" }, { quote: "red apple", position: first }]),
    [{ start: second, end: second + 9 }, { start: first, end: first + 9 }],
  );
});

test("marks are sorted, never overlap, and split the text they cover", () => {
  const marks = drawableMarks([
    { id: 2, kind: "saved", start: 20, end: 30 },
    { id: 0, kind: "saved", start: 2, end: 8 },
    { id: 1, kind: "saved", start: 5, end: 12 },
    { id: 3, kind: "saved", start: 40, end: 40 },
  ]);
  assert.deepEqual(marks.map((m) => m.id), [0, 2]);
  assert.deepEqual(
    splitByMarks(0, 25, marks).map((p) => [p.text, p.mark?.id ?? null]),
    [
      [[0, 2], null],
      [[2, 8], 0],
      [[8, 20], null],
      [[20, 25], 2],
    ],
  );
  assert.deepEqual(splitByMarks(30, 35, marks), [{ text: [0, 5], mark: null }]);
});

test("a selection is trimmed to its text, and kept within 2000 characters", () => {
  assert.deepEqual(quoteOf("  hello world \n", 0, 15), { start: 2, end: 13, quote: "hello world" });
  assert.equal(quoteOf("   \n ", 0, 5), null);
  const long = "x".repeat(3000);
  assert.equal(quoteOf(long, 0, 3000)?.quote.length, 2000);
});

test("annotations are kept in document order", () => {
  const a = { quote: "a", comment: "1", position: 10 };
  const b = { quote: "b", comment: "2", position: 5 };
  const c = { quote: "c", comment: "3", position: 50 };
  assert.deepEqual(insertAnnotation(insertAnnotation(insertAnnotation([], a), c), b), [b, a, c]);
});
