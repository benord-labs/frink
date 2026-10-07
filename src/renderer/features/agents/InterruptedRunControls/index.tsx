/**
 * InterruptedRunControls — pinned recovery row for a run cancelled by an app restart (marker set),
 * hidden for user cancels; Continue/Retry is chosen server-side by `resumeMode` (flows/resume.ts).
 */

import { memo, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { buildHiddenWakeMessage } from '../../../../shared/lib/message-markers/hidden-wake-marker';
import type { RecoveryKind } from '../../../../shared/types/flow-run/resume';
import { RESUME_INTERRUPTED_WAKE_TEXT } from '../../../lib/agent-chat/resume-wake-text';
import { useFlowResumeLock } from '../../../lib/agent-chat/use-flow-resume-lock';
import { trpc } from '../../../lib/trpc';
import { clearFlowRunEndedErrorSignal } from '../main/active-chat/utils';
import { RunStatusRow } from '../RunStatusRow';
import { RecoverRow } from './RecoverRow';

type InterruptedRunControlsProps = {
  chatId: string | null;
  /** Scopes the wake: only the sub-chat whose session drives the interrupted node can be woken. */
  subChatId: string;
  /** Guarded chat send (socket/account checks + autoscroll); false when it refused to send. */
  guardedSend: (text: string) => boolean;
  /** Streaming state — the resume lock releases on the turn it started actually ending. */
  isTurnActive: boolean;
};

/** A resume ticket (boot continuation, typed reply, or a Continue/Retry click) already owns the run and waits for a slot. */
function QueuedResumeRow() {
  return (
    <RunStatusRow dotClassName="bg-[hsl(var(--status-warning))]" label="Flow run interrupted">
      <span className="px-2 text-xs text-muted-foreground">Queued to resume this step…</span>
    </RunStatusRow>
  );
}

export const InterruptedRunControls = memo(function InterruptedRunControls({
  chatId,
  subChatId,
  guardedSend,
  isTurnActive,
}: InterruptedRunControlsProps) {
  const utils = trpc.useUtils();
  const { data } = trpc.flows.interruptedRunForChat.useQuery(
    { chatId: chatId ?? '', subChatId },
    {
      enabled: Boolean(chatId),
      // Poll only while a RESUMABLE run lingers, so the row clears once a resume flips the run
      // back to running. A user-cancelled run is also `cancelled` (truthy data) but renders nothing,
      // so gating on `resumable` (not mere presence) avoids polling forever with no row to clear.
      refetchInterval: (query) => (query.state.data?.resumable ? 5000 : false),
    },
  );

  // Keyed on tab + run + step + mode: the row is reused across all, so a confirm is for one Retry.
  const [confirmingFor, setConfirmingFor] = useState<string | null>(null);
  // Switching any of them drops the confirmation, so returning never reopens a stale one.
  const confirmTarget = data
    ? `${subChatId}:${data.runId}:${data.nodeRunId}:${data.resumeMode}`
    : null;
  if (confirmingFor !== null && confirmingFor !== confirmTarget) setConfirmingFor(null);
  // Set on submit, so a second click before `isPending` renders cannot send a second request.
  const rerunInFlight = useRef(false);
  const rerunMutation = trpc.flows.retryRunFromLastNode.useMutation({
    // Awaited (also after a refusal), so the button stays disabled until the refetched row lands.
    onSettled: async () => {
      rerunInFlight.current = false;
      setConfirmingFor(null);
      if (!chatId) return;
      await Promise.all([
        utils.flows.interruptedRunForChat.invalidate({ chatId, subChatId }),
        utils.flows.hasIncompleteRunForChat.invalidate({ chatId }),
      ]);
    },
    // No global mutationCache.onError — without this a server precondition throw (run already
    // advanced / cancelled meanwhile) would be silently swallowed. Only the re-admit branch fires
    // this mutation; a failed wake is reported by the resume lock instead.
    onError: (error) =>
      toast.error('Could not recover the step', {
        description: error.message || 'Please try again in a moment.',
      }),
  });

  // Backstop for the on-click clear below: main can emit the declined send's `execute:error`
  // LATE (its preflight is async), after the click already cleared the latch — a fresh listener
  // set has no assistantMessageId yet, so the stale-error guard cannot drop it and it re-latches.
  // The authoritative signal that recovery worked is this row's own query flipping the run off
  // `resumable`; clear again on that transition so a re-latched signal cannot outlive recovery.
  // The helper is category-scoped: an unrelated failure latched meanwhile must survive.
  // The prior observation is keyed to its sub-chat: this component is not remounted per sub-chat
  // (no key= on the row), so a panel switch must not read X's `resumable` as Y's transition and
  // wipe Y's own legitimately-latched signal.
  const resumable = Boolean(data?.resumable);
  const lastObserved = useRef({ subChatId, resumable: false });
  useEffect(() => {
    const prev = lastObserved.current;
    lastObserved.current = { subChatId, resumable };
    if (prev.subChatId === subChatId && prev.resumable && !resumable) {
      clearFlowRunEndedErrorSignal(subChatId);
    }
  }, [resumable, subChatId]);

  // Single-shot lock shared with the paused bar: its ref closes the same-tick double-click window
  // that React state alone leaves open. Without it a second click inside the 5s poll window sends a
  // duplicate request, which the executor treats as a supersede — aborting the very turn the first
  // click started. It also reports a wake that ended with the run still cancelled.
  const { resumePending, start } = useFlowResumeLock(data?.runId ?? '', subChatId, isTurnActive);

  // Only a recoverable (restart-interrupted) run gets a resume CTA; a user-cancelled run is absent
  // here (resumable === false renders nothing — the user stopped it on purpose).
  if (!data?.resumable) return null;

  // Nothing to click while the ticket waits (boot continuation / typed reply); a second request would be refused.
  if (data.resumeMode === 'queued') return <QueuedResumeRow />;

  const isSessionResume = data.resumeMode === 'session';
  const isRetry = data.resumeMode === 'retry';
  const pending = isSessionResume ? resumePending : rerunMutation.isPending;
  const recover = (kind: RecoveryKind) => {
    // Clear a latched FLOW_RUN_ENDED send failure on intent: a re-admitted step streams into a
    // sub-chat whose start chunk may never reach the transport that latched it.
    clearFlowRunEndedErrorSignal(subChatId);
    if (kind === 'continue' && isSessionResume) {
      start(() => guardedSend(buildHiddenWakeMessage(RESUME_INTERRUPTED_WAKE_TEXT)));
      return;
    }
    if (rerunInFlight.current) return;
    rerunInFlight.current = true;
    rerunMutation.mutate({ runId: data.runId, kind });
  };

  return (
    <RecoverRow
      isRetry={isRetry}
      pending={pending}
      confirming={confirmingFor === confirmTarget}
      onTrigger={() =>
        isRetry && data.confirmSideEffects
          ? setConfirmingFor(confirmTarget)
          : recover(isRetry ? 'retry' : 'continue')
      }
      // The confirm only ever retries; the server refuses it if the step has since changed.
      onConfirm={() => recover('retry')}
      onCancel={() => setConfirmingFor(null)}
    />
  );
});
