/* eslint-disable max-lines, max-lines-per-function */
import { buttonVariants } from '@benord-labs/frink-primitives';
import type { UIMessage } from 'ai';
import { useSetAtom, useStore } from 'jotai';
import { Loader2 } from 'lucide-react';
import { type ReactElement, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  type ResolvedTaskStartMode,
  resolveTaskExecutionMetadata,
  resolveTaskStartInWorktreeFromConfig,
  toChatMode,
} from '../../../../shared/lib/trigger-rule-config';
import { PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT } from '../../../../shared/types/plan';
import { AGENTS_PAGE_COLUMN_CLASS } from '../../../components/ChatAtmosphereSurface/constants';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../../components/ui/alert-dialog';
import {
  chatModeAtomFamily,
  lastSelectedModelIdAtomFamily,
  pendingBuildPlanSubChatIdAtom,
} from '../../../features/agents/atoms';
import { activeOverlayAtom } from '../../../lib/atoms';
import { trpc, trpcClient } from '../../../lib/trpc';
import {
  getHistoryDeleteAllTarget,
  HISTORY_TASK_STATUSES,
} from '../../../lib/work-queue/delete-all-target';
import { assessRowRetry } from '../../../lib/work-queue/task-menu/task-menu-actions';
import { useWorkQueueTaskNavigation } from '../../../lib/work-queue/use-work-queue-task-navigation';
import {
  openWorkQueueTaskChat,
  parseWorkQueueMessages,
  startWorkQueuePlanExecution,
} from '../../../lib/work-queue/work-queue-chat-actions';
import { createAgentChat } from '../../agents/lib/create-agent-chat';
import { createQueueItem, generateQueueId } from '../../agents/lib/queue-utils';
import { agentChatStore } from '../../agents/stores/agent-chat-store';
import { useMessageQueueStore } from '../../agents/stores/message-queue-store';
import { useAgentSubChatStore } from '../../agents/stores/sub-chat-store';
import { useWorkQueueOverviewCounts } from '../hooks/use-work-queue-overview-counts';
import { useWorkQueueOverviewPages } from '../hooks/use-work-queue-overview-pages';
import type { ConfirmedRecovery, Task } from '../types';
import { buildTaskMessage } from '../utils/build-task-message';
import { dedupeRowsById } from '../utils/dedupe-rows-by-id';
import { getOverviewTaskChatId } from '../utils/overview-task-groups';
import { parseTriggerContext } from '../utils/trigger-context';
import { EmptyState } from './EmptyState';
import { HistorySummaryFooter } from './HistorySummaryFooter';
import { HistoryTaskList } from './HistoryTaskList';
import { useWorkQueueView } from './hooks';
import { QueueHeader } from './QueueHeader';
import { QueueOverview } from './QueueOverview';
import type {
  PaginatedCursor,
  PaginatedTasksPayload,
  WorkQueueTaskRow,
  WorkQueueTaskStatus,
} from './types';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
type WorkQueueProps = {
  onRequestClose: () => void;
  onNavigateToChat: (chatId: string) => void;
  sidebarTrigger?: ReactNode;
};
type QueuedStartMetadata = {
  startMode: ResolvedTaskStartMode;
  skipReview: boolean;
  configuredModel?: string;
};
const HISTORY_PAGE_SIZE = 50;

function mergeRowsById(
  baseRows: WorkQueueTaskRow[],
  incomingRows: WorkQueueTaskRow[],
): WorkQueueTaskRow[] {
  const byId = new Map<string, WorkQueueTaskRow>(baseRows.map((row) => [row.id, row]));
  for (const row of incomingRows) {
    byId.set(row.id, row);
  }
  return Array.from(byId.values());
}

function isNotFoundTrpcError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as {
    data?: { code?: string };
    shape?: { data?: { code?: string } };
  };
  return err.data?.code === 'NOT_FOUND' || err.shape?.data?.code === 'NOT_FOUND';
}

export function WorkQueue({
  onRequestClose,
  onNavigateToChat,
  sidebarTrigger,
}: WorkQueueProps): ReactElement {
  const utils = trpc.useUtils();
  const store = useStore();
  const setActiveOverlay = useSetAtom(activeOverlayAtom);
  const setPendingBuildPlanSubChatId = useSetAtom(pendingBuildPlanSubChatIdAtom);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const queuedStartMetadataRef = useRef<Map<string, QueuedStartMetadata>>(new Map());
  const {
    backToOverviewButtonRef,
    historyButtonRef,
    isHistoryView,
    openHistory,
    historyRefetchInterval,
    returnToOverview,
  } = useWorkQueueView(onRequestClose);
  const overviewPages = useWorkQueueOverviewPages(!isHistoryView);
  const [isDeleteAllDialogOpen, setIsDeleteAllDialogOpen] = useState(false);
  const [isDeletingAll, setIsDeletingAll] = useState(false);
  const isDeletingAllRef = useRef(false);
  const { navigateToChatIfOwned, ownsTaskNavigation } =
    useWorkQueueTaskNavigation(onNavigateToChat);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const [historyHeadRows, setHistoryHeadRows] = useState<WorkQueueTaskRow[]>([]);
  const [historyTail, setHistoryTail] = useState<{
    boundaryKey: string;
    nextCursor: PaginatedCursor | null;
    rows: WorkQueueTaskRow[];
  } | null>(null);
  const historyLoadInFlightRef = useRef(false);
  const historyGenerationRef = useRef(0);
  const prefetchedHistoryPagesRef = useRef<Map<string, PaginatedTasksPayload>>(new Map());
  const { data: taskCounts } = trpc.tasks.listCounts.useQuery(
    { collapseByFlow: true },
    {
      refetchInterval: 5000,
      structuralSharing: true,
    },
  );
  const deleteAllTarget = isHistoryView ? getHistoryDeleteAllTarget(taskCounts) : null;
  const historyQuery = trpc.tasks.listPaginated.useQuery(
    {
      statuses: [...HISTORY_TASK_STATUSES],
      limit: HISTORY_PAGE_SIZE,
      cursor: null,
      collapseByFlow: true,
    },
    { refetchInterval: historyRefetchInterval },
  );
  useEffect(() => {
    if (!historyQuery.data) return;
    setHistoryHeadRows(dedupeRowsById(historyQuery.data.items as unknown as WorkQueueTaskRow[]));
  }, [historyQuery.data]);

  const historyHeadCursor = (historyQuery.data?.nextCursor ?? null) as PaginatedCursor | null;
  const historyBoundaryKey = historyHeadCursor
    ? `${historyHeadCursor.createdAt}:${historyHeadCursor.id}`
    : 'end';
  const historyBoundaryRef = useRef(historyBoundaryKey);
  useEffect(() => {
    if (historyBoundaryRef.current === historyBoundaryKey) return;
    historyBoundaryRef.current = historyBoundaryKey;
    historyGenerationRef.current += 1;
    setHistoryTail(null);
    prefetchedHistoryPagesRef.current.clear();
  }, [historyBoundaryKey]);
  const currentHistoryTail = historyTail?.boundaryKey === historyBoundaryKey ? historyTail : null;
  const nextHistoryCursor = currentHistoryTail ? currentHistoryTail.nextCursor : historyHeadCursor;
  const historyTasksRaw = dedupeRowsById([
    ...historyHeadRows,
    ...(currentHistoryTail?.rows ?? []),
  ]).sort((a, b) => {
    if (a.createdAt === b.createdAt) return a.id < b.id ? 1 : -1;
    return a.createdAt < b.createdAt ? 1 : -1;
  });

  const prefetchHistoryPage = useCallback(async (cursor: PaginatedCursor | null) => {
    if (!cursor) return;
    const key = `${cursor.createdAt}:${cursor.id}`;
    if (prefetchedHistoryPagesRef.current.has(key)) return;
    const generation = historyGenerationRef.current;
    try {
      const page = (await trpcClient.tasks.listPaginated.query({
        statuses: [...HISTORY_TASK_STATUSES],
        limit: HISTORY_PAGE_SIZE,
        cursor,
        collapseByFlow: true,
      })) as unknown as PaginatedTasksPayload;
      if (historyGenerationRef.current !== generation) return;
      prefetchedHistoryPagesRef.current.set(key, page);
    } catch {}
  }, []);

  useEffect(() => {
    if (!isHistoryView) return;
    void prefetchHistoryPage(nextHistoryCursor);
  }, [isHistoryView, nextHistoryCursor, prefetchHistoryPage]);

  const refreshTaskViews = useCallback(
    (taskId?: string) => {
      historyGenerationRef.current += 1;
      setHistoryTail(null);
      prefetchedHistoryPagesRef.current.clear();
      setHistoryHeadRows((previous) =>
        taskId ? previous.filter((task) => task.id !== taskId) : [],
      );
      void utils.tasks.listPaginated.invalidate({
        statuses: [...HISTORY_TASK_STATUSES],
      });
      void utils.tasks.listCounts.invalidate();
      void utils.tasks.workQueueOverviewCounts.invalidate();
      void overviewPages.refresh();
    },
    [overviewPages.refresh, utils.tasks],
  );

  const isLoading = isHistoryView ? historyQuery.isLoading : overviewPages.isLoading;

  const showDeleteFailedToast = (description: string) =>
    toast.error('Could not delete task', { description });

  const cancelMutation = trpc.tasks.cancel.useMutation({
    onSuccess: (_data, taskId) => refreshTaskViews(taskId),
    onError: (error) => {
      toast.error('Could not cancel task', {
        description: error.message || 'Please try again in a moment.',
      });
    },
  });

  const deleteMutation = trpc.tasks.delete.useMutation({
    onSuccess: (data, taskId) => {
      if (!data.success) {
        if (data.reason === 'not_found') {
          showDeleteFailedToast('This task no longer exists.');
          refreshTaskViews(taskId);
          return;
        }
        showDeleteFailedToast(
          'Only pending, plan-ready, done, completed, cancelled, or failed tasks can be deleted.',
        );
        return;
      }
      refreshTaskViews(taskId);
    },
    onError: (error) => {
      showDeleteFailedToast(error.message || 'Please try again in a moment.');
    },
  });

  const updateTaskStatusMutation = trpc.tasks.updateStatus.useMutation({
    onSuccess: (_data, variables) => refreshTaskViews(variables.taskId),
  });
  // tasks.recover re-resolves the kind server-side, so a stale row label is refused, never swapped.
  const retryTaskMutation = trpc.tasks.recover.useMutation({
    onSuccess: (_data, variables) => refreshTaskViews(variables.taskId),
  });
  // tasks.complete also finalizes sibling done rows in a Flow.
  const completeTaskMutation = trpc.tasks.complete.useMutation({
    onSuccess: (_data, variables) => refreshTaskViews(variables.taskId),
    onError: (error) => {
      toast.error('Could not mark task complete', {
        description: error.message || 'Please try again in a moment.',
      });
    },
  });
  const startExecutionMutation = trpc.tasks.startExecution.useMutation({
    onSuccess: (_data, variables) => refreshTaskViews(variables.taskId),
    onError: (error) => {
      toast.error('Could not start execution', {
        description: error.message || 'Please try again in a moment.',
      });
    },
  });
  const deleteMatchingMutation = trpc.tasks.deleteMatching.useMutation({
    onSuccess: () => refreshTaskViews(),
    onError: (error) => {
      toast.error('Could not delete tasks', {
        description: error.message || 'Please try again in a moment.',
      });
    },
  });
  const createChatMutation = trpc.chats.create.useMutation({
    onSuccess: async (chat, variables) => {
      if (!variables) return;
      const fallbackStartMode = variables.mode === 'plan' ? 'plan' : 'execute';
      const queuedStartMetadata = variables.taskId
        ? queuedStartMetadataRef.current.get(variables.taskId)
        : undefined;
      if (variables.taskId) {
        queuedStartMetadataRef.current.delete(variables.taskId);
      }
      const startMetadata: QueuedStartMetadata = queuedStartMetadata ?? {
        startMode: fallbackStartMode,
        skipReview: fallbackStartMode !== 'plan',
      };

      // Match auto-start ordering: set mode/model before selecting chat. toChatMode maps the task
      // startMode (incl. debug) to the chat mode the executor reads.
      store.set(chatModeAtomFamily(chat.id), toChatMode(startMetadata.startMode));
      if (startMetadata.configuredModel) {
        store.set(lastSelectedModelIdAtomFamily(chat.id), startMetadata.configuredModel);
      }

      if (variables.taskId) {
        try {
          await updateTaskStatusMutation.mutateAsync({
            taskId: variables.taskId,
            status: 'running',
            result: {
              chatId: chat.id,
              startMode: startMetadata.startMode,
              skipReview: startMetadata.skipReview,
              ...(startMetadata.configuredModel
                ? {
                    requestedModel: startMetadata.configuredModel,
                    activeModel: startMetadata.configuredModel,
                  }
                : {}),
            },
          });
        } catch {
          toast.error('Failed to update task status', {
            description:
              'The chat was created but the task status could not be updated. Please check the task manually.',
          });
        }
      }

      navigateToChatIfOwned(chat.id);
      utils.chats.list.invalidate();
      utils.chats.listCounts.invalidate();
      utils.chats.listByFolder.invalidate();
    },
    onError: (_error, variables) => {
      if (!variables) return;
      if (variables.taskId) {
        queuedStartMetadataRef.current.delete(variables.taskId);
      }
    },
  });

  const handleCancel = (id: string) => cancelMutation.mutate(id);
  const handleDelete = (id: string) => deleteMutation.mutate(id);

  const showMissingChatToast = () => {
    toast.error('This chat was deleted', {
      description: 'This is a leftover from a previous deletion. You can safely remove this task.',
    });
  };

  const showUnableToVerifyChatToast = () => {
    toast.error("Couldn't verify this chat right now", {
      description: 'Please try again in a moment.',
    });
  };

  const navigateToResolvedChat = (chatId: string, subChatId?: string): boolean => {
    if (!navigateToChatIfOwned(chatId)) return false;
    utils.chats.list.invalidate();
    utils.chats.listCounts.invalidate();
    utils.chats.listByFolder.invalidate();
    if (subChatId) {
      const subChatStore = useAgentSubChatStore.getState();
      subChatStore.setChatId(chatId);
      subChatStore.setActiveSubChat(subChatId);
    }
    return true;
  };

  const handleOpenChat = async (
    task: Task,
    chatId: string,
    options?: { skipExistenceCheck?: boolean; preloadedChat?: unknown },
  ): Promise<string | undefined> =>
    openWorkQueueTaskChat(
      {
        taskId: task.id,
        prompt: buildTaskMessage(task),
        chatId,
        resultSubChatId: task.result?.subChatId as string | undefined,
        ...options,
      },
      {
        ownsNavigation: ownsTaskNavigation,
        getChat: (id) => trpcClient.chats.get.query({ id }),
        getSubChat: (id) => trpcClient.chats.getSubChat.query({ id }),
        seedUserMessageIfEmpty: (input) => trpcClient.chats.seedUserMessageIfEmpty.mutate(input),
        navigate: navigateToResolvedChat,
        isNotFoundError: isNotFoundTrpcError,
        onMissingChat: showMissingChatToast,
        onUnknownChat: showUnableToVerifyChatToast,
      },
    );

  const handleStartExecution = async (taskId: string) => {
    const rawTask = allTaskRows.find((t) => t.id === taskId);
    if (!rawTask) return;
    const rawResult = rawTask.result;
    const chatId =
      rawResult && typeof rawResult === 'object' && 'chatId' in rawResult
        ? ((rawResult.chatId as string | undefined) ?? rawTask.linkedChatId ?? undefined)
        : (rawTask.linkedChatId ?? undefined);
    if (!chatId) {
      toast.error('Cannot start execution', {
        description: 'This reviewed plan is missing a linked chat.',
      });
      return;
    }

    const mappedTask = mapTask(rawTask);
    await startWorkQueuePlanExecution(
      {
        taskId,
        chatId,
        resultSubChatId: mappedTask.result?.subChatId as string | undefined,
        startExecution: () => startExecutionMutation.mutateAsync({ taskId }),
        setPendingPlan: setPendingBuildPlanSubChatId,
        onInvalidPlan: (description) =>
          toast.error('Cannot continue approved plan', { description }),
        recoverPlan: ({ approval, chat: rawChat, subChat, subChatId }) => {
          useMessageQueueStore.getState().prependItem(subChatId, {
            ...createQueueItem(generateQueueId(), PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT),
            approvedPlanContext: approval.context,
          });
          const chat = rawChat as {
            projectId?: string | null;
            project?: { path?: string } | null;
            taskId?: string | null;
          };
          if (!agentChatStore.has(subChatId)) {
            createAgentChat({
              chatId,
              subChatId,
              projectId: chat.projectId ?? '',
              mode: 'agent',
              initialMessages: (parseWorkQueueMessages(subChat.messages) ?? []) as UIMessage[],
              projectPath: chat.project?.path,
              streamId: subChat.streamId ?? null,
              getExecutionAccountType: () =>
                utils.claudeCode.getResolvedAccount.getData({ chatId })?.type ?? 'claude-code',
            });
          }
          void utils.claudeCode.getResolvedAccount.fetch({ chatId });
        },
      },
      {
        ownsNavigation: ownsTaskNavigation,
        getChat: (id) => trpcClient.chats.get.query({ id }),
        getSubChat: (id) => trpcClient.chats.getSubChat.query({ id }),
        seedUserMessageIfEmpty: (input) => trpcClient.chats.seedUserMessageIfEmpty.mutate(input),
        navigate: navigateToResolvedChat,
        isNotFoundError: isNotFoundTrpcError,
        onMissingChat: showMissingChatToast,
        onUnknownChat: showUnableToVerifyChatToast,
      },
    );
  };

  const handleStartTask = (taskId: string, mode: 'agent' | 'plan' = 'agent') => {
    const task = allTaskRows.find((t) => t.id === taskId);
    if (!task) return;

    const message = buildTaskMessage(task);
    const triggerContext = parseTriggerContext(task.triggerContext);
    const startMetadata = resolveTaskExecutionMetadata(triggerContext?._config, {
      overrideMode: mode,
    });
    queuedStartMetadataRef.current.set(task.id, startMetadata);
    const useWorktree = resolveTaskStartInWorktreeFromConfig(
      triggerContext?._config,
      task.projectId,
    );

    createChatMutation.mutate({
      initialMessage: message,
      taskId: task.id,
      projectId: task.projectId || undefined,
      useWorktree,
      mode,
    });
  };
  const handleRetryTask = (taskId: string, confirmed?: ConfirmedRecovery) => {
    const task = allTaskRows.find((t) => t.id === taskId);
    const kind = confirmed?.kind ?? task?.recoveryKind;
    if (!task || !kind) return;
    const retryAssessment = assessRowRetry(task);
    if (!retryAssessment.canRetry) {
      toast.error('Retry blocked', {
        description:
          retryAssessment.remediation ??
          'Fix the task credentials in Settings > AI providers, then try again.',
      });
      return;
    }
    retryTaskMutation.mutate(
      { taskId, kind, recoveryNodeRunId: confirmed?.recoveryNodeRunId },
      {
        onError: (error) => {
          toast.error(`Could not ${kind} task`, {
            description: error.message || 'Please try again in a moment.',
          });
          refreshTaskViews(taskId);
        },
      },
    );
  };
  const handleMarkComplete = (taskId: string) => {
    const task = allTaskRows.find((t) => t.id === taskId);
    if (!task) return;
    completeTaskMutation.mutate({
      taskId,
      result: {
        ...(isObject(task?.result) ? task.result : {}),
        summary: 'Marked complete from work queue',
      },
    });
  };

  const deleteAllMatching = async () => {
    if (isDeletingAllRef.current) return;
    const target = deleteAllTarget;
    if (!target) return;

    isDeletingAllRef.current = true;
    setIsDeleteAllDialogOpen(false);
    setIsDeletingAll(true);
    try {
      const { deletedCount } = await deleteMatchingMutation.mutateAsync({
        statuses: target.statuses,
      });
      if (deletedCount > 0) {
        toast.success('Tasks deleted', {
          description: `Removed ${deletedCount} task${deletedCount === 1 ? '' : 's'}.`,
        });
      } else {
        toast.message('Nothing removed', {
          description: 'No matching tasks were deleted. Counts may have changed.',
        });
      }
    } catch {
      // Error toast from deleteMatchingMutation.onError
    } finally {
      isDeletingAllRef.current = false;
      setIsDeletingAll(false);
    }
  };

  const loadNextHistoryPage = useCallback(async () => {
    if (!nextHistoryCursor || historyLoadInFlightRef.current) return;
    historyLoadInFlightRef.current = true;
    const boundaryKey = historyBoundaryKey;
    const generation = historyGenerationRef.current;
    try {
      const cursorKey = `${nextHistoryCursor.createdAt}:${nextHistoryCursor.id}`;
      const prefetchedPage = prefetchedHistoryPagesRef.current.get(cursorKey);
      prefetchedHistoryPagesRef.current.delete(cursorKey);
      const page =
        prefetchedPage ??
        ((await trpcClient.tasks.listPaginated.query({
          statuses: [...HISTORY_TASK_STATUSES],
          limit: HISTORY_PAGE_SIZE,
          cursor: nextHistoryCursor,
          collapseByFlow: true,
        })) as unknown as PaginatedTasksPayload);
      if (historyGenerationRef.current !== generation) return;
      setHistoryTail((previous) => ({
        boundaryKey,
        nextCursor: page.nextCursor,
        rows: mergeRowsById(previous?.boundaryKey === boundaryKey ? previous.rows : [], page.items),
      }));
      void prefetchHistoryPage(page.nextCursor);
    } finally {
      historyLoadInFlightRef.current = false;
    }
  }, [historyBoundaryKey, nextHistoryCursor, prefetchHistoryPage]);

  const isMutating =
    cancelMutation.isPending ||
    deleteMutation.isPending ||
    createChatMutation.isPending ||
    updateTaskStatusMutation.isPending ||
    retryTaskMutation.isPending ||
    startExecutionMutation.isPending ||
    deleteMatchingMutation.isPending ||
    isDeletingAll;

  // Map and group tasks. Display status = effectiveStatus (per-flow collapse); raw `status` is kept
  // on the source rows (allTaskRows) for mutations that branch on the real task state.
  const mapTask = (t: WorkQueueTaskRow): Task => ({
    id: t.id,
    title: t.title ?? null,
    description: t.description,
    status: t.effectiveStatus ?? t.status,
    source: t.source,
    result: t.result as Task['result'],
    createdAt: t.createdAt,
    startedAt: t.startedAt,
    completedAt: t.completedAt,
    needsAttentionAt: t.needsAttentionAt,
    projectName: t.projectName,
    projectId: t.projectId,
    flowRunId: t.flowRunId,
    linkedChatId: t.linkedChatId ?? getOverviewTaskChatId(t),
    triggerContext: parseTriggerContext(t.triggerContext),
    recoveryKind: t.recoveryKind,
    confirmSideEffects: t.confirmSideEffects,
    recoveryNodeRunId: t.recoveryNodeRunId,
  });
  const overviewAttentionRows = overviewPages.attention.rows as WorkQueueTaskRow[];
  const overviewRunningRows = overviewPages.running.rows as WorkQueueTaskRow[];
  const overviewInboxRows = overviewPages.inbox.rows as WorkQueueTaskRow[];
  const allTaskRows = dedupeRowsById([
    ...overviewAttentionRows,
    ...overviewRunningRows,
    ...overviewInboxRows,
    ...historyTasksRaw,
  ]);
  const displayStatus = (t: WorkQueueTaskRow): WorkQueueTaskStatus => t.effectiveStatus ?? t.status;
  const waitingTasks = overviewInboxRows.map(mapTask);
  const overviewRunningTasks = overviewRunningRows.map(mapTask);
  const completedHistoryTasks = historyTasksRaw
    .filter((t) => displayStatus(t) === 'completed')
    .map(mapTask);
  const cancelledHistoryTasks = historyTasksRaw
    .filter((t) => displayStatus(t) === 'cancelled')
    .map(mapTask);
  const commonTaskActions = {
    onStartExecution: handleStartExecution,
    onCancel: handleCancel,
    onDelete: handleDelete,
    onOpenChat: handleOpenChat,
    onStartTask: handleStartTask,
    onRetryTask: handleRetryTask,
    onMarkComplete: handleMarkComplete,
    isLoading: isMutating,
  };

  const renderHistoryEmptyState = (message: string) => (
    <div className="flex h-full min-h-[120px] items-center justify-center rounded-lg border border-border/30 bg-muted/10 px-4 py-8 text-center text-xs text-muted-foreground">
      {message}
    </div>
  );
  const completedOnlyCount = taskCounts?.completed ?? completedHistoryTasks.length;
  const cancelledCount = taskCounts?.cancelled ?? cancelledHistoryTasks.length;
  const overview = useWorkQueueOverviewCounts({
    inbox: overviewInboxRows.length,
    queued: 0,
    review: overviewAttentionRows.length,
    running: overviewRunningRows.length,
  });
  const openTaskCount = overview.inbox + overview.queued + overview.running + overview.review;
  const isEmpty = allTaskRows.length === 0 && overview.queued === 0;
  return (
    <main
      className={AGENTS_PAGE_COLUMN_CLASS}
      data-agents-page
      aria-labelledby="work-queue-heading"
    >
      <section className="flex h-full min-h-0 flex-col" aria-label="Work Queue">
        <QueueHeader
          headingRef={headingRef}
          isLoading={isLoading}
          openTaskCount={openTaskCount}
          sidebarTrigger={sidebarTrigger}
          backToOverviewButtonRef={backToOverviewButtonRef}
          canDeleteAll={(deleteAllTarget?.estimateCount ?? 0) > 0}
          isDeletingAll={isDeletingAll}
          isHistoryView={isHistoryView}
          isMutating={isMutating}
          onClose={onRequestClose}
          onDeleteAll={() => setIsDeleteAllDialogOpen(true)}
          onReturnToOverview={returnToOverview}
        />
        <div className="flex min-h-0 flex-1 flex-col pt-4">
          {isLoading ? (
            <div
              className="flex min-h-0 flex-1 items-center justify-center"
              role="status"
              aria-live="polite"
            >
              <Loader2
                className="h-5 w-5 animate-spin text-muted-foreground motion-reduce:animate-none"
                aria-hidden
              />
              <span className="sr-only">Loading Work Queue</span>
            </div>
          ) : isHistoryView ? (
            historyTasksRaw.length === 0 ? (
              renderHistoryEmptyState('No completed or cancelled tasks yet.')
            ) : (
              <HistoryTaskList
                tasks={historyTasksRaw.map(mapTask)}
                canLoadMore={nextHistoryCursor !== null}
                onLoadMore={loadNextHistoryPage}
                taskActions={commonTaskActions}
              />
            )
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="-mx-2 min-h-0 flex-1 overflow-y-auto px-2 [scrollbar-gutter:stable]">
                <QueueOverview
                  attentionTasks={overviewAttentionRows.map(mapTask)}
                  pagination={overviewPages}
                  queuedCount={overview.queued}
                  reviewCount={overview.review}
                  runningTasks={overviewRunningTasks}
                  runningCount={overview.running}
                  taskActions={commonTaskActions}
                  waitingTasks={waitingTasks}
                />
                {isEmpty && (
                  <EmptyState
                    onOpenSettings={() => {
                      setActiveOverlay('flows');
                    }}
                  />
                )}
              </div>
              <HistorySummaryFooter
                cancelledCount={cancelledCount}
                completedCount={completedOnlyCount}
                historyButtonRef={historyButtonRef}
                onViewHistory={openHistory}
              />
            </div>
          )}
        </div>
        <AlertDialog open={isDeleteAllDialogOpen} onOpenChange={setIsDeleteAllDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete all in this view?</AlertDialogTitle>
              <AlertDialogDescription className="space-y-2">
                <span className="block">
                  Permanently delete up to {deleteAllTarget?.estimateCount ?? 0} task
                  {deleteAllTarget && deleteAllTarget.estimateCount === 1 ? '' : 's'} matching this
                  history view? This cannot be undone. The number removed may be lower if tasks
                  changed meanwhile.
                </span>
                <span className="block text-muted-foreground">
                  Chats linked to these tasks are kept, but will no longer be tied to the task.
                </span>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isDeletingAll}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className={buttonVariants({ variant: 'destructive' })}
                onClick={() => void deleteAllMatching()}
                disabled={isDeletingAll}
              >
                {isDeletingAll ? 'Deleting...' : 'Delete all'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </section>
    </main>
  );
}
