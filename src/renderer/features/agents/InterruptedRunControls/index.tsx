/**
 * InterruptedRunControls — chat-level resume affordance for a flow run that was interrupted by an
 * app/process restart (the run is `cancelled` but carries the restart marker, so its worktree +
 * upstream outputs are intact). Pinned above the composer, mirroring TaskAcceptBar, because the
 * interrupted agent may have died before streaming its first frame — there is no assistant message
 * to anchor message-level controls (TaskControls) to.
 *
 * Why it exists: a restart-interrupted flow chat is otherwise a dead-end from the chat surface —
 * the "Re-run from previous node" control lives only in the FlowEditor run-history panel. A run
 * cancelled deliberately by the user (no marker) is NOT resumable, so the row stays hidden for it.
 *
 * TWO mechanisms behind one row, chosen server-side by `resumeMode` (flows/resume.ts):
 *  - `session` — the common case. "Resume" sends a HIDDEN wake message down the same follow-up pipe
 *    a typed reply uses, so the agent simply wakes and continues in place. Deliberately NOT a
 *    re-dispatch: that re-sends the node's full instructions as a visible bubble the transcript
 *    already contains, which reads to the user as the flow asking twice and to the agent as a
 *    contradiction against the session it just resumed.
 *  - `redispatch` — a non-agent node was interrupted, or this sub-chat has no resumable session, so
 *    there is nothing to wake. Falls back to the run-scoped `flows.rerunRun` and RENAMES itself to
 *    "Re-run step", because that genuinely re-runs the step from its instructions. Never call that
 *    "Resume" — a resume that silently re-runs is the masquerade this surface exists to avoid.
 */

import { Button } from '@benord-labs/frink-primitives';
import { Play, RotateCw } from 'lucide-react';
import { memo, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { buildHiddenWakeMessage } from '../../../../shared/lib/message-markers/hidden-wake-marker';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip';
import { RESUME_INTERRUPTED_WAKE_TEXT } from '../../../lib/agent-chat/resume-wake-text';
import { useFlowResumeLock } from '../../../lib/agent-chat/use-flow-resume-lock';
import { trpc } from '../../../lib/trpc';
import { clearFlowRunEndedErrorSignal } from '../main/active-chat/utils';
import { RunStatusRow } from '../RunStatusRow';

type InterruptedRunControlsProps = {
  chatId: string | null;
  /** Scopes the wake: only the sub-chat whose session drives the interrupted node can be woken. */
  subChatId: string;
  /** Guarded chat send (socket/account checks + autoscroll); false when it refused to send. */
  guardedSend: (text: string) => boolean;
  /** Streaming state — the resume lock releases on the turn it started actually ending. */
  isTurnActive: boolean;
};

/** A resume ticket (boot carry-on, typed reply, or Re-run step) already owns the run and waits for a slot. */
function QueuedResumeRow() {
  return (
    <RunStatusRow dotClassName="bg-[hsl(var(--status-warning))]" label="Flow run interrupted">
      <span className="px-2 text-xs text-muted-foreground">Queued to resume this step…</span>
    </RunStatusRow>
  );
}

function buttonText(pending: boolean, isSessionResume: boolean, label: string): string {
  if (!pending) return label;
  return isSessionResume ? 'Resuming…' : 'Re-running…';
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

  const rerunMutation = trpc.flows.rerunRun.useMutation({
    onSuccess: () => {
      if (!chatId) return;
      void utils.flows.interruptedRunForChat.invalidate({ chatId, subChatId });
      void utils.flows.hasIncompleteRunForChat.invalidate({ chatId });
    },
    // No global mutationCache.onError — without this a server precondition throw (run already
    // advanced / cancelled meanwhile) would be silently swallowed. Only the re-dispatch branch
    // fires this mutation; a failed wake is reported by the resume lock instead.
    onError: (error) =>
      toast.error('Could not re-run the step', {
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
  const { resumePending, start } = useFlowResumeLock(data?.runId ?? '', isTurnActive);

  // Only a recoverable (restart-interrupted) run gets a resume CTA; a user-cancelled run is absent
  // here (resumable === false renders nothing — the user stopped it on purpose).
  if (!data?.resumable) return null;

  // Nothing to click while the ticket waits (boot carry-on / typed reply); a second request would be refused.
  if (data.resumeMode === 'queued') return <QueuedResumeRow />;

  const isSessionResume = data.resumeMode === 'session';
  const pending = isSessionResume ? resumePending : rerunMutation.isPending;
  const label = isSessionResume ? 'Resume' : 'Re-run step';
  // An ELEMENT, not a component reference: a lowercase JSX tag would render an unknown HTML
  // element, and the naming rule forbids the capitalised const a component reference needs.
  const icon = isSessionResume ? (
    <Play className="h-3.5 w-3.5" aria-hidden />
  ) : (
    <RotateCw className="h-3.5 w-3.5" aria-hidden />
  );

  return (
    <RunStatusRow dotClassName="bg-[hsl(var(--status-warning))]" label="Flow run interrupted">
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          {/* span keeps the tooltip alive while the button is disabled (disabled elements
                don't fire pointer events). */}
          <span className="inline-flex">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 gap-1 text-xs text-muted-foreground hover:text-foreground rounded-md"
              disabled={pending}
              onClick={() => {
                // A latched FLOW_RUN_ENDED send failure must not outlive the user's recovery
                // action — cleared here, on intent, because a redispatch continuation streams
                // into a sub-chat whose start chunk may never reach the transport that latched it.
                clearFlowRunEndedErrorSignal(subChatId);
                if (isSessionResume) {
                  start(() => guardedSend(buildHiddenWakeMessage(RESUME_INTERRUPTED_WAKE_TEXT)));
                  return;
                }
                rerunMutation.mutate({ runId: data.runId });
              }}
              aria-label={
                isSessionResume
                  ? 'Resume interrupted flow run'
                  : 'Re-run the interrupted step of this flow run'
              }
              aria-busy={pending || undefined}
            >
              {icon}
              <span>{buttonText(pending, isSessionResume, label)}</span>
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {isSessionResume
            ? 'This flow run was interrupted by a restart. Resume wakes the agent where it stopped — same chat and worktree, no repeated instructions. Typing a message also resumes it.'
            : 'This step cannot be picked up mid-flight, so it restarts from its instructions in the same worktree. Any work it already did may happen again.'}
        </TooltipContent>
      </Tooltip>
    </RunStatusRow>
  );
});
