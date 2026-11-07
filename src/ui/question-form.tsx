"use client";

import type { Question } from "@/server/questions";
import { emptyDraft, toggleOption, toggleOther, typeOther, type QuestionDraft } from "./question-model";
import { strings } from "./strings";
import { fieldClass } from "./ui";

/**
 * The questions of an item of questions (hq_ask), each with its options as
 * radio buttons (check boxes for a multi-select question) and « Autre » with a
 * free text. The drafts belong to the caller, one per question.
 */
export function QuestionForm({
  itemId,
  questions,
  drafts,
  onChange,
  disabled,
}: {
  itemId: number;
  questions: readonly Question[];
  drafts: readonly QuestionDraft[];
  onChange: (index: number, next: QuestionDraft) => void;
  disabled: boolean;
}) {
  const t = strings.question.desk;
  return (
    <div className="space-y-4">
      {questions.map((question, index) => {
        const draft = drafts[index] ?? emptyDraft();
        const kind = question.multiSelect ? "checkbox" : "radio";
        const group = `q-${itemId}-${index}`;
        return (
          <fieldset key={index} className="space-y-2" disabled={disabled}>
            <legend className="text-sm font-medium">
              <span className="text-muted">{index + 1}. </span>
              {question.header && (
                <span className="mr-1.5 rounded bg-soft px-1.5 py-0.5 text-xs font-medium text-muted">{question.header}</span>
              )}
              {question.question}
            </legend>
            <p className="text-xs text-muted">{question.multiSelect ? t.chooseMany : t.choose}</p>
            <ul className="space-y-1">
              {question.options.map((option, optionIndex) => (
                <li key={optionIndex}>
                  <label className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-soft">
                    <input
                      type={kind}
                      name={group}
                      className="mt-1 shrink-0"
                      checked={draft.options.includes(optionIndex)}
                      onChange={() => onChange(index, toggleOption(question, draft, optionIndex))}
                    />
                    <span className="min-w-0 break-words">
                      {option.label}
                      {option.description && <span className="block text-xs text-muted">{option.description}</span>}
                    </span>
                  </label>
                </li>
              ))}
              <li>
                <div className="flex flex-wrap items-start gap-2 rounded-md px-2 py-1.5 text-sm">
                  <label className="flex shrink-0 cursor-pointer items-center gap-2">
                    <input
                      type={kind}
                      name={group}
                      checked={draft.otherOn}
                      onChange={() => onChange(index, toggleOther(question, draft))}
                    />
                    {t.otherLabel}
                  </label>
                  <input
                    type="text"
                    aria-label={t.otherField(index + 1)}
                    className={`${fieldClass} min-w-0 flex-1`}
                    value={draft.other}
                    maxLength={5000}
                    onChange={(event) => onChange(index, typeOther(question, draft, event.target.value))}
                  />
                </div>
              </li>
            </ul>
          </fieldset>
        );
      })}
    </div>
  );
}
