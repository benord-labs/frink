/**
 * Picker-id → display label, shared by the composer's model trigger and the flow-run strip's
 * read-only readout. Its own folder (not a flat `src/shared/lib` file) so it stays clear of that
 * directory's fan-out ceiling; the label logic lives in one place regardless of provider.
 */
import {
  CLAUDE_CODE_MODELS,
  CODEX_MODELS,
  claudeModelToPickerItem,
  codexModelToPickerItem,
} from '../models';

/** The provider catalogs a picker id can belong to. */
export type ModelPickerVariant = 'claude' | 'codex';

/**
 * The fields the trigger/pill label reads — a structural subset every provider picker item
 * satisfies (Claude grafts on `version`). Structural on purpose so `src/shared` never depends on
 * the renderer's `ModelItem` (a `shared → renderer` import-wall violation).
 */
export type ModelLabelFields = {
  name: string;
  version?: string;
  detail?: string;
};

/**
 * Single source of truth for the picker label — the composer trigger's `formatTriggerLabel`
 * delegates here rather than forking its own formatting.
 */
export function formatModelPickerLabel(m: ModelLabelFields): string {
  const { name, suffix } = formatModelPickerLabelParts(m);
  return name + suffix;
}

/**
 * The same label split for the composer trigger, which renders the name in the foreground and the
 * ` · tier` suffix muted. `name + suffix` is always the full label.
 */
export function formatModelPickerLabelParts(m: ModelLabelFields) {
  let name = m.name;
  if (m.version && !m.name.includes(m.version)) name += ` ${m.version}`;
  const suffix = m.detail && m.detail !== 'Medium' ? ` · ${m.detail}` : '';
  return { name, suffix };
}

/**
 * Resolve a picker id to its picker item + provider across both catalogs. `null` for an
 * unknown / stale id (a catalog change or a cross-provider leftover) — callers hide the affordance.
 */
export function resolveModelPickerItemById(
  id: string,
): { item: ModelLabelFields; variant: ModelPickerVariant } | null {
  const claude = CLAUDE_CODE_MODELS.find((m) => m.id === id);
  if (claude) return { item: claudeModelToPickerItem(claude), variant: 'claude' };
  const codex = CODEX_MODELS.find((m) => m.id === id);
  if (codex) return { item: codexModelToPickerItem(codex), variant: 'codex' };
  return null;
}
