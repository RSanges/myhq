import type { Metadata } from "next";
import { Suspense } from "react";
import { SettingsPage } from "@/ui/settings";
import { strings } from "@/ui/strings";

export const metadata: Metadata = { title: strings.settings.pageTitle };

/**
 * The settings, in tabs addressed by the query (`?onglet=salles&salle=<room>`):
 * the page reads it on the client, so the shell stays prerendered and the tree
 * that reads it waits under Suspense.
 */
export default function Settings() {
  return (
    <main className="flex-1">
      <Suspense fallback={<p className="mx-auto w-full max-w-5xl px-4 py-6 text-sm text-muted">{strings.settings.loading}</p>}>
        <SettingsPage />
      </Suspense>
    </main>
  );
}
