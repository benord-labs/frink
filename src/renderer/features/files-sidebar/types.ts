import type { FileStatus } from '../../../shared/changes-types';

/** State for the inline input when creating a new file/folder */
export type CreatingItem = {
  parentFolder: string;
  type: 'file' | 'folder';
};

export type FileEntry = {
  path: string;
  type: 'file' | 'folder';
  gitStatus?: FileStatus;
  isGitIgnored?: boolean;
};

/** Currently selected node in the file tree (for keyboard shortcuts) */
export type FileTreeSelection = {
  path: string;
  name: string;
  type: 'file' | 'folder';
} | null;

/** Metadata stored per selected item in multi-select */
export type FileTreeItemMeta = {
  name: string;
  type: 'file' | 'folder';
};

/** Multi-select state for the file tree */
export type FileTreeMultiSelection = {
  /** Set of selected node paths */
  paths: Set<string>;
  /** Anchor path for Shift range selection */
  anchor: string | null;
  /** Metadata for each selected item */
  items: Map<string, FileTreeItemMeta>;
};

export type FileTreeNode = {
  id: string;
  name: string;
  type: 'file' | 'folder';
  path: string;
  gitStatus?: FileStatus;
  isGitIgnored?: boolean;
  children?: FileTreeNode[];
  /** For lazy loading: true if children have been fetched */
  childrenLoaded?: boolean;
};
