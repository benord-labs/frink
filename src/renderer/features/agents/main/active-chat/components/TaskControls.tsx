/** The one recovery button of the newest stopped task: Continue (its session answered it) or Retry
 * (re-run from instructions); the server re-resolves the kind on click, so labels stay honest. */

import { Button } from '@benord-labs/frink-primitives';
import { Play, RotateCcw } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  assessTaskRetry,
  getTaskFailureContext,
  isRetryableParkedResult,
} from '../../../../../../shared/lib/task-retry-policy';
import type { RecoveryKind } from '../../../../../../shared/types/flow-run/resume';
import { SIDE_EFFECTS_CONFIRM } from '../../../../../components/SideEffectsConfirm';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../../../components/ui/tooltip';
import { useConfirm } from '../../../../../components/ui/use-confirm';
import { trpc } from '../../../../../lib/trpc';
import { RunStatusRow } from '../../../RunStatusRow';
import { ContinueAfterUsageLimit, isLoginRemoved } from '../../../ui/account-indicator';
import { invalidateTaskQueries } from '../utils';

type TaskControlsProps = {
  subChatId: string;
  /** The chat's pinned task (chats.taskId) — the acting task for non-flow chats. */
  pinnedTaskId: string | null;
};

const ACTION_COOLDOWN_MS = 4000;

/** One recovery as sent: the kind and step attempt shown when the user clicked. */
type RecoverRequest = { taskId: string; kind: RecoveryKind; recoveryNodeRunId?: string };

export const TaskControls = memo(function TaskControls({
  subChatId,
  pinnedTaskId,
}: TaskControlsProps) {
  const utils = trpc.useUtils();
  const [isCoolingDown, setIsCoolingDown] = useState(false);
  const cooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A login switch recovers once it lands, with the kind and task current then, not at its click.
  const recoverRef = useRef(() => {});
  // Set on submit, so a second click before `isPending` renders cannot send a second request.
  const inFlight = useRef(false);
  const { confirm, dismiss, confirmDialog } = useConfirm();

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
  const kind = task?.recoveryKind;

  const resultRecord =
    task?.result && typeof task.result === 'object'
      ? (task.result as Record<string, unknown>)
      : null;
  const chatId = typeof resultRecord?.chatId === 'string' ? resultRecord.chatId : null;

  const recoverMutation = trpc.tasks.recover.useMutation({
    onSuccess: () => invalidateTaskQueries(utils),
    // The toast is load-bearing: there is no global mutationCache.onError. Refetching on error
    // matters too — the server refuses a kind that no longer holds, and the fresh read relabels.
    onError: (error) => {
      toast.error(`Could not ${kind === 'continue' ? 'continue' : 'retry'} task`, {
        description: error.message || 'Please try again in a moment.',
      });
      invalidateTaskQueries(utils);
    },
    onSettled: () => {
      inFlight.current = false;
    },
  });

  useEffect(() => {
    return () => {
      if (cooldownTimerRef.current) {
        clearTimeout(cooldownTimerRef.current);
      }
    };
  }, []);

  const status = task?.status;
  const stepId = task?.recoveryNodeRunId;
  // A confirm asked about one recovery never carries over to the task's next one.
  useEffect(() => dismiss(), [dismiss, taskId, status, kind, task?.confirmSideEffects, stepId]);
  // As in the Work Queue, a failed run whose stopped step is not this task recovers through it,
  // so this task's own retry policy does not apply.
  const failed = status === 'failed' || (task?.flowRunStatus === 'failed' && Boolean(stepId));
  const retryAssessment = stepId
    ? { canRetry: true, remediation: null }
    : assessTaskRetry(task ?? null);
  const failureContext = getTaskFailureContext(task ?? null);
  const canShowControls =
    failed || (status === 'needs_attention' && isRetryableParkedResult(task?.result));
  const isPending = recoverMutation.isPending;
  const canAct = retryAssessment.canRetry && !isCoolingDown && !isPending;
  const parkedChatId = status === 'needs_attention' ? chatId : null;
  const { data: chatLogin } = trpc.claudeCode.getResolvedAccount.useQuery(
    { chatId: parkedChatId ?? '' },
    { enabled: Boolean(parkedChatId) },
  );

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

  if (!canShowControls || !kind) return null;

  const send = (request: RecoverRequest) => {
    if (inFlight.current) return;
    inFlight.current = true;
    recoverMutation.mutate(request);
    startCooldown();
  };
  // A started non-agent step may repeat what it did, so its Retry confirms. The request is captured
  // as the dialog opens, and the server refuses it once the shown step has changed.
  const handleRecover = () => {
    if (!canAct) return;
    const request: RecoverRequest = { taskId, kind, recoveryNodeRunId: stepId };
    if (kind === 'retry' && task?.confirmSideEffects)
      void confirm(SIDE_EFFECTS_CONFIRM).then((ok) => ok && send(request));
    else send(request);
  };
  recoverRef.current = handleRecover;

  const isContinue = kind === 'continue';
  const blockedTooltip = !retryAssessment.canRetry
    ? (retryAssessment.remediation ??
      failureContext ??
      'Blocked until task prerequisites are fixed.')
    : isCoolingDown
      ? 'Cooling down for a few seconds.'
      : null;
  const pausedLabel =
    parkedChatId && isLoginRemoved(chatLogin)
      ? "This chat's login was removed"
      : 'Task paused by a transient error';
  const buttonLabel = isContinue
    ? isPending
      ? 'Continuing…'
      : 'Continue'
    : isPending
      ? 'Retrying…'
      : 'Retry';

  return (
    <RunStatusRow dotClassName="bg-destructive" label={failed ? 'Task failed' : pausedLabel}>
      {/* A parked run may move its chat to another login, then recovers there. */}
      {parkedChatId && canAct ? (
        <ContinueAfterUsageLimit
          chatId={parkedChatId}
          usageLimited={Boolean(resultRecord?.usageLimit)}
          onRetry={() => recoverRef.current()}
        />
      ) : null}
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
              disabled={!canAct}
              onClick={handleRecover}
              aria-label={isContinue ? 'Continue task' : 'Retry task'}
              aria-busy={isPending || undefined}
            >
              {isContinue ? (
                <Play className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              )}
              <span>{buttonLabel}</span>
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {blockedTooltip ??
            (isContinue
              ? 'Picks up where the agent stopped — same chat and worktree, nothing is redone.'
              : 'Runs it again from its instructions.')}
        </TooltipContent>
      </Tooltip>
      {confirmDialog}
    </RunStatusRow>
  );
});
