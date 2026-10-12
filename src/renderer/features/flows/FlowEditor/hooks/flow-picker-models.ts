/**
 * Canonical ModelItem lists for flow UI (full execution catalog; same ids as TRIGGER_* options).
 */

import { useMemo } from 'react';
import {
  type CodexAccountCatalog,
  codexModelsForAccount,
} from '../../../../../shared/lib/codex-cli-models';
import { CLAUDE_PICKER_MODELS, codexModelToPickerItem } from '../../../../../shared/lib/models';
import type { FlowSettings } from '../../../../../shared/types/flow';
import { useCodexAccountCatalog } from '../../../../lib/codex/use-codex-account-catalog';
import type { ModelItem } from '../../../agents/components/model-selector';
import { useProjectModelOptions } from './use-project-model-options';

/** Ultra is composer-only for now: unattended runs have no surface disclosing its usage cost. */
const FLOW_CLAUDE_PICKER_MODELS = CLAUDE_PICKER_MODELS.filter((m) => !m.ultra);

/** Picker catalog for the resolved project provider — one provider per project. Codex rows are
 *  the ones the signed-in account can use (all of them while its catalog is unknown). */
export function getFlowPickerModels(
  isCodexProject = false,
  codexCatalog: CodexAccountCatalog | null = null,
): readonly ModelItem[] {
  return isCodexProject
    ? codexModelsForAccount(codexCatalog).map(codexModelToPickerItem)
    : FLOW_CLAUDE_PICKER_MODELS;
}

/** ModelSelector visual variant for the resolved provider — same precedence as getFlowPickerModels. */
export function flowModelVariant(isCodexProject = false): 'claude' | 'codex' {
  return isCodexProject ? 'codex' : 'claude';
}

/** A flow model field's rows and selection: the project provider's rows (Codex ones limited to the
 *  signed-in account), and a saved id no row matches kept as stale so it still shows. */
export function useFlowModelPicker(isCodexProject: boolean, modelId: string) {
  const codexCatalog = useCodexAccountCatalog(isCodexProject);
  const availableModels = useMemo(
    () => getFlowPickerModels(isCodexProject, codexCatalog),
    [isCodexProject, codexCatalog],
  );
  const selectedPickerModel = modelId ? availableModels.find((m) => m.id === modelId) : undefined;
  const staleModelId = modelId && !selectedPickerModel ? modelId : undefined;
  return { availableModels, selectedPickerModel, staleModelId };
}

/** Flow settings' default model field, for the flow's default project; `onClearModel` drops a saved
 *  model once that project resolves to the other provider. */
export function useFlowDefaultModelPicker(
  settings: FlowSettings | undefined,
  onClearModel: () => void,
) {
  const projectId = settings?.defaultProjectId ?? '';
  const { isCodexProject } = useProjectModelOptions(projectId.trim() ? projectId : undefined, {
    model: settings?.defaultModel,
    onClearModel,
  });
  const picker = useFlowModelPicker(isCodexProject, settings?.defaultModel?.trim() ?? '');
  return { isCodexProject, ...picker };
}
