import type { Metadata } from "next";
import { SettingsPage } from "@/ui/settings";
import { strings } from "@/ui/strings";

export const metadata: Metadata = { title: strings.settings.pageTitle };

export default function Settings() {
  return (
    <main className="flex-1">
      <SettingsPage />
    </main>
  );
}
