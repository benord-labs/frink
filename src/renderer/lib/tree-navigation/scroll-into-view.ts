/**
 * Scroll a tree item element into view within its scrollable container.
 * Uses `scrollIntoView({ block: 'nearest' })` to minimize disruptive jumping.
 * Respects `prefers-reduced-motion` for accessibility.
 */
export function scrollTreeItemIntoView(element: HTMLElement | null | undefined): void {
  if (!element) return;
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  element.scrollIntoView({
    block: 'nearest',
    behavior: prefersReducedMotion ? 'instant' : 'smooth',
  });
}

/**
 * Find and scroll a tree item into view by its data attribute value.
 * @param container - The scrollable tree container element
 * @param id - The value of the data attribute to find
 * @param attribute - The data attribute name (default: 'data-tree-path')
 */
export function scrollTreeItemIntoViewById(
  container: HTMLElement | null,
  id: string,
  attribute = 'data-tree-path',
): void {
  if (!container) return;
  const el = container.querySelector<HTMLElement>(`[${attribute}="${CSS.escape(id)}"]`);
  scrollTreeItemIntoView(el);
}
