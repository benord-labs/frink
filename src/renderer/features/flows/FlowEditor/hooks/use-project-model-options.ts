/** Model and mode wiring for a flow node: Claude vs Codex options from the project's account, the
 * inherit-option label, clearing a saved model of the other provider, and why Plan can't run. */

import { useEffect, useRef } from 'react';
import { trpc } from '@/lib/trpc';
import {
  aiProvider,
  isInstalledAgent,
  unsupportedModeMessage,
} from '../../../../../shared/lib/ai-providers';
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

/** Why a project on this account can't run Plan, with what to do instead; null when it can. */
function planUnavailableFor(type: string | undefined): string | null {
  const refusal = unsupportedModeMessage(type, 'plan');
  return refusal && `${refusal} Pick another mode.`;
}

/** A Mode field offers no Plan where Plan can't run, unless the step is already saved as Plan:
 * that stays selected, shows why it won't run, and has no auto-approve to set. */
export function planModeOption(mode: string, planUnavailable: string | null) {
  const savedAsPlan = mode === 'plan';
  return {
    offered: savedAsPlan || planUnavailable === null,
    error: savedAsPlan ? planUnavailable : null,
    autoApprove: savedAsPlan && planUnavailable === null,
  };
}

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

  const agent = aiProvider(resolvedAccount?.type);
  const accountKnown = Boolean(projectId) && !isLoading;
  // Flows can't run on an agent yet; its project shows why instead of model fields.
  const unsupportedMessage =
    accountKnown && isInstalledAgent(agent)
      ? `This project uses ${agent.name}. Flows run on Claude or OpenAI for now.`
      : undefined;
  const executionKind: FlowProjectExecutionKind =
    !accountKnown || resolvedAccount == null || unsupportedMessage
      ? 'unknown'
      : accountTypeToExecutionKind(resolvedAccount.type);

  /** When provider is unknown, prefer the right picker catalog from the persisted model id (`codex-*`). */
  const catalogHint = (model || flowDefaultModel)?.trim();
  const isCodexProject =
    executionKind === 'codex' ||
    (executionKind === 'unknown' && (catalogHint?.startsWith(CODEX_MODEL_PREFIX) ?? false));

  const modelOptions = isCodexProject ? CODEX_MODEL_OPTIONS : CLAUDE_MODEL_OPTIONS;
  const planUnavailable = accountKnown ? planUnavailableFor(resolvedAccount?.type) : null;

  const modelPlaceholder = flowDefaultModel
    ? `Flow default (${modelOptions.find((o) => o.value === flowDefaultModel)?.label ?? flowDefaultModel})`
    : 'Flow default';

  const clearModelRef = useRef(onClearModel);
  clearModelRef.current = onClearModel;

  useEffect(() => {
    if (!isFlowModelIncompatibleWithProjectProvider(model, executionKind)) return;
    clearModelRef.current();
  }, [executionKind, model]);

  return { modelOptions, isCodexProject, modelPlaceholder, unsupportedMessage, planUnavailable };
}
