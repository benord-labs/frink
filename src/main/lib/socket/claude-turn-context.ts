import fs from 'node:fs';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import log from 'electron-log';
import {
  type AssistantPartsState,
  applyAssistantChunkToParts,
  assistantPartsSnapshot,
  assistantPartsStateFromChunks,
  createAssistantPartsState,
} from '../../../shared/lib/assistant-parts';
import { filterCanonicalPlanParts } from '../../../shared/plan-parts-filter';
import type { ToolPartState } from '../../../shared/types/assistant-message';
import { buildFrinkPlanChunks } from '../agent-runner/plan-document';
import type { UIMessageChunk } from '../claude/types';
import type { MessagePart } from './client';

/** `MessagePart.state` is an untyped index-signature field; this is the one typed writer for it. */
function setToolPartState(part: MessagePart, state: ToolPartState): void {
  part.state = state;
}

type TurnChunkSend = (payload: {
  chatId: string;
  subChatId: string;
  assistantMessageId: string;
  chunk: UIMessageChunk;
  parts: MessagePart[];
  messageIndex: number;
}) => void;

/** Per-execute bindings. Session callbacks read them off the active turn, so an adopted turn acts
 * as its own execute and a wake burst shares its arming turn's. */
export interface ClaudeTurnExecution {
  /** The MCP execution context the session's dynamic-chat server records signals under. */
  executionContextId: string | undefined;
  signalTaskId: string | null;
  /** `frink_task_signal` is mounted in the session this turn runs on. Enforced only with a task. */
  taskSignalReady: boolean;
  isFlowTurn: boolean;
  /** A person typed this turn into a chat an armed Flow step drives (sc-3214). */
  humanInterjection: boolean;
  isPlanMode: boolean;
  flowPlanAutoApprove: boolean;
  abortController: AbortController;
  sendChunk: TurnChunkSend;
}

/**
 * Fresh-per-turn mutable state read by the session's SDK callbacks (`canUseTool` and the hooks, in
 * `execution/claude-session/session-callbacks.ts`) and the terminal error handling while a Claude
 * turn runs. `handleRemoteExecute` creates one instance per turn and populates it as it progresses.
 *
 * It is grouped into a single object rather than loose locals because the persistent query
 * (`claude-session-registry.ts`) keeps its closures alive across turns — those closures read the
 * ACTIVE turn's state through this object (`session.currentTurn`), so installing a new instance
 * cleanly represents each turn without rebuilding the closures. A turn taken over from the
 * between-turn wake pump (a user message while the agent waits on background work) installs its
 * own instance the same way.
 */
export interface ClaudeTurnContext {
  /** Points at the turn's live `collectedChunks` once streaming starts, so the terminal catch can
   * persist partial output if the stream dies mid-turn. */
  lastCollectedChunks: UIMessageChunk[];
  /** Assistant message id this turn's chunks stream and persist under. */
  msgId: string;
  /** Monotonic stream index for this turn's `sendStreamChunkDirect` emissions from SDK closures. */
  nextMessageIndex: () => number;
  /** THIS turn's abort probe — per-turn, because the session-level controller outlives turns. */
  isAborted: () => boolean;
  /** Resolves only after this turn's exact foreground or transferred wake resources settle. */
  waitForExecutionSettlement: () => Promise<void>;
  /** Plan-mode submission halt: denies every tool from the instant the plan is submitted. */
  planSubmissionHalt: () => boolean;
  /** Raises {@link planSubmissionHalt}. The executor owns the flag; a wake burst needs to raise it
   * without owning it, because a burst that surfaced a plan card must stop the model's tools for
   * the rest of the wait — the getter alone gave bursts read access to a latch they could not set. */
  setPlanSubmissionHalt: () => void;
  /** Plan restrictions still in force (plan mode, plan not yet submitted): refuses terminal
   * `frink_task_signal` states so plan mode finishes only through ExitPlanMode. */
  planTerminalsLocked: boolean;
  /** This turn submitted a plan (ExitPlanMode called), so any signal recorded BEFORE that point
   * belongs to the drafting phase — see hasLatestTaskSignalFor's `requireTerminal`. */
  planSubmitted: boolean;
  /** The plan this turn's ExitPlanMode submitted (hook input): the card is built from this text. */
  submittedPlan: { path: string; text: string } | null;
  /** Records that canUseTool persisted the task signal mid-stream (skips the post-stream write). */
  setHasExplicitTaskSignal: (value: boolean) => void;
  /** Denied tool_use ids → denial message, read post-stream to emit synthetic tool-output-errors. */
  deniedToolIdsWithMessages: Map<string, string>;
  /** Operator reminders to deliver via the UserPromptSubmit hook for THIS turn (empty on wake
   * bursts and on turns whose reminders ride the prompt prepend instead). */
  pendingReminders: string[];
  /** Whether this turn delegates Frink's residual `ask` decisions to Claude's native Auto Mode. */
  autoReviewTools: boolean;
  /** Auto may review THIS turn's plan-drafting phase (resolveAutoReviewModes). On the turn because
   * canUseTool belongs to the session it was spawned for: an adopted cross-mode turn (or a wake
   * burst) gates its deny-floor on the active turn's eligibility, never a spawn-time constant. */
  planAutoReview: boolean;
  /** This context belongs to a between-turn wake burst (set by the pump's onBurstStart). Not
   * derivable from the hold registry: a hold exists during both a wake burst and a foreground turn
   * adopting it. Plan transitions (Enter/ExitPlanMode) are denied while set — a burst bypasses the
   * foreground stream's plan bookkeeping, so allowing them would lift SDK plan restrictions with no
   * card, no halt and no approval. */
  isWakeBurst: boolean;
  /** A steer was pushed into this turn. One it never read may run as a CLI turn of its own after
   * its result, with no reader, so the session is not kept idle for the next send. */
  steered: boolean;
  /** When this turn began. The MCP execution context never clears its recorded signal and its wake
   * bursts share it, so anything read from there is only THIS turn's if it postdates this stamp. */
  startedAt: string;
  /** This turn took over a wake hold and has not yet logged how it ended (logAdoptedTurnEnd). */
  adoptedHold?: boolean;
  execution: ClaudeTurnExecution;
}

export function createClaudeTurnContext(): ClaudeTurnContext {
  return {
    lastCollectedChunks: [],
    msgId: '',
    nextMessageIndex: () => 0,
    isAborted: () => false,
    waitForExecutionSettlement: async () => {},
    planSubmissionHalt: () => false,
    setPlanSubmissionHalt: () => {},
    planTerminalsLocked: false,
    planSubmitted: false,
    submittedPlan: null,
    setHasExplicitTaskSignal: () => {},
    deniedToolIdsWithMessages: new Map(),
    pendingReminders: [],
    autoReviewTools: false,
    planAutoReview: false,
    isWakeBurst: false,
    steered: false,
    startedAt: new Date().toISOString(),
    execution: {
      executionContextId: undefined,
      signalTaskId: null,
      taskSignalReady: false,
      isFlowTurn: false,
      humanInterjection: false,
      isPlanMode: false,
      flowPlanAutoApprove: false,
      abortController: new AbortController(),
      sendChunk: () => {},
    },
  };
}

/** An adopting execute's bindings on the held session: all its own, except whether the session
 * listed `frink_task_signal`, which was fixed when the held session was spawned. */
export function adoptHeldExecution(
  own: ClaudeTurnExecution,
  held: ClaudeTurnExecution,
): ClaudeTurnExecution {
  return { ...own, taskSignalReady: held.taskSignalReady };
}

/**
 * The turn context one wake burst runs under: a fresh instance so the session's SDK closures
 * attribute wake activity correctly — including hook denials, which land in this turn's denied map
 * for the burst backfill — while the state a wait must carry ACROSS bursts is copied off the arming
 * turn rather than re-derived.
 *
 * Plan state is the load-bearing part (decision `flow-quiet-wait-handling`): a plan-drafting wait's
 * bursts keep terminals locked and plan transitions denied, so `turnOwesTerminalSignal` stays sound
 * and a burst can neither record a terminal `frink_task_signal` nor lift SDK plan restrictions
 * unattended. The halt is carried as BOTH its getter and its setter — the executor owns the flag, a
 * burst reads it to stay tool-less and raises it when it surfaces a plan card.
 */
export function createWakeBurstTurn(
  arming: ClaudeTurnContext,
  burst: {
    msgId: string;
    chunks: UIMessageChunk[];
    /** MUST continue the arming turn's counter, not restart. The renderer keeps a high-water mark
     * per assistant message id and ignores anything at or below it — a burst restarting at 0 under
     * the same id would have every one of its chunks silently dropped, leaving a frozen transcript
     * that the database says is fine. */
    nextMessageIndex: () => number;
    /** The ARMING turn's Auto grant. Set here rather than after publication: the PreToolUse hook
     * reads it through `session.currentTurn`, so a burst published first would gate on the default. */
    autoReviewTools: boolean;
    waitForExecutionSettlement: () => Promise<void>;
  },
): ClaudeTurnContext {
  const wakeTurn = createClaudeTurnContext();
  wakeTurn.msgId = burst.msgId;
  wakeTurn.lastCollectedChunks = burst.chunks;
  wakeTurn.nextMessageIndex = burst.nextMessageIndex;
  wakeTurn.autoReviewTools = burst.autoReviewTools;
  wakeTurn.waitForExecutionSettlement = burst.waitForExecutionSettlement;
  wakeTurn.planTerminalsLocked = arming.planTerminalsLocked;
  wakeTurn.planSubmitted = arming.planSubmitted;
  wakeTurn.planSubmissionHalt = arming.planSubmissionHalt;
  wakeTurn.setPlanSubmissionHalt = arming.setPlanSubmissionHalt;
  wakeTurn.planAutoReview = arming.planAutoReview;
  wakeTurn.isWakeBurst = true;
  wakeTurn.execution = arming.execution;
  return wakeTurn;
}

/**
 * Incremental parts builder state. The streaming hot path mutates this in place
 * per chunk, so a single call to `applyChunkToParts` is O(1) instead of the
 * O(N) full-walk that `buildPartsFromChunks` performs. Avoids the O(N²)
 * heap-allocation storm during long streams (e.g. 300+ line file edits).
 */
export type PartsState = AssistantPartsState<MessagePart>;

export function createPartsState(): PartsState {
  return createAssistantPartsState<MessagePart>();
}

/**
 * Apply a single chunk to the parts state, mutating in place. Intended for the
 * streaming hot path so we never re-walk the full chunks array per event.
 */
export function applyChunkToParts(state: PartsState, chunk: UIMessageChunk): void {
  applyAssistantChunkToParts(state, chunk);
}

/**
 * Build the full `parts` array from a chunks list. Pure, used by the test
 * corpus and by terminal/post-stream call sites that fold a small chunk list
 * once. The streaming hot loop should mutate a `PartsState` instead.
 */
/**
 * Fold a whole chunk history into a fresh, ready-to-extend `PartsState`.
 *
 * The trailing `flushText` matters for callers that keep streaming into the result: it closes the
 * last text part, so text arriving afterwards begins a new one instead of fusing onto the end of a
 * paragraph that was already finished.
 */
export function partsStateFromChunks(chunks: UIMessageChunk[]): PartsState {
  return assistantPartsStateFromChunks<MessagePart>(chunks);
}

export function buildPartsFromChunks(chunks: UIMessageChunk[]): MessagePart[] {
  return partsStateFromChunks(chunks).parts;
}

/**
 * Snapshot a live `PartsState` for transport (IPC / socket) including any
 * in-flight `text-delta` accumulator. Mirrors {@link buildPartsFromChunks}'s
 * end-of-loop `flushText` so streaming consumers see partial text mid-stream.
 * Returns the underlying `parts` array directly when there is no pending text
 * — callers must not mutate it.
 */
export function partsSnapshot(state: PartsState): MessagePart[] {
  return assistantPartsSnapshot(state);
}

/**
 * Rebuild parts from `collectedChunks` while reusing the same `MessagePart` objects for tool
 * calls that already exist in `liveParts` (matched by `toolCallId`). Keeps in-memory
 * mutations on those objects (e.g. the AskUserQuestion result written by
 * `holdQuestionUntilAnswered`) aligned with what we stream and persist.
 */
function toolCallIdFromPart(p: MessagePart): string | undefined {
  const id = (p as Record<string, unknown>).toolCallId;
  return typeof id === 'string' ? id : undefined;
}

function reconcileLivePartsWithChunks(
  liveParts: MessagePart[],
  collectedChunks: UIMessageChunk[],
): void {
  const rebuilt = buildPartsFromChunks(collectedChunks);
  const liveToolById = new Map<string, MessagePart>();
  for (const p of liveParts) {
    const id = toolCallIdFromPart(p);
    if (id) liveToolById.set(id, p);
  }
  liveParts.length = 0;
  for (const bp of rebuilt) {
    const id = toolCallIdFromPart(bp);
    if (id) {
      const existing = liveToolById.get(id);
      if (existing) {
        Object.assign(existing, bp);
        liveParts.push(existing);
        continue;
      }
    }
    liveParts.push(bp);
  }
}

/** Session id announced in a chunk's message metadata, if any. */
/** Every SDK frame carries session_id, so the first frame of any kind persists it (a Stop before
 * the result frame otherwise leaves nothing to resume, sc-2472); the chunk metadata is the fallback. */
export function sessionIdFromFrame(frame: SDKMessage, chunk: UIMessageChunk): string | null {
  return frame.session_id ? frame.session_id : sessionIdFromChunk(chunk);
}

function sessionIdFromChunk(chunk: UIMessageChunk): string | null {
  const id = (
    'messageMetadata' in chunk
      ? (chunk.messageMetadata as { sessionId?: unknown } | undefined)
      : undefined
  )?.sessionId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** Denied-tool message for a call id: exact match, or composite `parent:child` suffix match
 * (MCP sub-tool denials record the child id; the stream reports the composite). */
export function matchDeniedToolMessage(
  denied: ReadonlyMap<string, string>,
  toolCallId: string,
): string | undefined {
  const exact = denied.get(toolCallId);
  if (exact !== undefined) return exact;
  for (const [id, message] of denied) {
    if (toolCallId.endsWith(`:${id}`)) return message;
  }
  return undefined;
}

/**
 * Read the plan file a plan-mode turn wrote and emit the canonical frink-plan card inline —
 * each chunk is pushed into `collectedChunks` and streamed — so the UI shows the card at
 * ExitPlanMode rather than at stream end. Returns the advanced message index, or null when
 * nothing was emitted (empty file or read failure): the caller's post-stream fallback then
 * owns emission.
 */
export async function emitInlinePlanCard(params: {
  chatId: string;
  subChatId: string;
  assistantMessageId: string;
  planPath: string;
  /** The submitted plan's exact text; when given, the card is built from it and the file is not read. */
  planText?: string;
  collectedChunks: UIMessageChunk[];
  messageIndex: number;
  flowDriven: boolean;
  autoApproved: boolean;
  /** Injected (the executor passes sendStreamChunkDirect) — importing ./client here would close
   * a turn-context → client → executor → turn-context cycle. */
  send: (payload: {
    chatId: string;
    subChatId: string;
    assistantMessageId: string;
    chunk: UIMessageChunk;
    parts: MessagePart[];
    messageIndex: number;
  }) => void;
}): Promise<number | null> {
  const { chatId, subChatId, assistantMessageId, planPath, collectedChunks, send } = params;
  let { messageIndex } = params;
  try {
    const planContent = (params.planText ?? (await fs.promises.readFile(planPath, 'utf8'))).trim();
    if (planContent.length === 0) {
      log.warn(
        `[Socket Executor] Claude plan mode: plan file was empty at inline emission for ${subChatId} (${planPath})`,
      );
      return null;
    }
    const inlinePlanChunks = buildFrinkPlanChunks(subChatId, planContent, planPath, {
      flowDriven: params.flowDriven,
      autoApproved: params.autoApproved,
    });
    for (const planChunk of inlinePlanChunks) {
      collectedChunks.push(planChunk);
      const parts = filterCanonicalPlanParts(buildPartsFromChunks(collectedChunks), planContent);
      send({
        chatId,
        subChatId,
        assistantMessageId,
        chunk: planChunk,
        parts,
        messageIndex: messageIndex++,
      });
    }
    log.info(
      `[Socket Executor] Claude plan mode: emitted frink-plan inline at ExitPlanMode for ${subChatId} (planPath=${planPath})`,
    );
    return messageIndex;
  } catch (err) {
    log.warn(
      `[Socket Executor] Claude plan mode: failed to emit plan inline for ${subChatId} (${planPath}), falling back to post-stream:`,
      err,
    );
    return null;
  }
}

/**
 * Build the per-turn chunk emitter used by tools that stream their own UI (AskUserQuestion).
 *
 * `sendChunk` is INJECTED rather than imported: this module is reachable from the claude/ layer, and
 * importing the socket client here would close the client↔executor cycle that plan-auto-approve's
 * `notify` injection documents.
 */
export function createTurnChunkEmitter(params: {
  turn: { lastCollectedChunks: UIMessageChunk[]; msgId: string; nextMessageIndex: () => number };
  liveParts: MessagePart[];
  chatId: string;
  subChatId: string;
  sendChunk: TurnChunkSend;
}): (chunk: UIMessageChunk) => void {
  const { turn, liveParts, chatId, subChatId, sendChunk } = params;
  return (chunk) => {
    turn.lastCollectedChunks.push(chunk);
    reconcileLivePartsWithChunks(liveParts, turn.lastCollectedChunks);
    sendChunk({
      chatId,
      subChatId,
      assistantMessageId: turn.msgId,
      chunk,
      parts: liveParts,
      messageIndex: turn.nextMessageIndex(),
    });
  };
}
