/** React Flow / dagre layout dimensions */
export const RF_NODE_WIDTH = 320;
export const RF_NODE_HEIGHT = 80;
export const FAN_OUT_BODY_TOP = 152;
export const FAN_OUT_CHILD_X = 40;
export const FAN_OUT_CHILD_COLUMN_GAP = 40;
export const FAN_OUT_CHILD_STEP = 136;
export const FAN_OUT_BOTTOM_PADDING = 32;

/** Snap grid (matches Background dots gap) */
export const FLOW_CANVAS_GRID_SIZE = 16;

/** Dot radius (px) for `Background` dots — slightly larger than default (1) for readability on atmosphere. */
export const FLOW_CANVAS_DOT_SIZE = 1.5;

export const DAGRE_OPTS = {
  rankdir: 'TB' as const,
  nodesep: 48,
  ranksep: 60,
};
