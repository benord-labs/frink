import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';

/**
 * Key an unsent mid-run note to the RUN, not just the sub-chat. `getOrCreateFlowChat` reuses one
 * chat + sub-chat for every run against the same worktree, so a sub-chat-only key would let a note
 * typed during run A survive that run's end and resurface under an unrelated run B — auto-opened,
 * one Enter away from being queued into the wrong run's turn. Scoping to the run means a later run
 * always starts clean, and the draft only outlives the surface, never the run it was written for.
 */
export const flowNoteDraftKey = (flowRunId: string, subChatId: string) =>
  `${flowRunId}:${subChatId}`;

/**
 * Unsent mid-run note per run+sub-chat, held outside FlowRunStrip so the draft survives the strip
 * unmounting — the flow-chat bottom surface swaps the strip out whenever the run parks or ends,
 * which is exactly when a user is most likely to be mid-sentence.
 *
 * Deliberately NOT shared with the park reply box: that surface keys its draft on the driving task
 * so sequential parked nodes reset between parks, and sharing this would carry an unsent note into
 * the next park and quietly reverse that reset (decision flow-park-answer-surface).
 */
export const flowNoteDraftAtomFamily = atomFamily((_runScopedKey: string) => atom<string>(''));
