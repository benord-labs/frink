/**
 * Shared display labels for flow block types (v1 + first-party extensions).
 */

import {
  type FlowBlockType,
  getAddableBlockTypes,
  getFlowBlockDescriptions,
  getFlowBlockDisplayLabels,
  getTriggerBlockTypes,
} from '../../../../shared/lib/block-registry';

/** Block types that may appear at most once as the flow entry point */
export const FLOW_TRIGGER_TYPES = new Set<FlowBlockType>(getTriggerBlockTypes());

/** All block types that can be added after the trigger (excludes trigger types) */
export const FLOW_ADDABLE_BLOCK_TYPES: FlowBlockType[] = [...getAddableBlockTypes()];

/** Same strings as shared registry (single source of truth). */
export const FLOW_BLOCK_LABELS: Record<FlowBlockType, string> = getFlowBlockDisplayLabels();

/** Short descriptions for the node creator panel */
export const FLOW_BLOCK_DESCRIPTIONS: Record<FlowBlockType, string> = getFlowBlockDescriptions();
