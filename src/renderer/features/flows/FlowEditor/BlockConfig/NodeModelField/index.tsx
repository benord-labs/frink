/**
 * Inheritance-aware model override for flow node configs (ModelSelector + NodeInheritableField).
 */

import { Cpu } from 'lucide-react';
import { type ReactElement, useMemo, useState } from 'react';
import { ModelSelector } from '../../../../agents/components/model-selector';
import { flowModelVariant, getFlowPickerModels } from '../../hooks/flow-picker-models';
import { NodeInheritableField } from '../NodeInheritableField';

type ModelOption = { value: string; label: string };

type NodeModelFieldProps = {
  model: string;
  flowDefaultModel: string | undefined;
  modelOptions: readonly ModelOption[];
  /** Resolved project account — selects the Codex picker catalog instead of Claude's. */
  isCodexProject: boolean;
  inheritOptionLabel: string;
  selectId?: string;
  onModelChange: (model: string | undefined) => void;
};

export function NodeModelField({
  model,
  flowDefaultModel,
  modelOptions,
  isCodexProject,
  inheritOptionLabel,
  selectId,
  onModelChange,
}: NodeModelFieldProps): ReactElement {
  const [modelMenuOpen, setModelMenuOpen] = useState(false);

  const availableModels = useMemo(() => getFlowPickerModels(isCodexProject), [isCodexProject]);

  const cardLabel = useMemo((): string => {
    const id = flowDefaultModel?.trim();
    if (!id) return inheritOptionLabel;
    return modelOptions.find((o) => o.value === id)?.label ?? id;
  }, [flowDefaultModel, modelOptions, inheritOptionLabel]);

  return (
    <NodeInheritableField
      value={model}
      flowDefault={flowDefaultModel}
      icon={<Cpu className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" aria-hidden />}
      inheritedLabel={cardLabel}
      alwaysCard
      onReset={() => onModelChange(undefined)}
      renderPicker={({ hasOverride: pickerOverride }) => {
        const modelTrim = model.trim();
        const selectedPickerModel = modelTrim
          ? availableModels.find((m) => m.id === modelTrim)
          : undefined;
        const staleModelId = modelTrim && !selectedPickerModel ? modelTrim : undefined;

        return (
          <ModelSelector
            mode="flow"
            flowInheritLabel={inheritOptionLabel}
            triggerId={selectId}
            selectedModel={pickerOverride ? selectedPickerModel : undefined}
            staleModelId={pickerOverride ? staleModelId : undefined}
            availableModels={availableModels}
            onModelChange={(m) => onModelChange(m.id)}
            onClearModel={() => onModelChange(undefined)}
            modelVariant={flowModelVariant(isCodexProject)}
            isOpen={modelMenuOpen}
            onOpenChange={setModelMenuOpen}
          />
        );
      }}
    />
  );
}
