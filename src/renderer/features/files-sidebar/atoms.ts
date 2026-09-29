import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
import {
  type ContentSearchOptions,
  DEFAULT_CONTENT_SEARCH_OPTIONS,
} from './types/content-search-options';

export type FilesSidebarTab = 'files' | 'search';

// Identity marker for "this split session has not seeded its file trees yet"; never mutated.
export const UNSEEDED_SPLIT_PANE_FILE_TREES = new Set<number>();

// Which split-pane indices have their file tree open (ephemeral, not persisted)
export const splitPaneFileTreesAtom = atom<Set<number>>(UNSEEDED_SPLIT_PANE_FILE_TREES);

// Files sidebar open state - persisted across sessions
export const filesSidebarOpenAtom = atomWithStorage<boolean>(
  'files-sidebar-open',
  true, // Open by default
  undefined,
  { getOnInit: true },
);

// Files sidebar width - persisted across sessions (single-pane only)
export const filesSidebarWidthAtom = atomWithStorage<number>(
  'files-sidebar-width',
  280, // Default width
  undefined,
  { getOnInit: true },
);

// Active tab in single-pane Files sidebar (persisted)
export const filesSidebarActiveTabAtom = atomWithStorage<FilesSidebarTab>(
  'files-sidebar-active-tab',
  'files',
  undefined,
  { getOnInit: true },
);

// Split-pane file tree width - persisted; used only when file tree is inside a split pane (narrower limits than single-pane)
export const splitPaneFileTreeWidthAtom = atomWithStorage<number>(
  'split-pane-file-tree-width',
  240,
  undefined,
  { getOnInit: true },
);

// Persisted options shared by single-pane and split-pane content search tabs.
export const contentSearchOptionsAtom = atomWithStorage<ContentSearchOptions>(
  'files-sidebar-content-search-options',
  DEFAULT_CONTENT_SEARCH_OPTIONS,
  undefined,
  { getOnInit: true },
);
