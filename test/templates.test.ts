import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  instantiateRole,
  listRoleTemplates,
  readRoleTemplate,
  roleTemplatesDir,
  ROLE_PLACEHOLDERS,
  type RoleValues,
} from "../src/server/templates";

const dir = roleTemplatesDir(process.cwd());

const values: RoleValues = {
  project: "Acme Notes",
  targets: ["forums about note taking", "question sites"],
  audience: "students who take notes on a phone",
  features: ["shared notebooks", "offline mode"],
  autonomy: "B",
  guardrails: "No promise outside the list.",
};

const ROLES = [
  "aso-reviews",
  "community-watch",
  "competitor-watch",
  "dev",
  "directories-partners",
  "email-lifecycle",
  "metrics-analyst",
  "seo-content",
  "video-social",
];

test("one template per role, each using every placeholder", () => {
  const templates = listRoleTemplates(dir);
  assert.deepEqual(
    templates.map((t) => t.name),
    ROLES,
  );
  for (const { name, title } of templates) {
    assert.ok(title.length > 0, `${name} has a title`);
    const text = readRoleTemplate(dir, name);
    for (const key of ROLE_PLACEHOLDERS) assert.match(text, new RegExp(`\\{\\{${key}\\}\\}`), `${name} uses {{${key}}}`);
    assert.match(text, /hq_submit/, `${name} says what it submits`);
    assert.match(text, /never/i, `${name} says what it never does`);
  }
});

test("instantiation fills every placeholder, lists become Markdown lists", () => {
  const role = instantiateRole(readRoleTemplate(dir, "community-watch"), values);
  assert.doesNotMatch(role, /\{\{/);
  assert.match(role, /^# Acme Notes: community watch/);
  assert.match(role, /- shared notebooks\n- offline mode/);
  assert.match(role, /## Autonomy: level B/);
});

test("instantiation refuses invalid values and unknown placeholders", () => {
  assert.throws(() => instantiateRole("{{project}}", { ...values, autonomy: "D" as "A" }), /autonomy/);
  assert.throws(() => instantiateRole("{{project}}", { ...values, features: [] }), /features/);
  assert.throws(() => instantiateRole("{{project}} {{budget}}", values), /\{\{budget\}\}/);
  assert.throws(() => readRoleTemplate(dir, "../secret"), /unknown role template/);
  assert.throws(() => readRoleTemplate(dir, "nope"), /known: aso-reviews/);
});

/** Words written with a capital inside a sentence that a generic template may use. */
const GENERIC_NAMES = new Set(["AI", "GEO", "Git", "Markdown", "MyHQ", "SEO"]);

test("templates are generic: no proper name, path, address, link or amount", () => {
  for (const file of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    assert.doesNotMatch(text, /[–—]/, `${file}: no em or en dash`);
    assert.doesNotMatch(text, /https?:\/\/|www\./, `${file}: no link`);
    assert.doesNotMatch(text, /[\w.-]+@[\w-]+\.\w+/, `${file}: no email address`);
    assert.doesNotMatch(text, /[A-Za-z]:\\|\/Users\/|\/home\//, `${file}: no machine path`);
    assert.doesNotMatch(text, /[$€£]\s?\d|\d\s?(€|EUR|USD)/, `${file}: no amount`);
    const prose = text.replace(/`[^`]*`/g, "").replace(/\{\{\w+\}\}/g, "");
    for (const line of prose.split("\n")) {
      for (const sentence of line.replace(/^[\s#\-\d.]+/, "").split(/[.:!?;(]\s+/)) {
        const capitalized = sentence.trim().split(/\s+/).slice(1).filter((word) => /^[A-Z]/.test(word));
        for (const word of capitalized) {
          const name = word.replace(/[^A-Za-z]/g, "");
          if (name.length <= 1) continue; // autonomy levels A, B and C
          assert.ok(GENERIC_NAMES.has(name), `${file}: "${name}" looks like a proper name ("${sentence.trim()}")`);
        }
      }
    }
  }
});
