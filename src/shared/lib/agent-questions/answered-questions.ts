/**
 * A user's answer to a structured question the agent asked.
 *
 * The answer travels as an ordinary follow-up message — the ruling in
 * `docs/decisions/agent-user-question-mechanism.md`. What makes it render as a card rather than a
 * bare bubble is `metadata.answeredQuestions` on the message, NOT anything embedded in its text:
 * the AI SDK's `convertToModelMessages` only ever reads `parts`, so display metadata cannot reach
 * the model by construction. That guarantee is the point — an in-text marker would instead oblige
 * every consumer (model prompt, replayed history, search index, rollback composer, clipboard, title
 * naming) to remember to strip it, which is exactly how the trigger/task markers came to leak.
 *
 */

/** One answered question: the question's short heading, and what the user picked. */
export type AnsweredQuestion = { label: string; answer: string };

/**
 * The tool-part result recorded when a question's window expires unanswered.
 *
 * Shared because the two ends are in different processes: main writes it onto the part (the model
 * is never told — the held call stays unanswered), and the renderer matches it to draw "Timed out"
 * rather than falling through to a red error the user cannot act on.
 */
export const QUESTION_TIMED_OUT_RESULT = 'Timed out';

/** The question fields both producers share — a subset of the shared `AgentUserQuestion` type. */
type LabelledQuestion = { question: string; header: string };

/**
 * Pair each question with its answer, dropping the ones left blank. Keyed on `question` because that
 * is the key the answer maps are built under (`AgentUserQuestion`'s `formattedAnswers`); displayed
 * as `header`, which is a required, boundary-validated field (`agentUserQuestionSchema`) — so there
 * is no fallback here on purpose.
 */
export function toAnsweredQuestions(
  questions: ReadonlyArray<LabelledQuestion>,
  answers: Record<string, string>,
): AnsweredQuestion[] {
  return questions
    .map((q) => ({ label: q.header, answer: answers[q.question]?.trim() ?? '' }))
    .filter((entry) => entry.answer.length > 0);
}

/**
 * Everything a producer needs: the model-visible `text` and the ready-to-attach display-only
 * `metadata`. Owning the metadata shape here keeps callers from importing the type just to build it.
 * Null when nothing was picked — every caller reads that as "don't send" (and, for a card, "un-stick
 * yourself").
 *
 * Each question is restated above its answer. An answer always arrives in a LATER turn, and a park
 * ends the asking turn with its `AskUserQuestion` call unanswered; on resume the CLI pairs that
 * call with a neutral "permission stream closed" error (measured 2026-08-04), so the agent
 * normally still has the question and its reasoning. The restatement stays because it costs
 * nothing and pins WHICH question a late answer addresses — a park raised via `frink_task_signal`
 * may have asked in prose several turns back, where a bare "Now" would attach to nothing.
 *
 * The agent has not lost its work, and this deliberately carries no "re-check state, you may have
 * already done things" warning — that was in an earlier revision and was simply false.
 */
export function buildAnswerMessage(
  questions: ReadonlyArray<LabelledQuestion>,
  answers: Record<string, string>,
): { text: string; metadata: { answeredQuestions: AnsweredQuestion[] } } | null {
  const answered = toAnsweredQuestions(questions, answers);
  if (answered.length === 0) return null;
  const text = questions
    .map((q) => ({ question: q.question, answer: answers[q.question]?.trim() ?? '' }))
    .filter((entry) => entry.answer.length > 0)
    .map((entry) => `Q: ${entry.question}\nA: ${entry.answer}`)
    .join('\n\n');
  return { text, metadata: { answeredQuestions: answered } };
}

/** Narrow `metadata.answeredQuestions` off a persisted message, which is `unknown` at the boundary. */
export function readAnsweredQuestions(value: unknown): AnsweredQuestion[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.every(isAnsweredQuestion) ? value : null;
}

function isAnsweredQuestion(value: unknown): value is AnsweredQuestion {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.label === 'string' && typeof entry.answer === 'string';
}
