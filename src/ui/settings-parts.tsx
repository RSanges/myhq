"use client";

import { useEffect, useState, type Dispatch, type FormEvent, type ReactNode, type SetStateAction } from "react";
import { ApiError, errorText } from "./api";
import { rebase } from "./settings-model";
import { strings } from "./strings";
import { buttonClass, ErrorNote } from "./ui";

// Pieces shared by the tabs of the settings page: the form of a tab with its
// save bar (the button is active only after a change), its cards, the small
// fields and the switch.

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
 * The form of one tab: its cards, then a save bar that says whether
 * something changed, with « Annuler les changements » and « Enregistrer »,
 * both active only while the form differs from what is saved. The result of a
 * save is said in the bar (a status), a failure under it (an alert).
 */
export function TabForm({
  id,
  children,
  onSave,
  onReset,
  dirty,
  blocked,
  onDirtyChange,
}: {
  id: string;
  children: ReactNode;
  /** Sends the tab; throws when the server refuses it. */
  onSave: () => Promise<void>;
  /** Puts the saved values back in the form. */
  onReset: () => void;
  /** The form differs from what is saved. */
  dirty: boolean;
  /** A field holds a value the server would refuse. */
  blocked?: boolean;
  /** Told when `dirty` changes, for the dot on the tab. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const saving = state.kind === "saving";

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || blocked || !dirty) return;
    setState({ kind: "saving" });
    try {
      await onSave();
      setState({ kind: "saved" });
    } catch (error) {
      setState({ kind: "error", message: saveErrorText(error) });
    }
  };

  const status = saving
    ? t.savebar.saving
    : dirty
      ? blocked
        ? t.savebar.blocked
        : t.savebar.dirty
      : state.kind === "saved"
        ? t.saved
        : t.savebar.idle;
  const tone = dirty ? (blocked ? "text-danger" : "text-warn") : state.kind === "saved" ? "text-ok" : "text-muted";

  return (
    <form onSubmit={submit} aria-label={t.tabs.labels[id as keyof typeof t.tabs.labels]} className="min-w-0 space-y-4">
      {children}
      <div className="settings-savebar" data-dirty={dirty || undefined}>
        <p aria-live="polite" className={`min-w-0 text-sm ${tone}`}>
          {status}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={buttonClass()}
            disabled={!dirty || saving}
            onClick={() => {
              onReset();
              setState({ kind: "idle" });
            }}
          >
            {t.savebar.cancel}
          </button>
          <button type="submit" className={buttonClass("primary")} disabled={!dirty || saving || blocked}>
            {saving ? t.saving : t.save}
          </button>
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

/**
 * The form of a tab, built from the saved settings: when they change under
 * it (a save, a gesture), the values the owner did not touch follow them.
 * Returns the form, its setter, and the reset to the saved values.
 */
export function useSavedForm<T>(saved: T): [T, Dispatch<SetStateAction<T>>, () => void] {
  const [form, setForm] = useState(saved);
  const [previous, setPrevious] = useState(saved);
  if (previous !== saved) {
    setPrevious(saved);
    setForm((current) => rebase(current, previous, saved));
  }
  return [form, setForm, () => setForm(saved)];
}

/** A card of a tab: a title, a line under it, its fields. */
export function Card({ id, title, hint, children, aside }: { id: string; title: string; hint?: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-title`} className="min-w-0 space-y-4 rounded-lg border border-line bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h3 id={`${id}-title`} className="text-base font-semibold">
            {title}
          </h3>
          {hint && <p className="text-sm text-muted">{hint}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
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

/** An on/off switch (a button with role switch), labelled by its own text or `label`. */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  id,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="settings-switch"
    />
  );
}

/** Where a value comes from: myhq.json, a variable of .env.local, or the default. */
export function sourceText(source: "file" | "env" | "default" | "system", variable?: string): string {
  if (source === "file") return t.sources.file;
  if (source === "env") return t.sources.env(variable ?? "");
  if (source === "system") return t.sources.system;
  return t.sources.default;
}
