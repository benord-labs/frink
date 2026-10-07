/**
 * Recovery actions for a PAUSED run's parked nodes (extracted from FlowRunHistoryPanel/index.tsx):
 * approval nodes get Approve; a non-plan awaiting_input park is a QUESTION and gets the Answer
 * jump to the driving chat (ParkAnswerSurface renders it there). A blocked park (agent signalled
 * blocked/partial) gets the same Answer jump — the chat reply is the context-preserving resume —
 * plus Retry/Skip; failed keeps Retry/Skip only. The run's recovery step reads Continue instead of
 * Retry when its agent session already answered it, and a started non-agent step confirms first.
 */
import { Button } from '@benord-labs/frink-primitives';
import { Loader2, MessageSquare, Play, RotateCcw, SkipForward } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { RESUME_ACTIONABLE_NODE_STATUSES } from '../../../../../../shared/types/flow';
import type {
  RecoveryKind,
  ResumeStepRequest,
  RunRecovery,
} from '../../../../../../shared/types/flow-run/resume';
import { ReasonTooltip } from '../../../../../components/ReasonTooltip';
import { SideEffectsConfirm } from '../../../../../components/SideEffectsConfirm';
import { useDirtyNavGuard } from '../../../../../hooks/use-dirty-nav-guard';
import { resolveEffectiveAgentMode } from '../../../../../lib/flows/resolve-effective-agent-mode';
import { trpc } from '../../../../../lib/trpc';
import { DirtyNavAlertDialog } from '../BatchReportPanel/DirtyNavAlertDialog';
import { parseNodeOutput } from '../NodeRunDetail/parse-node-output';

/** Structural subset of DbFlowRunWithNodeRuns; the panel passes the full snake_case DTO. */
type PausedRunDetail = {
  nodeRuns: Array<{
    id: string;
    // biome-ignore lint/style/useNamingConvention: flows IPC snake_case contract
    node_id: string;
    // biome-ignore lint/style/useNamingConvention: flows IPC snake_case contract
    block_type: string;
    status: string;
    // biome-ignore lint/style/useNamingConvention: flows IPC snake_case contract
    node_output: Record<string, unknown> | null;
  }>;
  graph?: {
    nodes?: Array<{
      id: string;
      blockType?: string;
      label?: string;
      config?: Record<string, unknown>;
    }>;
    // Needed to resolve an agent node's INHERITED mode by walking back to its start_task; the
    // panel already receives them on the run's graph snapshot (flows.getRun returns the stored
    // FlowGraph verbatim), this only declares them.
    edges?: Array<{ source: string; target: string }>;
  } | null;
  recoveries?: RunRecovery[];
};

/**
 * The agent's park reason rides on the node_run's node_output (mapTaskToNodeOutput writes
 * summary + details into outputs). Read it per node — via the established parseNodeOutput reader —
 * so each parked node shows its OWN reason.
 */
function nodeRunReason(nodeOutput: Record<string, unknown> | null): {
  summary?: string;
  details?: string;
} {
  const parsed = parseNodeOutput(nodeOutput);
  const outputs = parsed.success ? parsed.output.outputs : undefined;
  return {
    summary: typeof outputs?.summary === 'string' ? outputs.summary : undefined,
    details: typeof outputs?.details === 'string' ? outputs.details : undefined,
  };
}

/**
 * An agent-signal park stamps `signal` on the node output (mapSignalToNodeOutput); the plan_ready
 * park leaves it absent. Both land on node status `awaiting_input`, so this is what separates "the
 * agent asked a question" from "a plan is waiting for approval".
 *
 * Absent/unparseable output reads as NO signal: a question park is always written through the
 * signal bridge and therefore always carries one, so a missing output is the plan-approval shape,
 * not a question that lost its marker.
 */
function nodeRunHasAgentSignal(nodeOutput: Record<string, unknown> | null): boolean {
  const parsed = parseNodeOutput(nodeOutput);
  return parsed.success && parsed.output.signal != null;
}

type PausedRunActionsProps = {
  detail: PausedRunDetail;
  /** A Retry's `kind` is the recovery the button showed, so the server can refuse a stale one. */
  onResumeRun: (request: ResumeStepRequest) => Promise<void>;
  resumePending: boolean;
  pendingResumeAction?: 'approve' | 'retry' | 'skip';
  pendingResumeNodeRunId?: string;
};

export function PausedRunActions({
  detail,
  onResumeRun,
  resumePending,
  pendingResumeAction,
  pendingResumeNodeRunId,
}: PausedRunActionsProps) {
  const utils = trpc.useUtils();
  const { showDialog, requestNav, confirmNav, cancelNav } = useDirtyNavGuard();
  const [answeringNodeRunId, setAnsweringNodeRunId] = useState<string | null>(null);
  const [confirmingNodeRunId, setConfirmingNodeRunId] = useState<string | null>(null);
  const confirmTriggerRef = useRef<HTMLButtonElement>(null);
  // Set on submit, so a second click before `resumePending` renders cannot resubmit the step.
  const recoverInFlight = useRef(false);
  const recoveryByNodeRun = useMemo(
    () => new Map(detail.recoveries?.map((r) => [r.nodeRunId, r])),
    [detail.recoveries],
  );

  // Jump to the chat driving the parked node — answering happens there (ParkAnswerSurface), the
  // Runs tab only carries the jump affordance (agent-user-question-mechanism: quick-pick or jump).
  const handleAnswer = async (nodeRunId: string) => {
    setAnsweringNodeRunId(nodeRunId);
    try {
      const link = await utils.tasks.getFlowChatForNodeRun.fetch({ nodeRunId });
      if (link?.chatId) {
        requestNav(link.chatId);
      } else {
        toast.error('No chat found for this step');
      }
    } catch {
      toast.error('Could not open the chat for this step');
    } finally {
      setAnsweringNodeRunId(null);
    }
  };

  const actionableStatuses: readonly string[] = RESUME_ACTIONABLE_NODE_STATUSES;

  const approvalNodes = detail.nodeRuns.filter(
    (nr) => nr.block_type === 'approval' && nr.status === 'awaiting_input',
  );
  const actionableNodes = detail.nodeRuns.filter(
    (nr) => nr.block_type !== 'approval' && actionableStatuses.includes(nr.status),
  );

  // A confirmation belongs to one run's step: drop it once that step leaves view, so it never reopens.
  if (confirmingNodeRunId && !actionableNodes.some((nr) => nr.id === confirmingNodeRunId)) {
    setConfirmingNodeRunId(null);
  }

  if (approvalNodes.length === 0 && actionableNodes.length === 0) return null;

  const isResumeLoadingFor = (action: 'approve' | 'retry' | 'skip', nodeRunId: string) =>
    resumePending && pendingResumeAction === action && pendingResumeNodeRunId === nodeRunId;
  // `kind` is the one the user chose, so a poll mid-confirmation can't swap it (the server refuses).
  const recoverStep = (nodeRunId: string, kind: RecoveryKind) => {
    setConfirmingNodeRunId(null);
    if (recoverInFlight.current) return;
    recoverInFlight.current = true;
    void onResumeRun({ action: 'retry', nodeRunId, kind }).finally(() => {
      recoverInFlight.current = false;
    });
  };

  return (
    <div className="mt-2 space-y-1.5 border-t border-border/35 pt-2">
      {approvalNodes.map((nr) => {
        const reason = nodeRunReason(nr.node_output);
        return (
          <div key={nr.id} className="flex items-center justify-between gap-2">
            <ReasonTooltip summary={reason.summary} details={reason.details}>
              <span className="text-[11px] text-muted-foreground truncate">
                {reason.summary?.trim() || 'Waiting for approval'}
              </span>
            </ReasonTooltip>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="h-6 gap-1 text-[11px] shrink-0"
              disabled={resumePending}
              onClick={() => onResumeRun({ action: 'approve', nodeRunId: nr.id })}
            >
              {isResumeLoadingFor('approve', nr.id) ? (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              ) : null}
              Approve
            </Button>
          </div>
        );
      })}
      {actionableNodes.map((nr) => {
        const graphNode = detail.graph?.nodes?.find((n) => n.id === nr.node_id);
        const label = graphNode?.label ?? graphNode?.blockType ?? nr.node_id;
        // A plan-mode agent node pauses (plan_ready → awaiting_input) for plan approval. The flow
        // run panel owns this approval (the chat plan card's Approve is suppressed) — so offer
        // Approve here (advances to the execute node). Review the plan itself in the chat card.
        // Exclude auto-approve nodes: they resolve `done` not `plan_ready`, so a residual
        // `awaiting_input` is a genuine agent question (needs_attention) — not a plan to approve.
        // Node config alone is NOT enough: a plan-mode agent may also park to ASK something
        // (frink_task_signal awaiting_input), which lands on the same node status. Approving that
        // would mark the node completed and advance with no plan and no answer, skipping the
        // plan_ready gate — so require the park to carry no agent signal. mapSignalToNodeOutput
        // stamps `signal` on an agent-signal park; the plan_ready branch leaves it absent.
        // Mode must be the EFFECTIVE one, not the node's own `config.mode`: that field is an
        // override, and its default (unset) means "inherit the start_task mode". Reading it raw
        // hides Approve on exactly the configuration the editor steers users toward.
        const cfg = graphNode?.config as { mode?: string; autoApprove?: boolean } | undefined;
        const isPlanApproval =
          nr.status === 'awaiting_input' &&
          graphNode?.blockType === 'agent' &&
          resolveEffectiveAgentMode(detail.graph, nr.node_id) === 'plan' &&
          cfg?.autoApprove !== true &&
          !nodeRunHasAgentSignal(nr.node_output);
        // A non-plan awaiting_input park is a genuine agent QUESTION — Retry re-runs the node and
        // Skip abandons it, neither answers. Offer the Answer jump to the driving chat instead
        // (ParkAnswerSurface renders the question there). A blocked park (signal blocked|partial)
        // keeps Retry/Skip but gets the jump too — a chat reply resumes with context, a Retry
        // discards it. Failed nodes have no parked reply pipe: Retry/Skip only.
        const isQuestionPark = nr.status === 'awaiting_input' && !isPlanApproval;
        const isReplyPark = nr.status === 'blocked';
        const reason = nodeRunReason(nr.node_output);
        // The agent's ask (summary) is the most actionable line; fall back to the node label.
        const lineText =
          reason.summary?.trim() || (isPlanApproval ? `${label} — plan ready` : label);
        const recovery = recoveryByNodeRun.get(nr.id);
        const isContinue = recovery?.kind === 'continue';
        return (
          <div key={nr.id} className="flex items-center justify-between gap-2">
            <ReasonTooltip summary={reason.summary} details={reason.details}>
              <span className="text-[11px] text-muted-foreground truncate">{lineText}</span>
            </ReasonTooltip>
            <div className="flex items-center gap-1 shrink-0">
              {isPlanApproval ? (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="h-6 gap-1 text-[11px]"
                  disabled={resumePending}
                  onClick={() => onResumeRun({ action: 'approve', nodeRunId: nr.id })}
                  title="Approve the plan and continue to the next step."
                >
                  {isResumeLoadingFor('approve', nr.id) ? (
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                  ) : null}
                  Approve
                </Button>
              ) : null}
              {isQuestionPark ? (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="h-6 gap-1 text-[11px]"
                  disabled={answeringNodeRunId !== null}
                  onClick={() => void handleAnswer(nr.id)}
                  title="Open the chat and answer the agent's question."
                >
                  {answeringNodeRunId === nr.id ? (
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                  ) : (
                    <MessageSquare className="h-3 w-3" aria-hidden />
                  )}
                  Answer
                </Button>
              ) : (
                <>
                  {isReplyPark ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      className="h-6 gap-1 text-[11px]"
                      disabled={answeringNodeRunId !== null}
                      onClick={() => void handleAnswer(nr.id)}
                      title="Open the chat and reply to unblock the agent."
                    >
                      {answeringNodeRunId === nr.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                      ) : (
                        <MessageSquare className="h-3 w-3" aria-hidden />
                      )}
                      Answer
                    </Button>
                  ) : null}
                  <Button
                    ref={confirmingNodeRunId === nr.id ? confirmTriggerRef : undefined}
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="h-6 text-[11px]"
                    disabled={resumePending}
                    onClick={() =>
                      recovery?.confirmSideEffects
                        ? setConfirmingNodeRunId(nr.id)
                        : recoverStep(nr.id, recovery?.kind ?? 'retry')
                    }
                  >
                    {isResumeLoadingFor('retry', nr.id) ? (
                      <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                    ) : isContinue ? (
                      <Play className="h-3 w-3" aria-hidden />
                    ) : (
                      <RotateCcw className="h-3 w-3" aria-hidden />
                    )}
                    {isContinue ? 'Continue' : 'Retry'}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 text-[11px] text-muted-foreground"
                    disabled={resumePending}
                    onClick={() => onResumeRun({ action: 'skip', nodeRunId: nr.id })}
                  >
                    {isResumeLoadingFor('skip', nr.id) ? (
                      <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                    ) : (
                      <SkipForward className="h-3 w-3" aria-hidden />
                    )}
                    Skip
                  </Button>
                </>
              )}
            </div>
          </div>
        );
      })}
      {confirmingNodeRunId ? (
        <SideEffectsConfirm
          pending={resumePending}
          onConfirm={() => recoverStep(confirmingNodeRunId, 'retry')}
          onCancel={() => setConfirmingNodeRunId(null)}
          returnFocusRef={confirmTriggerRef}
        />
      ) : null}
      <DirtyNavAlertDialog showDialog={showDialog} onConfirm={confirmNav} onCancel={cancelNav} />
    </div>
  );
}
