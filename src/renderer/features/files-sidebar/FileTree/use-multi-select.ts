import { useRef, useSyncExternalStore } from 'react';
import type { FileTreeItemMeta, FileTreeMultiSelection } from '../types';

/** A single selected item, resolved from its stored metadata */
type SelectedItem = { path: string; name: string; type: 'file' | 'folder' };

/**
 * Ref-stable external store for file-tree multi-selection.
 *
 * The store handle identity never changes, so placing it in a React context
 * causes zero re-renders in consumers. Components subscribe to just the slice
 * they need via `useSyncExternalStore` (see MultiSelectContext), so a selection
 * change re-renders only the nodes whose own selected-bit flipped — not O(N).
 */
export type SelectionStore = {
  /** Subscribe to selection changes; returns an unsubscribe fn */
  subscribe: (listener: () => void) => () => void;
  /** Current selection (same reference between mutations) */
  getSnapshot: () => FileTreeMultiSelection;
  /** Whether a single path is currently selected */
  isSelected: (path: string) => boolean;
  /** Number of selected items */
  getCount: () => number;
  /** The "primary" selected item (last directly selected), or null */
  getPrimary: () => SelectedItem | null;
  /** All selected items as an array */
  getSelectedItems: () => SelectedItem[];
  /** Batch items for drag data when `draggedPath` is part of a >1 selection */
  getBatchDragItems: (draggedPath: string) => SelectedItem[] | undefined;
  /** Handle a click with modifier detection — the main entry point */
  handleSelect: (
    path: string,
    meta: FileTreeItemMeta,
    modifiers: { shift: boolean; meta: boolean },
  ) => void;
  /** Select a single path (clears everything else, sets anchor) */
  selectOne: (path: string, meta: FileTreeItemMeta) => void;
  /** Toggle a single path in/out of the selection (Cmd+Click) */
  toggleItem: (path: string, meta: FileTreeItemMeta) => void;
  /** Select a contiguous range from anchor to the given path (Shift+Click/Arrow) */
  selectRange: (toPath: string, visiblePaths: string[], metaLookup: MetaLookup) => void;
  /** Select all visible paths */
  selectAll: (visiblePaths: string[], metaLookup: MetaLookup) => void;
  /** Clear all selection */
  clearSelection: () => void;
  /** Remove descendants of a collapsed folder from selection */
  deselectDescendants: (folderPath: string) => void;
};

/** Return type of the useMultiSelect hook */
type MultiSelectAPI = {
  /** Current multi-select state (reactive) */
  selection: FileTreeMultiSelection;
  /** Number of selected items */
  count: number;
  /** Check if a path is selected */
  isSelected: (path: string) => boolean;
  /** Handle a click with modifier detection — the main entry point */
  handleSelect: SelectionStore['handleSelect'];
  /** Select a single path (clears everything else, sets anchor) */
  selectOne: SelectionStore['selectOne'];
  /** Toggle a single path in/out of the selection (Cmd+Click) */
  toggleItem: SelectionStore['toggleItem'];
  /** Select a contiguous range from anchor to the given path (Shift+Click/Arrow) */
  selectRange: SelectionStore['selectRange'];
  /** Select all visible paths */
  selectAll: SelectionStore['selectAll'];
  /** Clear all selection */
  clearSelection: SelectionStore['clearSelection'];
  /** Remove descendants of a collapsed folder from selection */
  deselectDescendants: SelectionStore['deselectDescendants'];
  /** Get the currently selected items as an array */
  getSelectedItems: SelectionStore['getSelectedItems'];
  /** Get the "primary" selected item (last clicked or anchor) */
  getPrimary: SelectionStore['getPrimary'];
  /** The ref-stable store handle to hand down to the tree for per-node subscription */
  selectionStore: SelectionStore;
};

/** Function to look up metadata for a path */
export type MetaLookup = (path: string) => FileTreeItemMeta;

const EMPTY_SET = new Set<string>();
const EMPTY_MAP = new Map<string, FileTreeItemMeta>();
const EMPTY_SELECTION: FileTreeMultiSelection = {
  paths: EMPTY_SET,
  anchor: null,
  items: EMPTY_MAP,
};

/**
 * Create a selection store. The returned handle is stable for the store's
 * lifetime; only the internal `selection`/`primary` values change, and
 * subscribers are notified on every mutation.
 *
 * Supports:
 * - Plain click: single-select (clears others, sets anchor)
 * - Cmd+Click: toggle individual item in/out
 * - Shift+Click: contiguous range from anchor to clicked
 * - Shift+Arrow: extend selection by one
 * - Cmd+A: select all
 */
export function createSelectionStore(): SelectionStore {
  let selection: FileTreeMultiSelection = EMPTY_SELECTION;
  // Track the primary (last directly selected) path for backwards compat
  let primary: string | null = null;
  const listeners = new Set<() => void>();

  const commit = (next: FileTreeMultiSelection): void => {
    selection = next;
    for (const listener of listeners) listener();
  };

  const getSelectedItems = (): SelectedItem[] =>
    Array.from(selection.items.entries()).map(([path, meta]) => ({
      path,
      name: meta.name,
      type: meta.type,
    }));

  const selectOne = (path: string, meta: FileTreeItemMeta): void => {
    primary = path;
    commit({ paths: new Set([path]), anchor: path, items: new Map([[path, meta]]) });
  };

  const toggleItem = (path: string, meta: FileTreeItemMeta): void => {
    const paths = new Set(selection.paths);
    const items = new Map(selection.items);
    if (paths.has(path)) {
      paths.delete(path);
      items.delete(path);
    } else {
      paths.add(path);
      items.set(path, meta);
    }
    primary = path;
    commit({ paths, anchor: path, items });
  };

  const selectRange = (toPath: string, visiblePaths: string[], metaLookup: MetaLookup): void => {
    const anchor = selection.anchor;
    if (!anchor) {
      // No anchor — just select the single item
      const meta = metaLookup(toPath);
      primary = toPath;
      commit({ paths: new Set([toPath]), anchor: toPath, items: new Map([[toPath, meta]]) });
      return;
    }

    const anchorIdx = visiblePaths.indexOf(anchor);
    const toIdx = visiblePaths.indexOf(toPath);
    if (anchorIdx === -1 || toIdx === -1) return;

    const start = Math.min(anchorIdx, toIdx);
    const end = Math.max(anchorIdx, toIdx);

    const paths = new Set<string>();
    const items = new Map<string, FileTreeItemMeta>();

    for (let i = start; i <= end; i++) {
      const p = visiblePaths[i];
      paths.add(p);
      items.set(p, selection.items.get(p) ?? metaLookup(p));
    }

    primary = toPath;
    // Keep the anchor the same for continuous Shift+Arrow
    commit({ paths, anchor, items });
  };

  const selectAll = (visiblePaths: string[], metaLookup: MetaLookup): void => {
    const paths = new Set(visiblePaths);
    const items = new Map<string, FileTreeItemMeta>();
    for (const p of visiblePaths) {
      items.set(p, metaLookup(p));
    }
    primary = visiblePaths[0] ?? null;
    commit({ paths, anchor: visiblePaths[0] ?? null, items });
  };

  const clearSelection = (): void => {
    primary = null;
    commit(EMPTY_SELECTION);
  };

  /** Remove all selected paths that are descendants of the given folder.
   *  If the current anchor is a descendant being deselected, reset it to
   *  the collapsed folder so subsequent Shift+Click ranges start sensibly.
   *
   *  Note: The reset anchor (`folderPath`) may not have a corresponding entry
   *  in the `items` map. This is intentional and safe — `selectRange` resolves
   *  missing metadata via its `metaLookup` callback, so a subsequent Shift+Click
   *  will still produce correct results even if the anchor is metadata-free. */
  const deselectDescendants = (folderPath: string): void => {
    const prefix = `${folderPath}/`;
    const hasDescendants = Array.from(selection.paths).some((p) => p.startsWith(prefix));
    if (!hasDescendants) return;

    const paths = new Set<string>();
    const items = new Map<string, FileTreeItemMeta>();
    for (const [p, meta] of selection.items) {
      if (!p.startsWith(prefix)) {
        paths.add(p);
        items.set(p, meta);
      }
    }
    // Reset anchor to the folder if it pointed at a now-hidden descendant
    const anchor = selection.anchor?.startsWith(prefix) ? folderPath : selection.anchor;
    commit({ paths, anchor, items });
  };

  const handleSelect = (
    path: string,
    meta: FileTreeItemMeta,
    modifiers: { shift: boolean; meta: boolean },
  ): void => {
    if (modifiers.meta && !modifiers.shift) {
      toggleItem(path, meta);
    } else if (modifiers.shift) {
      // Shift+Click requires visiblePaths + metaLookup for range selection.
      // Callers MUST use selectRange directly for Shift+Click — this fallback
      // selects the single item to avoid silent data loss.
      if (process.env.NODE_ENV === 'development') {
        // biome-ignore lint/suspicious/noConsole: dev-only warning for incorrect API usage
        console.warn(
          'useMultiSelect: Shift+Click passed to handleSelect — use selectRange() for proper range selection',
        );
      }
      selectOne(path, meta);
    } else {
      selectOne(path, meta);
    }
  };

  const getPrimary = (): SelectedItem | null => {
    if (!primary) return null;
    const meta = selection.items.get(primary);
    if (!meta) return null;
    return { path: primary, name: meta.name, type: meta.type };
  };

  const getBatchDragItems = (draggedPath: string): SelectedItem[] | undefined => {
    if (!selection.paths.has(draggedPath) || selection.paths.size <= 1) return undefined;
    return getSelectedItems().filter((item) => item.path !== draggedPath);
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => selection,
    isSelected: (path) => selection.paths.has(path),
    getCount: () => selection.paths.size,
    getPrimary,
    getSelectedItems,
    getBatchDragItems,
    handleSelect,
    selectOne,
    toggleItem,
    selectRange,
    selectAll,
    clearSelection,
    deselectDescendants,
  };
}

/** Inert store used when selection is suppressed (e.g. during search). */
export const NOOP_SELECTION_STORE: SelectionStore = {
  subscribe: () => () => {},
  getSnapshot: () => EMPTY_SELECTION,
  isSelected: () => false,
  getCount: () => 0,
  getPrimary: () => null,
  getSelectedItems: () => [],
  getBatchDragItems: () => undefined,
  handleSelect: () => {},
  selectOne: () => {},
  toggleItem: () => {},
  selectRange: () => {},
  selectAll: () => {},
  clearSelection: () => {},
  deselectDescendants: () => {},
};

/**
 * Hook for managing multi-select state in the file tree.
 *
 * Owns a ref-stable {@link SelectionStore} and derives the reactive `selection`
 * from it via `useSyncExternalStore`. Hand `selectionStore` down to `<FileTree>`
 * so individual `TreeNode`s subscribe to only their own selected-bit.
 */
export function useMultiSelect(): MultiSelectAPI {
  const storeRef = useRef<SelectionStore | null>(null);
  if (storeRef.current === null) storeRef.current = createSelectionStore();
  const store = storeRef.current;

  const selection = useSyncExternalStore(store.subscribe, store.getSnapshot);

  return {
    selection,
    count: selection.paths.size,
    isSelected: store.isSelected,
    handleSelect: store.handleSelect,
    selectOne: store.selectOne,
    toggleItem: store.toggleItem,
    selectRange: store.selectRange,
    selectAll: store.selectAll,
    clearSelection: store.clearSelection,
    deselectDescendants: store.deselectDescendants,
    getSelectedItems: store.getSelectedItems,
    getPrimary: store.getPrimary,
    selectionStore: store,
  };
}
