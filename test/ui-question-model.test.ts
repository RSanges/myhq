import assert from "node:assert/strict";
import { test } from "node:test";
import type { Question } from "../src/server/questions";
import {
  draftAnswer,
  draftAnswers,
  emptyDraft,
  toggleOption,
  toggleOther,
  typeOther,
  unanswered,
} from "../src/ui/question-model";

const single: Question = { question: "Tone?", options: [{ label: "Playful" }, { label: "Serious" }] };
const multi: Question = { question: "Channels?", multiSelect: true, options: [{ label: "Blog" }, { label: "Social" }, { label: "Mail" }] };

test("a single-select question takes one option, or Autre with a text, never both", () => {
  let draft = toggleOption(single, emptyDraft(), 1);
  assert.deepEqual(draftAnswer(draft), { options: [1] });
  draft = toggleOption(single, draft, 0);
  assert.deepEqual(draftAnswer(draft), { options: [0] }, "a new option replaces the first");
  draft = toggleOther(single, draft);
  assert.equal(draftAnswer(draft), null, "Autre without a text is no answer");
  draft = typeOther(single, draft, "  Dry  ");
  assert.deepEqual(draftAnswer(draft), { options: [], other: "Dry" });
  draft = toggleOption(single, draft, 1);
  assert.deepEqual(draftAnswer(draft), { options: [1] }, "an option takes Autre off");
});

test("typing in Autre ticks it", () => {
  const draft = typeOther(single, toggleOption(single, emptyDraft(), 0), "Neither");
  assert.deepEqual(draft, { options: [], otherOn: true, other: "Neither" });
});

test("a multi-select question toggles options and mixes them with Autre", () => {
  let draft = emptyDraft();
  assert.equal(draftAnswer(draft), null);
  draft = toggleOption(multi, draft, 2);
  draft = toggleOption(multi, draft, 0);
  assert.deepEqual(draftAnswer(draft), { options: [0, 2] }, "in ascending order");
  draft = toggleOption(multi, draft, 2);
  assert.deepEqual(draftAnswer(draft), { options: [0] });
  draft = typeOther(multi, draft, "Podcast");
  assert.deepEqual(draftAnswer(draft), { options: [0], other: "Podcast" }, "Autre adds to the options");
  draft = toggleOther(multi, draft);
  assert.deepEqual(draftAnswer(draft), { options: [0] }, "unticking Autre drops its text from the answer");
});

test("the answers are complete when every question has one", () => {
  const questions = [single, multi];
  assert.equal(draftAnswers(questions, [toggleOption(single, emptyDraft(), 0)]), null);
  assert.equal(unanswered(questions, [toggleOption(single, emptyDraft(), 0)]), 1);
  assert.equal(unanswered(questions, []), 2);
  const drafts = [toggleOption(single, emptyDraft(), 0), toggleOption(multi, emptyDraft(), 1)];
  assert.deepEqual(draftAnswers(questions, drafts), [{ options: [0] }, { options: [1] }]);
  assert.equal(unanswered(questions, drafts), 0);
});
