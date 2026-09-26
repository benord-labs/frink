/** Layout constants for the BatchPlanCanvas (380px-wide side panel). */

/**
 * Stages in these statuses cannot act as dependency sources (outgoing dep edges).
 * Mirrors server rules for which stages may be edge sources in the batch DAG editor.
 */
export const NON_SOURCE_STATUSES = new Set<string>(['failed', 'cancelled']);

/** Node dimensions — smaller than FlowCanvas (320×80) to fit 380px panel. */
export const BATCH_NODE_WIDTH = 140;
export const BATCH_NODE_HEIGHT = 52;

/** dagre layout options for compact 380px-wide panel. */
export const BATCH_DAGRE_OPTS = {
  rankdir: 'TB' as const,
  nodesep: 16,
  ranksep: 60,
};

/** fitView padding as a fraction of canvas dimensions. */
export const BATCH_FIT_VIEW_PADDING = 0.12;
