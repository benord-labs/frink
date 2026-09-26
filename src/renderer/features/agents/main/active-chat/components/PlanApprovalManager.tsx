import type { UIMessage } from 'ai';
import { useSetAtom } from 'jotai';
import { useEffect, useMemo } from 'react';
import { pendingPlanApprovalsAtom } from '../../../atoms';
import { hasUnapprovedPlan as checkForUnapprovedPlan } from '../utils/message-helpers';

type Props = {
  messages: UIMessage[];
  isPlanMode: boolean;
  subChatId: string;
  parentChatId: string;
  isActive: boolean;
  isStreaming: boolean;
  hasUnapprovedPlanRef: React.MutableRefObject<boolean>;
  handleApprovePlan: () => void;
};

export function PlanApprovalManager({
  messages,
  isPlanMode,
  subChatId,
  parentChatId,
  isActive: _isActive,
  isStreaming: _isStreaming,
  hasUnapprovedPlanRef,
  handleApprovePlan: _handleApprovePlan,
}: Props) {
  // Check if there's an unapproved plan
  const hasUnapprovedPlan = useMemo(
    () => checkForUnapprovedPlan(messages, isPlanMode),
    [messages, isPlanMode],
  );

  // Keep ref in sync for use in scroll initialization
  hasUnapprovedPlanRef.current = hasUnapprovedPlan;

  // Update pending plan approvals atom for sidebar indicators
  const setPendingPlanApprovals = useSetAtom(pendingPlanApprovalsAtom);
  useEffect(() => {
    setPendingPlanApprovals((prev: Map<string, string>) => {
      const newMap = new Map(prev);
      if (hasUnapprovedPlan) {
        newMap.set(subChatId, parentChatId);
      } else {
        newMap.delete(subChatId);
      }
      if (newMap.size !== prev.size || ![...newMap.keys()].every((id) => prev.has(id))) {
        return newMap;
      }
      return prev;
    });
  }, [hasUnapprovedPlan, subChatId, parentChatId, setPendingPlanApprovals]);

  // Cmd+Enter to approve plan is handled by KeyboardShortcutsManager (pane-scoped with isPaneActive).

  // Clean up pending plan approval when unmounting
  useEffect(() => {
    return () => {
      setPendingPlanApprovals((prev: Map<string, string>) => {
        if (prev.has(subChatId)) {
          const newMap = new Map(prev);
          newMap.delete(subChatId);
          return newMap;
        }
        return prev;
      });
    };
  }, [subChatId, setPendingPlanApprovals]);

  return null;
}
