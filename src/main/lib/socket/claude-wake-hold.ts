/**
 * Between-turn wake holds for Claude sessions (executor seam).
 *
 * A session whose turn ended with harness work still pending (backgrounded commands, Monitors,
 * ScheduleWakeup crons) stays alive with an {@link armIdle} sink consuming its stream, so the
 * harness's own wake (task_notification → continuation turn, cron → meta prompt turn) reaches
 * the chat instead of dying with the CLI. Each wake burst streams + persists into the ARMING
 * turn's assistant message — a wait is one turn, however many times the harness wakes it; a
 * follow-up user message adopts the hold (`takeWakeHold` → `pump.startTurn`) rather than spawning
 * a fresh process over live work.
 *
 * A wait ends when the harness reports nothing left in flight — and on nothing else. That is the
 * Claude Code CLI's own contract: its wait loop polls task liveness with no wake cap and no timeout,
 * and the one guard it offers (`--max-budget-usd`) is a hidden, opt-in, `--print`-only flag with no
 * default. A ceiling chosen HERE would be worse than none: the user never set it and cannot raise
 * it, so a legitimately long wait — a multi-hour benchmark monitor is a real workload — dies for a
 * reason they cannot see, which is the failure mode this whole seam exists to avoid. A budget is the
 * user's to set: `Options.maxBudgetUsd` reports `error_max_budget_usd` when it trips, so wanting one
 * means passing it through, never accounting for spend here.
 *
 * A CLI that wedges — stops waking altogether — is not this module's to catch: the flow watcher's
 * 45-minute quiet-idle sweep parks the task and tells the user. KNOWN GAP: that sweep reads the
 * `tasks` table, so it only covers a TASK-LINKED wait; a plain chat has no automatic backstop.
 * Recovery there is the user's: the held row carries a Stop (RunStatusRows) that reaches
 * `releaseWakeHold` through the ordinary remote-stop path, because the composer's own Stop is gated
 * on `isStreaming` and so is absent between wakes. A flow chat is excluded — its bottom surface
 * already owns the terminal verb, and a raw stop there abandons the run without `cancelRun`.
 *
 * IO is injected by the executor as thin adapters (not imported from ./client) so this module
 * stays out of the client↔executor import cycle and is trivially testable.
 */

import log from 'electron-log';
import type { TaskSignalPayload } from '../../../shared/types/task-signal';
import type { WakeHoldEndReason, WakeHoldState } from '../../../shared/types/wake-hold';
import { createTransformer } from '../claude';
import { clearPendingApprovals } from '../claude/ask-user-question-approval';
import type { UIMessageChunk } from '../claude/types';
import type { FlowResourceActivityRelease } from '../flows/admission/activity';
import { captureMainException, captureMainMessage } from '../sentry/init';
import type { StopPendingWork } from '../task-stop-hook';
import {
  type ClaudeSession,
  endSession as endClaudeSession,
  getSession as getClaudeSession,
  retireRetainedSessions,
} from './claude-session-registry';
import {
  applyChunkToParts,
  type ClaudeTurnExecution,
  createWakeBurstTurn,
  partsSnapshot,
  partsStateFromChunks,
} from './claude-turn-context';
// Type-only — erased at compile time, so it does not reintroduce the client↔executor runtime cycle
// this module is kept out of.
import type { MessagePart } from './client';
import { settleClaudeWakeHold } from './execution/claude-provider-cleanup';
import { armIdle } from './execution/claude-session-loop';
import type { ExecutionSettlementBarrier } from './execution/execution-settlement-barrier';
import {
  logDroppedPendingWork,
  resumeQuietIdleParkOnBurst,
  settleBurstSignal,
  summarizePendingWork,
} from './execution/wake-hold-signal';
import type { WakePump } from './execution/wake-pump-types';
import { backfillDeniedTools } from './streaming/burst-chunks';

/** A held session's pump plus the arming turn's execution bindings — an adopting turn keeps only
 * whether the session listed `frink_task_signal` (adoptHeldExecution). */
export type WakeHold = {
  pump: WakePump;
  /** The exact session this hold owns — disposal is identity-guarded on it (ABA: the key can be
   * re-registered to a NEW session while an orphaned hold's async cleanup is still in flight). */
  session: ClaudeSession;
  execution: ClaudeTurnExecution;
  /** Publishes held-vs-finished to the renderer. Carried on the hold rather than reached through
   * `io` because the module-level release functions have no io in scope. */
  setHeld: (held: boolean, pending?: WakeHoldState, endReason?: WakeHoldEndReason) => void;
  /** Flow resource ownership transferred from the arming execute until this pump settles. */
  releaseFlowResourceActivity?: FlowResourceActivityRelease;
  /** Flow wake holds retain their foreground runtime slot until pump/provider cleanup settles. */
  releaseRuntimeSlot?: () => void;
  /** Removes this exact provider controller from the Flow run's cancellation registry. */
  unregisterFlowRunAbort?: () => void;
  /** Durable task cancellation started by Stop/reload and owed before Flow activity release. */
  cancellationPersistence?: Promise<void>;
  executionSettlement?: ReturnType<ExecutionSettlementBarrier['retain']>;
  /** Provider cleanup is in flight; keep this owner discoverable so a late Stop can join it. */
  settling: boolean;
  /**
   * Latched once this hold's wait has been retracted, by ANY exit. Read by the burst-end republish,
   * which would otherwise resurrect a wait that already ended: `onBurstEnd` runs before the pump
   * consults its takeover and work-finished branches, so a turn takeover or a user Stop landing
   * mid-burst is always followed by one more burst end. Neither is catchable by identity alone —
   * a takeover DELETES the map entry (and its 'turn-taken-over' exit never retracts), while a Stop
   * deliberately KEEPS it so the live pump stays adoptable.
   */
  retracted: boolean;
};

const activeWakeHolds = new Map<string, WakeHold>();

/**
 * Register a hold and tell the renderer this chat is WAITING, not finished.
 *
 * Between bursts a held chat is indistinguishable from a finished one everywhere else — no
 * transport, no observed run, status 'ready' — so the renderer would otherwise render the
 * end-of-turn treatment (collapsed steps + a final-response block) over an agent that is still
 * working, once per burst. Every mutation of {@link activeWakeHolds} goes through this pair so no
 * exit path can leave the chat advertising a wait that already ended.
 */
function setHold(subChatId: string, hold: WakeHold, pending: StopPendingWork): void {
  activeWakeHolds.set(subChatId, hold);
  hold.setHeld(true, summarizePendingWork(pending));
}

function retractHold(hold: WakeHold, endReason?: WakeHoldEndReason): void {
  if (hold.retracted) return;
  hold.retracted = true;
  hold.setHeld(false, undefined, endReason);
}

/** Evict a hold and retract the wait. */
function dropHold(subChatId: string, hold: WakeHold): void {
  activeWakeHolds.delete(subChatId);
  retractHold(hold);
}

/** With a session, true only for THAT session's hold: a retracted-but-unsettled hold from a
 * superseded draining session must not gate a fresh execute's finalize/dispose decisions. */
export function hasWakeHold(subChatId: string, session?: ClaudeSession): boolean {
  const hold = activeWakeHolds.get(subChatId);
  return session ? hold?.session === session && !hold.retracted : hold !== undefined;
}

/** Read-only registry access for the out-of-file readers in execution/wake-hold-registry-view.ts.
 * The Map itself stays private so the setHold/retractHold/dropHold trio remains its only writer. */
export function readWakeHolds(): ReadonlyMap<string, WakeHold> {
  return activeWakeHolds;
}

/** Refuse a hold without adopting it. A flow-owned hold whose pump will still settle is only
 * retracted — its cleanup pipeline needs the registry entry; anything else leaves the registry
 * now. */
function refuseHold(subChatId: string, hold: WakeHold, pumpSettles: boolean): void {
  if (hold.releaseFlowResourceActivity && pumpSettles) {
    hold.settling = true;
    retractHold(hold);
  } else {
    dropHold(subChatId, hold);
  }
}

/** Claim the chat's hold for an adopting turn (removes it from the registry). A hold whose pump
 * already exited (budget/interrupt/stream-end, its `done` cleanup microtask still pending) is
 * unadoptable — its queue has no reader — so it reads as absent and the caller takes the
 * fresh-session path; the pump's own done handler still owns the session disposal. */
export function takeWakeHold(
  subChatId: string,
  successorHasFlowResourceActivity = false,
): WakeHold | undefined {
  const hold = activeWakeHolds.get(subChatId);
  if (!hold) return undefined;
  if (getClaudeSession(subChatId) !== hold.session) {
    refuseHold(subChatId, hold, hold.pump.isEnded());
    log.info(`[Socket Executor] Wake hold for ${subChatId} lost session ownership`);
    return undefined;
  }
  // A closed queue has no reader for the adopting message: the wait already ended and the session
  // is only draining what the CLI still owes it — a pump alive in that drain still settles.
  if (hold.pump.isEnded() || hold.session.queue.closed) {
    if (!hold.pump.isEnded()) {
      captureMainMessage('wake hold refused adoption after its wait ended', 'warning', {
        surface: 'wake-pump-stand-down',
        subChatId,
      });
    }
    refuseHold(subChatId, hold, true);
    log.info(`[Socket Executor] Wake hold for ${subChatId} already ended — fresh session instead`);
    return undefined;
  }
  if (hold.releaseFlowResourceActivity && !successorHasFlowResourceActivity) {
    // An ordinary/gate-off follow-up must not inherit Flow-owned resources after admission can
    // settle. End the old wait and let the caller take its legacy fresh-session path instead.
    releaseWakeHold(subChatId, 'non-flow successor bypassed Flow wake hold');
    return undefined;
  }
  // The adopting turn runs in the foreground — the chat is executing, no longer waiting. If that
  // turn also ends with pending work it arms a fresh hold and re-advertises.
  dropHold(subChatId, hold);
  // A question held into this wait is superseded by the reply that adopted it. The pump exits
  // 'turn-taken-over' (disposal's clear never runs) and a held chat has no activeExecutions entry
  // (the new execute's supersede clear never fires), so this is the only seam that can emit the
  // terminal ask-user-question-result the renderer's identity-keyed retire requires.
  clearPendingApprovals('Continued by your reply.', subChatId);
  return hold;
}

/**
 * Tear down a between-turn wake hold (user Stop/pause, chat delete, provider switch, app quit).
 * Closing the session's queue lets the CLI exit — which stops its backgrounded tasks — and the
 * pump exits via its stream-end path (its `done` handler owns the cleanup). No-op without a hold.
 */
export function releaseWakeHold(
  subChatId: string,
  reason: string,
  cancellationPersistence?: Promise<void>,
): void {
  let reportOrphanedCancellationError = true;
  void cancellationPersistence?.catch((error) => {
    if (reportOrphanedCancellationError) {
      captureMainException(error, { surface: 'claude-wake-hold', stage: 'cancellation-persist' });
    }
  });
  const hold = activeWakeHolds.get(subChatId);
  if (hold?.releaseFlowResourceActivity) reportOrphanedCancellationError = false;
  if (!hold) return;
  if (hold.releaseFlowResourceActivity && hold.pump.isEnded()) hold.settling = true;
  if (cancellationPersistence && hold.releaseFlowResourceActivity) {
    const existing = hold.cancellationPersistence;
    hold.cancellationPersistence = existing
      ? Promise.allSettled([existing, cancellationPersistence]).then((results) => {
          const errors = results.flatMap((result) =>
            result.status === 'rejected' ? [result.reason] : [],
          );
          if (errors.length > 1) {
            throw new AggregateError(errors, 'Wake hold cancellation persistence failed');
          }
          if (errors.length === 1) throw errors[0];
        })
      : cancellationPersistence;
  }
  log.info(`[Socket Executor] Releasing wake hold for ${subChatId}: ${reason}`);
  // Identity-guarded: if the key already maps to a NEWER session (the held one was disposed and
  // recreated while this hold's cleanup was pending), ending by key would kill the innocent
  // successor mid-turn. Drop the stale entry instead; the orphan pump's done handler no-ops too.
  if (getClaudeSession(subChatId) === hold.session) {
    // The map entry stays — `pump.done` owns eviction here, and clearing it early would make the
    // still-live pump unadoptable. Retract the wait immediately anyway so the UI reacts to Stop on
    // the keystroke rather than after the stream unwinds; `pump.done`'s dropHold repeats it. The
    // latch is what keeps it retracted: closing the queue does not truncate an in-flight burst, so
    // its burst end still runs and would otherwise re-advertise the wait the user just ended.
    retractHold(hold);
    logDroppedPendingWork(subChatId, hold.session.stopHook?.lastPendingWork ?? null, reason);
    endClaudeSession(subChatId);
  } else if (!hold.settling) {
    dropHold(subChatId, hold);
  }
}

/** Quit-time sweep: idle sessions and wake holds. Flow-owned holds are skipped, see
 * docs/decisions/unattended-wake-budget.md; a Flow turn's session is never left idle. */
export function releaseNonFlowClaudeSessions(reason: string): void {
  retireRetainedSessions(reason);
  for (const [subChatId, hold] of [...activeWakeHolds]) {
    if (!hold.releaseFlowResourceActivity) releaseWakeHold(subChatId, reason);
  }
}

/** Executor-injected adapters — each closes over the executor's typed senders/builders. */
export interface WakeHoldIo {
  /** Stream one wake-burst chunk with the burst's cumulative parts snapshot. */
  streamChunk: (
    msgId: string,
    chunk: UIMessageChunk,
    parts: MessagePart[],
    messageIndex: number,
  ) => void;
  /** Surface a plan this burst finished as a pending-approval card, calling `onSubmitted` only if
   * one reached the transcript. */
  emitPlanCard: (
    msgId: string,
    chunks: UIMessageChunk[],
    startIndex: number,
    deniedToolIdsWithMessages: Map<string, string>,
    turn: { onSubmitted: () => void; planAlreadySubmitted: boolean; waitStartedMs: number },
  ) => Promise<void>;
  /** Finalize the merged assistant message. `chunks` spans the whole wait, so `hadContent` — not
   * its length — says whether anything new was said. Awaitable before the session is disposed. */
  completeBurst: (msgId: string, chunks: UIMessageChunk[], hadContent: boolean) => Promise<void>;
  /** Publish whether this chat is waiting on background work, and on what (see {@link setHold}). */
  setHeld: (held: boolean, pending?: WakeHoldState, endReason?: WakeHoldEndReason) => void;
  clearPendingApprovals: (reason: string, subChatId: string) => void;
  getLatestTaskSignal: (executionContextId: string) => TaskSignalPayload | null | undefined;
  clearCurrentExecutionChat: (executionContextId: string) => void;
}

export interface ArmWakePumpParams {
  session: ClaudeSession;
  pendingWork: StopPendingWork;
  subChatId: string;
  executionContextId: string | undefined;
  signalTaskId: string | null;
  releaseFlowResourceActivity?: FlowResourceActivityRelease;
  releaseRuntimeSlot?: () => void;
  unregisterFlowRunAbort?: () => void;
  executionSettlement?: ExecutionSettlementBarrier;
  canClearPendingApprovals?: () => boolean;
  io: WakeHoldIo;
}

/**
 * Arm the between-turn wake pump on a session the Stop hook reported pending harness work for.
 * Wake bursts extend the arming turn's assistant message; burst end runs the same duties
 * as a real turn end (a NEW signal persists — the late-wake supersede un-parks a ceiling-parked
 * task; a still-quiet wait refreshes the quiet-end marker so the park sweep's inactivity clock
 * restarts). The pump's `done` handler owns disposal for every exit except a turn takeover.
 *
 * A turn that declares its own work done stands the pump down at the next burst end
 * (`declaresWaitOver`); the arming moment itself does not decide, because this call is the
 * flow-resource transfer point and a hold is what carries those resources to their release.
 */
export function armWakePump(params: ArmWakePumpParams): WakeHold {
  const { session, pendingWork, subChatId, executionContextId, signalTaskId, io } = params;
  // The ARMING turn's Auto grant, captured before the first burst replaces `currentTurn`. A wake
  // burst continues that turn's consent: the SDK query is still in `permissionMode: 'auto'` — only
  // a turn that ADOPTS the session resets the mode — so a burst context defaulting to false would
  // make Frink's own PreToolUse hook prompt for approval on work the user already granted Auto for,
  // with no one watching. Read off the session rather than passed in, because the session's
  // callbacks read `currentTurn` of this same session, so the two can never disagree.
  const armingAutoReviewTools = session.currentTurn?.autoReviewTools ?? false;
  // ONE message spans the whole wait: the arming turn's, which every burst appends to. A burst
  // continues the turn the user is reading rather than answering it again — an id per burst made a
  // single wait render as N collapsed step bars with N action rows. Read off the session for the
  // same reason as the Auto grant above: the burst context REPLACES `currentTurn`, so both must
  // resolve from one place or they drift. `chunks` is therefore shared by reference with the turn
  // context, which is required — the AskUserQuestion path snapshots that same array mid-burst.
  const arming = session.currentTurn;
  if (!arming) throw new Error(`armWakePump: ${subChatId} has no arming turn to extend`);
  // Anchored to the ARMING turn's start when no signal is on record: the signal slot is per
  // execution context and never cleared, so a null anchor would let a PREVIOUS turn's `done`
  // read as this wait's own declaration and stand the pump down at the first burst.
  let lastSeenSignalAt: string | null = executionContextId
    ? (io.getLatestTaskSignal(executionContextId)?.at ?? arming.startedAt)
    : arming.startedAt;
  log.info(
    `[Socket Executor] Holding session for ${subChatId}: ${pendingWork.backgroundTasks.length} background task(s), ${pendingWork.sessionCrons.length} cron(s) pending — wake pump armed`,
  );
  const { msgId, lastCollectedChunks: chunks, nextMessageIndex } = arming;
  /** Incremental parts accumulator — mutated per chunk. Rebuilding the full array from `chunks`
   * on every chunk is the O(N²) allocation storm the streaming path exists to avoid. Rebuilt whole
   * at each burst end, which is also how chunks that bypass `applyChunkToParts` (AskUserQuestion
   * pushes straight into the history) get folded back in rather than drifting for the whole wait. */
  let partsState = partsStateFromChunks(chunks);
  let burst: {
    /** Where this burst's chunks begin in the cumulative array — the arming turn and earlier
     * bursts sit below it and must not be re-emitted or re-scanned. */
    startIndex: number;
    transform: ReturnType<typeof createTransformer>;
    deniedToolIdsWithMessages: Map<string, string>;
  } | null = null;
  /** Accumulate one chunk into the merged message and ship it with the cumulative snapshot. */
  const emitChunk = (chunk: UIMessageChunk): void => {
    chunks.push(chunk);
    applyChunkToParts(partsState, chunk);
    io.streamChunk(msgId, chunk, partsSnapshot(partsState), nextMessageIndex());
  };
  const backfill = (b: NonNullable<typeof burst>): void =>
    backfillDeniedTools(chunks, b.startIndex, b.deniedToolIdsWithMessages, emitChunk);
  /** Latched by a burst whose own stop declared the turn finished (`declaresWaitOver`) — the
   * agent's word over the harness's task list, for a task that can never report itself done. */
  let waitOverDeclared = false;
  /** The wait's advertisement has been settled and stdin closed; the loop is now salvaging
   * whatever the CLI still writes. Those bursts are text only — the task row is already
   * reconciled, and re-settling it from a drain burst could flip a verdict the user has seen. */
  let waitOver = false;
  const pump = armIdle(session, {
    // Re-read Stop work each burst; without a hook it is unknown, so await stream settlement.
    // `waitOverDeclared` short-circuits that: a burst whose own stop declared the turn finished.
    isWorkFinished: () =>
      waitOverDeclared || (Boolean(session.stopHook) && !session.stopHook?.lastPendingWork),
    onWaitOver: () => {
      waitOver = true;
      retractHold(hold, 'wait-over');
    },
    onBurstStart: () => {
      const wakeTurn = createWakeBurstTurn(arming, {
        msgId,
        chunks,
        nextMessageIndex,
        autoReviewTools: armingAutoReviewTools,
        waitForExecutionSettlement:
          params.executionSettlement?.wait ?? arming.waitForExecutionSettlement,
      });
      burst = {
        startIndex: chunks.length,
        transform: createTransformer(),
        deniedToolIdsWithMessages: wakeTurn.deniedToolIdsWithMessages,
      };
      session.currentTurn = wakeTurn;
      void resumeQuietIdleParkOnBurst(signalTaskId, subChatId);
    },
    onMessage: (m) => {
      if (!burst) return;
      for (const chunk of burst.transform(m)) {
        emitChunk(chunk);
      }
    },
    onBurstEnd: async () => {
      if (!burst) return;
      backfill(burst);
      // Before the parts rebuild below, which folds the card's chunks into the accumulator, and
      // before completeBurst persists them — a card emitted after either would not survive reload.
      // Raising the halt leaves every later burst tool-less until the user approves — read through
      // the arming turn's live getter, which each burst context inherits.
      await io.emitPlanCard(msgId, chunks, burst.startIndex, burst.deniedToolIdsWithMessages, {
        onSubmitted: arming.setPlanSubmissionHalt,
        planAlreadySubmitted: arming.planSubmissionHalt(),
        waitStartedMs: Date.parse(arming.startedAt),
      });
      const hadContent = chunks.length > burst.startIndex;
      burst = null;
      partsState = partsStateFromChunks(chunks);
      // Awaited: the wait may be declared over the moment this returns, and disposal follows.
      await io.completeBurst(msgId, chunks, hadContent);
      if (waitOver) return;
      const pending = session.stopHook?.lastPendingWork;
      const settled = await settleBurstSignal({
        subChatId,
        signalTaskId,
        executionContextId,
        getLatestTaskSignal: io.getLatestTaskSignal,
        pending,
        lastSeenSignalAt,
        throwOnError: Boolean(params.releaseFlowResourceActivity),
      });
      lastSeenSignalAt = settled.lastSeenSignalAt;
      waitOverDeclared ||= settled.waitOver;
      // Re-state what the wait is still blocked on, now that this burst's own stop refreshed the
      // snapshot. A falsy read ends the wait rather than extends it. Checked AFTER the await so a
      // takeover or Stop landing during it still wins; `waitOverDeclared` joins `retracted` because
      // this callback runs before the work-finished branch and would else advertise one last wait.
      if (pending && !hold.retracted && !waitOverDeclared) {
        io.setHeld(true, summarizePendingWork(pending));
      }
    },
  });
  const hold: WakeHold = {
    pump,
    session,
    execution: arming.execution,
    setHeld: io.setHeld,
    releaseFlowResourceActivity: params.releaseFlowResourceActivity,
    releaseRuntimeSlot: params.releaseRuntimeSlot,
    unregisterFlowRunAbort: params.unregisterFlowRunAbort,
    retracted: false,
    settling: false,
  };
  setHold(subChatId, hold, pendingWork);
  hold.executionSettlement = params.executionSettlement?.retain();
  void pump.done
    .then(async (exit) => {
      hold.settling = true;
      await settleClaudeWakeHold({
        exit,
        resources: hold,
        subChatId,
        session,
        executionContextId,
        io,
        canClearPendingApprovals: params.canClearPendingApprovals,
        retractIfCurrent: () => {
          const own = activeWakeHolds.get(subChatId);
          if (own?.pump === pump) retractHold(own);
        },
        dropIfCurrent: () => {
          const own = activeWakeHolds.get(subChatId);
          if (own?.pump === pump) dropHold(subChatId, own);
        },
        takeCutShortBurst: () => {
          const cutShort = burst;
          burst = null;
          if (!cutShort) return null;
          return {
            backfill: () => backfill(cutShort),
            complete: () => io.completeBurst(msgId, chunks, chunks.length > cutShort.startIndex),
          };
        },
      });
      hold.executionSettlement?.finish();
    })
    .catch((error) => {
      hold.executionSettlement?.finish(error);
      captureMainException(error, { surface: 'claude-wake-hold', stage: 'cleanup' });
      log.error(`[Socket Executor] Wake hold cleanup failed for ${subChatId}`, error);
    });
  return hold;
}
