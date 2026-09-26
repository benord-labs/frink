/**
 * Generic DOM query for ordered visible tree items.
 * Works with any tree that uses `data-tree-path` or `data-item-id` attributes.
 */

type TreeItemInfo<T extends string = string> = {
  id: T;
  element: HTMLElement;
};

/**
 * Query visible tree items from the DOM in document order.
 * @param container - The scrollable tree container element
 * @param attribute - The data attribute to read item IDs from (default: 'data-tree-path')
 */
export function getVisibleTreeItems<T extends string = string>(
  container: HTMLElement | null,
  attribute = 'data-tree-path',
): TreeItemInfo<T>[] {
  if (!container) return [];
  const elements = Array.from(container.querySelectorAll<HTMLElement>(`[${attribute}]`));
  const items: TreeItemInfo<T>[] = [];
  for (const el of elements) {
    const id = el.getAttribute(attribute) as T | null;
    if (id) items.push({ id, element: el });
  }
  return items;
}
