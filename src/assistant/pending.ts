import type { ChatAction } from "./actions";

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

  clear(): void {
    this.current = null;
  }
}
