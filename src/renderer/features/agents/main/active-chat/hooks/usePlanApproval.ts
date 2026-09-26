import type { UIMessage } from 'ai';
import { useCallback, useEffect } from 'react';
import { toast } from 'sonner';
import type { ChatMode } from '../../../../../../shared/types/chat-mode';
import {
  type ApprovedPlanContext,
  findUnapprovedPlanPart,
  PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT,
} from '../../../../../../shared/types/plan';
import { appStore } from '../../../../../lib/jotai-store';
import { pendingModeIntentAtomFamily } from '../../../atoms';
import { armApprovedPlanState } from '../../../stores/sub-chat-store';

type Props = {
  subChatId: string;
  messages: UIMessage[];
  pendingBuildPlanSubChatId: string | null;
  setPendingBuildPlanSubChatId: (id: string | null) => void;
  setChatMode: (mode: ChatMode) => void;
  scrollToBottom: () => void;
  sendMessageRef: React.RefObject<unknown>;
  isResolvedExecutionAccountReady: boolean;
};

export function usePlanApproval({
  subChatId,
  messages,
  pendingBuildPlanSubChatId,
  setPendingBuildPlanSubChatId,
  setChatMode,
  scrollToBottom,
  sendMessageRef,
  isResolvedExecutionAccountReady,
}: Props) {
  const handleApprovePlan = useCallback(() => {
    if (!isResolvedExecutionAccountReady) return;
    let approvedPlanContext: ApprovedPlanContext | null = null;
    let approvedPlanIsFlowDriven = false;

    // Extract approved plan context from current messages.
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'assistant' && msg.parts) {
        const found = findUnapprovedPlanPart(
          msg.parts as Array<{ type: string; output?: unknown; input?: Record<string, unknown> }>,
        );
        // The newest plan-ready part decides: an unusable one must not fall back to an older plan.
        if (found) {
          approvedPlanContext = found.planContext;
          approvedPlanIsFlowDriven = found.flowDriven;
          break;
        }
      }
    }

    if (!approvedPlanContext) {
      toast.error('No pending plan found to approve. Refresh and try again.');
      return;
    }

    // Flow-driven plans are resumed by replying in the chat (the input bar flips plan→agent and the
    // engine unparks the node) OR via the Flow run panel — never the in-chat Approve button, which
    // would continue this turn while the flow stays paused and its node re-runs. Ruled on the
    // FOUND plan's own flag: the backward scan can land on an older parked flow card that a
    // recency-scoped transcript predicate would miss. See `flow-agent-node-mode`.
    if (approvedPlanIsFlowDriven) {
      toast.info('This plan belongs to a Flow run — reply in the chat or use the Flow run panel.');
      setPendingBuildPlanSubChatId(null);
      return;
    }

    armApprovedPlanState(subChatId, approvedPlanContext);

    // Approval is a mode TRANSITION: the intent rides the trigger send so main persists the
    // row (the mode's owner — decision `sub-chat-mode-ownership`) even when display mirrors are
    // wiped before the send goes out.
    appStore.set(pendingModeIntentAtomFamily(subChatId), 'agent');

    // Update React state (for UI)
    setChatMode('agent');

    // Re-arm stick-to-bottom and jump to the newly sent trigger.
    scrollToBottom();

    // Send plan-approval execution trigger (now in agent mode)
    (
      sendMessageRef.current as (message: {
        role: string;
        parts: Array<{ type: string; text: string }>;
      }) => void
    )({
      role: 'user',
      parts: [{ type: 'text', text: PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT }],
    });
  }, [
    subChatId,
    messages,
    setChatMode,
    setPendingBuildPlanSubChatId,
    scrollToBottom,
    sendMessageRef,
    isResolvedExecutionAccountReady,
  ]);

  // Handle pending plan approval trigger from sidebar/card
  useEffect(() => {
    if (pendingBuildPlanSubChatId !== subChatId) return;
    if (!isResolvedExecutionAccountReady) return;
    // Target sub-chat only (one ChatViewInner per subChatId). Do not gate on isActive:
    // hidden keep-alive tabs can briefly report isActive=false while the user still clicked Approve on that sub-chat.
    setPendingBuildPlanSubChatId(null); // Clear immediately to prevent double-trigger
    handleApprovePlan();
  }, [
    pendingBuildPlanSubChatId,
    subChatId,
    isResolvedExecutionAccountReady,
    setPendingBuildPlanSubChatId,
    handleApprovePlan,
  ]);

  return handleApprovePlan;
}
