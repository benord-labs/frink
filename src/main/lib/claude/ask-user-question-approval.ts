import log from 'electron-log';
import { isPlainObject } from '../../../shared/lib/case-converter';
import type { AgentUserQuestion, TaskSignalPayload } from '../../../shared/types/task-signal';
import { PERMISSION_PROMPT_TIMEOUT_MS } from '../permissions/constants';
import { agentUserQuestionsSchema, QUESTION_TEXT_MAX } from '../trpc/routers/frink-task-signal';
import type { UIMessageChunk } from './types';

export type PendingToolApprovalDecision = {
  approved: boolean;
  message?: string;
  updatedInput?: unknown;
};

/** A bounded, renderer-safe view of a native AskUserQuestion provider hold. */
export type PendingQuestionProjection = {
  chatId: string;
  subChatId: string;
  toolUseId: string;
  questions: AgentUserQuestion[];
};

export type PendingToolApprovalEntry = {
  subChatId: string;
  taskId?: string;
  /**
   * Projection fields. Set only by an AskUserQuestion hold (the map's one producer) — other
   * pending-approval callers (steering's open-approval check, wake-hold tests) never populate
   * these and are correctly invisible to the question-recovery queries below.
   */
  chatId?: string;
  questions?: AgentUserQuestion[];
  /** `false` means a competing lifecycle transition already won and the entry must stay put. */
  resolve: (decision: PendingToolApprovalDecision) => boolean | undefined;
};

/** Shared across tRPC stream and socket executor so `respondToolApproval` resolves in both paths. */
export const pendingToolApprovals = new Map<string, PendingToolApprovalEntry>();

/** Resolve one exact entry without deleting a replacement registered under the same tool id. */
export function resolvePendingToolApproval(
  toolUseId: string,
  decision: PendingToolApprovalDecision,
): boolean {
  const pending = pendingToolApprovals.get(toolUseId);
  if (!pending) return false;
  if (pending.resolve(decision) === false) return false;
  if (pendingToolApprovals.get(toolUseId) === pending) {
    pendingToolApprovals.delete(toolUseId);
  }
  return true;
}

/** Renderer-safe recovery view of every AskUserQuestion hold open on one sub-chat. */
export function listPendingQuestionProjections(subChatId: string): PendingQuestionProjection[] {
  const matches: PendingQuestionProjection[] = [];
  for (const [toolUseId, entry] of pendingToolApprovals) {
    if (entry.subChatId !== subChatId || !entry.chatId || !entry.questions) continue;
    matches.push({
      chatId: entry.chatId,
      subChatId: entry.subChatId,
      toolUseId,
      questions: entry.questions,
    });
  }
  return matches;
}

/** Identity-only recovery index; question contents stay behind the per-sub-chat bounded seed. */
export function listPendingQuestionSubChatIds(): string[] {
  const subChatIds = new Set<string>();
  for (const entry of pendingToolApprovals.values()) {
    if (entry.chatId && entry.questions) subChatIds.add(entry.subChatId);
  }
  return [...subChatIds];
}

export function clearPendingApprovals(message: string, subChatId?: string): void {
  for (const [toolUseId, pending] of pendingToolApprovals) {
    if (subChatId && pending.subChatId !== subChatId) continue;
    resolvePendingToolApproval(toolUseId, { approved: false, message });
  }
}

const ASK_FALLBACK_QUESTIONS: AgentUserQuestion[] = [
  {
    question:
      'The agent asked a follow-up question that could not be displayed. Ask it to restate the choices, or type your answer.',
    header: 'Follow-up question',
    options: [
      {
        label: 'Ask again',
        description: 'Ask the agent to restate its question and available choices.',
      },
    ],
    multiSelect: false,
  },
];

/**
 * `canUseTool` handler for EVERY AskUserQuestion: HOLD the call, and never answer it on expiry.
 *
 * A question is usually asked while its owner is at the machine, so the tool is left to behave
 * natively — the call stays open and, if the answer arrives in time, it returns the real `{answers}`
 * and the turn simply continues. Nothing is parked and the model is told nothing, because nothing
 * happened worth telling it.
 *
 * When the window expires the run is parked and the TURN IS ENDED with the call still unanswered.
 * That is deliberate, and it is not a matter of taste: the CLI DISCARDS a `canUseTool` deny message
 * and substitutes its own canned "the user doesn't want to proceed … STOP what you are doing". So an
 * expiry we answer reaches the model as a hard user refusal, indistinguishable from a real one, and
 * the agent stops. Silence is the only ending that does not lie to it.
 *
 * On resume the asking turn survives: the CLI pairs the killed call with a neutral "permission
 * stream closed" error during its exit grace, so the agent keeps its question and reasoning and is
 * never told the user refused. See `docs/decisions/agent-user-question-mechanism.md`.
 */
export async function holdQuestionUntilAnswered(params: {
  toolUseID: string;
  toolInput: Record<string, unknown>;
  chatId: string;
  subChatId: string;
  /** Emits the live question card, so the held call has a surface to be answered through. */
  emitChunk: (chunk: UIMessageChunk) => void;
  /**
   * Park the run and kill the turn. INJECTED rather than imported: reaching for the MCP server or
   * the executor from here closes an import cycle, the same constraint createModeFlip's `notify`
   * documents. Must park BEFORE aborting — the teardown reconcile would CAS a later park to
   * `cancelled`, which is why `pauseFlowRunForSubChat` orders it the same way.
   */
  parkAndKill: (signal: TaskSignalPayload, onPersisted: () => void) => Promise<void>;
}): Promise<
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string }
> {
  const { toolUseID, toolInput, chatId, subChatId, emitChunk, parkAndKill } = params;

  const recoverableQuestions =
    buildAskUserQuestionParkSignal(toolInput).questions ?? ASK_FALLBACK_QUESTIONS;

  const emitLiveQuestion = (): void => {
    emitChunk({
      type: 'ask-user-question',
      toolUseId: toolUseID,
      questions: recoverableQuestions,
    } as UIMessageChunk);
  };
  emitLiveQuestion();

  const response = await new Promise<PendingToolApprovalDecision>((resolve) => {
    const lifecycle: { state: 'holding' | 'answered' | 'parking' | 'parked' } = {
      state: 'holding',
    };
    let parkPersisted = false;
    let deferredDenial: PendingToolApprovalDecision | undefined;
    const pending: PendingToolApprovalEntry = {
      subChatId,
      chatId,
      questions: recoverableQuestions,
      resolve: (decision) => {
        if (lifecycle.state === 'parking') {
          // Stop/skip owns the provider if the durable park later fails. Remember only denials:
          // an answer whose router response was {ok:false} must remain visibly retryable.
          if (!decision.approved) deferredDenial ??= decision;
          return false;
        }
        if (lifecycle.state !== 'holding') return false;
        lifecycle.state = 'answered';
        clearTimeout(timeoutId);
        resolve(decision);
        return true;
      },
    };
    const timeoutId = setTimeout(() => {
      // The state change is the answer-versus-park CAS. Router/teardown resolutions that arrive
      // after it return false and cannot send a tool result to the model on its way out.
      if (lifecycle.state !== 'holding') return;
      lifecycle.state = 'parking';
      void parkAndKill(buildAskUserQuestionParkSignal(toolInput), () => {
        parkPersisted = true;
        // The durable awaiting_input write is now the answer surface. Only now may the live native
        // card disappear; deleting it earlier can swallow an answer if persistence loses the race.
        if (pendingToolApprovals.get(toolUseID) === pending) {
          pendingToolApprovals.delete(toolUseID);
        }
        emitChunk({ type: 'ask-user-question-timeout', toolUseId: toolUseID } as UIMessageChunk);
      })
        .then(() => {
          lifecycle.state = 'parked';
        })
        .catch((error) => {
          log.error('[Socket Executor] Failed to park a held AskUserQuestion', {
            subChatId,
            stage: parkPersisted ? 'cleanup' : 'persistence',
            error: error instanceof Error ? error.message : String(error),
          });
          if (!parkPersisted) {
            if (deferredDenial) {
              lifecycle.state = 'answered';
              if (pendingToolApprovals.get(toolUseID) === pending) {
                pendingToolApprovals.delete(toolUseID);
              }
              resolve(deferredDenial);
            } else {
              // The provider call is still live. Put the latch back so the user can answer. The
              // renderer retires the card only on a chunk carrying this question's own toolUseId —
              // which the failed park's partial teardown may have produced — so re-emit the live card.
              lifecycle.state = 'holding';
              emitChunk({
                type: 'error',
                errorText:
                  'Frink could not park this question. It remains answerable and its execution remains active.',
              });
              emitLiveQuestion();
            }
          } else {
            // Durable park won, but exact cleanup did not. Keep the admission occupied and surface
            // the failure; claiming `parked` here would allow the controller to oversubscribe.
            emitChunk({
              type: 'error',
              errorText:
                'The question was saved, but its agent did not fully stop. The execution slot remains occupied.',
            });
          }
        });
      // Deliberately never resolved. The turn is being killed, and settling this promise is the one
      // thing that would put a message in front of the model on its way out.
    }, PERMISSION_PROMPT_TIMEOUT_MS);

    pendingToolApprovals.set(toolUseID, pending);
  });

  // Resolved WITHOUT an answer means the user skipped, or the run was paused/stopped/superseded —
  // every teardown path resolves its pending approvals that way. That is a genuine refusal and the
  // model should hear it; the silence above is only for the park, where the turn ends regardless.
  if (!response.approved) {
    const message = response.message || 'Skipped';
    // The model gets the CLI's canned refusal whatever we say, but the TRANSCRIPT does not have to:
    // this carries the real reason to the card, which would otherwise render a bare red error for
    // an ordinary Skip.
    emitChunk({
      type: 'ask-user-question-result',
      toolUseId: toolUseID,
      result: message,
    } as UIMessageChunk);
    return { behavior: 'deny', message };
  }

  // Answered in time: hand the model the real answers and let the turn run on, exactly as the tool
  // behaves natively. Nothing was parked, so there is nothing to un-park.
  return {
    behavior: 'allow',
    updatedInput: response.updatedInput as Record<string, unknown> | undefined,
  };
}

/** A high surrogate with no low after it, or a low with no high before it. */
const LONE_SURROGATE_REGEX =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

/**
 * Clip to a UTF-16 length without leaving a lone surrogate — neither by splitting a pair at the
 * cut nor by passing one through from the provider. A lone surrogate is not a well-formed string:
 * Postgres rejects it in the jsonb the park is persisted into, so the write fails and strands the
 * question the user was asked. Interior ones are replaced with U+FFFD rather than dropped, keeping
 * the rest of the text intact.
 */
function clipText(value: string, max: number): string {
  let clipped = value;
  if (value.length > max) {
    const isHighSurrogateAtCut = isHighSurrogate(value.charCodeAt(max - 1));
    const isLowSurrogateAfterCut = isLowSurrogate(value.charCodeAt(max));
    const cutSplitsAPair = isHighSurrogateAtCut && isLowSurrogateAfterCut;
    clipped = value.slice(0, cutSplitsAPair ? max - 1 : max);
  }
  return clipped.replace(LONE_SURROGATE_REGEX, '\uFFFD');
}

/**
 * Normalize an SDK question to Frink's bounded renderer/recovery contract. The caps are Frink's,
 * not the SDK's: clipping display text, filtering malformed options, and bounding both arrays keeps
 * an otherwise answerable provider question recoverable after a renderer restart.
 */
function normalizeQuestion(value: unknown): Record<string, unknown> | null {
  if (!isPlainObject(value) || typeof value.question !== 'string' || !value.question) return null;
  if (typeof value.header !== 'string' || !value.header || !Array.isArray(value.options))
    return null;

  const options = value.options
    .filter(isPlainObject)
    .filter((option) => typeof option.label === 'string' && option.label.length > 0)
    .map((option) => ({
      // SAFETY: the preceding filter admits only options whose `label` is a non-empty string.
      label: clipText(option.label as string, 200),
      ...(typeof option.description === 'string'
        ? { description: clipText(option.description, 500) }
        : {}),
    }))
    .slice(0, 20);
  if (options.length === 0) return null;

  return {
    question: clipText(value.question, QUESTION_TEXT_MAX),
    header: clipText(value.header, 120),
    options,
    ...(typeof value.multiSelect === 'boolean' ? { multiSelect: value.multiSelect } : {}),
  };
}

function normalizeQuestions(questions: unknown): unknown {
  if (!Array.isArray(questions)) return questions;
  const normalized = questions.slice(0, 10).map(normalizeQuestion);
  // A partial card is worse than a bounded fallback: the held tool call expects an answer for
  // every question it asked, so silently dropping one can resume Claude with incomplete input.
  return normalized.some((question) => question === null) ? null : normalized;
}

/**
 * Turn an SDK `AskUserQuestion` call into the `awaiting_input` signal that parks the run, once the
 * hold above expires unanswered.
 *
 * Built from the tool's OWN payload rather than asked of the agent, because the `questions` shape is
 * identical on both sides (see `AgentUserQuestion`). Re-asking the model to restate it through
 * `frink_task_signal` was the previous design, and a transcription step is one the model can simply
 * skip — it did, reasoning its way to a unilateral decision instead of asking.
 *
 * The same normalized questions feed the live card, crash-recovery projection, and eventual park.
 * A safe fallback card keeps malformed provider input visible and answerable on every surface.
 */
export function buildAskUserQuestionParkSignal(
  toolInput: Record<string, unknown>,
): TaskSignalPayload {
  const parsed = agentUserQuestionsSchema.safeParse(normalizeQuestions(toolInput.questions));
  const questions = parsed.success && parsed.data.length ? parsed.data : ASK_FALLBACK_QUESTIONS;
  return {
    state: 'awaiting_input',
    // Headers, never the question text: this is the at-a-glance line on the work-queue card, and a
    // full question runs to hundreds of characters.
    summary: `Needs your input: ${questions.map((q) => q.header).join(', ')}`,
    questions,
    at: new Date().toISOString(),
  };
}
