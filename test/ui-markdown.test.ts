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

const text = (value: string) => ({ type: "text", text: value });
const para = (...children: object[]) => ({ type: "paragraph", children });

test("headings keep their level (1 to 6) and drop closing hashes", () => {
  assert.deepEqual(parseMarkdown("# One\n#### Four ##\n###### Six\n#NoSpace"), [
    { type: "heading", level: 1, children: [text("One")] },
    { type: "heading", level: 4, children: [text("Four")] },
    { type: "heading", level: 6, children: [text("Six")] },
    para(text("#NoSpace")),
  ]);
});

test("lists nest by indentation, and an item may hold paragraphs and code", () => {
  const [list] = parseMarkdown("- a\n  - b\n    - c\n- d\n\n  more of d\n\n  ```\n  code\n  ```");
  assert.equal(list?.type, "list");
  if (list?.type !== "list") return;
  assert.equal(list.items.length, 2);
  const [a, d] = list.items;
  assert.deepEqual(a!.blocks.map((b) => b.type), ["paragraph", "list"]);
  const inner = a!.blocks[1];
  assert.equal(inner?.type === "list" && inner.items[0]!.blocks[1]?.type, "list", "a list three levels deep");
  assert.deepEqual(d!.blocks.map((b) => b.type), ["paragraph", "paragraph", "code"]);
  assert.deepEqual(d!.blocks[2], { type: "code", text: "code" });
});

test("ordered lists keep their first number, mixed kinds make two lists, a blank line does not split one", () => {
  const blocks = parseMarkdown("3. x\n4. y\n\n5. z\n- u\n- v");
  assert.deepEqual(
    blocks.map((b) => (b.type === "list" ? [b.ordered, b.start, b.items.length] : b.type)),
    [
      [true, 3, 3],
      [false, 1, 2],
    ],
  );
  assert.deepEqual(parseMarkdown("1) one\n2) two").map((b) => b.type === "list" && b.ordered), [true]);
});

test("task items carry their state, a plain item none", () => {
  const [list] = parseMarkdown("- [ ] todo\n- [x] done\n- [X] done too\n- [x]no space\n- plain");
  assert.equal(list?.type, "list");
  if (list?.type !== "list") return;
  assert.deepEqual(list.items.map((i) => i.checked), [false, true, true, null, null]);
  assert.deepEqual(list.items[0]!.blocks, [para(text("todo"))]);
  assert.deepEqual(list.items[3]!.blocks, [para(text("[x]no space"))]);
});

test("block quotes hold blocks of their own", () => {
  assert.deepEqual(parseMarkdown("> **Note**\n> second line\n>\n> - item"), [
    {
      type: "quote",
      blocks: [
        para({ type: "strong", children: [text("Note")] }, { type: "br" }, text("second line")),
        { type: "list", ordered: false, start: 1, items: [{ checked: null, blocks: [para(text("item"))] }] },
      ],
    },
  ]);
});

test("rules, and fences with backticks or tildes, longer fences closing on the same kind", () => {
  assert.deepEqual(parseMarkdown("***\n- - -\n___").map((b) => b.type), ["rule", "rule", "rule"]);
  assert.deepEqual(parseMarkdown("~~~\n```\ninside\n```\n~~~"), [{ type: "code", text: "```\ninside\n```" }]);
  assert.deepEqual(parseMarkdown("````\n```\nx\n````\nafter"), [{ type: "code", text: "```\nx" }, para(text("after"))]);
});

test("tables: header, alignment from the separator row, body rows padded or cut to the header", () => {
  const [table] = parseMarkdown("| Name | Qty | Note |\n|:--|--:|:-:|\n| **A** | 1 | `x` |\n| B | 2 |\n| C | 3 | y | extra |");
  assert.equal(table?.type, "table");
  if (table?.type !== "table") return;
  assert.deepEqual(table.align, ["left", "right", "center"]);
  assert.deepEqual(table.header, [[text("Name")], [text("Qty")], [text("Note")]]);
  assert.equal(table.rows.length, 3);
  assert.deepEqual(table.rows[0]![0], [{ type: "strong", children: [text("A")] }]);
  assert.deepEqual(table.rows[0]![2], [{ type: "code", text: "x" }]);
  assert.deepEqual(table.rows[1]![2], [], "a missing cell is empty");
  assert.equal(table.rows[2]!.length, 3, "an extra cell is dropped");
});

test("tables: no edge pipes, default alignment, escaped pipes, and a table may interrupt a paragraph", () => {
  const blocks = parseMarkdown("intro\na | b\n--|--\n1 \\| 2 | 3\n\nafter");
  assert.deepEqual(blocks.map((b) => b.type), ["paragraph", "table", "paragraph"]);
  const table = blocks[1]!;
  assert.equal(table.type === "table" && table.align.every((a) => a === null), true);
  assert.deepEqual(table.type === "table" && table.rows[0]![0], [text("1 | 2")]);
});

test("a table stops at a blank line or at a block of another kind", () => {
  const blocks = parseMarkdown("| a |\n|---|\n| 1 |\n# Title\n\n| b |\n|---|\n| 2 |\nplain text");
  assert.deepEqual(blocks.map((b) => b.type), ["table", "heading", "table", "paragraph"]);
});

test("things that look like a table but are not stay plain text", () => {
  // No delimiter row, a delimiter with another number of cells, a rule under a line.
  for (const source of ["a | b\nc | d", "| a | b |\n|---|\n| 1 | 2 |", "title\n---"]) {
    assert.ok(parseMarkdown(source).every((b) => b.type !== "table"), source);
  }
});

test("images show their alt text in brackets, with or without a safe address", () => {
  assert.deepEqual(parseInline("![a chart](https://example.com/c.png) and ![](x.png) and ![z](javascript:x)"), [
    text("[a chart] and [image] and [z]"),
  ]);
});

test("escapes, bold italic, and emphasis around other marks", () => {
  assert.deepEqual(parseInline("\\*not\\* \\| ***both*** **a *b* c** snake_case 2 * 3 * 4"), [
    text("*not* | "),
    { type: "strong", children: [{ type: "em", children: [text("both")] }] },
    text(" "),
    { type: "strong", children: [text("a "), { type: "em", children: [text("b")] }, text(" c")] },
    text(" snake_case 2 * 3 * 4"),
  ]);
  assert.deepEqual(parseInline("[**bold** link](http://example.com/a) \"quoted\" [t](https://example.com \"title\")").map((n) => n.type), ["link", "text", "link"]);
});

test("malformed syntax degrades to plain text and never throws", () => {
  const samples = [
    "**unclosed bold",
    "`unclosed code",
    "[broken](link",
    "[x]()",
    "*",
    "| |\n|-|",
    "|||\n|--|--|--|\n||",
    "```",
    "> > > > nested",
    "- [ ]",
    "1.",
    "- \n-",
    "\\",
    "<b onclick=alert(1)>x</b>",
    "- a\n\t- tab\n\t\t- deeper",
    "\u0000  weird",
  ];
  for (const sample of samples) assert.doesNotThrow(() => parseMarkdown(sample), sample);
  assert.deepEqual(parseInline("**unclosed bold and *x"), [text("**unclosed bold and *x")]);
  assert.deepEqual(parseInline("[broken](link"), [text("[broken](link")]);
  assert.deepEqual(parseMarkdown("<b onclick=alert(1)>x</b>"), [para(text("<b onclick=alert(1)>x</b>"))]);
});

test("deep nesting is cut instead of overflowing, and random input never throws", () => {
  const deep = Array.from({ length: 200 }, (_, level) => `${" ".repeat(level * 2)}- item ${level}`).join("\n");
  assert.doesNotThrow(() => parseMarkdown(deep));
  assert.doesNotThrow(() => parseMarkdown(`${">".repeat(500)} deep quote`));
  const alphabet = ["|", "-", ":", "*", "`", "[", "]", "(", ")", ">", "#", " ", "\n", "x", "1", ".", "~", "\\", "!"];
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let n = 0; n < 300; n++) {
    const source = Array.from({ length: 80 }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
    assert.doesNotThrow(() => parseMarkdown(source), source);
  }
});
