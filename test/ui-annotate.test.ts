import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import { drawableMarks, insertAnnotation, locateQuotes, plainText, quoteOf, splitByMarks, type Mark } from "../src/ui/annotate";
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

const PLAN = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "launch-plan.md"), "utf8");
const render = (marks: Mark[] = []) => renderToStaticMarkup(createElement(Markdown, { source: PLAN, marks }));
const planText = plainText(parseMarkdown(PLAN));
const markAt = (id: number, quote: string): Mark => {
  const start = planText.indexOf(quote);
  assert.ok(start >= 0, `"${quote}" is in the text`);
  return { id, kind: "saved", start, end: start + quote.length };
};
const marksOf = (html: string, id: number) => [...html.matchAll(new RegExp(`<mark [^>]*data-ann="${id}"[^>]*>([^<]*)</mark>`, "g"))].map((m) => m[1]);

test("the text model of a long plan matches the rendered text character for character", () => {
  assert.equal(textContent(render()), planText);
  // The same with highlights everywhere, in a cell, in a nested item, in a task, across a cell border.
  const marks = [
    markAt(0, "Liste d'attente\t650"),
    markAt(1, "un pour la liste d'attente"),
    markAt(2, "Corriger les cinq bugs"),
    markAt(3, "À savoir"),
  ];
  assert.equal(textContent(render(marks)), planText);
});

test("the model leaves out list markers and checkboxes, and separates cells with a tab and rows with a newline", () => {
  assert.ok(planText.includes("Semaine\tPhase\tBudget (EUR)\tStatut\n1\tPréparation du site\t400\tFait\n"));
  assert.ok(planText.includes("3 à 4\tBeta fermée\t1 200\tÀ lancer\n"));
  assert.ok(planText.includes("dont 100 testeurs invités\ndont 400 issus de la liste d'attente\n"));
  assert.ok(planText.includes("Écrire les trois e-mails de bienvenue\nun pour les testeurs\nun pour la liste d'attente\nBrancher"));
  assert.ok(planText.includes("Inviter les cent premiers testeurs\nEnvoyer le questionnaire de la semaine 3\n"));
  assert.ok(!planText.includes("[x]") && !planText.includes("[ ]") && !planText.includes("1. Finaliser") && !planText.includes("- un pour"));
  assert.ok(planText.includes("capture du tableau"), "an image is its alt text");
});

test("a quote inside a table cell is highlighted in that cell", () => {
  const html = render([markAt(0, "Liste d'attente")]);
  assert.deepEqual(marksOf(html, 0), ["Liste d&#x27;attente"]);
  assert.match(html, /<td[^>]*><mark [^>]*data-ann="0"[^>]*>Liste d&#x27;attente<\/mark>\t<\/td>/);
  // A selection made in the cell maps back onto it: the quote is a slice of the model, and is found again.
  const at = planText.indexOf("Relations presse");
  const picked = quoteOf(planText, at - 1, at + "Relations presse".length + 1);
  assert.equal(picked?.quote, "Relations presse");
  assert.deepEqual(locateQuotes(planText, [{ quote: picked!.quote, position: picked!.start }]), [{ start: at, end: at + 16 }]);
});

test("a quote that crosses table cells is cut into pieces, one or more per cell", () => {
  const html = render([markAt(0, "400\tFait")]);
  assert.equal(textContent(html), planText);
  assert.deepEqual(marksOf(html, 0), ["400", "\t", "Fait"]);
  assert.match(html, /<td data-align="right"><mark [^>]*>400<\/mark><mark [^>]*>\t<\/mark><\/td><td data-align="left"><strong><mark [^>]*>Fait<\/mark><\/strong>/);
});

test("a quote inside a nested list is highlighted in its item", () => {
  const html = render([markAt(0, "un pour la liste d'attente")]);
  assert.match(html, /<ul><li><p>un pour les testeurs<\/p>\n<\/li><li><p><mark [^>]*data-ann="0"[^>]*>un pour la liste d&#x27;attente<\/mark><\/p>\n<\/li><\/ul>/);
});

test("a quote across a bold span is highlighted in pieces, inside and outside it", () => {
  const html = render([markAt(0, "sur six semaines, avec le budget")]);
  assert.equal(textContent(html), planText);
  assert.deepEqual(marksOf(html, 0), ["sur ", "six semaines", ", avec le ", "budget"]);
  assert.match(html, /<strong><mark [^>]*>six semaines<\/mark><\/strong>/);
  assert.match(html, /<em><mark [^>]*>budget<\/mark><\/em>/);
});

test("a sample plan renders as headings, a table, nested lists, tasks, a quote and code", () => {
  const blocks = parseMarkdown(PLAN);
  assert.deepEqual(
    blocks.map((block) => (block.type === "heading" ? `h${block.level}` : block.type)),
    ["h1", "paragraph", "h2", "list", "h3", "table", "h3", "list", "quote", "rule", "h4", "code", "paragraph"],
  );
  const html = render();
  // Headings one level down from the Markdown level.
  assert.match(html, /<h2 data-level="1">Plan de lancement/);
  assert.match(html, /<h3 data-level="2">1\. Objectifs<\/h3>/);
  assert.match(html, /<h4 data-level="3">Calendrier<\/h4>/);
  assert.match(html, /<h5 data-level="4">Annonce prévue<\/h5>/);
  assert.equal(html.match(/<h1/g), null, "no h1 in a body");
  // The table: a header row, five body rows, alignment from the separator row, in its own scrolling container.
  assert.match(html, /<div class="table-wrap" role="region" aria-label="Tableau" tabindex="0"><table><thead><tr><th data-align="left" scope="col">Semaine/);
  assert.equal(html.match(/<th /g)?.length, 4);
  assert.equal(html.match(/<tbody>[\s\S]*<\/tbody>/)![0].match(/<tr>/g)?.length, 5);
  assert.match(html, /<td data-align="right">400\t<\/td>/);
  assert.match(html, /<th data-align="center" scope="col">Phase/);
  assert.match(html, /<td data-align="left"><strong>Fait<\/strong>\n<\/td>/);
  // Nested lists: an ordered list in an ordered list, a bullet list in an item.
  assert.match(html, /<li><p>Préparer le terrain<\/p>\n<ol><li><p>Finaliser/);
  assert.match(html, /<li><p>Atteindre <strong>500 inscrits<\/strong>[^<]*<\/p>\n<ul><li>/);
  // Task items: disabled checkboxes, two open and one done.
  assert.equal(html.match(/<input type="checkbox" disabled="" readOnly="" aria-label="Fait" checked=""\/>/g)?.length, 1);
  assert.equal(html.match(/<input type="checkbox" disabled="" readOnly="" aria-label="À faire"\/>/g)?.length, 2);
  // The quote, the rule, the code block, the links and the image.
  assert.match(html, /<blockquote><p><strong>À savoir<\/strong>/);
  assert.match(html, /<hr\/>/);
  assert.match(html, /<pre><code>Les carnets partagés arrivent le 12\./);
  assert.match(html, /<a href="https:\/\/example\.com\/guide" target="_blank" rel="noopener noreferrer">guide de lancement<\/a>/);
  assert.ok(!html.includes("<img") && html.includes("[capture du tableau]"));
});

test("a body with anything unsafe or malformed renders as inert text", () => {
  const html = renderToStaticMarkup(
    createElement(Markdown, { source: "<script>alert(1)</script> [x](javascript:alert) **open\n\n| a | b |\n|--|\n| 1 |" }),
  );
  assert.ok(!html.includes("<script") && !html.includes("<a ") && !html.includes("<table"));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});
