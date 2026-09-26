import type { TerminalInstance } from './types';

/** Build instances in strip order; drops missing ids. */
export function resolveSplitPaneInstances(
  terminals: TerminalInstance[],
  paneIds: readonly string[],
): TerminalInstance[] {
  const byId = new Map(terminals.map((t) => [t.id, t] as const));
  const out: TerminalInstance[] = [];
  for (const id of paneIds) {
    const t = byId.get(id);
    if (t) out.push(t);
  }
  return out;
}

/** Drop stale / duplicate ids; fewer than two panes collapses to single-column UI. */
export function normalizeSplitPaneIds(
  paneIds: readonly string[],
  terminals: TerminalInstance[],
): string[] {
  const valid = new Set(terminals.map((t) => t.id));
  const deduped: string[] = [];
  for (const id of paneIds) {
    if (!valid.has(id)) continue;
    if (deduped.includes(id)) continue;
    deduped.push(id);
  }
  return deduped.length >= 2 ? deduped : [];
}

/**
 * One tab badge per split strip: hide non-primary sessions from the tab row (same badge as first pane).
 */
export function getVisibleTerminalTabsForStrip(
  terminals: readonly TerminalInstance[],
  splitPaneIds: readonly string[],
): TerminalInstance[] {
  if (splitPaneIds.length < 2) return [...terminals];
  const secondary = new Set(splitPaneIds.slice(1));
  return terminals.filter((t) => !secondary.has(t.id));
}

/** Tab row uses primary id; highlight when focus or selection is any pane in the strip. */
export function isSplitStripTabActive(
  stripPrimaryTabId: string,
  activeTerminalId: string | null,
  keyboardFocusTerminalId: string | null,
  splitPaneIds: readonly string[],
): boolean {
  if (splitPaneIds.length < 2 || stripPrimaryTabId !== splitPaneIds[0]) return false;
  const inStrip = (id: string | null) => Boolean(id && splitPaneIds.includes(id));
  return inStrip(activeTerminalId) || inStrip(keyboardFocusTerminalId);
}

/**
 * Whether to mount split columns: group exists and the selected tab is a session in the strip.
 * When the user selects another tab (outside the strip), returns false so a single column shows
 * while the group remains in `splitPaneIds` for tab badges.
 */
export function isSplitLayoutVisible(
  splitPaneIds: readonly string[],
  activeTerminalId: string | null,
  resolvedPaneCount: number,
): boolean {
  return (
    resolvedPaneCount >= 2 && Boolean(activeTerminalId && splitPaneIds.includes(activeTerminalId))
  );
}

/** Instances passed to TerminalContent — empty when viewing a tab outside the split group. */
export function getSplitPaneTerminalsForContent(
  resolved: TerminalInstance[],
  splitPaneIds: readonly string[],
  activeTerminalId: string | null,
): TerminalInstance[] {
  if (!isSplitLayoutVisible(splitPaneIds, activeTerminalId, resolved.length)) {
    return [];
  }
  return [...resolved];
}

/** Scroll tab strip should target the primary tab when any pane in the strip is focused. */
export function tabScrollTargetIdForActivePane(
  activeTerminalId: string | null,
  keyboardFocusTerminalId: string | null,
  splitPaneIds: readonly string[],
): string | null {
  if (splitPaneIds.length < 2) return activeTerminalId;
  if (
    (activeTerminalId !== null && splitPaneIds.includes(activeTerminalId)) ||
    (keyboardFocusTerminalId !== null && splitPaneIds.includes(keyboardFocusTerminalId))
  ) {
    return splitPaneIds[0];
  }
  return activeTerminalId;
}
