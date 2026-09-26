/** Human-readable block type names (UI + validation messages). */

import type { FlowBlockType } from '../types/flow';
import { getFlowBlockDisplayLabels } from './block-registry';

export const FLOW_BLOCK_DISPLAY_LABELS: Record<FlowBlockType, string> = getFlowBlockDisplayLabels();
