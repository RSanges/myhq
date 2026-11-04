import { strings } from "../ui/strings";
import type { InlineKeyboard } from "./telegram";

export type ButtonAction = "approve" | "reject" | "revise" | "seen";

const CODES: Record<ButtonAction, string> = { approve: "a", reject: "r", revise: "v", seen: "w" };

const button = (action: ButtonAction, text: string, approvalId: number) => ({
  text,
  callback_data: `hq:${CODES[action]}:${approvalId}`,
});

/** The buttons of a pending-approval alert. */
export function approvalKeyboard(approvalId: number): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        button("approve", strings.desk.approve, approvalId),
        button("reject", strings.desk.reject, approvalId),
        button("revise", strings.desk.revise, approvalId),
      ],
    ],
  };
}

/** The one button of an informational alert (« À regarder »): « Vu », same as the desk's. */
export function seenKeyboard(approvalId: number): InlineKeyboard {
  return { inline_keyboard: [[button("seen", strings.desk.seen, approvalId)]] };
}

/** Reads the `callback_data` of a button press. Null when it is not ours. */
export function parseButtonData(data: string | undefined): { action: ButtonAction; approvalId: number } | null {
  const match = /^hq:([arvw]):(\d{1,9})$/.exec(data ?? "");
  if (!match) return null;
  const action = (Object.keys(CODES) as ButtonAction[]).find((key) => CODES[key] === match[1])!;
  return { action, approvalId: Number(match[2]) };
}
