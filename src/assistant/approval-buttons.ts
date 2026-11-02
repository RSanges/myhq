import { strings } from "../ui/strings";
import type { InlineKeyboard } from "./telegram";

export type ButtonAction = "approve" | "reject" | "revise";

const CODES: Record<ButtonAction, string> = { approve: "a", reject: "r", revise: "v" };

/** The buttons of a pending-approval alert. */
export function approvalKeyboard(approvalId: number): InlineKeyboard {
  const button = (action: ButtonAction, text: string) => ({ text, callback_data: `hq:${CODES[action]}:${approvalId}` });
  return {
    inline_keyboard: [
      [
        button("approve", strings.desk.approve),
        button("reject", strings.desk.reject),
        button("revise", strings.desk.revise),
      ],
    ],
  };
}

/** Reads the `callback_data` of a button press. Null when it is not ours. */
export function parseButtonData(data: string | undefined): { action: ButtonAction; approvalId: number } | null {
  const match = /^hq:([arv]):(\d{1,9})$/.exec(data ?? "");
  if (!match) return null;
  const action = (Object.keys(CODES) as ButtonAction[]).find((key) => CODES[key] === match[1])!;
  return { action, approvalId: Number(match[2]) };
}
