import { getDefaultGridRatios, getDefaultRatios, type SplitViewState } from '../atoms';
import {
  growLinearMultiPaneRatios,
  LINEAR_MULTI_MIN_RATIO,
  LINEAR_MULTI_RESIZE_STEP,
  shrinkLinearMultiPaneRatios,
} from './linear-multi-pane-resize';

function clampActivePaneIndex(index: number, n: number): number {
  if (typeof index !== 'number' || !Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(n - 1, Math.trunc(index)));
}

/** Pure resize step for the active pane (grow = steal space, shrink = give space). */
export function adjustActivePaneSplitRatios(
  prev: SplitViewState,
  direction: 'grow' | 'shrink',
): SplitViewState {
  if (prev.chatIds.length < 2) return prev;
  const n = prev.chatIds.length;
  const active = clampActivePaneIndex(prev.activePaneIndex, n);
  const base: SplitViewState = { ...prev, activePaneIndex: active };
  const step = direction === 'grow' ? LINEAR_MULTI_RESIZE_STEP : -LINEAR_MULTI_RESIZE_STEP;

  if (n === 2) {
    const ratios = [...(base.ratios.length === 2 ? base.ratios : getDefaultRatios(2))];
    const other = 1 - active;
    let rActive = (ratios[active] ?? 0.5) + step;
    rActive = Math.max(LINEAR_MULTI_MIN_RATIO, Math.min(1 - LINEAR_MULTI_MIN_RATIO, rActive));
    const rOther = 1 - rActive;
    ratios[active] = rActive;
    ratios[other] = rOther;
    return { ...base, ratios };
  }

  if (n >= 3 && (base.layout === 'horizontal' || base.layout === 'vertical')) {
    const ratioBase = base.ratios.length === n ? base.ratios : getDefaultRatios(n);
    const ratios =
      direction === 'grow'
        ? growLinearMultiPaneRatios(
            ratioBase,
            active,
            n,
            LINEAR_MULTI_RESIZE_STEP,
            LINEAR_MULTI_MIN_RATIO,
          )
        : shrinkLinearMultiPaneRatios(
            ratioBase,
            active,
            n,
            LINEAR_MULTI_RESIZE_STEP,
            LINEAR_MULTI_MIN_RATIO,
          );
    return { ...base, ratios };
  }

  const gr = base.gridRatios ?? getDefaultGridRatios();
  const rows = [...gr.rows];
  const cols = [...gr.cols];

  if (base.layout === 'grid' && n === 4) {
    const row = Math.floor(active / 2);
    const col = active % 2;
    const r0 = Math.max(
      LINEAR_MULTI_MIN_RATIO,
      Math.min(1 - LINEAR_MULTI_MIN_RATIO, (rows[row] ?? 0.5) + step),
    );
    rows[row] = r0;
    rows[1 - row] = 1 - r0;
    const c0 = Math.max(
      LINEAR_MULTI_MIN_RATIO,
      Math.min(1 - LINEAR_MULTI_MIN_RATIO, (cols[col] ?? 0.5) + step),
    );
    cols[col] = c0;
    cols[1 - col] = 1 - c0;
    return { ...base, gridRatios: { rows, cols } };
  }

  if (base.layout === 'three-bottom') {
    if (active === 2) {
      const r1 = Math.max(
        LINEAR_MULTI_MIN_RATIO,
        Math.min(1 - LINEAR_MULTI_MIN_RATIO, (rows[1] ?? 0.5) + step),
      );
      rows[1] = r1;
      rows[0] = 1 - r1;
    } else {
      const r0 = Math.max(
        LINEAR_MULTI_MIN_RATIO,
        Math.min(1 - LINEAR_MULTI_MIN_RATIO, (rows[0] ?? 0.5) + step),
      );
      rows[0] = r0;
      rows[1] = 1 - r0;
      const c0 = Math.max(
        LINEAR_MULTI_MIN_RATIO,
        Math.min(1 - LINEAR_MULTI_MIN_RATIO, (cols[active] ?? 0.5) + step),
      );
      cols[active] = c0;
      cols[1 - active] = 1 - c0;
    }
    return { ...base, gridRatios: { rows, cols } };
  }

  if (base.layout === 'three-right') {
    if (active === 2) {
      const c1 = Math.max(
        LINEAR_MULTI_MIN_RATIO,
        Math.min(1 - LINEAR_MULTI_MIN_RATIO, (cols[1] ?? 0.5) + step),
      );
      cols[1] = c1;
      cols[0] = 1 - c1;
    } else {
      const c0 = Math.max(
        LINEAR_MULTI_MIN_RATIO,
        Math.min(1 - LINEAR_MULTI_MIN_RATIO, (cols[0] ?? 0.5) + step),
      );
      cols[0] = c0;
      cols[1] = 1 - c0;
      const r0 = Math.max(
        LINEAR_MULTI_MIN_RATIO,
        Math.min(1 - LINEAR_MULTI_MIN_RATIO, (rows[active] ?? 0.5) + step),
      );
      rows[active] = r0;
      rows[1 - active] = 1 - r0;
    }
    return { ...base, gridRatios: { rows, cols } };
  }

  return base;
}
