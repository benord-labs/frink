/**
 * Scroll a tree node into view within the scrollable tree container.
 * Delegates to the shared tree-navigation utility.
 */
import { scrollTreeItemIntoViewById } from '@/lib/tree-navigation';

export function scrollTreeNodeIntoView(container: HTMLElement | null, path: string): void {
  scrollTreeItemIntoViewById(container, path, 'data-tree-path');
}
