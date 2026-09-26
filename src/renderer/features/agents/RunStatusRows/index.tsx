/**
 * RunStatusRows — the full end-of-run stack for a sub-chat, in one mount: accept
 * (TaskAcceptBar), Retry/Carry-on (TaskControls) and Resume (InterruptedRunControls), all
 * RunStatusRow grammar. Their states are mutually exclusive (accept + retry share one
 * sub-chat-scoped task resolver; resume is marker-gated), so at most one row renders.
 */

import { Button } from '@benord-labs/frink-primitives';
import { useAtomValue } from 'jotai';
import { Square } from 'lucide-react';
import { toast } from 'sonner';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip';
import { wakeHeldAtomFamily } from '../../../lib/stores/active-transport-registry';
import { trpc } from '../../../lib/trpc';
import { InterruptedRunControls } from '../InterruptedRunControls';
import { TaskAcceptBar, TaskControls } from '../main/active-chat/components';
import { RunStatusRow } from '../RunStatusRow';

type RunStatusRowsProps = {
  subChatId: string;
  /** The chat's pinned task (chats.taskId) — the acting task for non-flow chats. */
  pinnedTaskId: string | null;
  chatId: string | null;
  /** Guarded chat send — the Resume row wakes an interrupted run through it. */
  guardedSend: (text: string) => boolean;
  /** Streaming state, so the Resume row can tell a finished wake from a stalled one. */
  isTurnActive: boolean;
  /**
   * True while a flow surface owns the chat's terminal verb — see {@link BackgroundWaitRow}. Also
   * true while the driving-task query is still PENDING: a flow chat derives 'composer' before its
   * first result, so trusting that window would offer a raw stop on exactly the chats that must not
   * have one. The same value gates KeyboardShortcutsManager's `suppressRawStop`, from one expression
   * in ActiveChat, so the row and the Escape key can never disagree about who owns stopping.
   */
  flowSurfaceOwnsStop: boolean;
};

/**
 * The session is alive between wake bursts, waiting on work it started — a backgrounded command, a
 * Monitor, a ScheduleWakeup cron — and will resume on its own. Everything else about the chat looks
 * finished at this point, so without this row the wait is invisible and the last message reads as a
 * final answer.
 *
 * Names what it is waiting on, from the snapshot main refreshes at every wake burst — the arming
 * snapshot it used to carry could only shrink into a lie, which is why this row said nothing before.
 * The wording stays "as of the last wake" honest: between bursts nothing newer exists to report,
 * because the pump only learns anything when the harness wakes it.
 *
 * Stop is this wait's ONLY in-app exit. Nothing else offers one between bursts: the composer toggles
 * Send/Stop on `isStreaming`, false while the pump idles, and this row replaces the end-of-run rows
 * so Accept/Retry are unreachable too. `stopTarget` is null when the chat cannot own that verb —
 * either a flow surface already owns it (a raw stop there aborts without `cancelRun` and strands the
 * run, per decision flow-run-chat-surface) or there is no chat id to address the stop to.
 */
/**
 * "2 Monitors" · "1 Command, 1 Scheduled wake" — aggregated by kind, because a wait on five shell
 * commands should not print the same word five times. Every label is one of a fixed set main emits,
 * so the naive plural is safe and the string is bounded.
 */
function describeWait(waitingOn: string[]): string {
  const byKind = new Map<string, number>();
  for (const label of waitingOn) byKind.set(label, (byKind.get(label) ?? 0) + 1);
  return [...byKind]
    .map(([label, count]) => `${count} ${label}${count === 1 ? '' : 's'}`)
    .join(', ');
}

function BackgroundWaitRow({
  waitingOn,
  stopTarget,
}: {
  /** Non-empty — the IPC guard rejects a hold that names nothing. */
  waitingOn: string[];
  stopTarget: { chatId: string; subChatId: string } | null;
}) {
  // Same mutation the transport's own abort fires, so a stop from here is indistinguishable from
  // the composer's: onStop → handleRemoteStop → releaseWakeHold, which retracts the held flag
  // eagerly rather than waiting for the stream to unwind.
  const stopWait = trpc.socket.sendStop.useMutation({
    // sendStop reports a refusal in its payload rather than throwing, so both paths need handling.
    onSuccess: (result) => {
      if (!result.success) {
        toast.error('Could not stop the background work', { description: result.reason });
      }
    },
    onError: (error) =>
      toast.error('Could not stop the background work', { description: error.message }),
  });

  return (
    <RunStatusRow
      dotClassName="bg-primary motion-safe:animate-pulse"
      label={`Working in the background — ${describeWait(waitingOn)}`}
    >
      {stopTarget ? (
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
                disabled={stopWait.isPending}
                onClick={() => stopWait.mutate(stopTarget)}
                aria-label="Stop waiting on background work"
                aria-busy={stopWait.isPending || undefined}
              >
                <Square className="h-3.5 w-3.5" aria-hidden />
                <span>{stopWait.isPending ? 'Stopping…' : 'Stop'}</span>
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            Ends the wait and the agent&apos;s session, which also stops the background work it
            started. Sending a message continues the chat instead.
          </TooltipContent>
        </Tooltip>
      ) : null}
    </RunStatusRow>
  );
}

export function RunStatusRows({
  subChatId,
  pinnedTaskId,
  chatId,
  guardedSend,
  isTurnActive,
  flowSurfaceOwnsStop,
}: RunStatusRowsProps) {
  const wakeHold = useAtomValue(wakeHeldAtomFamily(subChatId));

  // A held session has not finished, so none of the end-of-run affordances apply yet — accepting or
  // retrying a run that is about to write more would act on a half-finished state. The wait
  // REPLACES them, preserving this surface's one-row-at-a-time grammar.
  if (wakeHold) {
    return (
      <BackgroundWaitRow
        waitingOn={wakeHold.waitingOn}
        stopTarget={chatId && !flowSurfaceOwnsStop ? { chatId, subChatId } : null}
      />
    );
  }

  return (
    <>
      <TaskAcceptBar subChatId={subChatId} pinnedTaskId={pinnedTaskId} chatId={chatId} />
      <TaskControls subChatId={subChatId} pinnedTaskId={pinnedTaskId} />
      <InterruptedRunControls
        chatId={chatId}
        subChatId={subChatId}
        guardedSend={guardedSend}
        isTurnActive={isTurnActive}
      />
    </>
  );
}
