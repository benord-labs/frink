/**
 * Model field wiring for a flow node: Claude vs Codex options from the resolved project account,
 * the inherit-option label, and clearing a saved model that belongs to the other provider.
 */

import { useEffect, useRef } from 'react';
import { trpc } from '@/lib/trpc';
import {
  CODEX_MODEL_OPTIONS,
  CLAUDE_MODEL_OPTIONS,
} from '../../../../lib/flows/model-options/flow-model-options';
import {
  CODEX_MODEL_PREFIX,
  type FlowProjectExecutionKind,
  isFlowModelIncompatibleWithProjectProvider,
} from './project-model-affinity';

/** Resolved account `type` → flow execution kind (NULL/legacy/unknown account → claude-code). */
const accountTypeToExecutionKind = (type: string | undefined): FlowProjectExecutionKind =>
  type === 'codex' ? 'codex' : 'claude-code';

type UseProjectModelOptionsConfig = {
  /** The saved id as stored: a node's model override, or the flow default in Flow settings. */
  model: string | undefined;
  /** Flow default this node inherits; Flow settings owns that default and passes none. */
  flowDefaultModel?: string;
  /** Drops the saved id once the project resolves to the other provider. */
  onClearModel: () => void;
};

export function useProjectModelOptions(
  projectId: string | undefined,
  { model, flowDefaultModel, onClearModel }: UseProjectModelOptionsConfig,
) {
  const { data: resolvedAccount, isLoading } = trpc.claudeCode.getResolvedAccount.useQuery(
    { projectId },
    {
      enabled: Boolean(projectId),
      placeholderData: undefined,
    },
  );

  const executionKind: FlowProjectExecutionKind =
    !projectId || isLoading || resolvedAccount == null
      ? 'unknown'
      : accountTypeToExecutionKind(resolvedAccount.type);

  /** When provider is unknown, prefer the right picker catalog from the persisted model id (`codex-*`). */
  const catalogHint = (model || flowDefaultModel)?.trim();
  const isCodexProject =
    executionKind === 'codex' ||
    (executionKind === 'unknown' && (catalogHint?.startsWith(CODEX_MODEL_PREFIX) ?? false));

  const modelOptions = isCodexProject ? CODEX_MODEL_OPTIONS : CLAUDE_MODEL_OPTIONS;

  const modelPlaceholder = flowDefaultModel
    ? `Flow default (${modelOptions.find((o) => o.value === flowDefaultModel)?.label ?? flowDefaultModel})`
    : 'Flow default';

  const clearModelRef = useRef(onClearModel);
  clearModelRef.current = onClearModel;

  useEffect(() => {
    if (!isFlowModelIncompatibleWithProjectProvider(model, executionKind)) return;
    clearModelRef.current();
  }, [executionKind, model]);

  return { modelOptions, isCodexProject, modelPlaceholder };
}
