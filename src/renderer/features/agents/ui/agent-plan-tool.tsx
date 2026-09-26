import { Button } from '@benord-labs/frink-primitives';
import { useAtomValue, useSetAtom } from 'jotai';
import { Minimize2, Maximize2, Loader2 } from 'lucide-react';
import { memo, useEffect, useState } from 'react';
import { type FrinkPlanStatus, stripPlanFrontmatter } from '../../../../shared/types/plan';
import { MemoizedMarkdown } from '../../../components/chat-markdown-renderer';
import { Kbd } from '../../../components/ui/kbd';
import { TextShimmer } from '../../../components/ui/text-shimmer';
import { toPlainPreview } from '../../../lib/agent-chat/plan/plan-preview';
import { wakeHeldAtomFamily } from '../../../lib/stores/active-transport-registry';
import { cn } from '../../../lib/utils';
import { pendingBuildPlanSubChatIdAtom } from '../atoms';
import { hiddenApprovalPlanIdsForSubChatAtomFamily } from '../stores/message-store';
import { getToolStatus } from './agent-tool-registry';
import { areToolPropsEqual } from './agent-tool-utils';

const PLAN_CONTENT_MAX_HEIGHT_CLASS = 'max-h-[750px]';

type Plan = {
  id: string;
  title: string;
  summary?: string;
  planText?: string;
  status: FrinkPlanStatus;
  /** Flow-driven plan: suppress the in-chat Approve (the flow run panel owns approval). */
  flowDriven?: boolean;
};

type AgentPlanToolProps = {
  part: {
    type: string;
    toolCallId: string;
    state?: string;
    input?: {
      action?: 'create' | 'update' | 'approve' | 'complete';
      plan?: Plan;
    };
    output?: {
      success?: boolean;
      message?: string;
    };
  };
  chatStatus?: string;
  subChatId?: string;
  isStreaming?: boolean;
};

/**
 * AgentPlanTool subscribes to `hiddenApprovalPlanIdsForSubChatAtomFamily(subChatId)` via
 * `useAtomValue`. If parent re-renders with a new `subChatId` (chat switch) but the same `part`
 * and `chatStatus`, the base `areToolPropsEqual` would skip re-render — the hook would then keep
 * reading the previous subChat's atom, leaking visibility state across chats. Include `subChatId`
 * and `isStreaming` so the component re-renders when either changes.
 */
function areAgentPlanToolPropsEqual(prev: AgentPlanToolProps, next: AgentPlanToolProps): boolean {
  if (prev.subChatId !== next.subChatId) return false;
  if (prev.isStreaming !== next.isStreaming) return false;
  return areToolPropsEqual(prev, next);
}

function getDisplayPlanText(planText: string | undefined): string | undefined {
  if (!planText) return undefined;
  return stripPlanFrontmatter(planText);
}

export const AgentPlanTool = memo(function AgentPlanTool({
  part,
  chatStatus,
  subChatId,
  isStreaming = false,
}: AgentPlanToolProps) {
  const plan = part.input?.plan;
  const [isExpanded, setIsExpanded] = useState(() => plan?.status === 'awaiting_approval');
  const [isApprovalStarted, setIsApprovalStarted] = useState(false);
  const setPendingBuildPlanSubChatId = useSetAtom(pendingBuildPlanSubChatIdAtom);
  const { isPending } = getToolStatus(part, chatStatus);
  const action = part.input?.action || 'create';

  useEffect(() => {
    if (plan?.status === 'awaiting_approval') {
      setIsExpanded(true);
    }
  }, [plan?.status]);

  useEffect(() => {
    if (plan?.status !== 'awaiting_approval') {
      setIsApprovalStarted(false);
    }
  }, [plan?.status]);

  const hiddenApprovalPlanIds = useAtomValue(
    hiddenApprovalPlanIdsForSubChatAtomFamily(subChatId ?? ''),
  );
  const wakeHeld = useAtomValue(wakeHeldAtomFamily(subChatId ?? ''));
  if (!plan) return null;
  // Button hides for every plan inside a closed approval epoch — i.e. up to and including the
  // most-recently-approved plan in this chat. Plans created later (next epoch, user re-enters
  // plan mode after execution) keep their buttons so a fresh approval cycle works normally.
  const isInClosedEpoch = part.toolCallId ? hiddenApprovalPlanIds.has(part.toolCallId) : false;
  const hasPendingApproval = plan.status === 'awaiting_approval' && !isInClosedEpoch;
  const isLockedOpen = hasPendingApproval;
  const effectiveIsExpanded = isLockedOpen || isExpanded;

  const displayPlanText = getDisplayPlanText(plan.planText);

  // Determine header title based on action and status
  const getHeaderTitle = () => {
    if (isPending) {
      if (action === 'create') return 'Creating plan...';
      if (action === 'approve') return 'Approving plan...';
      if (action === 'complete') return 'Completing plan...';
      return 'Updating plan...';
    }

    if (plan.status === 'awaiting_approval') return 'Plan ready for review';
    if (plan.status === 'completed') return 'Plan completed';
    if (plan.status === 'approved') return 'Plan approved';
    return plan.title;
  };

  // Flow-driven plans approve ONLY through the flow run panel (resumeFlowRun → execute node).
  // Suppressing the in-chat Approve prevents a double-fire: clicking it would continue the chat
  // turn while the flow stays paused and its execute node later re-runs the same plan.
  // A held chat (waiting on background work between wake bursts) offers ONE action — the held
  // row's Stop; Approve returns when the wait ends, so the two verbs never compete.
  const canApproveFromCard =
    hasPendingApproval && Boolean(subChatId) && !plan.flowDriven && wakeHeld == null;
  /** Session may still be "streaming" until finish while the plan part is already complete — do not block approve. */
  const approveButtonDisabled =
    isApprovalStarted ||
    (plan.status === 'awaiting_approval' ? isPending : isPending || isStreaming);
  const handleApproveFromCard = () => {
    if (!canApproveFromCard || !subChatId || isApprovalStarted) return;
    setIsApprovalStarted(true);
    setPendingBuildPlanSubChatId(subChatId);
  };

  return (
    <div className="rounded-lg border border-border glass-card overflow-hidden mx-2">
      {/* Header - click anywhere to expand/collapse */}
      <Button
        variant="ghost"
        size="auto"
        disabled={isLockedOpen}
        className={cn(
          'w-full justify-start text-left font-normal',
          'flex justify-between px-2.5 py-2 rounded-none duration-150 focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-2',
          isLockedOpen ? 'cursor-default' : '',
        )}
        onClick={() => {
          if (!isLockedOpen) {
            setIsExpanded(!effectiveIsExpanded);
          }
        }}
        onKeyDown={(e) => {
          if (isLockedOpen) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setIsExpanded(!effectiveIsExpanded);
          }
        }}
        aria-expanded={effectiveIsExpanded}
        aria-label={
          isLockedOpen
            ? 'Plan details expanded'
            : `${effectiveIsExpanded ? 'Collapse' : 'Expand'} plan details`
        }
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <div className="flex flex-col min-w-0 flex-1">
            {isPending ? (
              <TextShimmer as="span" duration={1.2} className="text-xs font-medium">
                {getHeaderTitle()}
              </TextShimmer>
            ) : (
              <span className="text-xs font-medium text-foreground truncate">
                {getHeaderTitle()}
              </span>
            )}
            {plan.summary && !effectiveIsExpanded && (
              <span className="text-[11px] text-muted-foreground/60 truncate">
                {toPlainPreview(plan.summary)}
              </span>
            )}
          </div>
        </div>

        {/* Right side */}
        <div className="flex items-center gap-2 shrink-0 ml-2">
          {isPending && <Loader2 className="w-3 h-3 animate-spin" />}

          {!isLockedOpen && (
            <div className="relative w-4 h-4">
              <Maximize2
                className={cn(
                  'absolute inset-0 w-4 h-4 text-muted-foreground transition-[opacity,transform] duration-200 ease-out',
                  effectiveIsExpanded ? 'opacity-0 scale-75' : 'opacity-100 scale-100',
                )}
              />
              <Minimize2
                className={cn(
                  'absolute inset-0 w-4 h-4 text-muted-foreground transition-[opacity,transform] duration-200 ease-out',
                  effectiveIsExpanded ? 'opacity-100 scale-100' : 'opacity-0 scale-75',
                )}
              />
            </div>
          )}
        </div>
      </Button>

      {/* Expanded content */}
      {effectiveIsExpanded && (
        <div className="border-t border-border">
          {/* The plan exactly as the agent wrote it — what Approve hands to the execution turn */}
          {displayPlanText && (
            <div className={cn(PLAN_CONTENT_MAX_HEIGHT_CLASS, 'overflow-y-auto px-2.5 py-2')}>
              <MemoizedMarkdown
                content={displayPlanText}
                id={`plan-${plan.id}`}
                className="text-xs text-foreground/90 prose-p:text-xs prose-p:text-foreground/90 prose-li:text-xs prose-li:text-foreground/90 prose-strong:text-xs prose-strong:text-foreground prose-headings:text-xs prose-headings:text-foreground prose-code:text-xs prose-code:text-foreground"
              />
            </div>
          )}

          {/* Plan status footer */}
          {hasPendingApproval && (
            <div className="px-2.5 py-2 border-t border-border bg-muted/50 flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                Awaiting your approval to proceed
              </span>
              {canApproveFromCard && (
                <Button
                  size="sm"
                  onClick={handleApproveFromCard}
                  disabled={approveButtonDisabled}
                  title="Approves the plan and sends a message to start execution."
                >
                  Approve &amp; Run
                  <Kbd shortcutId="approve-plan" className="ml-1.5 text-primary-foreground/70" />
                </Button>
              )}
            </div>
          )}

          {plan.status === 'completed' && (
            <div className="px-2.5 py-2 border-t border-border bg-muted/50">
              <span className="text-xs text-muted-foreground">Plan completed successfully</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}, areAgentPlanToolPropsEqual);
