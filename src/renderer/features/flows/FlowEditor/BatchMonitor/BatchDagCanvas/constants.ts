/** Layout constants for the BatchDagCanvas (full-width Monitor view). */

/** Node dimensions — larger than BatchPlanCanvas (140×52) to fit full-width Monitor canvas. */
export const MONITOR_NODE_WIDTH = 200;
export const MONITOR_NODE_HEIGHT = 72;

/** dagre layout options for full-width Monitor view with larger nodes. */
export const MONITOR_DAGRE_OPTS = {
  rankdir: 'TB' as const,
  nodesep: 24,
  ranksep: 80,
};

/** fitView padding as a fraction of canvas dimensions (match FlowCanvas editor). */
export const MONITOR_FIT_VIEW_PADDING = 0.15;

/** Show MiniMap when stage count exceeds this threshold. */
export const MINIMAP_STAGE_THRESHOLD = 8;
