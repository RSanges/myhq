import type { RoadmapStatus } from "@/server/roadmap-schema";
import { ownerInitial, ownerTint } from "./roadmap-model";
import { strings } from "./strings";

const t = strings.roadmap;

/** ASCII keys for the status styles in globals.css. */
export const statusKey: Record<RoadmapStatus, "done" | "doing" | "todo" | "blocked"> = {
  fait: "done",
  "en cours": "doing",
  "à faire": "todo",
  bloqué: "blocked",
};

/** The class that plays the "just changed" highlight, or nothing. */
export function flash(changed: ReadonlySet<string>, key: string): string {
  return changed.has(key) ? " wall-flash" : "";
}

/** Status with a shape and a label, so that colour is never the only signal. */
export function StatusChip({ status }: { status: RoadmapStatus }) {
  return (
    <span className="wall-chip" data-status={statusKey[status]}>
      {t.status[status]}
    </span>
  );
}

const ownerTints = 5;

/** Initial of the owner in a small circle (a dashed empty one when there is none). */
export function OwnerDot({ owner }: { owner: string }) {
  if (owner.trim() === "") {
    return <span className="wall-owner" data-empty="" role="img" aria-label={t.noOwner} title={t.noOwner} />;
  }
  return (
    <span
      className="wall-owner"
      data-tint={ownerTint(owner, ownerTints)}
      role="img"
      aria-label={t.ownerLabel(owner)}
      title={owner}
    >
      {ownerInitial(owner)}
    </span>
  );
}
