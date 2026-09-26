/**
 * Composer placeholder for the active-chat input — state-aware so the input itself tells the
 * user what typing does. The interrupted case is the load-bearing one: typing in a
 * restart-interrupted flow chat resumes the run in place (executor follow-up resume), but
 * nothing else on the surface says so — the placeholder is that affordance's only label.
 * Passive cache read: InterruptedRunControls owns the 5s poll on the same query, so the
 * Resume row and this placeholder follow one cache entry and cannot desync.
 */

import { trpc } from '../trpc';

export function useComposerPlaceholder(
  parentChatId: string,
  subChatId: string,
  isStreaming: boolean,
): string {
  const { data } = trpc.flows.interruptedRunForChat.useQuery(
    { chatId: parentChatId, subChatId },
    { enabled: !!parentChatId, staleTime: 30000 },
  );
  if (isStreaming) return 'Add to the queue';
  // Name the button as it actually reads: it says "Re-run step" whenever the run can't be woken.
  // In that mode typing cannot resume the run (there is no session or admission slot to wake into),
  // so the placeholder must not promise it.
  // Queued: a resume ticket (carry-on or Re-run step) already owns the run; no button can help.
  if (data?.resumable && data.resumeMode === 'queued')
    return 'Waiting for a free slot to resume this step — it will pick up where it stopped';
  if (data?.resumable)
    return data.resumeMode === 'session'
      ? 'Type to resume with new instructions — or press Resume to continue as-is'
      : 'Press Re-run step to restart this step — typing will not resume it';
  return 'Plan, @ for context, / for commands';
}
