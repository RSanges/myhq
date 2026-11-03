// Selection lists: a chat reply that holds a GFM task list (`- [ ] label`) is
// a list of choices the user ticks, on the desk and on Telegram. This module
// is pure (no server code) so that the panel and the bridge share it.

import { strings } from "../ui/strings";

/** One item of a selection list. */
export type Choice = {
  /** The short id the label starts with (`1`, `A2`), or null when it has none. */
  id: string | null;
  /** The label as written, id included. */
  label: string;
};

/** A task list with more items than this stays plain text. */
export const MAX_CHOICES = 12;

const TASK_LINE = /^\s{0,3}[-*+]\s+\[ \]\s+(\S.*?)\s*$/;
const LEADING_ID = /^([A-Za-z]?\d{1,4})[.)]\s+\S/;

/** The task-list lines of a reply (unchecked items only), and the lines that are not. */
function split(text: string): { items: string[]; rest: string[] } {
  const items: string[] = [];
  const rest: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = TASK_LINE.exec(line);
    if (match) items.push(match[1]!);
    else rest.push(line);
  }
  return { items, rest };
}

/**
 * The choices of a reply: its task-list items in order, or null when there is
 * no such list or it has more than MAX_CHOICES items.
 */
export function extractChoices(text: string): Choice[] | null {
  const { items } = split(text);
  if (items.length === 0 || items.length > MAX_CHOICES) return null;
  return items.map((label) => ({ id: LEADING_ID.exec(label)?.[1] ?? null, label }));
}

/** The reply without its task-list lines, for a view that shows the choices apart. */
export function textWithoutChoices(text: string): string {
  return split(text).rest.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** What is sent for a ticked choice: its id, or the whole label when it has none. */
export function choiceValue(choice: Choice): string {
  return choice.id ?? choice.label;
}

/** The message the selection becomes: `Sélection : 1, 3, 5`. */
export function selectionMessage(choices: Choice[], selected: ReadonlySet<number>): string {
  const values = choices.filter((_, index) => selected.has(index)).map(choiceValue);
  return strings.assistant.selection.message(values);
}
