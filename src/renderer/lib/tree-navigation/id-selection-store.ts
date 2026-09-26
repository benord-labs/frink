/**
 * Ref-stable Cmd/Shift-click multi-selection over plain string ids. Rows subscribe to their own
 * selected-bit via `useSyncExternalStore`, so a toggle re-renders only the rows that flipped.
 */
export type IdSelectionStore = {
  subscribe: (listener: () => void) => () => void;
  /** Same reference between mutations. */
  getSnapshot: () => ReadonlySet<string>;
  isSelected: (id: string) => boolean;
  /** Cmd+click: flip one id and make it the range anchor. */
  toggle: (id: string) => void;
  /** Shift+click: select the contiguous run between the anchor and `toId` in `orderedIds`. */
  selectRange: (toId: string, orderedIds: readonly string[]) => void;
  /** Drop one id, e.g. when its row leaves the screen. */
  deselect: (id: string) => void;
  /** Empty the selection; `anchor` is where the next Shift+click range starts from. */
  clear: (anchor?: string | null) => void;
};

const EMPTY: ReadonlySet<string> = new Set();

export function createIdSelectionStore(): IdSelectionStore {
  let selection = EMPTY;
  let anchor: string | null = null;
  const listeners = new Set<() => void>();

  const commit = (next: ReadonlySet<string>): void => {
    if (next === selection) return;
    selection = next;
    for (const listener of listeners) listener();
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => selection,
    isSelected: (id) => selection.has(id),
    toggle: (id) => {
      const next = new Set(selection);
      if (!next.delete(id)) next.add(id);
      anchor = id;
      commit(next);
    },
    selectRange: (toId, orderedIds) => {
      const from = anchor ? orderedIds.indexOf(anchor) : -1;
      const to = orderedIds.indexOf(toId);
      if (to === -1) return;
      if (from === -1) anchor = toId;
      const [start, end] = from === -1 ? [to, to] : [Math.min(from, to), Math.max(from, to)];
      commit(new Set(orderedIds.slice(start, end + 1)));
    },
    deselect: (id) => {
      if (!selection.has(id)) return;
      const next = new Set(selection);
      next.delete(id);
      commit(next);
    },
    clear: (nextAnchor = null) => {
      anchor = nextAnchor;
      commit(EMPTY);
    },
  };
}
