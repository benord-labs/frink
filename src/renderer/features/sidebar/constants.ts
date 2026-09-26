/**
 * Resize bounds for the inset left sidepane. The chat sidebar and Settings occupy the same slot and
 * share `agentsSidebarWidthAtom`, so they must agree on the limits or a drag in one clamps in the other.
 * Named distinctly from the files sidebar's own bounds — different pane, different numbers.
 */
export const SIDEPANE_MIN_WIDTH = 160;
export const SIDEPANE_MAX_WIDTH = 420;
