"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { ApiError, errorText } from "./api";
import { strings } from "./strings";
import { buttonClass, ErrorNote } from "./ui";

// Pieces shared by the four groups of the settings page: the card with its own
// save button and its confirmation, and the small fields.

const t = strings.settings;

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

/** The text of a failed save: French per code, with the server's detail for an input the server refused. */
export function saveErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    const own = t.errors[error.code];
    if (own) return own;
    if (error.code === "INVALID_INPUT" || error.code === "ROOM_INVALID") return `${error.display} (${error.message})`;
  }
  return errorText(error);
}

/**
 * One group of settings: a form with its own button. The result of the save
 * is said right under the button, as a status for a success and an alert for
 * a failure; touching a field takes it away.
 */
export function GroupCard({
  id,
  title,
  hint,
  children,
  onSave,
  blocked,
}: {
  id: string;
  title: string;
  hint: string;
  children: ReactNode;
  /** Sends the group; throws when the server refuses it. */
  onSave: () => Promise<void>;
  /** True while a field holds a value the server would refuse. */
  blocked?: boolean;
}) {
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const saving = state.kind === "saving";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || blocked) return;
    setState({ kind: "saving" });
    try {
      await onSave();
      setState({ kind: "saved" });
    } catch (error) {
      setState({ kind: "error", message: saveErrorText(error) });
    }
  };

  return (
    <form
      onSubmit={submit}
      onChange={() => !saving && setState({ kind: "idle" })}
      onClick={() => !saving && state.kind !== "idle" && setState({ kind: "idle" })}
      aria-labelledby={`${id}-title`}
      className="min-w-0 space-y-4 rounded-lg border border-line bg-card p-4 sm:p-5"
    >
      <div className="space-y-1">
        <h2 id={`${id}-title`} className="text-base font-semibold">
          {title}
        </h2>
        <p className="text-sm text-muted">{hint}</p>
      </div>
      {children}
      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <button type="submit" className={buttonClass("primary")} disabled={saving || blocked}>
          {saving ? t.saving : t.save}
        </button>
        <div aria-live="polite" className="min-w-0 text-sm">
          {state.kind === "saved" && <p className="text-ok">{t.saved}</p>}
        </div>
      </div>
      {state.kind === "error" && (
        <ErrorNote>
          {t.saveFailed} {state.message}
        </ErrorNote>
      )}
    </form>
  );
}

/** A label above a control, with a hint under it. */
export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: ReactNode;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

/** The error shown under a field whose value the server would refuse. */
export function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="text-xs text-danger">
      {children}
    </p>
  );
}
