// The answers being drafted on the desk for an item of questions (hq_ask), kept
// free of the DOM so that they can be tested on their own.

import type { Answer, Question } from "@/server/questions";

/** What is ticked for one question: options by index, and « Autre » with its text. */
export type QuestionDraft = { options: number[]; otherOn: boolean; other: string };

export const emptyDraft = (): QuestionDraft => ({ options: [], otherOn: false, other: "" });

/**
 * Ticks or unticks an option. A single-select question takes one answer: an
 * option replaces the previous one and « Autre ». A multi-select one toggles.
 */
export function toggleOption(question: Question, draft: QuestionDraft, option: number): QuestionDraft {
  if (!question.multiSelect) return { ...draft, options: [option], otherOn: false };
  const options = draft.options.includes(option) ? draft.options.filter((o) => o !== option) : [...draft.options, option];
  return { ...draft, options };
}

/** Ticks « Autre »: in a single-select question it replaces the option; in a multi-select one it toggles. */
export function toggleOther(question: Question, draft: QuestionDraft): QuestionDraft {
  if (!question.multiSelect) return { ...draft, options: [], otherOn: true };
  return { ...draft, otherOn: !draft.otherOn };
}

/** Typing in the « Autre » field ticks it. */
export function typeOther(question: Question, draft: QuestionDraft, text: string): QuestionDraft {
  return { options: question.multiSelect ? draft.options : [], otherOn: true, other: text };
}

/**
 * The answer a draft stands for, or null while the question has none: nothing
 * ticked, or « Autre » ticked with no text.
 */
export function draftAnswer(draft: QuestionDraft): Answer | null {
  const other = draft.otherOn ? draft.other.trim() : "";
  if (draft.otherOn && other === "") return null;
  if (draft.options.length === 0 && other === "") return null;
  return { options: [...draft.options].sort((a, b) => a - b), ...(other ? { other } : {}) };
}

/** The answers of every question, or null while one is missing. */
export function draftAnswers(questions: readonly Question[], drafts: readonly QuestionDraft[]): Answer[] | null {
  const answers = questions.map((_, index) => draftAnswer(drafts[index] ?? emptyDraft()));
  return answers.every((answer): answer is Answer => answer !== null) ? answers : null;
}

/** How many questions still have no answer. */
export function unanswered(questions: readonly Question[], drafts: readonly QuestionDraft[]): number {
  return questions.filter((_, index) => draftAnswer(drafts[index] ?? emptyDraft()) === null).length;
}
