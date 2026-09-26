/**
 * Collect the ordered list of visible tree node paths by querying the DOM.
 * Each TreeNode renders a button with a `data-tree-path` attribute.
 * Delegates to the shared tree-navigation utility.
 */
import { getVisibleTreeItems } from '@/lib/tree-navigation';

export function getVisiblePaths(container: HTMLElement | null): string[] {
  return getVisibleTreeItems(container, 'data-tree-path').map((item) => item.id);
}
