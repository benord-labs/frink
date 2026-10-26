/** Model and mode wiring for a flow node: Claude vs Codex options from the project's account, the
 * inherit-option label, clearing a saved model of the other provider, and why a mode can't run. */

import { useEffect, useRef } from 'react';
import { trpc } from '@/lib/trpc';
import {
  aiProvider,
  isInstalledAgent,
  unsupportedModeMessage,
} from '../../../../../shared/lib/ai-providers';
import type { ChatMode } from '../../../../../shared/types/chat-mode';
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

/** Why a project on this account can't run `mode`, with what to do instead; null when it can. */
function modeUnavailableFor(type: string | undefined, mode: ChatMode): string | null {
  const refusal = unsupportedModeMessage(type, mode);
  return refusal && `${refusal} Pick another mode.`;
}

/** A Mode field offers no `option` where it can't run, unless the step is already saved as it:
 * that stays selected and shows why. `ready` = saved as it and able to run. */
export function modeOption(saved: string, option: ChatMode, unavailable: string | null) {
  const savedAsOption = saved === option;
  return {
    offered: savedAsOption || unavailable === null,
    error: savedAsOption ? unavailable : null,
    ready: savedAsOption && unavailable === null,
  };
}

/** An Agent step's Plan and Debug options, and why its saved mode won't run (null when it will). */
export function agentModeOptions(saved: string, unavailable: (mode: ChatMode) => string | null) {
  const plan = modeOption(saved, 'plan', unavailable('plan'));
  const debug = modeOption(saved, 'debug', unavailable('debug'));
  return { plan, debug, error: plan.error ?? debug.error };
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
  const modeUnavailable = (mode: ChatMode) =>
    accountKnown ? modeUnavailableFor(resolvedAccount?.type, mode) : null;

  const modelPlaceholder = flowDefaultModel
    ? `Flow default (${modelOptions.find((o) => o.value === flowDefaultModel)?.label ?? flowDefaultModel})`
    : 'Flow default';

  const clearModelRef = useRef(onClearModel);
  clearModelRef.current = onClearModel;

  useEffect(() => {
    if (!isFlowModelIncompatibleWithProjectProvider(model, executionKind)) return;
    clearModelRef.current();
  }, [executionKind, model]);

  return { modelOptions, isCodexProject, modelPlaceholder, unsupportedMessage, modeUnavailable };
}
