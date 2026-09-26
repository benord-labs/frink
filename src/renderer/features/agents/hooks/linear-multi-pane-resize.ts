/**
 * Keyboard grow/shrink for **linear** multi-pane layouts (`horizontal` or `vertical` with N≥3).
 * Ratios sum to 1 along the split axis (row of columns or column of rows).
 * Grow: steal from the next pane first (right / below); last pane steals from previous.
 */

export const LINEAR_MULTI_RESIZE_STEP = 0.05;
export const LINEAR_MULTI_MIN_RATIO = 0.15;

/** @returns new ratios array (mutates nothing) */
export function growLinearMultiPaneRatios(
  ratios: readonly number[],
  activeIndex: number,
  n: number,
  step: number = LINEAR_MULTI_RESIZE_STEP,
  minRatio: number = LINEAR_MULTI_MIN_RATIO,
): number[] {
  const next = [...ratios];
  if (next.length !== n || n < 2) return next;
  const active = activeIndex;
  if (active < n - 1) {
    const i = active;
    const j = active + 1;
    const pairSum = (next[i] ?? 0) + (next[j] ?? 0);
    let newI = (next[i] ?? 0) + step;
    newI = Math.max(minRatio, Math.min(pairSum - minRatio, newI));
    next[i] = newI;
    next[j] = pairSum - newI;
  } else {
    const i = active - 1;
    const j = active;
    const pairSum = (next[i] ?? 0) + (next[j] ?? 0);
    let newJ = (next[j] ?? 0) + step;
    newJ = Math.max(minRatio, Math.min(pairSum - minRatio, newJ));
    next[j] = newJ;
    next[i] = pairSum - newJ;
  }
  return next;
}

/** @returns new ratios array (mutates nothing) */
export function shrinkLinearMultiPaneRatios(
  ratios: readonly number[],
  activeIndex: number,
  n: number,
  step: number = LINEAR_MULTI_RESIZE_STEP,
  minRatio: number = LINEAR_MULTI_MIN_RATIO,
): number[] {
  const next = [...ratios];
  if (next.length !== n || n < 2) return next;
  const active = activeIndex;
  if (active < n - 1) {
    const i = active;
    const j = active + 1;
    const pairSum = (next[i] ?? 0) + (next[j] ?? 0);
    let newI = (next[i] ?? 0) - step;
    newI = Math.max(minRatio, Math.min(pairSum - minRatio, newI));
    next[i] = newI;
    next[j] = pairSum - newI;
  } else {
    const i = active - 1;
    const j = active;
    const pairSum = (next[i] ?? 0) + (next[j] ?? 0);
    let newJ = (next[j] ?? 0) - step;
    newJ = Math.max(minRatio, Math.min(pairSum - minRatio, newJ));
    next[j] = newJ;
    next[i] = pairSum - newJ;
  }
  return next;
}
