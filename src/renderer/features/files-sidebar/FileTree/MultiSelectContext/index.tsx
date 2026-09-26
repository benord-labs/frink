import { createContext, useContext, useSyncExternalStore } from 'react';
import { NOOP_SELECTION_STORE, type SelectionStore } from '../use-multi-select';

// ---- Selection state (ref-stable store; components subscribe per-slice) ----

/**
 * Holds the ref-stable {@link SelectionStore} handle. Its identity never
 * changes, so consuming this context does NOT re-render on selection changes —
 * only the per-slice `useSyncExternalStore` subscriptions below do.
 */
export const SelectionStateContext = createContext<SelectionStore>(NOOP_SELECTION_STORE);

/** Read the selection store handle (stable — for on-demand snapshot reads) */
export function useSelectionStore(): SelectionStore {
  return useContext(SelectionStateContext);
}

/** Subscribe to whether a single path is selected — re-renders only when this path's bit flips */
export function useIsSelected(path: string): boolean {
  const store = useContext(SelectionStateContext);
  return useSyncExternalStore(store.subscribe, () => store.isSelected(path));
}

/** Subscribe to the selected count. Use sparingly — every subscriber re-renders on any count change. */
export function useSelectionCount(): number {
  const store = useContext(SelectionStateContext);
  return useSyncExternalStore(store.subscribe, store.getCount);
}

// ---- Selection actions (stable callbacks, rarely change) ----

type SelectionActionsValue = {
  /** Called when a modifier click occurs */
  onModifiedClick?: (
    path: string,
    name: string,
    type: 'file' | 'folder',
    modifiers: { shift: boolean; meta: boolean },
  ) => void;
  /** Batch delete callback */
  onBatchDelete?: (paths: string[]) => void;
  /** Remove descendants of a collapsed folder from selection */
  deselectDescendants?: (folderPath: string) => void;
};

const EMPTY_ACTIONS: SelectionActionsValue = {};

export const SelectionActionsContext = createContext<SelectionActionsValue>(EMPTY_ACTIONS);

/** Read stable action callbacks (don't re-render on selection changes) */
export function useSelectionActions(): SelectionActionsValue {
  return useContext(SelectionActionsContext);
}
