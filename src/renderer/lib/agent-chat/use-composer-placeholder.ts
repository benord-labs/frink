/**
 * Composer placeholder; in a restart-interrupted flow chat it is the only cue that typing continues
 * the run. Reads InterruptedRunControls' polled cache entry so both stay in sync.
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
  // Queued: a resume ticket (a typed reply, or a Continue/Retry click) already owns the run.
  if (data?.resumable && data.resumeMode === 'queued')
    return 'Queued to resume this step — it will pick up where it stopped';
  // Name the one button the row shows. Retry means nothing of the step reached a session, so typing
  // has no conversation to continue and the hint must not promise it.
  if (data?.resumable)
    return data.resumeMode === 'retry'
      ? 'Press Retry to run this step again'
      : 'Type to continue with new instructions — or press Continue';
  return 'Plan, @ for context, / for commands';
}
