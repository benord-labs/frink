/**
 * TaskAcceptBar — chat-level accept affordance (done → completed), pinned above the composer.
 *
 * Chat-level rather than message-anchored on purpose: a cancelled follow-up leaves the user's
 * message as the subchat's last with no assistant reply, which orphans any message-anchored
 * control. Shown constantly while the task awaits review — nothing flips a task off `done` on a
 * follow-up message, so hiding it during streaming only made it flicker; the work stays
 * unverified until the user accepts (or cancels/deletes the task elsewhere).
 */

import { Button } from '@benord-labs/frink-primitives';
import { Archive, Check } from 'lucide-react';
import { memo } from 'react';
import { trpc } from '../../../../../lib/trpc';
import { RunStatusRow } from '../../../RunStatusRow';
import { invalidateTaskQueries } from '../utils';

type TaskAcceptBarProps = {
  subChatId: string;
  /** The chat's pinned task (chats.taskId) — the acting task for non-flow chats. */
  pinnedTaskId: string | null;
  chatId: string | null;
};

export const TaskAcceptBar = memo(function TaskAcceptBar({
  subChatId,
  pinnedTaskId,
  chatId,
}: TaskAcceptBarProps) {
  const utils = trpc.useUtils();
  // The SAME resolver TaskControls uses (one cache entry — react-query dedups the fetch): both
  // status rows act on one task, so their states stay mutually exclusive by construction. Poll
  // while awaiting review: other surfaces (work queue, sidebar) complete the task without
  // invalidating this cache — without it the bar would linger after an accept made elsewhere.
  // The same poll carries `flowRunStatus`, so the bar appears within a tick of the run finishing.
  const { data: task } = trpc.tasks.getActionableTaskForSubChat.useQuery(
    { subChatId, fallbackTaskId: pinnedTaskId },
    {
      enabled: subChatId.length > 0,
      refetchInterval: (query) => (query.state.data?.status === 'completed' ? false : 5000),
    },
  );
  const taskId = task?.id ?? null;
  // Accept goes through tasks.complete (not updateStatus): completing a flow task must also flip
  // the run's sibling `done` rows, which the complete proc handles.
  const completeMutation = trpc.tasks.complete.useMutation({
    onSuccess: () => invalidateTaskQueries(utils),
  });

  // Flow tasks accept only when the run actually COMPLETED (final node done). A mid-flow `done`
  // must not surface the bar (the flow is still working), and a cancelled/failed run never offers
  // completion — done ≠ completed: the run dying early means the work was never finished, however
  // reviewable the partial output is (see decision `agent-execution-wall-clock` context).
  const show =
    taskId !== null &&
    task?.status === 'done' &&
    (!task.flowRunId || task.flowRunStatus === 'completed');

  if (!show) return null;

  return (
    <RunStatusRow
      dotClassName="bg-[hsl(var(--status-online))]"
      label="Ready for review"
      detail="verify the result, then mark it complete."
    >
      <Button
        variant="ghost"
        size="sm"
        onClick={() => completeMutation.mutate({ taskId })}
        disabled={completeMutation.isPending}
        className="h-7 px-2.5 gap-1 text-xs rounded-md text-[hsl(var(--status-online-text))] hover:text-[hsl(var(--status-online-text))] hover:bg-[hsl(var(--status-online)/0.1)]"
        aria-label="Mark task complete"
        title="Mark complete"
        aria-busy={completeMutation.isPending || undefined}
      >
        <Check className="h-3.5 w-3.5" />
        <span>Mark complete</span>
      </Button>
      {/* Primary end-of-flow action: accept the result AND clear the chat from the sidebar in
                one click. Completes first (done → completed), then asks the sidebar to archive —
                archive is recoverable, so this is the safe default for closing out parallel runs. */}
      <Button
        variant="ghost"
        size="sm"
        onClick={() =>
          completeMutation.mutate(
            { taskId },
            {
              onSuccess: () => {
                if (!chatId) return;
                window.dispatchEvent(
                  new CustomEvent('sidebar:archive-chat', { detail: { chatId } }),
                );
              },
            },
          )
        }
        disabled={completeMutation.isPending}
        className="h-7 px-2.5 gap-1 text-xs rounded-md text-[hsl(var(--status-online-text))] hover:text-[hsl(var(--status-online-text))] hover:bg-[hsl(var(--status-online)/0.1)]"
        aria-label="Mark task complete and archive chat"
        title="Complete & Archive"
        aria-busy={completeMutation.isPending || undefined}
      >
        <Archive className="h-3.5 w-3.5" />
        <span>{completeMutation.isPending ? 'Completing...' : 'Complete & Archive'}</span>
      </Button>
    </RunStatusRow>
  );
});
