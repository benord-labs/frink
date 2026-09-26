/**
 * Check if dropping source into destFolder would create a cycle.
 * Returns true if destFolder IS or IS INSIDE sourcePath.
 */
function isDescendantOrSelf(sourcePath: string, destFolderPath: string): boolean {
  return destFolderPath === sourcePath || destFolderPath.startsWith(`${sourcePath}/`);
}

/**
 * Get the parent folder of a relative path (empty string = project root).
 */
function getParentFolder(relativePath: string): string {
  const lastSlash = relativePath.lastIndexOf('/');
  return lastSlash === -1 ? '' : relativePath.slice(0, lastSlash);
}

/**
 * Filter out items whose path is a descendant of another item in the list.
 * Prevents double-moving when a user selects both `src/` and `src/main.ts` —
 * the child is already included inside the parent folder move.
 */
export function deduplicateDescendants<T extends { path: string }>(items: T[]): T[] {
  const sorted = [...items].sort((a, b) => a.path.localeCompare(b.path));
  return sorted.filter((item, i) => {
    if (i === 0) return true;
    const prev = sorted[i - 1];
    return !item.path.startsWith(`${prev.path}/`);
  });
}

type DragItem = {
  path: string;
  type: 'file' | 'folder';
};

/**
 * Collect drag items from DnD event data, dedup descendants, and filter out
 * items that can't be moved to the destination (already there, or cycle).
 */
export function collectMovableItems(
  dragData: {
    nodePath: string;
    nodeType: 'file' | 'folder';
    batchItems?: Array<{ path: string; type: 'file' | 'folder' }>;
  },
  destFolder: string,
): DragItem[] {
  const items = deduplicateDescendants([
    { path: dragData.nodePath, type: dragData.nodeType },
    ...(dragData.batchItems ?? []).map((b) => ({ path: b.path, type: b.type })),
  ]);

  return items.filter((item) => {
    if (item.type === 'folder' && isDescendantOrSelf(item.path, destFolder)) return false;
    if (getParentFolder(item.path) === destFolder) return false;
    return true;
  });
}
