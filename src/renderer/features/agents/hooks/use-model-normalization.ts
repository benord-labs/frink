import { useEffect, useRef } from 'react';
import type { CodexAccountCatalog } from '../../../../shared/lib/codex-cli-models';
import { CODEX_MODELS, normalizeModelIdForExecutionAccount } from '../../../../shared/lib/models';

/**
 * Reads the model id via ref, not reactively: split-view panes on different account types would
 * ping-pong. Skipped until `accountResolved`, else a valid id is clobbered to 'sonnet' on load.
 * A Codex model the account can't use is kept (shown as unavailable); one needing the account's
 * default waits while its catalog (`undefined`) loads, which starts only once the account is Codex.
 */
export function useModelNormalization(
  isCodexAccount: boolean,
  lastSelectedModelId: string,
  setLastSelectedModelId: (id: string) => void,
  accountResolved = true,
  codexCatalog?: CodexAccountCatalog | null,
): void {
  const lastSelectedModelIdRef = useRef(lastSelectedModelId);
  lastSelectedModelIdRef.current = lastSelectedModelId;
  const codexCatalogRef = useRef(codexCatalog);
  codexCatalogRef.current = codexCatalog;
  const codexCatalogLoading = codexCatalog === undefined;

  useEffect(() => {
    if (!accountResolved) return;
    const currentModelId = lastSelectedModelIdRef.current;
    const needsCodexDefault = isCodexAccount && !CODEX_MODELS.some((m) => m.id === currentModelId);
    if (needsCodexDefault && codexCatalogLoading) return;
    const next = normalizeModelIdForExecutionAccount(
      isCodexAccount,
      currentModelId,
      codexCatalogRef.current ?? null,
      { keepUnavailable: true },
    );
    if (next !== currentModelId) setLastSelectedModelId(next);
    // Only re-run when account type (or whether its catalog is loading) changes, NOT on model changes
  }, [isCodexAccount, accountResolved, codexCatalogLoading, setLastSelectedModelId]);
}
