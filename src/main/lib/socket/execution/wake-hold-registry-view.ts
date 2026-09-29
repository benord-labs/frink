/** Read-only views over the wake-hold registry. */

import log from 'electron-log';
import type { WakeHoldState } from '../../../../shared/types/wake-hold';
import { getSession as getClaudeSession } from '../claude-session-registry';
import { readWakeHolds } from '../claude-wake-hold';
import { summarizePendingWork } from './wake-hold-signal';

/**
 * Every LIVE hold, so a renderer that just booted can re-seed the wait state it keeps only in
 * memory. This registry is the sole record, and a window that cannot see a hold also loses the held
 * row's Stop — the only stop affordance between bursts, while the pump keeps running regardless.
 *
 * Read live off the Stop hook rather than a cached snapshot: it rewrites `lastPendingWork` on the
 * first line of every stop, so this is the same source the per-burst republish reads and the two
 * lanes cannot disagree. Null exactly when nothing is in flight, so `waitingOn` is never empty.
 *
 * `retracted`, not membership, is what says a wait ended — a stopped hold keeps its entry so its
 * live pump stays adoptable, and listing one would resurrect a wait the user already stopped.
 * `settling` covers the window after `pump.done` fires but before the retraction lands. Neither
 * `pump.isEnded()` nor a burst's wait-over declaration earns a field here: each leads its flag by
 * one microtask, and the retraction broadcast that follows corrects a list taken inside it.
 */
export function listWakeHolds(): Array<{
  subChatId: string;
  chatId: string;
  pending: WakeHoldState;
}> {
  return [...readWakeHolds()].flatMap(([subChatId, hold]) => {
    if (hold.retracted || hold.settling) return [];
    // A hold with no hook can never satisfy `isWorkFinished` — unstoppable by itself, so it must not
    // ALSO be what this list silently hides. Every production session is spawned with one.
    const { stopHook } = hold.session;
    if (!stopHook) log.warn(`[Socket Executor] Wake hold for ${subChatId} has no Stop hook`);
    const work = stopHook?.lastPendingWork;
    return work ? [{ subChatId, chatId: hold.chatId, pending: summarizePendingWork(work) }] : [];
  });
}

/**
 * Whether a Flow successor can enter the Claude provider seam on the slot already owned by its
 * exact live wake hold. This is a read-only preflight: `takeWakeHold` remains the ownership
 * transfer boundary and rechecks both session identity and pump liveness. A hold whose wait is
 * over (queue closed, session draining) mirrors takeWakeHold's refusal — its slot settles with
 * its own pump, and reporting it reusable would let the non-adopting branch kill the drain.
 */
export function hasReusableWakeHoldRuntimeSlot(subChatId: string): boolean {
  const hold = readWakeHolds().get(subChatId);
  return Boolean(
    hold?.releaseFlowResourceActivity &&
    hold.releaseRuntimeSlot &&
    getClaudeSession(subChatId) === hold.session &&
    !hold.pump.isEnded() &&
    !hold.session.queue.closed,
  );
}
