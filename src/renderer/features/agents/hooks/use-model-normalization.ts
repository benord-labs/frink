import { useEffect, useRef } from 'react';
import { normalizeModelIdForExecutionAccount } from '../../../../shared/lib/models';

/**
 * Reads the model id via ref, not reactively: split-view panes on different account types would
 * ping-pong. Skipped until `accountResolved`, else a valid id is clobbered to 'sonnet' on load.
 */
export function useModelNormalization(
  isCodexAccount: boolean,
  lastSelectedModelId: string,
  setLastSelectedModelId: (id: string) => void,
  accountResolved = true,
): void {
  const lastSelectedModelIdRef = useRef(lastSelectedModelId);
  lastSelectedModelIdRef.current = lastSelectedModelId;

  useEffect(() => {
    if (!accountResolved) return;
    const currentModelId = lastSelectedModelIdRef.current;
    const next = normalizeModelIdForExecutionAccount(isCodexAccount, currentModelId);
    if (next !== currentModelId) setLastSelectedModelId(next);
    // Only re-run when account type changes, NOT when model changes
  }, [isCodexAccount, accountResolved, setLastSelectedModelId]);
}
