"use client";

import type { SettingsView } from "@/server/settings-schema";
import { Card } from "./settings-parts";
import { strings } from "./strings";
import { Badge } from "./ui";

const t = strings.settings;

/** « Sécurité », read only: which secrets are set (never their value) and the guard rails always in force. */
export function SecurityTab({ settings }: { settings: SettingsView }) {
  return (
    <div className="space-y-4">
      <p>
        <Badge tone="neutral">{t.security.readOnly}</Badge>
      </p>
      <Card id="secrets" title={t.secrets.title} hint={t.secrets.body}>
        <ul className="divide-y divide-line rounded-md border border-line text-sm">
          {settings.secrets.map((secret) => (
            <li key={secret.name} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
              <code className="break-all text-xs">{secret.name}</code>
              <span className="min-w-0 flex-1 text-muted">{t.secrets.names[secret.name] ?? secret.name}</span>
              {secret.set ? (
                <Badge tone="ok">{t.secrets.set}</Badge>
              ) : (
                <span className="text-xs text-muted">
                  {t.secrets.unset} : {t.secrets.unsetHints[secret.name]}
                </span>
              )}
            </li>
          ))}
        </ul>
      </Card>
      <Card id="guards" title={t.security.guardsTitle} hint={t.security.guardsHint}>
        <ul className="grid gap-3 sm:grid-cols-2">
          {t.security.guards(settings.attachmentMaxMb).map((guard) => (
            <li key={guard.title} className="min-w-0 space-y-1 rounded-md border border-line p-3">
              <p className="text-sm font-medium">{guard.title}</p>
              <p className="text-sm text-muted">{guard.body}</p>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
