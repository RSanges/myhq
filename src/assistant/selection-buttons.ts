import { strings } from "../ui/strings";
import type { Choice } from "./choices";
import type { InlineKeyboard } from "./telegram";

/** The Bot API shows a button label in full; ours are cut so that a line stays readable. */
export const BUTTON_LABEL_LIMIT = 40;

export type SelectionButton = { action: "toggle"; index: number } | { action: "send" } | { action: "cancel" };

/** One toggle button per choice (☐ or ☑ first), then « Valider la sélection » and « Annuler ». */
export function selectionKeyboard(choices: Choice[], selected: ReadonlySet<number>): InlineKeyboard {
  const t = strings.assistant.selection;
  return {
    inline_keyboard: [
      ...choices.map((choice, index) => {
        const label = choice.label.length > BUTTON_LABEL_LIMIT ? `${choice.label.slice(0, BUTTON_LABEL_LIMIT - 3).trimEnd()}...` : choice.label;
        return [{ text: `${selected.has(index) ? "☑" : "☐"} ${label}`, callback_data: `hq:s:${index}` }];
      }),
      [
        { text: t.validate, callback_data: "hq:s:ok" },
        { text: t.cancel, callback_data: "hq:s:no" },
      ],
    ],
  };
}

/** Reads the `callback_data` of a press on a selection keyboard. Null when it is not ours. */
export function parseSelectionData(data: string | undefined): SelectionButton | null {
  const match = /^hq:s:(ok|no|\d{1,2})$/.exec(data ?? "");
  if (!match) return null;
  if (match[1] === "ok") return { action: "send" };
  if (match[1] === "no") return { action: "cancel" };
  return { action: "toggle", index: Number(match[1]) };
}
