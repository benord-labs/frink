/**
 * RunStatusRows — the full end-of-run stack for a sub-chat, in one mount: accept
 * (TaskAcceptBar), a stopped task's Continue/Retry (TaskControls) and an interrupted run's
 * (InterruptedRunControls), all RunStatusRow grammar. Their states are mutually exclusive (accept + retry share one
 * sub-chat-scoped task resolver; resume is marker-gated), so at most one row renders.
 */

import { Button } from '@benord-labs/frink-primitives';
import { useAtomValue } from 'jotai';
import { Square } from 'lucide-react';
import { toast } from 'sonner';
import type { WakeHoldItem, WakeHoldState } from '../../../../shared/types/wake-hold';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip';
import {
  backgroundRosterAtomFamily,
  wakeHeldAtomFamily,
} from '../../../lib/stores/active-transport-registry';
import { backgroundWorkItems } from '../../../lib/stores/background-work-items';
import { trpc } from '../../../lib/trpc';
import { BackgroundWorkPopover } from '../BackgroundWorkPopover';
import { InterruptedRunControls } from '../InterruptedRunControls';
import { TaskAcceptBar, TaskControls } from '../main/active-chat/components';

type RunStatusRowsProps = {
  subChatId: string;
  /** The chat's pinned task (chats.taskId) — the acting task for non-flow chats. */
  pinnedTaskId: string | null;
  chatId: string | null;
  /** Guarded chat send — the Resume row wakes an interrupted run through it. */
  guardedSend: (text: string) => boolean;
  /** Streaming state: the Resume row tells a finished wake from a stalled one by it, and the
   * background-work row hands its Stops to the composer while a turn streams. */
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
 * Stays up while that work is live, through wake bursts and follow-up turns: a row that blinks out
 * while the agent speaks reads as "the work ended" (see {@link backgroundWorkItems}).
 *
 * Stop is this wait's ONLY in-app exit. Nothing else offers one between bursts: the composer toggles
 * Send/Stop on `isStreaming`, false while the pump idles, and this row replaces the end-of-run rows
 * so Accept/Retry are unreachable too. `stopTarget` is null when the chat cannot own that verb —
 * either a flow surface already owns it (a raw stop there aborts without `cancelRun` and strands the
 * run, per decision flow-run-chat-surface) or there is no chat id to address the stop to.
 * While a turn streams the composer's Stop owns the chat, so the row offers none.
 */
const MAX_LABEL_DESCRIPTION = 80;

/**
 * "2 Monitors" · "1 Command, 1 Scheduled wake" — aggregated by kind, because a wait on five shell
 * commands should not print the same word five times. Every label is one of a fixed set main emits,
 * so the naive plural is safe and the string is bounded.
 * A single item is named instead, so a new command never reads as the old one stuck.
 */
function describeWait(waitingOn: WakeHoldItem[]): string {
  const [only] = waitingOn;
  if (waitingOn.length === 1 && only.description.trim()) {
    const text = only.description.trim();
    return text.length > MAX_LABEL_DESCRIPTION
      ? `${text.slice(0, MAX_LABEL_DESCRIPTION - 1)}…`
      : text;
  }
  const byKind = new Map<string, number>();
  for (const { label } of waitingOn) byKind.set(label, (byKind.get(label) ?? 0) + 1);
  return [...byKind]
    .map(([label, count]) => `${count} ${label}${count === 1 ? '' : 's'}`)
    .join(', ');
}

function BackgroundWaitRow({
  subChatId,
  waitingOn,
  sessionStop,
  stopTarget,
  canStopItems,
}: {
  subChatId: string;
  /** Non-empty. */
  waitingOn: WakeHoldItem[];
  sessionStop: 'row' | 'flow' | 'none';
  stopTarget: { chatId: string; subChatId: string } | null;
  canStopItems: boolean;
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
    <BackgroundWorkPopover
      subChatId={subChatId}
      label={`Working in the background — ${describeWait(waitingOn)}`}
      waitingOn={waitingOn}
      sessionStop={sessionStop}
      canStopItems={canStopItems}
    >
      {sessionStop === 'row' && stopTarget ? (
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
                aria-label={
                  waitingOn.length > 1
                    ? 'Stop all background work'
                    : 'Stop waiting on background work'
                }
                aria-busy={stopWait.isPending || undefined}
              >
                <Square className="h-3.5 w-3.5" aria-hidden />
                <span>
                  {stopWait.isPending ? 'Stopping…' : waitingOn.length > 1 ? 'Stop all' : 'Stop'}
                </span>
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            Ends the wait and the agent&apos;s session, which also stops the background work it
            started. Sending a message continues the chat instead.
          </TooltipContent>
        </Tooltip>
      ) : null}
    </BackgroundWorkPopover>
  );
}

/** The background-work row for whatever is live, or nothing. `wakeHold` is passed in because the
 * parent also branches on it. */
function LiveBackgroundWork({
  subChatId,
  chatId,
  wakeHold,
  isTurnActive,
  flowSurfaceOwnsStop,
}: Pick<RunStatusRowsProps, 'subChatId' | 'chatId' | 'isTurnActive' | 'flowSurfaceOwnsStop'> & {
  wakeHold: WakeHoldState | null;
}) {
  const roster = useAtomValue(backgroundRosterAtomFamily(subChatId));
  const items = backgroundWorkItems(wakeHold, roster, isTurnActive);
  if (items.length === 0) return null;
  const stopTarget = chatId && !flowSurfaceOwnsStop ? { chatId, subChatId } : null;
  // While a turn streams, the composer's Stop owns the chat.
  const idleHold = wakeHold !== null && !isTurnActive;
  const sessionStop = !idleHold ? 'none' : stopTarget ? 'row' : 'flow';
  return (
    <BackgroundWaitRow
      subChatId={subChatId}
      waitingOn={items}
      sessionStop={sessionStop}
      stopTarget={stopTarget}
      // Main refuses to stop the last item of its own snapshot, so that count decides.
      canStopItems={idleHold && wakeHold.waitingOn.length > 1}
    />
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
  const row = (
    <LiveBackgroundWork
      subChatId={subChatId}
      chatId={chatId}
      wakeHold={wakeHold}
      isTurnActive={isTurnActive}
      flowSurfaceOwnsStop={flowSurfaceOwnsStop}
    />
  );

  // A held session has not finished, so none of the end-of-run affordances apply yet — accepting or
  // retrying a run that is about to write more would act on a half-finished state. The wait REPLACES
  // them, preserving this surface's one-row-at-a-time grammar.
  if (wakeHold) return row;

  // Unheld, the row only shows mid-turn, beside rows that stay mounted: the Resume row's lock tracks
  // the turn it started through `isTurnActive`.
  return (
    <>
      {row}
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
