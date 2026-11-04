import type { Metadata } from "next";
import { Suspense } from "react";
import { DeskModuleRoute } from "@/ui/desk-module";
import { strings } from "@/ui/strings";

export const metadata: Metadata = { title: strings.app.title };

/**
 * The page of one object of the desk (myhq.json `desk`), see docs/architecture.md,
 * section 8. The id is read on the client (useParams) inside a Suspense boundary,
 * so that the shell of the page is prerendered and the page loads at once.
 */
export default function DeskModule() {
  return (
    <main className="flex-1">
      <Suspense fallback={<p className="px-4 py-6 text-sm text-muted">{strings.deskModules.loading}</p>}>
        <DeskModuleRoute />
      </Suspense>
    </main>
  );
}
