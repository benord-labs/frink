/**
 * Filtering utilities for the node creator panel.
 */

import type { FlowBlockType } from '../../../../../shared/types/flow';
import { FLOW_BLOCK_DESCRIPTIONS, FLOW_BLOCK_LABELS } from '../constants';
import type { NodeCreatorCategory } from './nodeCreatorCategories';

export function filterNodeCreatorCategories(
  categories: NodeCreatorCategory[],
  allowed: Set<string>,
  q: string,
  customLabels?: ReadonlyMap<string, string>,
  customDescriptions?: ReadonlyMap<string, string>,
): NodeCreatorCategory[] {
  const needle = q.trim().toLowerCase();
  return categories
    .map((cat) => ({
      ...cat,
      types: cat.types.filter((t) => {
        // Custom and integration node types come from local manifests, not the
        // block registry, so the allowed set cannot vouch for them.
        if (!allowed.has(t) && cat.id !== 'custom' && cat.id !== 'integrations') return false;
        if (!needle) return true;
        const label = String(
          FLOW_BLOCK_LABELS[t as FlowBlockType] ?? customLabels?.get(t) ?? '',
        ).toLowerCase();
        const desc = String(
          FLOW_BLOCK_DESCRIPTIONS[t as FlowBlockType] ?? customDescriptions?.get(t) ?? '',
        ).toLowerCase();
        const typeStr = String(t).toLowerCase();
        return label.includes(needle) || desc.includes(needle) || typeStr.includes(needle);
      }),
    }))
    .filter((c) => c.types.length > 0);
}
