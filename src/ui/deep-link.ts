import type { FeedEntry } from "./model";

// Deep links to the desk: `/#approval-<id>` and `/#run-<id>`. Telegram alerts
// carry them when HQ_PUBLIC_URL is set (src/server/public-url.ts), and the desk
// follows them on load and on `hashchange`. Pure helpers: no DOM here.

export type DeepLink = { kind: "approval" | "run"; id: number };

/** Which tab of the desk shows an item. */
export type DeskTab = "pending" | "history";

const HASH = /^#?(approval|run)-([1-9]\d{0,8})$/;

/** The deep link a location hash stands for, or null for anything else (an unknown form, an id that is not a plain positive integer). */
export function parseHash(hash: string): DeepLink | null {
  const match = HASH.exec(hash.trim());
  return match ? { kind: match[1] as DeepLink["kind"], id: Number(match[2]) } : null;
}

export const approvalAnchor = (id: number): string => `approval-${id}`;
export const runAnchor = (id: number): string => `run-${id}`;
/** The hash that opens an item or a run: what the alerts carry after the address of the desk. */
export const approvalHash = (id: number): string => `#${approvalAnchor(id)}`;
export const runHash = (id: number): string => `#${runAnchor(id)}`;

export const tabOf = (status: string): DeskTab => (status === "pending" ? "pending" : "history");

/** The tab and id to show for an approval link, or null when it is not an approval link or the item is unknown. */
export function resolveApprovalLink(
  link: DeepLink | null,
  items: readonly { id: number; status: string }[],
): { id: number; tab: DeskTab } | null {
  if (!link || link.kind !== "approval") return null;
  const item = items.find((each) => each.id === link.id);
  return item ? { id: item.id, tab: tabOf(item.status) } : null;
}

/**
 * The feed row a run link scrolls to: the start of the run, or the oldest of
 * its events the page still holds. Null when the page holds none of them.
 */
export function runStartKey(entries: readonly FeedEntry[], runId: number): string | null {
  let best: { key: string; id: number; start: boolean } | null = null;
  for (const entry of entries) {
    if (entry.kind !== "event" || entry.event.runId !== runId) continue;
    const start = entry.event.type === "start";
    if (!best || (start && !best.start) || (start === best.start && entry.event.id < best.id)) {
      best = { key: entry.key, id: entry.event.id, start };
    }
  }
  return best?.key ?? null;
}
