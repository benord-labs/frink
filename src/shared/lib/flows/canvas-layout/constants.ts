/** Flow canvas layout dimensions, shared by the canvas, the patch tool and the skill reference. */
export const RF_NODE_WIDTH = 320;
/** Nominal card height used for layout; the rendered card grows with its content. */
export const RF_NODE_HEIGHT = 80;
export const FAN_OUT_BODY_TOP = 152;
export const FAN_OUT_CHILD_X = 40;
export const FAN_OUT_CHILD_COLUMN_GAP = 40;
export const FAN_OUT_CHILD_STEP = 136;
export const FAN_OUT_BOTTOM_PADDING = 32;

export const DAGRE_OPTS = {
  rankdir: 'TB' as const,
  nodesep: 48,
  ranksep: 60,
};

/** Horizontal distance from a loop target's centre to its back-edge's vertical stem. */
export const BACK_EDGE_CLEARANCE = 190;
