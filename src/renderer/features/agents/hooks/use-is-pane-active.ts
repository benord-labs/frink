/**
 * Returns whether the given pane is the focused pane (single view = active; split view = active when index matches).
 * Use for pane-scoped behavior: shortcuts, search scroll, highlight context.
 */
import { useAtomValue } from 'jotai';
import { splitViewActivePaneIndexAtom } from '../atoms';

export function useIsPaneActive(splitPaneIndex: number | undefined): boolean {
  const activePaneIndex = useAtomValue(splitViewActivePaneIndexAtom);
  return splitPaneIndex == null || activePaneIndex === splitPaneIndex;
}
