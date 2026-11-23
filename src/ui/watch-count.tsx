"use client";

import { approvalHash } from "./deep-link";
import { watchHref } from "./model";
import type { Approval } from "./schemas";
import { strings } from "./strings";

/**
 * The count of items to look at, as the tab title says it, made a link to the
 * oldest of them on the desk (`/bureau#approval-<id>`): the desk follows the
 * deep link to the list « À regarder ». A plain link, so that on the desk
 * itself the hash changes and `useDeepLink` hears it. Nothing without items.
 */
export function WatchCount({ unseen }: { unseen: readonly Approval[] }) {
  const href = watchHref(unseen);
  if (href === null) return null;
  return (
    <a className="text-sm font-medium text-accent underline-offset-2 hover:underline" href={href}>
      {strings.app.watchCount(unseen.length)}
    </a>
  );
}

/**
 * On the desk page, the items to look at that no tray watches (notifyTypes
 * without a `watch:` source): named under the tiles, each a link to its card
 * in the list « À regarder », instead of being found only at the bottom.
 */
export function UnwatchedNotice({ items }: { items: readonly Approval[] }) {
  if (items.length === 0) return null;
  const t = strings.desk;
  return (
    <section aria-labelledby="desk-unwatched" className="space-y-1 rounded-lg border border-line p-3 text-sm">
      <h2 id="desk-unwatched" className="font-semibold">
        {t.unwatchedTitle(items.length)}
      </h2>
      <p className="text-xs text-muted">{t.unwatchedHint}</p>
      <ul className="list-disc space-y-1 pl-5">
        {items.map((approval) => (
          <li key={approval.id}>
            <a className="underline-offset-2 hover:underline" href={approvalHash(approval.id)}>
              {approval.title}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
