// Copy-to-clipboard logic of the desk, kept free of React and of the DOM so
// that it can be tested: the browser pieces are passed in as `CopyIo`.

/**
 * What a click on the copy button led to: `copied` (the text is in the
 * clipboard), `manual` (nothing could write to the clipboard: the text is
 * shown selected so that the user copies it with the keyboard).
 */
export type CopyResult = "copied" | "manual";

/** The state shown on the button. */
export type CopyState = "idle" | CopyResult;

export type CopyIo = {
  /** `navigator.clipboard.writeText`, missing outside secure contexts. */
  writeText?: (text: string) => Promise<void>;
  /** Fallback: selects the text and runs the legacy copy command. True when it worked. */
  legacyCopy: (text: string) => boolean;
};

/**
 * Copies a text. `writeText` is called synchronously, before anything is
 * awaited, so that it still runs inside the user gesture of the click.
 */
export function copyText(text: string, io: CopyIo): Promise<CopyResult> {
  let written: Promise<void>;
  try {
    written = io.writeText ? io.writeText(text) : Promise.reject(new Error("clipboard unavailable"));
  } catch (error) {
    written = Promise.reject(error);
  }
  return written.then(
    () => "copied",
    () => {
      try {
        return io.legacyCopy(text) ? "copied" : "manual";
      } catch {
        return "manual";
      }
    },
  );
}

/** How long the `copied` confirmation stays on the button. */
export const COPIED_RESET_MS = 2_000;

/** The button label for a state. */
export function copyLabel(state: CopyState, labels: Record<CopyState, string>): string {
  return labels[state];
}

/** The real browser pieces, for the component. */
export function browserCopyIo(): CopyIo {
  return {
    writeText: typeof navigator !== "undefined" && navigator.clipboard ? (text) => navigator.clipboard.writeText(text) : undefined,
    legacyCopy(text) {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      try {
        area.select();
        return document.execCommand("copy");
      } finally {
        document.body.removeChild(area);
      }
    },
  };
}
