import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Generic role templates shipped with MyHQ (`templates/roles/*.md`), and
 * their instantiation for one project. A template uses six placeholders,
 * written `{{name}}`; onboarding fills them with the project's context.
 */
export const ROLE_PLACEHOLDERS = ["project", "targets", "audience", "features", "autonomy", "guardrails"] as const;

/** A value is a text, or a list of lines that becomes a Markdown list. */
const text = z
  .union([z.string().trim().min(1).max(20_000), z.array(z.string().trim().min(1).max(2_000)).min(1).max(100)])
  .transform((value) => (Array.isArray(value) ? value.map((line) => `- ${line}`).join("\n") : value));

export const roleValuesSchema = z.strictObject({
  project: z.string().trim().min(1).max(200),
  targets: text,
  audience: text,
  /** The closed list of what the agent may claim about the project. */
  features: text,
  /** A: inside the repository or the accounts; B: prepared, then signed by the user; C: human only. */
  autonomy: z.enum(["A", "B", "C"]),
  guardrails: text,
});
export type RoleValues = z.input<typeof roleValuesSchema>;

export const templateNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "a template name such as dev");

/** `templates/roles` of the MyHQ repository. */
export function roleTemplatesDir(repoRoot: string): string {
  return path.join(repoRoot, "templates", "roles");
}

export type RoleTemplate = { name: string; title: string };

/** The templates available, with the title of each (from its first heading). */
export function listRoleTemplates(dir: string): RoleTemplate[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => {
      const heading = /^#\s+(.+)$/m.exec(fs.readFileSync(path.join(dir, file), "utf8"))?.[1] ?? "";
      return { name: file.slice(0, -3), title: heading.replace(/^\{\{project\}\}:\s*/, "").trim() };
    });
}

/** The text of one template. Throws an explicit Error when it does not exist. */
export function readRoleTemplate(dir: string, name: string): string {
  const parsed = templateNameSchema.safeParse(name);
  const file = path.join(dir, `${name}.md`);
  if (!parsed.success || !fs.existsSync(file)) {
    const known = listRoleTemplates(dir).map((t) => t.name);
    throw new Error(`unknown role template "${name}" (known: ${known.join(", ")})`);
  }
  return fs.readFileSync(file, "utf8");
}

/**
 * Fills the placeholders of a template. Throws an explicit Error when a value
 * is invalid, or when a `{{...}}` is left in the result (a placeholder the
 * template uses but MyHQ does not know).
 */
export function instantiateRole(template: string, values: RoleValues): string {
  const parsed = roleValuesSchema.safeParse(values);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.length ? issue.path.join(".") : "(values)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid role values: ${details}`);
  }
  const filled = template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    (ROLE_PLACEHOLDERS as readonly string[]).includes(key) ? parsed.data[key as keyof typeof parsed.data] : match,
  );
  const left = [...new Set(filled.match(/\{\{\w+\}\}/g) ?? [])];
  if (left.length > 0) throw new Error(`unknown placeholder(s) in the template: ${left.join(", ")}`);
  return filled;
}
