import type { Metadata } from "next";
import { Suspense } from "react";
import { FoldersPage } from "@/ui/folders";
import { strings } from "@/ui/strings";

export const metadata: Metadata = { title: strings.folders.pageTitle };

/**
 * The room folders, addressed by the query (`?salle=<room>&chemin=<path>`):
 * the page reads it on the client, so the shell stays prerendered and the tree
 * that reads it waits under Suspense.
 */
export default function Folders() {
  return (
    <main className="flex-1">
      <Suspense fallback={<p className="mx-auto w-full max-w-5xl px-4 py-6 text-sm text-muted">{strings.folders.loadingRooms}</p>}>
        <FoldersPage />
      </Suspense>
    </main>
  );
}
