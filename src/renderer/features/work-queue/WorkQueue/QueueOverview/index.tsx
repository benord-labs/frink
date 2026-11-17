import { Button } from '@benord-labs/frink-primitives';
import { memo, type ReactElement } from 'react';
import { toast } from 'sonner';
import {
  useApprovalActions,
  useAwaitingApprovals,
} from '../../../../lib/work-queue/approvals/use-work-queue-approvals';
import { useAttentionSelection } from '../../../../lib/work-queue/use-attention-selection';
import type { Task } from '../../types';
import {
  AttentionCarousel,
  type AttentionTaskActions,
  getAttentionCopy,
} from '../AttentionCarousel';
import { InboxTaskList } from '../InboxTaskList';
import { InterruptedRunsBanner } from '../InterruptedRunsBanner';
import { QueuedAdmissions } from '../QueuedAdmissions';
import { QueuePausedBanner } from '../QueuePausedBanner';
import { QueueProgressSummary } from '../QueueProgressSummary';
import { RunningTaskList } from '../RunningTaskList';
import { OtherAttentionTasks } from './OtherAttentionTasks';

type Props = {
  attentionTasks: Task[];
  /** Per-lane paging, plus `refresh` to reload every lane (e.g. after Continue all). */
  pagination?: Record<'attention' | 'inbox' | 'running', LanePagination> & {
    refresh?: () => Promise<void>;
  };
  /** The interrupted-runs banner; replaced in tests that do not exercise it. */
  interruptedRuns?: ReactElement | null;
  queuedAdmissions?: ReactElement;
  queuedCount: number;
  reviewCount: number;
  runningTasks: Task[];
  runningCount: number;
  taskActions: AttentionTaskActions;
  waitingTasks: Task[];
};

type LanePagination = {
  canLoadMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => Promise<void>;
};

function LoadOlderTasks({ label, pagination }: { label: string; pagination?: LanePagination }) {
  if (!pagination?.canLoadMore) return null;
  const handleLoad = () => {
    void pagination
      .loadMore()
      .catch(() => toast.error('Could not load older tasks', { description: 'Please try again.' }));
  };
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      loading={pagination.isLoadingMore}
      onClick={handleLoad}
      className="mt-2 text-muted-foreground"
    >
      Load older {label} tasks
    </Button>
  );
}

export const QueueOverview = memo(function QueueOverview({
  attentionTasks,
  pagination,
  interruptedRuns = <InterruptedRunsBanner onRecovered={() => void pagination?.refresh?.()} />,
  queuedAdmissions = <QueuedAdmissions />,
  queuedCount,
  reviewCount,
  runningTasks,
  runningCount,
  taskActions,
  waitingTasks,
}: Props): ReactElement {
  const approvals = useAwaitingApprovals();
  const approvalActions = useApprovalActions();
  const {
    promoteTask: promoteAttentionTask,
    selectTask: selectAttentionTask,
    selectedTaskId: selectedAttentionTaskId,
    spotlightActionRef,
  } = useAttentionSelection([
    ...approvals.map((gate) => ({ id: gate.flowRunId })),
    ...attentionTasks,
  ]);
  const hasSecondaryAttention =
    approvals.length + attentionTasks.length > 1 || pagination?.attention.canLoadMore === true;
  // The Running poll can lag the approvals poll; a run never shows in both at once.
  const shownRunningTasks = runningTasks.filter(
    (task) => !approvals.some((gate) => gate.flowRunId === task.flowRunId),
  );

  const openTaskCount = queuedCount + reviewCount + runningCount;
  const handleOpenTask = (task: Task) => {
    const chatId = task.result?.chatId ?? task.linkedChatId;
    if (!chatId) {
      toast.error('Cannot open this task', {
        description: 'This task is missing its linked chat.',
      });
      return;
    }
    void taskActions.onOpenChat(task, chatId);
  };

  return (
    <>
      <QueuePausedBanner />
      {interruptedRuns}
      {openTaskCount > 0 && (
        <div className="mb-4 shrink-0">
          <QueueProgressSummary
            queuedCount={queuedCount}
            reviewCount={reviewCount}
            runningCount={runningCount}
          />
        </div>
      )}
      {selectedAttentionTaskId && (
        <div className="mb-4 shrink-0">
          <AttentionCarousel
            approvals={{ gates: approvals, actions: approvalActions }}
            tasks={attentionTasks}
            onOpenTask={handleOpenTask}
            onSelectTask={selectAttentionTask}
            selectedTaskId={selectedAttentionTaskId}
            spotlightActionRef={spotlightActionRef}
            taskActions={taskActions}
          />
        </div>
      )}
      {shownRunningTasks.length > 0 && (
        <div className="mb-4 shrink-0">
          <RunningTaskList
            tasks={shownRunningTasks}
            taskActions={taskActions}
            onOpenTask={handleOpenTask}
          />
          <LoadOlderTasks label="running" pagination={pagination?.running} />
        </div>
      )}
      {selectedAttentionTaskId && hasSecondaryAttention && (
        <div className="mb-4 shrink-0">
          <OtherAttentionTasks
            key={selectedAttentionTaskId}
            approvals={approvals}
            canLoadMore={pagination?.attention.canLoadMore === true}
            getPresentation={getAttentionCopy}
            onPromoteTask={promoteAttentionTask}
            selectedTaskId={selectedAttentionTaskId}
            taskActions={taskActions}
            tasks={attentionTasks}
            totalCount={reviewCount}
          />
          <LoadOlderTasks label="attention" pagination={pagination?.attention} />
        </div>
      )}
      {/* Always mounted: this subtree owns the removal announcement + focus target, which must
          outlive the last queued row leaving. It renders nothing of its own when the queue is empty. */}
      <div className="shrink-0">{queuedAdmissions}</div>
      {waitingTasks.length > 0 && (
        <div className="mb-4 shrink-0">
          <InboxTaskList
            tasks={waitingTasks}
            isLoading={taskActions.isLoading}
            taskActions={taskActions}
            onOpenTask={handleOpenTask}
            onStartTask={taskActions.onStartTask}
          />
          <LoadOlderTasks label="Inbox" pagination={pagination?.inbox} />
        </div>
      )}
    </>
  );
});
