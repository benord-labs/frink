/**
 * Returns whether the given pane is the focused pane (single view = active; split view = active when index matches).
 * Use for pane-scoped behavior: shortcuts, search scroll, highlight context.
 */
import { useAtomValue } from 'jotai';
import { selectAtom } from 'jotai/utils';
import { useMemo } from 'react';
import { splitViewAtom } from '../atoms';

export function useIsPaneActive(splitPaneIndex: number | undefined): boolean {
  // Subscribe to this pane's boolean, so a focus change re-renders only the two panes it flips
  const isActiveAtom = useMemo(
    () =>
      selectAtom(
        splitViewAtom,
        (sv) => splitPaneIndex == null || sv.activePaneIndex === splitPaneIndex,
      ),
    [splitPaneIndex],
  );
  return useAtomValue(isActiveAtom);
}
