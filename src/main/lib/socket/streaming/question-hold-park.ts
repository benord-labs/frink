import type { TaskSignalPayload } from '../../../../shared/types/task-signal';
import { holdQuestionUntilAnswered } from '../../claude/ask-user-question-approval';
import type { UIMessageChunk } from '../../claude/types';
import { captureMainMessage } from '../../sentry/init';
import { persistLinkedTaskSignal } from '../../trpc/routers/frink-task-signal-persist';
import { type ClaudeSession, unregisterSessionIfOwned } from '../claude-session-registry';

/**
 * End a turn that is holding an unanswered `AskUserQuestion`: park the run, then end the turn.
 *
 * Park BEFORE ending — the teardown reconcile CASes a still-`running` task to cancelled, which is
 * the ordering `pauseFlowRunForSubChat` documents for the same reason.
 *
 * Ending KILLS the session via `query.return()`, never `query.interrupt()`. Interrupt is a control
 * request the CLI answers for us: it closes its own pending `canUseTool` with the canned "The user
 * doesn't want to proceed" refusal, pairing the tool_use in its session file (the resumed model
 * reads a refusal nobody gave) and streaming it back as a red tool error. `query.return()` closes
 * the transport with no control write; nothing streams back, and during its exit grace the CLI
 * pairs the call with a neutral "permission stream closed" error — so the asking turn survives
 * resume and the model is never told the user refused (probed live on both endings, 2026-08-04).
 * Whether the caller's controller is aborted afterwards depends on who is waiting — see
 * `isFlowTurn`.
 */
export async function parkHeldQuestion(params: {
  signal: TaskSignalPayload;
  subChatId: string;
  signalTaskId: string | null | undefined;
  /** An unattended flow turn stamps its abort reason and aborts the controller on top of the kill. */
  isFlowTurn: boolean;
  abortController: AbortController;
  /** Classifier map, so a parked turn is not reported as an unexplained stream error. */
  abortSources: Map<string, string>;
  /** Retires the native card only after the task has a durable replacement answer surface. */
  onPersisted: () => void;
  /** Exact execution barrier; Flow admission is retained until every resource owner settles. */
  waitForSettlement: () => Promise<void>;
  /** Exact session captured when the question opened, avoiding an ABA lookup after persistence. */
  questionSession: ClaudeSession;
}): Promise<void> {
  const {
    signal,
    subChatId,
    signalTaskId,
    isFlowTurn,
    abortController,
    abortSources,
    onPersisted,
    waitForSettlement,
    questionSession,
  } = params;
  const persisted = await persistLinkedTaskSignal({ taskIdForExecution: signalTaskId, signal });
  if (isFlowTurn && !persisted) {
    throw new Error('Flow question park did not update its linked task');
  }
  onPersisted();
  // Ordering around the await is load-bearing on BOTH sides. `query.return()`'s cleanup ends the
  // input stream first (the turn ends there, read as graceful via interruptExpected) and only
  // resolves ~2s later behind the transport's exit race. The queue closes BEFORE the await so the
  // post-turn disposition — which runs inside that window — sees a dead-input session and disposes
  // it instead of arming a wake pump on the dead query. The registry entry is removed only AFTER
  // the teardown resolves: a concurrent duplicate execute must still find the session and honor
  // the leftover/turnSettled wait rather than spawning a second CLI against it mid-teardown.
  const killSession = async (): Promise<void> => {
    questionSession.interruptExpected = true;
    if (!questionSession.queue.closed) questionSession.queue.close();
    await questionSession.query.return(undefined).catch(() => {});
    unregisterSessionIfOwned(questionSession);
  };
  // The kill already ended this turn, so an attended chat stops here and ends CLEANLY: no abort
  // reason stamped, no stream-error disposition, and `runTurn` returns on interruptExpected rather
  // than throwing. A flow turn stamps its reason BEFORE the kill — the stream can end inside it, and
  // a throw from the executor tail must already classify as deliberate or it would overwrite the
  // fresh awaiting_input park as an api-error. It then aborts because an adopted turn runs under
  // another execute's controller. The transport is closed before the abort, so the executor's abort
  // reaction (which would re-send the self-answering interrupt) can never see another frame.
  if (!isFlowTurn) {
    await killSession();
    await waitForSettlement();
    return;
  }
  abortSources.set(subChatId, 'question-park');
  await killSession();
  abortController.abort();
  // The turn ends silently by design — no tool result, no thrown error — so this capture is the ONLY
  // signal that a question expired with nobody answering. Only flow turns reach it: a cluster means
  // agents are asking on runs no one is watching.
  captureMainMessage('question timed out unanswered — run parked and turn ended', 'warning', {
    subChatId,
  });
  await waitForSettlement();
}

/**
 * The whole AskUserQuestion path: hold the call, and on expiry park + end the turn. Kept together so
 * the session's `canUseTool` names one thing rather than wiring the hold to its own ending.
 */
export function holdOrParkQuestion(params: {
  toolUseID: string;
  toolInput: Record<string, unknown>;
  chatId: string;
  subChatId: string;
  signalTaskId: string | null | undefined;
  isFlowTurn: boolean;
  emitChunk: (chunk: UIMessageChunk) => void;
  abortController: AbortController;
  abortSources: Map<string, string>;
  waitForSettlement: () => Promise<void>;
  /** The session whose CLI asked; a lookup by chat id could return a successor. */
  questionSession: ClaudeSession;
}) {
  const { toolUseID, toolInput, chatId, subChatId, signalTaskId, isFlowTurn, emitChunk } = params;
  return holdQuestionUntilAnswered({
    toolUseID,
    toolInput,
    chatId,
    subChatId,
    emitChunk,
    parkAndKill: (signal, onPersisted) =>
      parkHeldQuestion({
        signal,
        subChatId,
        signalTaskId,
        isFlowTurn,
        abortController: params.abortController,
        abortSources: params.abortSources,
        onPersisted,
        waitForSettlement: params.waitForSettlement,
        questionSession: params.questionSession,
      }),
  });
}
