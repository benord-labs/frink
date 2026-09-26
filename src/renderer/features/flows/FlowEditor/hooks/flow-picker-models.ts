/**
 * Canonical ModelItem lists for flow UI (full execution catalog; same ids as TRIGGER_* options).
 */

import {
  CLAUDE_PICKER_MODELS,
  CODEX_MODELS,
  codexModelToPickerItem,
} from '../../../../../shared/lib/models';
import type { ModelItem } from '../../../agents/components/model-selector';

/** Ultra is composer-only for now: unattended runs have no surface disclosing its usage cost. */
const FLOW_CLAUDE_PICKER_MODELS = CLAUDE_PICKER_MODELS.filter((m) => m.effort !== 'ultra');

/** Picker catalog for the resolved project provider — one provider per project. */
export function getFlowPickerModels(isCodexProject = false): readonly ModelItem[] {
  return isCodexProject ? CODEX_MODELS.map(codexModelToPickerItem) : FLOW_CLAUDE_PICKER_MODELS;
}

/** ModelSelector visual variant for the resolved provider — same precedence as getFlowPickerModels. */
export function flowModelVariant(isCodexProject = false): 'claude' | 'codex' {
  return isCodexProject ? 'codex' : 'claude';
}
