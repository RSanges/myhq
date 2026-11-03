import type { ChatAction } from "./actions";
import type { Choice } from "./choices";

/** The reason or comment a Reject or Revise button asks for. */
export type DecisionQuestion = {
  decision: "rejected" | "revise";
  approvalId: number;
  /** The alert whose buttons were pressed, edited once the decision is taken. */
  alert: { messageId: number; text: string } | null;
};

/** Actions of a chat turn that read untrusted content, held until the user says yes. */
export type ConfirmationQuestion = { actions: ChatAction[] };

/** A question asked to the user, answered by their next text message. */
export type PendingQuestion = DecisionQuestion | ConfirmationQuestion;

/** Like the questions of the previous bot, a question expires after one hour. */
export const QUESTION_TTL_MS = 60 * 60 * 1000;

export type PeekResult =
  | { status: "none" }
  | { status: "expired"; question: PendingQuestion }
  | { status: "active"; question: PendingQuestion };

/**
 * The one question the assistant waits an answer for (a single chat is
 * served). A new question replaces the previous one. An expired question is
 * reported once, then forgotten.
 */
export class PendingQuestions {
  private current: { question: PendingQuestion; askedAt: number } | null = null;

  constructor(private readonly ttlMs = QUESTION_TTL_MS) {}

  ask(question: PendingQuestion, now = Date.now()): void {
    this.current = { question, askedAt: now };
  }

  peek(now = Date.now()): PeekResult {
    if (!this.current) return { status: "none" };
    if (now - this.current.askedAt > this.ttlMs) {
      const { question } = this.current;
      this.current = null;
      return { status: "expired", question };
    }
    return { status: "active", question: this.current.question };
  }

  /**
   * Like `peek`, but only for actions held for a yes: a question that waits for
   * a reason (the Reject and Revise buttons) is left alone and reads as none.
   */
  peekConfirmation(now = Date.now()): PeekResult {
    if (this.current && !("actions" in this.current.question)) return { status: "none" };
    return this.peek(now);
  }

  /** The held actions, when they wait for a yes and the hour is not over. Does not forget anything. */
  heldActions(now = Date.now()): ChatAction[] | null {
    const current = this.current;
    if (!current || !("actions" in current.question) || now - current.askedAt > this.ttlMs) return null;
    return current.question.actions;
  }

  clear(): void {
    this.current = null;
  }
}

/** A selection list sent with its keyboard: the items, and which ones are ticked. */
export type Selection = { choices: Choice[]; selected: Set<number>; text: string };

/** The most selection keyboards that stay alive at once (the oldest one expires first). */
export const MAX_SELECTIONS = 10;

/**
 * The selection keyboards on Telegram, by the id of the message that carries
 * them. A keyboard expires after one hour, like a question; an expired one is
 * forgotten when it is looked up.
 */
export class PendingSelections {
  private readonly byMessage = new Map<number, { selection: Selection; askedAt: number }>();

  constructor(private readonly ttlMs = QUESTION_TTL_MS) {}

  add(messageId: number, selection: Selection, now = Date.now()): void {
    this.byMessage.set(messageId, { selection, askedAt: now });
    while (this.byMessage.size > MAX_SELECTIONS) this.byMessage.delete(this.byMessage.keys().next().value!);
  }

  /** The keyboard's selection, or null when it never existed, is over or has expired. */
  get(messageId: number, now = Date.now()): Selection | null {
    const entry = this.byMessage.get(messageId);
    if (!entry) return null;
    if (now - entry.askedAt > this.ttlMs) {
      this.byMessage.delete(messageId);
      return null;
    }
    return entry.selection;
  }

  remove(messageId: number): void {
    this.byMessage.delete(messageId);
  }
}
