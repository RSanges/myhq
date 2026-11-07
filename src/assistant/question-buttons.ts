import { strings } from "../ui/strings";
import { BUTTON_LABEL_LIMIT } from "./selection-buttons";
import type { InlineKeyboard } from "./telegram";

/** A press on the keyboard of a question: an option (picked, or toggled in a multi-select question) or « Valider ». */
export type QuestionButton = { approvalId: number; question: number; action: "option"; option: number } | {
  approvalId: number;
  question: number;
  action: "validate";
};

const cut = (label: string) => (label.length > BUTTON_LABEL_LIMIT ? `${label.slice(0, BUTTON_LABEL_LIMIT - 3).trimEnd()}...` : label);

/**
 * The buttons of one question of an item (hq_ask): one per option; in a
 * multi-select question each one is ticked or not, and « Valider » closes it.
 * « Autre » has no button: it is a reply to the question's message. The
 * callback data names the item and the question (`hq:q:<id>:<question>:<option|ok>`,
 * 64 bytes at most), so a press means something after a restart too.
 */
export function questionKeyboard(
  approvalId: number,
  question: number,
  labels: readonly string[],
  multiSelect: boolean,
  selected: ReadonlySet<number> = new Set(),
): InlineKeyboard {
  const rows = labels.map((label, option) => [
    {
      text: `${multiSelect ? (selected.has(option) ? "☑ " : "☐ ") : ""}${option + 1}. ${cut(label)}`,
      callback_data: `hq:q:${approvalId}:${question}:${option}`,
    },
  ]);
  if (multiSelect) rows.push([{ text: strings.assistant.selection.validate, callback_data: `hq:q:${approvalId}:${question}:ok` }]);
  return { inline_keyboard: rows };
}

/** Reads the `callback_data` of a press on a question keyboard. Null when it is not ours. */
export function parseQuestionData(data: string | undefined): QuestionButton | null {
  const match = /^hq:q:(\d{1,9}):(\d{1,2}):(ok|\d)$/.exec(data ?? "");
  if (!match) return null;
  const base = { approvalId: Number(match[1]), question: Number(match[2]) };
  return match[3] === "ok" ? { ...base, action: "validate" } : { ...base, action: "option", option: Number(match[3]) };
}
