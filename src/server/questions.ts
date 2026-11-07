import { z } from "zod";
import { strings } from "../ui/strings";
import { HqError } from "./errors";

/** The type of the approval item `hq_ask` creates: questions of an agent, answered instead of approved. */
export const QUESTION_TYPE = "question";

/** A technical guard, not a design limit: the owner answers every question the agent asks. */
export const MAX_QUESTIONS = 20;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 6;

const optionSchema = z.strictObject({
  label: z.string().trim().min(1).max(200).describe("The answer, in a few words."),
  description: z.string().trim().min(1).max(1_000).optional().describe("What choosing it means or implies."),
});
export type QuestionOption = z.infer<typeof optionSchema>;

export const questionSchema = z.strictObject({
  question: z.string().trim().min(1).max(1_000).describe("The question, complete, ending with a question mark."),
  header: z.string().trim().min(1).max(30).optional().describe("A very short tag for the question (a word or two)."),
  options: z
    .array(optionSchema)
    .min(MIN_OPTIONS)
    .max(MAX_OPTIONS)
    .describe(`${MIN_OPTIONS} to ${MAX_OPTIONS} concrete answers. MyHQ always adds an "Other" answer with free text: do not add one.`),
  multiSelect: z.boolean().optional().describe("true: the owner may pick several answers. Default: exactly one."),
});
export type Question = z.infer<typeof questionSchema>;

export const questionsSchema = z.array(questionSchema).min(1).max(MAX_QUESTIONS);

/** What is stored in the payload of a question item: the questions, then the answers once given. */
export type QuestionPayload = {
  context?: string;
  questions: Question[];
  answers?: Answer[];
};

/**
 * The answer to one question: the options picked (by index in the question's
 * `options`) and/or the free text of « Autre ». A single-select question takes
 * one or the other; a multi-select one takes any mix, at least one thing.
 */
export const answerSchema = z.strictObject({
  options: z.array(z.number().int().min(0).max(MAX_OPTIONS - 1)).max(MAX_OPTIONS),
  other: z.string().trim().min(1).max(5_000).optional(),
});
export type Answer = z.infer<typeof answerSchema>;

export const answersSchema = z.array(answerSchema).min(1).max(MAX_QUESTIONS);

/** The payload of a stored question item, or null when it is not readable as one. */
export function parseQuestionPayload(payload: unknown): QuestionPayload | null {
  const parsed = z
    .object({
      context: z.string().optional(),
      questions: questionsSchema,
      answers: answersSchema.optional(),
    })
    .safeParse(payload);
  return parsed.success ? parsed.data : null;
}

/**
 * Checks the answers against the questions: one answer per question, options
 * that exist and appear once, a single choice for a single-select question,
 * something answered everywhere. Throws `INVALID_ANSWERS` (422) otherwise.
 */
export function assertAnswers(questions: readonly Question[], answers: readonly Answer[]): void {
  const fail = (message: string): never => {
    throw new HqError("INVALID_ANSWERS", 422, message);
  };
  if (answers.length !== questions.length) fail(`Expected ${questions.length} answers, got ${answers.length}.`);
  questions.forEach((question, index) => {
    const answer = answers[index]!;
    const where = `Question ${index + 1}`;
    if (answer.options.some((option) => option >= question.options.length)) fail(`${where}: an option does not exist.`);
    if (new Set(answer.options).size !== answer.options.length) fail(`${where}: an option is picked twice.`);
    const picked = answer.options.length + (answer.other ? 1 : 0);
    if (picked === 0) fail(`${where}: no answer.`);
    if (!question.multiSelect && picked > 1) fail(`${where}: this question takes a single answer.`);
  });
}

/** The answer as text: the labels picked, then the free text of « Autre » (written by `other`). */
export function answerText(question: Question, answer: Answer, other: (text: string) => string = strings.question.other): string {
  const labels = answer.options.map((option) => question.options[option]!.label);
  return [...labels, ...(answer.other ? [other(answer.other)] : [])].join(", ");
}

/**
 * The body of a question item, for the history and the search: the context,
 * then each question with its options, « Autre » last. Markdown, in the
 * owner's language.
 */
export function renderQuestionsBody(context: string | undefined, questions: readonly Question[]): string {
  const t = strings.question;
  const blocks = questions.map((question, index) => {
    const head = `${index + 1}. ${question.header ? `${t.headerTag(question.header)} ` : ""}${question.question}`;
    const options = question.options.map((option) => `- ${option.label}${option.description ? ` : ${option.description}` : ""}`);
    return [head, ...(question.multiSelect ? [t.multiple] : []), ...options, `- ${t.otherOption}`].join("\n");
  });
  return [...(context ? [context] : []), ...blocks].join("\n\n");
}

/** « Q : … / R : … » for each question: the `decision_note` of an answered item, read by the owner. */
export function answersNote(questions: readonly Question[], answers: readonly Answer[]): string {
  return questions.map((question, index) => strings.question.line(question.question, answerText(question, answers[index]!))).join("\n");
}

/** The task that wakes the agent: its questions and the owner's answers. English, like the revision task. */
export function answersTaskText(id: number, title: string, questions: readonly Question[], answers: readonly Answer[]): string {
  const lines = questions.flatMap((question, index) => [
    `Q${index + 1}: ${question.question}`,
    `A${index + 1}: ${answerText(question, answers[index]!, (text) => `Other: ${text}`)}`,
  ]);
  return [
    `The owner answered your questions #${id} "${title}".`,
    ...lines,
    "Go on with your work using these answers; do not ask the same questions again.",
  ].join("\n");
}
