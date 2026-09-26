import { useMemo } from 'react';
import type { FileEntry, FileTreeNode } from '../types';

type TreeNodeInternal = Omit<FileTreeNode, 'children'> & {
  children?: Record<string, TreeNodeInternal>;
};

/**
 * Build hierarchical tree from flat file list
 * Organizes files into a nested structure with folders and files
 */
export function buildFileTree(entries: FileEntry[]): FileTreeNode[] {
  const root: Record<string, TreeNodeInternal> = {};
  // Create a map of entries by path for quick lookup of isGitIgnored
  const entriesByPath = new Map<string, FileEntry>();
  for (const entry of entries) {
    entriesByPath.set(entry.path, entry);
  }

  for (const entry of entries) {
    const parts = entry.path.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const pathSoFar = parts.slice(0, i + 1).join('/');

      if (!current[part]) {
        // Check if there's an entry for this path to get isGitIgnored
        const pathEntry = entriesByPath.get(pathSoFar);
        current[part] = {
          id: pathSoFar,
          name: part,
          type: isLast ? entry.type : 'folder',
          path: pathSoFar,
          gitStatus: isLast ? entry.gitStatus : undefined,
          isGitIgnored: pathEntry?.isGitIgnored,
          children: isLast && entry.type === 'file' ? undefined : {},
        };
      } else {
        // Node already exists - update isGitIgnored if we have an entry for this path
        const pathEntry = entriesByPath.get(pathSoFar);
        if (pathEntry?.isGitIgnored !== undefined) {
          current[part].isGitIgnored = pathEntry.isGitIgnored;
        }
        // If this is a folder that needs children, ensure children object exists
        if (!isLast && !current[part].children) {
          current[part].children = {};
        }
      }

      if (!isLast && current[part].children) {
        current = current[part].children;
      }
    }
  }

  return convertToArray(root);
}

type RootContentEntry = Omit<FileEntry, 'type'> & { name: string; type: 'file' | 'folder' };
type SearchResultEntry = { path: string; type: string };

type UseFileTreeNodesArgs = {
  rootContents: RootContentEntry[];
  searchResults: SearchResultEntry[];
  isSearching: boolean;
  showModifiedOnly: boolean;
};

type UseFileTreeNodesResult = {
  /** The nodes to render: search results while searching, else the (optionally filtered) root listing. */
  nodes: FileTreeNode[];
  hasGitDiff: boolean;
};

/** Root-listing and search results → the FileTreeNode array to render (honouring modified-only),
 * plus whether the root listing has any git changes. Shared by FilesSidebar and PaneFileTree. */
export function useFileTreeNodes({
  rootContents,
  searchResults,
  isSearching,
  showModifiedOnly,
}: UseFileTreeNodesArgs): UseFileTreeNodesResult {
  const rootNodes: FileTreeNode[] = useMemo(() => {
    if (isSearching) return [];
    return rootContents.map((entry) => ({
      id: entry.path,
      name: entry.name,
      path: entry.path,
      type: entry.type,
      gitStatus: entry.gitStatus,
      isGitIgnored: entry.isGitIgnored,
      children: undefined,
      childrenLoaded: false,
    }));
  }, [rootContents, isSearching]);
  const hasGitDiff = rootNodes.some((node) => Boolean(node.gitStatus));

  const searchNodes: FileTreeNode[] = useMemo(() => {
    if (!isSearching) return [];
    return buildFileTree(
      searchResults.map((f) => ({
        path: f.path,
        // SAFETY: the search endpoint only returns files and folders.
        type: f.type as 'file' | 'folder',
      })),
    );
  }, [searchResults, isSearching]);

  const browseNodes =
    showModifiedOnly && !isSearching
      ? rootNodes.filter((node) => Boolean(node.gitStatus))
      : rootNodes;
  const nodes = isSearching ? searchNodes : browseNodes;

  return { nodes, hasGitDiff };
}

function convertToArray(nodes: Record<string, TreeNodeInternal>): FileTreeNode[] {
  return Object.values(nodes)
    .map((node) => ({
      ...node,
      children: node.children ? convertToArray(node.children) : undefined,
    }))
    .sort((a, b) => {
      // Folders first
      if (a.type !== b.type) {
        return a.type === 'folder' ? -1 : 1;
      }
      // Alphabetical by name
      return a.name.localeCompare(b.name);
    });
}
