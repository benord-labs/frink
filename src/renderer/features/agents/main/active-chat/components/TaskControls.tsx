/** Carry on (resume the persisted session in place; a paused run holding admission) / Retry (re-run from the
 * last node through admission; a non-flow task re-runs fresh behind a confirm) for the sub-chat's newest task. */

import { Button } from '@benord-labs/frink-primitives';
import { Loader2, Play, RotateCcw } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  assessTaskRetry,
  getTaskFailureContext,
  isRetryableParkedResult,
} from '../../../../../../shared/lib/task-retry-policy';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../../../components/ui/tooltip';
import { trpc } from '../../../../../lib/trpc';
import { RunStatusRow } from '../../../RunStatusRow';
import { invalidateTaskQueries } from '../utils';

type TaskControlsProps = {
  subChatId: string;
  /** The chat's pinned task (chats.taskId) — the acting task for non-flow chats. */
  pinnedTaskId: string | null;
};

const ACTION_COOLDOWN_MS = 4000;

export const TaskControls = memo(function TaskControls({
  subChatId,
  pinnedTaskId,
}: TaskControlsProps) {
  const utils = trpc.useUtils();
  const [isCoolingDown, setIsCoolingDown] = useState(false);
  const [confirmingFreshRetry, setConfirmingFreshRetry] = useState(false);
  const cooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const retryTriggerRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);

  const { data: task } = trpc.tasks.getActionableTaskForSubChat.useQuery(
    { subChatId, fallbackTaskId: pinnedTaskId },
    {
      enabled: subChatId.length > 0,
      // A failure (or a follow-up resume clearing one) is written by the MAIN process directly —
      // no renderer mutation fires an invalidation — so the row must poll to appear and to clear.
      // Stops only at `completed` (accepted, final): every other state — including null (a task
      // may still be minted) and cancelled (a new run can supersede it) — can flip main-side.
      refetchInterval: (query) => (query.state.data?.status === 'completed' ? false : 5000),
    },
  );
  const taskId = task?.id ?? '';

  const resultRecord =
    task?.result && typeof task.result === 'object'
      ? (task.result as Record<string, unknown>)
      : null;
  const chatId = typeof resultRecord?.chatId === 'string' ? resultRecord.chatId : null;

  // Workspace scope for the fresh-retry confirm copy — fetched only once the confirm opens.
  const { data: chat } = trpc.chats.get.useQuery(
    { id: chatId ?? '' },
    { enabled: confirmingFreshRetry && Boolean(chatId) },
  );

  // onError toasts are load-bearing: there is no global mutationCache.onError, so a server
  // precondition throw (e.g. concurrent state change) would otherwise be silently swallowed.
  const showActionError = (action: string) => (error: { message?: string }) =>
    toast.error(`Could not ${action} task`, {
      description: error.message || 'Please try again in a moment.',
    });
  // Flow-linked carry-on is accepted only while the run still holds active admission.
  const carryOnMutation = trpc.tasks.retry.useMutation({
    onSuccess: () => invalidateTaskQueries(utils),
    onError: showActionError('carry on'),
  });
  const retryNodeMutation = trpc.flows.retryRunFromLastNode.useMutation({
    onSuccess: () => invalidateTaskQueries(utils),
    onError: showActionError('retry'),
  });
  const freshRetryMutation = trpc.tasks.retry.useMutation({
    onSuccess: () => invalidateTaskQueries(utils),
    onError: showActionError('retry'),
  });

  // Move focus to the confirm button on swap (focus should land on the destructive action,
  // WCAG 2.4.3), and back to the trigger on cancel.
  useEffect(() => {
    if (confirmingFreshRetry) confirmRef.current?.focus();
    else if (wasConfirming.current) retryTriggerRef.current?.focus();
    wasConfirming.current = confirmingFreshRetry;
  }, [confirmingFreshRetry]);

  useEffect(() => {
    return () => {
      if (cooldownTimerRef.current) {
        clearTimeout(cooldownTimerRef.current);
      }
    };
  }, []);

  const status = task?.status;
  const retryAssessment = assessTaskRetry(task ?? null);
  const failureContext = getTaskFailureContext(task ?? null);
  const isFlowTask = Boolean(task?.flowRunId);
  const canShowControls =
    status === 'failed' || (status === 'needs_attention' && isRetryableParkedResult(task?.result));
  const canAct = retryAssessment.canRetry && !isCoolingDown;
  // Node retry re-dispatches the RUN, which requires a settled run — a parked (paused) run
  // carries on instead; the server would refuse the redispatch with PRECONDITION_FAILED. Same
  // rule for a batch member: its run is a Flow run like any other.
  const flowRunStatus = task?.flowRunStatus;
  const retryBlockedByRunState = Boolean(
    isFlowTask &&
    flowRunStatus &&
    flowRunStatus !== 'failed' &&
    flowRunStatus !== 'cancelled' &&
    flowRunStatus !== 'completed',
  );
  const carryOnBlockedByFlowState = Boolean(isFlowTask && flowRunStatus !== 'paused');

  const startCooldown = () => {
    setIsCoolingDown(true);
    if (cooldownTimerRef.current) {
      clearTimeout(cooldownTimerRef.current);
    }
    cooldownTimerRef.current = setTimeout(() => {
      setIsCoolingDown(false);
      cooldownTimerRef.current = null;
    }, ACTION_COOLDOWN_MS);
  };

  const handleCarryOn = () => {
    if (!canAct || !canShowControls || confirmingFreshRetry || carryOnBlockedByFlowState) return;
    carryOnMutation.mutate({ taskId, mode: 'continue' });
    startCooldown();
  };

  const handleRetry = () => {
    if (!canAct || !canShowControls) return;
    if (task?.flowRunId) {
      retryNodeMutation.mutate({ runId: task.flowRunId });
    } else {
      // Non-flow: no node to retry from — fresh re-run behind the scope confirm below.
      setConfirmingFreshRetry(true);
      return;
    }
    startCooldown();
  };

  const handleFreshRetryConfirm = () => {
    if (!canAct || !canShowControls) return;
    freshRetryMutation.mutate({ taskId, mode: 'restart' });
    setConfirmingFreshRetry(false);
    startCooldown();
  };

  const isCarryOnPending = carryOnMutation.isPending;
  const isRetryPending = retryNodeMutation.isPending || freshRetryMutation.isPending;

  const blockedTooltip = !retryAssessment.canRetry
    ? (retryAssessment.remediation ??
      failureContext ??
      'Blocked until task prerequisites are fixed.')
    : isCoolingDown
      ? 'Cooling down for a few seconds.'
      : null;

  // Fresh-retry scope copy (non-flow only): a worktree-scoped attempt is abandoned wholesale;
  // a shared project directory keeps whatever the failed attempt wrote.
  const worktreePath = chat?.worktreePath ?? null;
  const projectPath = chat?.project?.path ?? null;
  const isWorktreeScoped = Boolean(worktreePath && worktreePath !== projectPath);
  const freshRetryCopy = !chat
    ? 'Re-runs this task from scratch with a fresh session. Work from the failed attempt is abandoned if it ran in its own worktree; changes made in a shared project directory are NOT undone.'
    : isWorktreeScoped
      ? `Re-runs from scratch in a new worktree${chat.baseBranch ? ` created from ${chat.baseBranch}` : ''}. The failed attempt's worktree at ${worktreePath} — including all code changes made there — is abandoned (left on disk, no longer used).`
      : `This task ran directly in ${projectPath ?? 'the project directory'}. Re-running starts a fresh session but does NOT undo file changes already made there — if other work shares this directory, review git status first.`;

  if (!canShowControls) return null;

  const retryTooltip = retryBlockedByRunState
    ? 'Retry needs a settled run. Resume it from the Flow surface.'
    : (blockedTooltip ??
      (isFlowTask
        ? 'Retries the failed step — continues its live session where possible, otherwise re-runs it from its instructions. Same worktree.'
        : 'Re-run this task from scratch (a confirmation explains what is abandoned).'));

  return (
    <>
      {/* Retry (secondary) left, Carry on (primary) right — the default action sits in the
          terminal position. Carry on is a continuation, so it gets the play glyph, not the
          retry arrow. */}
      <RunStatusRow
        dotClassName="bg-destructive"
        label={status === 'failed' ? 'Task failed' : 'Task paused by a transient error'}
      >
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            {/* span keeps the tooltip alive while the button is disabled (disabled elements
                don't fire pointer events). */}
            <span className="inline-flex">
              <Button
                ref={retryTriggerRef}
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 gap-1 text-xs text-muted-foreground hover:text-foreground rounded-md"
                disabled={
                  isRetryPending || !canAct || confirmingFreshRetry || retryBlockedByRunState
                }
                onClick={handleRetry}
                aria-label="Retry task from the last invoked step"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                <span>Retry</span>
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{retryTooltip}</TooltipContent>
        </Tooltip>
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 gap-1 text-xs text-muted-foreground hover:text-foreground rounded-md"
                disabled={
                  isCarryOnPending || !canAct || confirmingFreshRetry || carryOnBlockedByFlowState
                }
                onClick={handleCarryOn}
                aria-label={
                  isCarryOnPending ? 'Carrying on task' : 'Carry on task from last response'
                }
                aria-busy={isCarryOnPending || undefined}
              >
                <Play className="h-3.5 w-3.5" aria-hidden />
                <span>{isCarryOnPending ? 'Carrying on...' : 'Carry on'}</span>
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {carryOnBlockedByFlowState
              ? "This Flow run can't be picked up where it stopped. Use Retry to continue it from its last step."
              : (blockedTooltip ??
                failureContext ??
                'Resume the session and continue from where it left off — same chat and worktree.')}
          </TooltipContent>
        </Tooltip>
      </RunStatusRow>
      {confirmingFreshRetry ? (
        <div className="px-2 relative z-10">
          <div
            className="w-full max-w-2xl mx-auto px-3 py-2 mb-1 space-y-1.5 glass-float rounded-xl border border-border"
            role="alert"
          >
            <p className="text-[11px] text-muted-foreground">{freshRetryCopy}</p>
            <div className="flex items-center gap-1.5">
              <Button
                ref={confirmRef}
                type="button"
                size="sm"
                variant="secondary"
                className="h-6 gap-1 text-[11px]"
                disabled={isRetryPending}
                onClick={handleFreshRetryConfirm}
              >
                {isRetryPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                ) : (
                  <RotateCcw className="h-3 w-3" aria-hidden />
                )}
                Confirm re-run
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 text-[11px] text-muted-foreground"
                disabled={isRetryPending}
                onClick={() => setConfirmingFreshRetry(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
});
