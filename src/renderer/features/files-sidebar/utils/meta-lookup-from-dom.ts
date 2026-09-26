import type { MetaLookup } from '../FileTree/use-multi-select';

/**
 * Create a MetaLookup function that reads node metadata from the DOM.
 * Uses `data-tree-path` and `data-tree-type` attributes set on TreeNode buttons.
 * All path interpolation uses CSS.escape() for safe selector construction.
 */
export function createMetaLookupFromDOM(container: HTMLElement | null): MetaLookup {
  return (path: string) => {
    const el = container?.querySelector(`[data-tree-path="${CSS.escape(path)}"]`);
    const name = path.split('/').pop() ?? path;
    const type = (el?.getAttribute('data-tree-type') as 'file' | 'folder') ?? 'file';
    return { name, type };
  };
}
