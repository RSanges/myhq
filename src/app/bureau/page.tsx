import type { Metadata } from "next";
import { Dashboard } from "@/ui/dashboard";
import { strings } from "@/ui/strings";

export const metadata: Metadata = { title: strings.desk.pageTitle };

/** The desk: the hub, the items to decide, the team, the feed (docs/architecture.md, section 8). */
export default function Desk() {
  return (
    <main className="flex-1">
      <Dashboard />
    </main>
  );
}
