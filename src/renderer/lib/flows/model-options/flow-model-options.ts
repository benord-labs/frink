/** Model dropdown options for flow node defaults, labelled from the shared model catalog. */
import { CLAUDE_CODE_MODELS, CODEX_MODELS } from '../../../../shared/lib/models';

export const CLAUDE_MODEL_OPTIONS = [
  ...CLAUDE_CODE_MODELS.map((model) => {
    const label = [model.familyName, model.variantLabel, model.contextWindow]
      .filter(Boolean)
      .join(' · ');
    // Add cost hints for base variants only
    if (model.id === 'haiku-5.5')
      return { value: model.id, label: `${label} (fastest, lowest cost)` };
    if (model.id === 'sonnet') return { value: model.id, label: `${label} (balanced default)` };
    if (model.id === 'opus')
      return { value: model.id, label: `${label} (highest quality, highest cost)` };
    return { value: model.id, label };
  }),
];

// Codex omits contextWindow (a vague "varies by account tier" sentence) so the flow-default
// label stays readable (e.g. "GPT-5.3 Codex · High").
export const CODEX_MODEL_OPTIONS = CODEX_MODELS.map((model) => ({
  value: model.id,
  label: [model.familyName, model.variantLabel].filter(Boolean).join(' · '),
}));
