import { z } from "zod";
import { MESSAGE_LIMIT } from "../assistant/text";
import { approvalHash, runHash } from "../ui/deep-link";
import { strings } from "../ui/strings";
import type { Env } from "./config";

const urlSchema = z.url({ protocol: /^https?$/ });

/**
 * HQ_PUBLIC_URL: the address at which the user reaches the desk from another
 * device (for example the Tailscale name of the machine). Optional: null when
 * unset or not an http(s) address, and the alerts then carry no link. Reduced
 * to its origin and path, without a trailing slash, so that a fragment can be
 * appended.
 */
export function publicUrl(env: Env = process.env): string | null {
  const raw = env.HQ_PUBLIC_URL?.trim();
  if (!raw) return null;
  const parsed = urlSchema.safeParse(raw);
  if (!parsed.success) return null;
  const url = new URL(parsed.data);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** « Ouvrir : <url>/#approval-<id> », or null without HQ_PUBLIC_URL. */
export function approvalLinkLine(id: number, env: Env = process.env): string | null {
  const base = publicUrl(env);
  return base ? strings.notify.open(`${base}/${approvalHash(id)}`) : null;
}

/** « Ouvrir : <url>/#run-<id> », or null without HQ_PUBLIC_URL. */
export function runLinkLine(id: number, env: Env = process.env): string | null {
  const base = publicUrl(env);
  return base ? strings.notify.open(`${base}/${runHash(id)}`) : null;
}

/** « Bureau : <url> », or null without HQ_PUBLIC_URL. */
export function deskLinkLine(env: Env = process.env): string | null {
  const base = publicUrl(env);
  return base ? strings.notify.desk(base) : null;
}

/** `text` followed by a line (a blank line between), or `text` itself when there is no line. */
export function withLine(text: string, line: string | null): string {
  return line ? `${text}\n\n${line}` : text;
}

/**
 * Adds a line at the end of the last message of a cut text, or as one more
 * message when it would not fit (the sender cuts at MESSAGE_LIMIT, which
 * would lose the link). A null line changes nothing.
 */
export function appendLine(parts: string[], line: string | null): string[] {
  if (!line) return parts;
  const last = parts[parts.length - 1];
  if (last !== undefined && last.length + 2 + line.length <= MESSAGE_LIMIT) return [...parts.slice(0, -1), `${last}\n\n${line}`];
  return [...parts, line];
}
