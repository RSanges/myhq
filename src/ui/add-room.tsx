"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { errorText, startOnboarding } from "./api";
import { DirBrowser } from "./dir-browser";
import type { Action } from "./model";
import { strings } from "./strings";
import { buttonClass, ErrorNote, fieldClass } from "./ui";

/**
 * The « Ajouter une salle » form: the path of a repository, and the button that
 * starts the onboarding agent on it (`POST /api/onboarding`); its room proposal
 * arrives on the desk. « Parcourir » opens a folder explorer that fills the field
 * (a browser never gives the path of a folder picked in its own dialog); the
 * field stays for whoever prefers to type. Shared by the desk (inside a disclosure) and by the sheet
 * of the receptionist on the floor.
 */
export function AddRoomForm({ dispatch }: { dispatch: (action: Action) => void }) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<number | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const t = strings.team.addRoom;
  const id = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (path.trim() === "") return;
    setBusy(true);
    setError(null);
    setStarted(null);
    try {
      const run = await startOnboarding(path);
      dispatch({ type: "run", run });
      setStarted(run.id);
      setPath("");
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="space-y-2" onSubmit={(event) => void submit(event)}>
      <label htmlFor={`${id}-path`} className="block text-sm font-medium">
        {t.label}
      </label>
      <div className="flex gap-2">
        <input
          ref={inputRef}
          id={`${id}-path`}
          className={`${fieldClass} min-w-0 flex-1`}
          value={path}
          maxLength={1000}
          required
          onChange={(event) => setPath(event.target.value)}
          aria-describedby={`${id}-hint`}
        />
        <button type="button" className={`${buttonClass()} shrink-0`} onClick={() => setBrowsing(true)}>
          {t.browse}
        </button>
      </div>
      {browsing && (
        <DirBrowser
          onClose={() => setBrowsing(false)}
          onChoose={(chosen) => {
            setPath(chosen);
            setStarted(null);
            setBrowsing(false);
            // The window gives focus back to « Parcourir » as it closes; the next step is the field.
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
        />
      )}
      <p id={`${id}-hint`} className="text-xs text-muted">
        {t.hint}
      </p>
      <button type="submit" className={buttonClass("primary")} disabled={busy || path.trim() === ""}>
        {busy ? t.starting : t.submit}
      </button>
      {error && <ErrorNote>{error}</ErrorNote>}
      {started !== null && !error && (
        <p role="status" className="text-sm text-ok">
          {t.started(started)}
        </p>
      )}
    </form>
  );
}
