import { useCallback, useEffect, useRef, useState } from 'react';

type UseSingleShotPlanApprovalOptions = {
  isStreaming: boolean;
  hasUnapprovedPlan: boolean;
  onApprove: () => void | Promise<void>;
};

type UseSingleShotPlanApprovalResult = {
  isApprovingPlan: boolean;
  handleApprovePlanSingleShot: () => void;
};

export function useSingleShotPlanApproval({
  isStreaming,
  hasUnapprovedPlan,
  onApprove,
}: UseSingleShotPlanApprovalOptions): UseSingleShotPlanApprovalResult {
  const [isApprovingPlan, setIsApprovingPlan] = useState(false);
  const approvalLockRef = useRef(false);

  // Reset single-shot approval lock once execution starts or plan is no longer pending.
  useEffect(() => {
    if (isStreaming || !hasUnapprovedPlan) {
      approvalLockRef.current = false;
      setIsApprovingPlan(false);
    }
  }, [isStreaming, hasUnapprovedPlan]);

  const handleApprovePlanSingleShot = useCallback(() => {
    if (approvalLockRef.current || isStreaming) return;

    approvalLockRef.current = true;
    setIsApprovingPlan(true);

    try {
      const approvalResult = onApprove();
      void Promise.resolve(approvalResult).catch(() => {
        approvalLockRef.current = false;
        setIsApprovingPlan(false);
      });
    } catch {
      // Keep UI recoverable if approval throws synchronously before stream transition.
      approvalLockRef.current = false;
      setIsApprovingPlan(false);
    }
  }, [isStreaming, onApprove]);

  return {
    isApprovingPlan,
    handleApprovePlanSingleShot,
  };
}
